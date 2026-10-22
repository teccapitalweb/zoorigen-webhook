'use strict';

const proxyquire = require('proxyquire').noCallThru();
const { FakeFirestore, FakeTimestamp, NOMBRE_DOC } = require('./fake-firestore');

const PRICE_MENSUAL = 'price_1TRcJnA7If2CqXs9dMBGRmDF';
const PRICE_ANUAL = 'price_1TRcJlA7If2CqXs97WQNmKFq';
const VIDEO_GRATIS = 'befd1641-850a-4099-88a8-047a1badc703';
const VIDEO_PREMIUM = 'b9b4a50a-9cec-45c2-b66f-e965eb97aebe';

const dias = n => Date.now() + n * 24 * 60 * 60 * 1000;
const ts = ms => new FakeTimestamp(ms);
const unix = ms => Math.floor(ms / 1000);

function suscripcion({ id, uid, precio = PRICE_MENSUAL, status = 'active', terminaEn = dias(20), cancelAlFinal = false, customer = 'cus_1', sinMetadata = false }) {
  return {
    id,
    customer,
    status,
    cancel_at_period_end: cancelAlFinal,
    current_period_end: unix(terminaEn),
    items: { data: [{ price: { id: precio } }] },
    metadata: sinMetadata ? {} : { firebaseUID: uid, planType: precio === PRICE_ANUAL ? 'anual' : 'mensual' }
  };
}

/**
 * Carga server.js con todo simulado.
 * @param {object} opciones
 *  - seed: documentos de Firestore { 'miembros/uid': {...} }
 *  - tokens: { token: { uid, email } } para Firebase Auth
 *  - usuariosAuth: { uid: { emailVerified, creationTime } } lo que responden auth.getUser / auth.getUsers
 *    (el objeto se devuelve y se puede cambiar durante la prueba, p. ej. para "confirmar el correo")
 *  - suscripciones: lista de objetos creados con suscripcion()
 *  - precios: true para que la Stripe simulada responda prices.retrieve (recordatorios de pago)
 *  - env: variables de entorno extra (p. ej. BUNNY_TOKEN_AUTH_KEY, CERTIFICATE_SIGNING_KEY)
 */
function cargarServidor({ seed = {}, tokens = {}, suscripciones = [], env = {}, usuariosAuth = {}, precios = false } = {}) {
  const guardado = {};
  const entorno = {
    STRIPE_SECRET_KEY: 'sk_test_falsa',
    STRIPE_WEBHOOK_SECRET: 'whsec_falsa',
    BUNNY_TOKEN_AUTH_KEY: 'clave-bunny-de-prueba',
    ...env
  };
  // Una BUNNY_API_KEY real del equipo no debe filtrarse a las pruebas; se restaura al terminar.
  guardado.BUNNY_API_KEY = process.env.BUNNY_API_KEY; delete process.env.BUNNY_API_KEY;
  // Lo mismo con las llaves de certificados y de correo (cada prueba pone las suyas en `env`).
  for (const k of ['CERTIFICATE_SIGNING_KEY', 'LEGACY_PROGRESS_IMPORT_BEFORE', 'CERTIFICADOS_ANTERIORES_HASTA', 'RESEND_API_KEY', 'MAIL_FROM', 'PANEL_URL']) {
    guardado[k] = process.env[k]; delete process.env[k];
  }
  for (const [k, v] of Object.entries(entorno)) { if (!(k in guardado)) guardado[k] = process.env[k]; process.env[k] = v; }
  // Evita que variables reales del equipo contaminen las pruebas.
  for (const k of ['STRIPE_PRICE_MENSUAL', 'STRIPE_PRICE_ANUAL', 'FIREBASE_SERVICE_ACCOUNT', 'BUNNY_STREAM_LIBRARY_ID']) {
    guardado[k] = process.env[k]; delete process.env[k];
  }

  const db = new FakeFirestore(seed);
  const mapaSuscripciones = new Map(suscripciones.map(s => [s.id, { ...s }]));
  const registro = { sesionesCreadas: [], actualizaciones: [], cupones: new Map(), codigos: new Map(), sesionesLeibles: new Map() };

  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => ts(Date.now()) };
  firestore.Timestamp = FakeTimestamp;
  firestore.FieldPath = { documentId: () => NOMBRE_DOC };

  const registroAuth = { getUser: 0, getUsers: 0, enlaces: [], actualizaciones: [], borrados: [], creados: [] };
  const usuarioAuth = uid => {
    const u = usuariosAuth[uid];
    if (!u) return null;
    const creacion = u.creationTime === undefined ? new Date().toUTCString() : u.creationTime;
    return {
      uid, emailVerified: u.emailVerified === true, metadata: { creationTime: creacion },
      email: u.email, displayName: u.displayName, providerData: u.providerData || []
    };
  };

  const admin = {
    apps: [],
    credential: { cert: v => v },
    initializeApp() {},
    firestore,
    auth: () => ({
      verifyIdToken: async token => {
        if (!tokens[token]) throw new Error('token inválido');
        return tokens[token];
      },
      getUser: async uid => {
        registroAuth.getUser++;
        const u = usuarioAuth(uid);
        if (!u) throw Object.assign(new Error('There is no user record'), { code: 'auth/user-not-found' });
        return u;
      },
      updateUser: async (uid, cambios) => { registroAuth.actualizaciones.push({ uid, cambios }); return { uid }; },
      deleteUser: async uid => {
        if (!usuariosAuth[uid]) throw Object.assign(new Error('There is no user record'), { code: 'auth/user-not-found' });
        registroAuth.borrados.push(uid);
        delete usuariosAuth[uid];
      },
      createUser: async datos => {
        if (usuariosAuth[datos.uid]) throw Object.assign(new Error('uid exists'), { code: 'auth/uid-already-exists' });
        if (Object.values(usuariosAuth).some(u => u.email && datos.email && u.email.toLowerCase() === datos.email.toLowerCase())) {
          throw Object.assign(new Error('email exists'), { code: 'auth/email-already-exists' });
        }
        registroAuth.creados.push(datos);
        usuariosAuth[datos.uid] = { emailVerified: datos.emailVerified === true, email: datos.email, displayName: datos.displayName };
        return { uid: datos.uid };
      },
      generateEmailVerificationLink: async (email, opciones) => {
        registroAuth.enlaces.push({ email, opciones });
        return 'https://club-zoorigen.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=CODIGO-PRUEBA&apiKey=x&lang=es';
      },
      getUsers: async identificadores => {
        registroAuth.getUsers++;
        const users = []; const notFound = [];
        for (const { uid } of identificadores) { const u = usuarioAuth(uid); if (u) users.push(u); else notFound.push({ uid }); }
        return { users, notFound };
      }
    })
  };

  const noExiste = id => Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing' });
  const stripe = {
    webhooks: {
      constructEvent: (body, firma) => {
        if (firma !== 'firma-valida') throw new Error('No signatures found matching the expected signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      }
    },
    checkout: { sessions: {
      create: async config => {
        if (registro.rechazarCupones && config.discounts) throw Object.assign(new Error('That promotion code has expired'), { code: 'promotion_code_expired' });
        registro.sesionesCreadas.push(config);
        return { id: 'cs_test', url: 'https://checkout.stripe.test/pay', client_secret: 'cs_secret_test' };
      },
      // Para el webhook: registro.sesionesLeibles.set('cs_1', { total_details: {...} })
      retrieve: async id => registro.sesionesLeibles.get(id) || { id, total_details: { amount_discount: 0, breakdown: { discounts: [] } } }
    } },
    // Recordatorios de pago: precio mensual, cupones base y códigos promocionales (en memoria)
    // Solo con precios: true (recordatorios de pago); sin él, Stripe «no responde» y el panel muestra el precio de lista, como siempre
    prices: { retrieve: async id => { if (!precios) throw new Error('Stripe sin conexión (prueba)'); return { id, unit_amount: 19900, currency: 'mxn', product: 'prod_mensual' }; } },
    coupons: {
      retrieve: async id => { if (!registro.cupones.has(id)) throw noExiste(id); return { ...registro.cupones.get(id) }; },
      create: async datos => { registro.cupones.set(datos.id, { ...datos }); return { ...datos }; }
    },
    promotionCodes: {
      create: async datos => {
        if ([...registro.codigos.values()].some(c => c.code === datos.code)) throw new Error('Promotion code already exists');
        const promo = { id: 'promo_' + (registro.codigos.size + 1), active: true, times_redeemed: 0, ...datos };
        registro.codigos.set(promo.id, promo);
        return { ...promo };
      },
      retrieve: async id => { if (!registro.codigos.has(id)) throw noExiste(id); return { ...registro.codigos.get(id) }; }
    },
    subscriptions: {
      retrieve: async id => {
        if (!mapaSuscripciones.has(id)) throw noExiste(id);
        return { ...mapaSuscripciones.get(id) };
      },
      update: async (id, cambios) => {
        if (!mapaSuscripciones.has(id)) throw noExiste(id);
        registro.actualizaciones.push({ id, cambios });
        const actual = { ...mapaSuscripciones.get(id), ...cambios };
        mapaSuscripciones.set(id, actual);
        return { ...actual };
      }
    }
  };

  let app;
  try {
    app = proxyquire('../../server.js', {
      stripe: () => stripe,
      'firebase-admin': admin
    });
  } finally {
    for (const [k, v] of Object.entries(guardado)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { app, db, registro, stripe, suscripciones: mapaSuscripciones, usuariosAuth, registroAuth };
}

module.exports = {
  cargarServidor, suscripcion, ts, dias, unix,
  PRICE_MENSUAL, PRICE_ANUAL, VIDEO_GRATIS, VIDEO_PREMIUM
};
