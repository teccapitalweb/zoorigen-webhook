// ═══════════════════════════════════════════════════════════
// WEBHOOK STRIPE — Club VIP Zoorigen
// Railway: zoorigen-webhook (reemplaza webhook Shopify)
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const bunnyCatalog = require('./data/zoorigen-bunny-catalog.json');
const pruebaGratuita = require('./services/prueba-gratuita');
const { montarRutasClub } = require('./services/rutas-club');
const { montarRutasNoticias } = require('./services/rutas-noticias');
const { iniciarProgramador } = require('./services/tarea-diaria');
const { montarRutasMateriales } = require('./services/rutas-materiales');
const { montarRutasRegistro } = require('./services/rutas-registro');
const { montarRutasAuth } = require('./services/rutas-auth');
const { montarRutasCertificados } = require('./services/rutas-certificados');
const { montarRutasPublico } = require('./services/rutas-publico');
const { montarRutasAdmin } = require('./services/rutas-admin');
const bitacoraMemoria = require('./services/bitacora-memoria');
const libros = require('./services/libros');
const materiales = require('./services/materiales');

// Guarda en memoria los últimos console.error para el panel de administración (Estado del sistema).
bitacoraMemoria.instalar();

// ── Config ──────────────────────────────────────────────
const rawKey = (process.env.STRIPE_SECRET_KEY || '').trim().replace(/^["']|["']$/g, '');
const stripe = Stripe(rawKey);
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim().replace(/^["']|["']$/g, '');
const PORT = process.env.PORT || 3000;
const STRIPE_PRICES = Object.freeze({
  mensual: String(process.env.STRIPE_PRICE_MENSUAL || 'price_1TRcJnA7If2CqXs9dMBGRmDF').trim(),
  anual: String(process.env.STRIPE_PRICE_ANUAL || 'price_1TRcJlA7If2CqXs97WQNmKFq').trim(),
});
// Llave con la que el servidor firma (HMAC) y verifica los certificados. Debe ser larga, al azar y ESTABLE: si cambia,
// los certificados ya emitidos dejan de validar. Si falta, el servidor arranca igual pero no emite ni verifica certificados.
const CERTIFICATE_SIGNING_KEY = (process.env.CERTIFICATE_SIGNING_KEY || '').trim().replace(/^["']|["']$/g, '');
// Fecha ISO: las cuentas de Firebase Auth creadas ANTES de ella importan una sola vez su progreso viejo (miembros.courseProgress).
const LEGACY_PROGRESS_IMPORT_BEFORE = (process.env.LEGACY_PROGRESS_IMPORT_BEFORE || '').trim().replace(/^["']|["']$/g, '');
// Fecha ISO: los certificados anteriores (escritos por el navegador, sin firma) solo se aceptan si se emitieron hasta ella.
// Sin definir = modo transición (sin límite de fecha). Definirla después de publicar las reglas de Firestore que impiden
// que el navegador escriba `certificados`.
const CERTIFICADOS_ANTERIORES_HASTA = (process.env.CERTIFICADOS_ANTERIORES_HASTA || '').trim().replace(/^["']|["']$/g, '');
const BUNNY_STREAM_LIBRARY_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || '731751').trim();
const BUNNY_TOKEN_AUTH_KEY = (process.env.BUNNY_TOKEN_AUTH_KEY || '').trim().replace(/^["']|["']$/g, '');
// Clave de GESTIÓN de Bunny Stream (solo lectura del catálogo). Es distinta de BUNNY_TOKEN_AUTH_KEY,
// que solo firma los reproductores. Si falta, el resto del servidor funciona igual.
const BUNNY_API_KEY = (process.env.BUNNY_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const BUNNY_TOKEN_TTL_SECONDS = Math.min(900, Math.max(60, Number(process.env.BUNNY_TOKEN_TTL_SECONDS) || 300));
const BUNNY_VIDEO_IDS = new Set(
  bunnyCatalog.flatMap(course => (course.lecciones || []).map(lesson => String(lesson.videoId || ''))).filter(Boolean)
);
// Única clase gratuita de toda la plataforma: primera clase del primer curso.
const BUNNY_FREE_VIDEO_IDS = new Set(['befd1641-850a-4099-88a8-047a1badc703']);
// Los videos que el panel admin agrega a los cursos (colección `cursos` de Firestore)
// se suman al catálogo estático. Solo se lee; nunca se escribe.
const VIDEO_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDICE_VIDEOS_TTL_MS = 60 * 1000;          // vigencia del caché del índice
const INDICE_VIDEOS_REFRESCO_MIN_MS = 10 * 1000; // mínimo entre lecturas a Firestore

// Firebase Admin — usa FIREBASE_SERVICE_ACCOUNT (JSON completo)
if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    credential = admin.credential.cert(serviceAccount);
  } else {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || 'club-zoorigen',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }
  admin.initializeApp({ credential });
}
const db = admin.firestore();
const auth = admin.auth();

const app = express();

// ── CORS para el frontend ──
app.use(cors());

function unixComoTimestamp(valor) {
  const segundos = Number(valor);
  return Number.isFinite(segundos) && segundos > 0
    ? admin.firestore.Timestamp.fromMillis(segundos * 1000)
    : null;
}

function idDeReferencia(valor) {
  return typeof valor === 'string' ? valor : (valor && valor.id) || null;
}

function subscriptionIdDeInvoice(invoice = {}) {
  return idDeReferencia(invoice.subscription) ||
    idDeReferencia(invoice.parent?.subscription_details?.subscription);
}

function periodoFinDeSubscription(subscription = {}) {
  return unixComoTimestamp(subscription.current_period_end) ||
    unixComoTimestamp(subscription.items?.data?.[0]?.current_period_end) ||
    unixComoTimestamp(subscription.cancel_at) ||
    unixComoTimestamp(subscription.ended_at);
}

function planDeSubscription(subscription = {}, fallback = 'mensual') {
  const priceId = idDeReferencia(subscription.items?.data?.[0]?.price);
  if (priceId === STRIPE_PRICES.anual) return 'anual';
  if (priceId === STRIPE_PRICES.mensual) return 'mensual';
  return subscription.metadata?.planType === 'anual' ? 'anual' : fallback;
}

function estadoDeSubscription(subscription = {}) {
  const planVence = periodoFinDeSubscription(subscription);
  const vigente = planVence && planVence.toMillis() > Date.now();
  const cobrando = subscription.status === 'active' || subscription.status === 'trialing';
  if (cobrando && vigente && subscription.cancel_at_period_end) return 'cancelled_active';
  if (cobrando && vigente) return 'active';
  if (subscription.status === 'past_due' || subscription.status === 'unpaid' || subscription.status === 'incomplete') return 'past_due';
  return 'expired';
}

function subscriptionPerteneceAUid(subscription = {}, firebaseUID) {
  const uidMetadata = subscription.metadata?.firebaseUID;
  return !uidMetadata || uidMetadata === firebaseUID;
}

async function buscarUidPorSubscription(subscriptionId) {
  for (const collectionName of ['miembros', 'usuarios']) {
    const snapshot = await db.collection(collectionName)
      .where('stripeSubscriptionId', '==', subscriptionId)
      .limit(1)
      .get();
    if (!snapshot.empty) return snapshot.docs[0].id;
  }
  return null;
}

async function sincronizarSubscription(firebaseUID, subscription, options = {}) {
  if (!firebaseUID) throw new Error('No se encontró el UID de Firebase para la suscripción');
  const subscriptionId = idDeReferencia(subscription);
  const customerId = idDeReferencia(subscription.customer);
  const planTipo = planDeSubscription(subscription, options.planType || 'mensual');
  const planVence = periodoFinDeSubscription(subscription);
  const planStatus = estadoDeSubscription(subscription);
  const planActivo = planStatus === 'active' || planStatus === 'cancelled_active';
  const planCancelado = planStatus === 'cancelled_active' || planStatus === 'expired';
  const pagoConfirmado = options.pagoConfirmado === true;

  const miembro = {
    planActivo,
    planCancelado,
    planTipo,
    planStatus,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: subscription.status || null,
    actualizadoDesdeStripe: admin.firestore.FieldValue.serverTimestamp(),
  };
  const usuario = {
    planActivo,
    planCancelado,
    tipoPlan: planTipo,
    planStatus,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: subscription.status || null,
    actualizadoDesdeStripe: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (planVence) {
    miembro.planVence = planVence;
    usuario.fechaExpiracion = planVence;
  }
  if (options.email) {
    miembro.email = options.email;
    usuario.email = options.email;
  }
  if (options.nuevaSuscripcion) {
    miembro.planInicio = admin.firestore.FieldValue.serverTimestamp();
    usuario.fechaActivacion = admin.firestore.FieldValue.serverTimestamp();
  }
  if (pagoConfirmado) {
    miembro.ultimoPago = admin.firestore.FieldValue.serverTimestamp();
    usuario.ultimoPago = admin.firestore.FieldValue.serverTimestamp();
  }

  const batch = db.batch();
  batch.set(db.collection('miembros').doc(firebaseUID), miembro, { merge: true });
  batch.set(db.collection('usuarios').doc(firebaseUID), usuario, { merge: true });
  await batch.commit();
  return { planStatus, planActivo, planVence };
}

// ── Administradores ──
// Quién administra se decide SOLO en el servidor, nunca con datos que mande el navegador:
//   1) ADMIN_EMAILS (variable de entorno, correos separados por comas): la cuenta debe iniciar sesión con ese correo y
//      el correo debe estar VERIFICADO por Firebase (token.email_verified === true; Google ya viene verificado).
//   2) Un documento admins/{uid} o miembros/{uid}.role === 'admin' fijado a mano en Firestore (como siempre).
// Al entrar una cuenta de ADMIN_EMAILS, el servidor marca miembros/{uid}.role = 'admin' y adminOrigen = 'ADMIN_EMAILS'
// (con el Admin SDK) para que las reglas de Firestore y el club la reconozcan; si el correo sale de la lista, la
// siguiente petición a la administración le quita esa marca. Una marca puesta a mano (sin adminOrigen) no se toca.
function correosAdministrador() {
  return new Set(String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

function esAdminPorCorreo(decoded) {
  if (!decoded || decoded.email_verified !== true || typeof decoded.email !== 'string') return false;
  return correosAdministrador().has(decoded.email.trim().toLowerCase());
}

// Regla de administrador (compartida): existe admins/{uid}, miembros/{uid}.role === 'admin' o el token es de ADMIN_EMAILS.
function esAdminPorDocumentos(adminDoc, miembroDoc, decoded) {
  return Boolean(adminDoc.exists || miembroDoc.data()?.role === 'admin' || esAdminPorCorreo(decoded));
}

const SINCRONIZACION_ADMIN_MS = 5 * 60 * 1000;
const adminsSincronizados = new Map(); // uid -> último momento en que se sincronizó por ADMIN_EMAILS

// Pone (o quita) la marca de administrador en miembros/{uid} según ADMIN_EMAILS. Nunca lanza.
async function sincronizarAdminPorCorreo(decoded, { forzar = false } = {}) {
  try {
    const uid = decoded.uid;
    const porCorreo = esAdminPorCorreo(decoded);
    if (!porCorreo && !adminsSincronizados.has(uid) && !forzar) return { admin: false, cambio: false };
    const ahora = Date.now();
    if (porCorreo && !forzar && ahora - (adminsSincronizados.get(uid) || 0) < SINCRONIZACION_ADMIN_MS) return { admin: true, cambio: false };
    const ref = db.collection('miembros').doc(uid);
    const snap = await ref.get();
    const m = snap.exists ? (snap.data() || {}) : {};
    if (porCorreo) {
      adminsSincronizados.set(uid, ahora);
      if (!snap.exists || m.role === 'admin') return { admin: true, cambio: false, sincronizado: snap.exists };
      await ref.set({ role: 'admin', adminOrigen: 'ADMIN_EMAILS' }, { merge: true });
      return { admin: true, cambio: true, sincronizado: true };
    }
    adminsSincronizados.delete(uid);
    if (snap.exists && m.role === 'admin' && m.adminOrigen === 'ADMIN_EMAILS') {
      await ref.set({ role: 'member', adminOrigen: typeof admin.firestore.FieldValue.delete === 'function' ? admin.firestore.FieldValue.delete() : null }, { merge: true });
      return { admin: false, cambio: true };
    }
    return { admin: false, cambio: false };
  } catch (error) {
    console.error('[Admin] No se pudo sincronizar la marca de administrador:', error.message);
    return { admin: esAdminPorCorreo(decoded), cambio: false };
  }
}

async function autenticarFirebase(req, res) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Sesión requerida' });
    return null;
  }
  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1]);
  } catch (_) {
    res.status(401).json({ error: 'Sesión inválida o vencida' });
    return null;
  }
  // Quien inicia sesión con un correo de ADMIN_EMAILS queda marcado como administrador en Firestore (una vez cada 5 min).
  if (esAdminPorCorreo(decoded) || adminsSincronizados.has(decoded.uid)) await sincronizarAdminPorCorreo(decoded);
  return decoded;
}

// Exige sesión de Firebase y que sea administrador. Responde 401/403/500 y devuelve null si no pasa.
async function autenticarAdmin(req, res) {
  const decoded = await autenticarFirebase(req, res);
  if (!decoded) return null;
  try {
    const [adminDoc, miembroDoc] = await Promise.all([
      db.collection('admins').doc(decoded.uid).get(),
      db.collection('miembros').doc(decoded.uid).get()
    ]);
    // Una marca de administrador puesta por ADMIN_EMAILS deja de valer si el correo ya no está en la lista.
    const m = miembroDoc.data() || {};
    if (m.role === 'admin' && m.adminOrigen === 'ADMIN_EMAILS' && !esAdminPorCorreo(decoded)) {
      await sincronizarAdminPorCorreo(decoded, { forzar: true });
      res.status(403).json({ error: 'Solo los administradores pueden hacer esto' });
      return null;
    }
    if (!esAdminPorDocumentos(adminDoc, miembroDoc, decoded)) {
      res.status(403).json({ error: 'Solo los administradores pueden hacer esto' });
      return null;
    }
    return decoded;
  } catch (error) {
    console.error('[Admin] No se pudo verificar el permiso:', error.message);
    res.status(500).json({ error: 'No se pudo verificar el permiso de administrador' });
    return null;
  }
}

// ── STRIPE WEBHOOK (necesita body RAW para verificar firma) ──
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  // Verificar firma del webhook
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Firma inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`✅ Evento recibido: ${event.type}`);

  try {
    switch (event.type) {
      // ── PAGO EXITOSO → Activar plan ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const firebaseUID = session.metadata?.firebaseUID;
        const email = session.customer_email || session.customer_details?.email;
        const planType = session.metadata?.planType || 'mensual';
        const subscriptionId = idDeReferencia(session.subscription);
        if (!firebaseUID || !subscriptionId) throw new Error('Checkout sin firebaseUID o subscriptionId');
        if (session.payment_status !== 'paid') {
          console.warn(`Pago no confirmado para checkout ${session.id}: ${session.payment_status}`);
          break;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const resultado = await sincronizarSubscription(firebaseUID, subscription, {
          email,
          planType,
          nuevaSuscripcion: true,
          pagoConfirmado: true,
        });
        if (!resultado.planActivo) throw new Error(`La suscripción ${subscriptionId} no quedó activa (${subscription.status})`);
        console.log(`🎉 Plan ${planType} activado para ${firebaseUID}`);
        break;
      }

      // ── RENOVACIÓN AUTOMÁTICA ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = subscriptionIdDeInvoice(invoice);
        if (!subscriptionId || invoice.billing_reason === 'subscription_create') break;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const firebaseUID = subscription.metadata?.firebaseUID || await buscarUidPorSubscription(subscriptionId);
        if (!firebaseUID) throw new Error(`No se encontró miembro para la suscripción ${subscriptionId}`);
        await sincronizarSubscription(firebaseUID, subscription, { pagoConfirmado: true });
        console.log(`🔄 Renovación exitosa para ${firebaseUID}`);
        break;
      }

      // ── PAGO FALLIDO → suspender hasta que Stripe confirme un cobro ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = subscriptionIdDeInvoice(invoice);
        if (!subscriptionId) break;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const firebaseUID = subscription.metadata?.firebaseUID || await buscarUidPorSubscription(subscriptionId);
        if (!firebaseUID) throw new Error(`No se encontró miembro para el pago fallido ${subscriptionId}`);
        await sincronizarSubscription(firebaseUID, { ...subscription, status: 'past_due' });
        console.log(`⚠️ Membresía suspendida por pago fallido para ${firebaseUID}`);
        break;
      }

      // ── CAMBIO DE ESTADO / CANCELACIÓN AL FINAL DEL PERIODO ──
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const firebaseUID = subscription.metadata?.firebaseUID || await buscarUidPorSubscription(subscription.id);
        if (!firebaseUID) throw new Error(`No se encontró miembro para la suscripción ${subscription.id}`);
        await sincronizarSubscription(firebaseUID, subscription);
        console.log(`🔁 Suscripción sincronizada para ${firebaseUID}: ${subscription.status}`);
        break;
      }

      // ── CANCELACIÓN DEFINITIVA ──
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const firebaseUID = subscription.metadata?.firebaseUID || await buscarUidPorSubscription(subscription.id);
        if (!firebaseUID) throw new Error(`No se encontró miembro para cancelar ${subscription.id}`);
        await sincronizarSubscription(firebaseUID, { ...subscription, status: 'canceled' });
        await Promise.all([
          db.collection('miembros').doc(firebaseUID).set({ canceladoEn: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }),
          db.collection('usuarios').doc(firebaseUID).set({ fechaCancelacion: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }),
        ]);
        console.log(`🚫 Suscripción cancelada para ${firebaseUID}`);
        break;
      }

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
    }
  } catch (error) {
    console.error('❌ Error procesando evento:', error);
    // Stripe reintentará el webhook. Nunca confirmar un evento que no se guardó.
    return res.status(500).json({ received: false });
  }

  return res.json({ received: true });
});

// ── Endpoint para crear Checkout Session (redirect o embedded) ──
app.post('/create-checkout-session', express.json(), async (req, res) => {
  try {
    const decoded = await autenticarFirebase(req, res);
    if (!decoded) return;
    const { embedded } = req.body;
    const planType = req.body.planType === 'anual' ? 'anual' : 'mensual';
    const priceId = STRIPE_PRICES[planType];
    const firebaseUID = decoded.uid;
    const email = decoded.email;
    if (!email) return res.status(400).json({ error: 'Tu cuenta no tiene correo electrónico' });

    // Evita cobros duplicados cuando ya hay una suscripción vigente en Stripe.
    const miembroDoc = await db.collection('miembros').doc(firebaseUID).get();
    const subscriptionIdActual = miembroDoc.data()?.stripeSubscriptionId;
    if (subscriptionIdActual) {
      try {
        const actual = await stripe.subscriptions.retrieve(subscriptionIdActual);
        if (!subscriptionPerteneceAUid(actual, firebaseUID)) {
          return res.status(403).json({ error: 'La suscripción guardada no pertenece a esta cuenta' });
        }
        if (estadoDeSubscription(actual) === 'active' || estadoDeSubscription(actual) === 'cancelled_active') {
          return res.status(409).json({ error: 'Ya tienes una membresía vigente; no se generó otro cobro.' });
        }
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
        // Las referencias del sistema anterior no existen en la cuenta Stripe actual.
      }
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      // Muestra «Agregar código» en el formulario de pago (los códigos se crean en el panel de Stripe).
      allow_promotion_codes: true,
      // Desactiva Stripe Link (pago directo con tarjeta, sin verificación por teléfono)
      wallet_options: { link: { display: 'never' } },
      metadata: {
        firebaseUID: firebaseUID,
        planType,
      },
      subscription_data: {
        metadata: { firebaseUID, planType },
      },
    };

    if (embedded) {
      // Embedded Checkout — formulario dentro de la página
      sessionConfig.ui_mode = 'embedded';
      sessionConfig.return_url = 'https://www.zoorigen.com/pages/club-gracias.html?session_id={CHECKOUT_SESSION_ID}';
    } else {
      // Redirect Checkout — redirige a Stripe
      sessionConfig.success_url = 'https://www.zoorigen.com/pages/club-gracias.html?session_id={CHECKOUT_SESSION_ID}';
      sessionConfig.cancel_url = 'https://www.zoorigen.com/pages/club-suscripcion.html?cancelado=true';
    }

    const session = await stripe.checkout.sessions.create(sessionConfig, { apiVersion: '2025-04-30.basil' });

    if (embedded) {
      res.json({ clientSecret: session.client_secret });
    } else {
      res.json({ url: session.url });
    }
  } catch (error) {
    console.error('❌ Error creando sesión:', error);
    res.status(500).json({ error: error.message });
  }
});

function fechaComoDate(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (valor._seconds) return new Date(valor._seconds * 1000);
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function tieneAccesoVigente(data = {}) {
  const vence = fechaComoDate(data.planVence || data.fechaExpiracion);
  const noHaVencido = Boolean(vence && vence.getTime() > Date.now());
  if (['past_due', 'unpaid', 'incomplete', 'expired', 'pending_payment'].includes(data.planStatus)) return false;
  // 'cancelled' lo escribía el servidor anterior (Shopify): el miembro conserva el
  // acceso hasta planVence. Es la misma regla que calculateStatus() en club.js.
  if (data.planStatus === 'cancelled') return data.planActivo !== false && noHaVencido;
  if (data.planStatus === 'cancelled_active') return Boolean(vence && noHaVencido);
  if (data.planStatus === 'active') return noHaVencido;
  return data.planActivo === true && noHaVencido;
}

// ── Índice de videos desde Firestore (caché en memoria) ──
// conocidos: videoId de cualquier lección de `cursos`.
// gratis: videoId de lecciones con gratis === true dentro de un curso con cursoMuestraGratis === true.
// cursos: por cada curso, la lista ORDENADA de videoIds y qué clases libera la prueba gratuita
//   (ver services/prueba-gratuita.js). elegibles / porDefectoId salen de ese mapa.
let indiceVideos = null;         // último índice leído con éxito: { conocidos, gratis, cursos, ..., cargadoEn }
let ultimaLecturaVideos = 0;     // momento del último intento de lectura (éxito o fallo)
let lecturaVideosEnCurso = null; // evita lecturas simultáneas duplicadas

function indiceVacio() {
  return { conocidos: new Set(), gratis: new Set(), cursos: new Map(), datos: new Map(), elegibles: [], porDefectoId: null, cargadoEn: 0 };
}

async function leerIndiceVideosDeFirestore() {
  const snapshot = await db.collection('cursos').get();
  const conocidos = new Set();
  const gratis = new Set();
  const cursos = new Map();
  const datos = new Map(); // datos básicos de cada curso (logros y premios)
  for (const doc of snapshot.docs) {
    const curso = doc.data() || {};
    cursos.set(doc.id, pruebaGratuita.resumirCurso(curso, id => BUNNY_FREE_VIDEO_IDS.has(id)));
    datos.set(doc.id, {
      area: typeof curso.area === 'string' ? curso.area.trim().slice(0, 80) : '',
      disponibleSiempre: curso.disponibleSiempre === true,
      cursoMuestraGratis: curso.cursoMuestraGratis === true
    });
    if (!Array.isArray(curso.lecciones)) continue;
    for (const leccion of curso.lecciones) {
      const id = leccion && typeof leccion.videoId === 'string' ? leccion.videoId.trim() : '';
      if (!VIDEO_ID_REGEX.test(id)) continue;
      conocidos.add(id);
      // Una lección gratis solo cuenta si el curso permite muestra gratis.
      if (curso.cursoMuestraGratis === true && leccion.gratis === true) gratis.add(id);
    }
  }
  const { elegibles, porDefectoId } = pruebaGratuita.resumenDeCursos(cursos, id => BUNNY_FREE_VIDEO_IDS.has(id));
  return { conocidos, gratis, cursos, datos, elegibles, porDefectoId, cargadoEn: Date.now() };
}

// Devuelve siempre un índice (vacío si Firestore nunca respondió): jamás lanza, para que un
// fallo de Firestore deje funcionando solo los conjuntos estáticos, como antes.
// `forzar` pide refrescar aunque el caché sea reciente, pero respetando el mínimo entre lecturas.
async function obtenerIndiceVideos({ forzar = false } = {}) {
  const ahora = Date.now();
  const vigente = indiceVideos && ahora - indiceVideos.cargadoEn < INDICE_VIDEOS_TTL_MS;
  if (vigente && !forzar) return indiceVideos;
  if (lecturaVideosEnCurso) return lecturaVideosEnCurso;
  // Tope de lecturas: ráfagas de IDs falsos o una caída de Firestore no generan lectura por petición.
  if (ahora - ultimaLecturaVideos < INDICE_VIDEOS_REFRESCO_MIN_MS) return indiceVideos || indiceVacio();
  ultimaLecturaVideos = ahora;
  lecturaVideosEnCurso = leerIndiceVideosDeFirestore()
    .then(indice => { indiceVideos = indice; return indice; })
    .catch(error => {
      console.error('[Bunny embed-token] No se pudo leer el índice de videos de Firestore:', error);
      return indiceVideos || indiceVacio();
    })
    .finally(() => { lecturaVideosEnCurso = null; });
  return lecturaVideosEnCurso;
}

async function videoEsConocido(videoId) {
  if (BUNNY_VIDEO_IDS.has(videoId)) return true;
  if ((await obtenerIndiceVideos()).conocidos.has(videoId)) return true;
  // Puede ser un video recién agregado: un refresco (limitado) antes de decir que no existe.
  return (await obtenerIndiceVideos({ forzar: true })).conocidos.has(videoId);
}

// `incluirFija: false` quita solo el video gratis fijo de siempre (para quien debe elegir su prueba
// o ya eligió); las clases marcadas gratis desde el panel no cambian.
async function videoEsGratis(videoId, { refrescar = false, incluirFija = true } = {}) {
  if (incluirFija && BUNNY_FREE_VIDEO_IDS.has(videoId)) return true;
  if ((await obtenerIndiceVideos()).gratis.has(videoId)) return true;
  if (!refrescar) return false;
  return (await obtenerIndiceVideos({ forzar: true })).gratis.has(videoId);
}

// ── Prueba gratuita: un curso a elección ──
// Quien nunca ha pagado elige UN curso; todas sus clases menos la última son gratis. La elección
// vive en `pruebasGratuitas/{uid}`, una colección que solo escribe este servidor (las reglas de
// Firestore niegan lo que no listan, así que el navegador no puede crearla ni cambiarla).
// Las reglas puras están en services/prueba-gratuita.js.
function errorHttp(status, mensaje) {
  return Object.assign(new Error(mensaje), { status });
}

// Mismo cálculo de siempre: acceso vigente en `miembros` o en el documento legado `usuarios`.
function tienePlanVigente(miembroDoc, usuarioDoc) {
  return Boolean((miembroDoc.exists && tieneAccesoVigente(miembroDoc.data())) ||
    (usuarioDoc.exists && tieneAccesoVigente(usuarioDoc.data())));
}

async function leerEleccionPrueba(uid) {
  const snap = await db.collection('pruebasGratuitas').doc(uid).get();
  const cursoId = snap.exists && snap.data() ? snap.data().cursoId : null;
  return typeof cursoId === 'string' && cursoId ? cursoId : null;
}

// Para quien NO es admin ni tiene plan: ¿la prueba le abre este video?, ¿se le quita la clase gratis fija?
// Si algo falla aquí no se concede nada extra y todo queda como antes de la prueba.
async function reglasPruebaParaVideo(uid, videoId, miembroDoc, usuarioDoc) {
  try {
    const eleccion = await leerEleccionPrueba(uid);
    if (eleccion) {
      let curso = (await obtenerIndiceVideos()).cursos.get(eleccion);
      if (!curso) curso = (await obtenerIndiceVideos({ forzar: true })).cursos.get(eleccion);
      // La clase fija deja de ser gratis desde que elige; solo se abren las clases 1..n-1 de SU curso.
      return { permite: Boolean(curso && curso.gratisPrueba.has(videoId)), quitaClaseFija: true };
    }
    const miembro = miembroDoc.exists ? miembroDoc.data() : null;
    if (pruebaGratuita.nuncaHaTenidoPlan(miembro, usuarioDoc.exists ? usuarioDoc.data() : null)) {
      // Todavía debe elegir: la clase fija ya no es gratis (si hay cursos que pueda elegir).
      const indice = await obtenerIndiceVideos();
      return { permite: false, quitaClaseFija: indice.elegibles.length > 0 };
    }
  } catch (error) {
    console.error('[Prueba gratuita] No se pudo evaluar la prueba; queda como antes:', error);
  }
  return { permite: false, quitaClaseFija: false };
}

async function estadoPruebaGratuita(uid, indice) {
  const [adminDoc, miembroDoc, usuarioDoc, eleccion] = await Promise.all([
    db.collection('admins').doc(uid).get(),
    db.collection('miembros').doc(uid).get(),
    db.collection('usuarios').doc(uid).get(),
    leerEleccionPrueba(uid)
  ]);
  return pruebaGratuita.evaluarPruebaGratuita({
    miembro: miembroDoc.exists ? miembroDoc.data() : null,
    usuario: usuarioDoc.exists ? usuarioDoc.data() : null,
    esAdmin: esAdminPorDocumentos(adminDoc, miembroDoc),
    tienePlan: tienePlanVigente(miembroDoc, usuarioDoc),
    eleccion,
    cursosElegibles: indice.elegibles
  });
}

app.get('/api/prueba-gratuita', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const decoded = await autenticarFirebase(req, res);
    if (!decoded) return;
    const indice = await obtenerIndiceVideos();
    const estado = await estadoPruebaGratuita(decoded.uid, indice);
    return res.json({
      elegible: estado.elegible,
      elegida: estado.elegida,
      motivo: estado.motivo,
      cursosElegibles: estado.elegible ? indice.elegibles : [],
      cursoPorDefectoId: indice.porDefectoId
    });
  } catch (error) {
    console.error('[Prueba gratuita] consulta:', error);
    return res.status(500).json({ error: 'No se pudo consultar tu prueba gratuita' });
  }
});

app.post('/api/prueba-gratuita', express.json(), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const decoded = await autenticarFirebase(req, res);
    if (!decoded) return;
    const cursoId = typeof req.body?.cursoId === 'string' ? req.body.cursoId.trim() : '';
    if (!cursoId) return res.status(400).json({ error: 'Falta el curso que quieres elegir' });

    // Al elegir se pide un índice fresco (limitado a una lectura cada 10 s) para no aceptar un curso ya retirado.
    const indice = await obtenerIndiceVideos({ forzar: true });
    if (!indice.cargadoEn) {
      return res.status(503).json({ error: 'No pudimos cargar los cursos. Intenta de nuevo en un momento' });
    }
    const estado = await estadoPruebaGratuita(decoded.uid, indice);
    if (!estado.elegible) {
      return res.status(estado.codigo === 'ya-elegida' ? 409 : 403).json({ error: estado.motivo });
    }
    if (!indice.elegibles.includes(cursoId)) {
      return res.status(400).json({ error: 'Ese curso no se puede elegir como prueba gratuita' });
    }

    // Transacción: si dos solicitudes llegan a la vez, solo la primera guarda; la otra ve la elección y recibe 409.
    const ref = db.collection('pruebasGratuitas').doc(decoded.uid);
    await db.runTransaction(async tx => {
      const actual = await tx.get(ref);
      if (actual.exists) throw errorHttp(409, pruebaGratuita.MOTIVOS_PRUEBA['ya-elegida']);
      tx.set(ref, { uid: decoded.uid, cursoId, elegidoEn: admin.firestore.FieldValue.serverTimestamp() });
    });
    return res.json({ ok: true, cursoId });
  } catch (error) {
    if (error && error.status) return res.status(error.status).json({ error: error.message });
    console.error('[Prueba gratuita] elección:', error);
    return res.status(500).json({ error: 'No se pudo guardar tu prueba gratuita' });
  }
});

// Reproductor privado: el navegador nunca recibe la clave secreta de Bunny.
app.post('/api/bunny/embed-token', express.json(), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!BUNNY_TOKEN_AUTH_KEY || !BUNNY_STREAM_LIBRARY_ID) {
      return res.status(503).json({ error: 'Bunny Stream no está configurado en Railway' });
    }

    const videoId = String(req.body?.videoId || '').trim();
    if (!VIDEO_ID_REGEX.test(videoId) || !(await videoEsConocido(videoId))) {
      return res.status(404).json({ error: 'Video no reconocido en el catálogo de Zoorigen' });
    }

    const authorization = String(req.headers.authorization || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Sesión requerida' });

    let decoded;
    try {
      decoded = await auth.verifyIdToken(match[1]);
    } catch (_) {
      return res.status(401).json({ error: 'Sesión inválida o vencida' });
    }

    const [adminDoc, miembroDoc, usuarioDoc] = await Promise.all([
      db.collection('admins').doc(decoded.uid).get(),
      db.collection('miembros').doc(decoded.uid).get(),
      db.collection('usuarios').doc(decoded.uid).get()
    ]);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc, decoded);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    const sinAcceso = !esAdmin && !tienePlan;
    // Prueba gratuita: solo se evalúa para quien no es admin ni tiene plan (a ellos no les cambia nada).
    const prueba = sinAcceso
      ? await reglasPruebaParaVideo(decoded.uid, videoId, miembroDoc, usuarioDoc)
      : { permite: false, quitaClaseFija: false };
    // A quien ya tiene acceso no le hace falta forzar un refresco solo para saber si es gratis.
    const esClaseGratis = prueba.permite ||
      await videoEsGratis(videoId, { refrescar: sinAcceso, incluirFija: !prueba.quitaClaseFija });

    if (!esClaseGratis && !esAdmin && !tienePlan) {
      return res.status(403).json({ error: 'Necesitas una membresía activa para ver esta clase' });
    }

    const expires = Math.floor(Date.now() / 1000) + BUNNY_TOKEN_TTL_SECONDS;
    const token = crypto
      .createHash('sha256')
      .update(BUNNY_TOKEN_AUTH_KEY + videoId + expires)
      .digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${videoId}?token=${token}&expires=${expires}`;

    return res.json({ embedUrl, expires, freePreview: esClaseGratis });
  } catch (error) {
    console.error('[Bunny embed-token]', error);
    return res.status(500).json({ error: 'No se pudo preparar la reproducción' });
  }
});

// ── ADMIN: catálogo de Bunny EN VIVO (solo lectura) ──
// Alimenta el botón "Sincronizar con Bunny" del panel: consulta las colecciones y videos de la
// librería con la clave de gestión (BUNNY_API_KEY) y devuelve solo los videos ya procesados.
// No escribe nada ni en Bunny ni en Firestore.
const BUNNY_API_BASE = 'https://video.bunnycdn.com/library';
const BUNNY_POR_PAGINA = 100;
const BUNNY_MAX_PAGINAS = 100;      // tope de seguridad contra un bucle infinito
const BUNNY_COLECCIONES_EN_PARALELO = 5;
const BUNNY_STATUS_TERMINADO = 4;

// Primer entero del título sin extensión ("Clase 03.mp4" -> 3); 0 si no hay.
function numeroDeClaseBunny(titulo) {
  const limpio = String(titulo || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const m = limpio.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// Quita la clave de cualquier texto antes de registrarlo en consola.
function sinClaveBunny(texto) {
  const t = String(texto || '');
  return BUNNY_API_KEY ? t.split(BUNNY_API_KEY).join('***') : t;
}

async function bunnyApiGet(ruta) {
  // globalThis.fetch se lee en cada llamada para poder simularlo en las pruebas.
  const r = await globalThis.fetch(`${BUNNY_API_BASE}/${encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)}${ruta}`, {
    headers: { AccessKey: BUNNY_API_KEY, accept: 'application/json' }
  });
  if (!r.ok) throw new Error(`Bunny respondió ${r.status} en ${ruta.split('?')[0]}`);
  return r.json();
}

async function bunnyListarTodo(ruta) {
  const items = [];
  for (let pagina = 1; pagina <= BUNNY_MAX_PAGINAS; pagina++) {
    const sep = ruta.includes('?') ? '&' : '?';
    const data = await bunnyApiGet(`${ruta}${sep}page=${pagina}&itemsPerPage=${BUNNY_POR_PAGINA}`);
    const lote = Array.isArray(data?.items) ? data.items : [];
    items.push(...lote);
    if (lote.length < BUNNY_POR_PAGINA) break;
  }
  return items;
}

app.get('/api/admin/bunny-catalogo', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const decoded = await autenticarAdmin(req, res);
    if (!decoded) return;

    if (!BUNNY_API_KEY) {
      return res.status(503).json({
        error: 'Falta conectar la clave de Bunny (BUNNY_API_KEY) en el servidor',
        codigo: 'sin_api_key'
      });
    }

    const colecciones = await bunnyListarTodo('/collections');
    const catalogo = [];
    for (let i = 0; i < colecciones.length; i += BUNNY_COLECCIONES_EN_PARALELO) {
      const grupo = colecciones.slice(i, i + BUNNY_COLECCIONES_EN_PARALELO);
      const resultados = await Promise.all(grupo.map(async col => {
        const videos = await bunnyListarTodo(`/videos?collection=${encodeURIComponent(col.guid)}`);
        const sesiones = videos
          .filter(v => v && v.status === BUNNY_STATUS_TERMINADO)
          .map(v => ({ numero: numeroDeClaseBunny(v.title), titulo: String(v.title || ''), videoId: v.guid }))
          .sort((a, b) => a.numero - b.numero || a.titulo.localeCompare(b.titulo, 'es', { numeric: true }));
        return { titulo: col.name, collectionId: col.guid, sesiones };
      }));
      catalogo.push(...resultados.filter(c => c.sesiones.length > 0));
    }

    return res.json({ ok: true, catalogo });
  } catch (error) {
    console.error('[Admin bunny-catalogo]', sinClaveBunny(error && error.message));
    return res.status(502).json({ error: 'No se pudo consultar el catálogo de Bunny. Intenta de nuevo en un momento' });
  }
});

// Verificación bajo demanda: Stripe es la fuente de verdad para suscripciones Stripe.
app.post('/verify-membership', express.json(), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const decoded = await autenticarFirebase(req, res);
    if (!decoded) return;
    const miembroDoc = await db.collection('miembros').doc(decoded.uid).get();
    const miembro = miembroDoc.exists ? miembroDoc.data() : {};
    const subscriptionId = miembro.stripeSubscriptionId;

    if (!subscriptionId) {
      const active = tieneAccesoVigente(miembro);
      return res.json({
        active,
        status: active ? (miembro.planCancelado ? 'cancelled_active' : 'active') : 'expired',
        source: miembro.activadoManualmente ? 'manual' : (miembro.shopifyOrderId ? 'shopify' : 'firestore'),
        expiresAt: fechaComoDate(miembro.planVence)?.toISOString() || null,
        verifiedWithStripe: false,
      });
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (!subscriptionPerteneceAUid(subscription, decoded.uid)) {
        return res.status(403).json({ error: 'La suscripción no pertenece a esta cuenta' });
      }
      const resultado = await sincronizarSubscription(decoded.uid, subscription);
      return res.json({
        active: resultado.planActivo,
        status: resultado.planStatus,
        source: 'stripe',
        expiresAt: resultado.planVence ? resultado.planVence.toDate().toISOString() : null,
        verifiedWithStripe: true,
      });
    } catch (error) {
      if (error?.code === 'resource_missing') {
        return res.status(409).json({
          error: 'Esta suscripción pertenece al sistema de cobro anterior y requiere revisión de soporte.',
          code: 'historical_subscription',
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('❌ Error verificando membresía:', error);
    return res.status(500).json({ error: 'No se pudo verificar la membresía' });
  }
});

// Referidos: el viejo POST /api/referidos (invitados por `miembros.referredBy`) se quitó. Ahora el
// invitado se registra con POST /api/referidos/registrar y la pantalla usa GET /api/referidos/estado
// (services/rutas-club.js). Lo que el navegador escribe en `referredBy` ya no cuenta.

// ── Health check ──
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Club VIP Zoorigen — Stripe Webhook',
    version: 'membership-sync-2026-08-28',
    timestamp: new Date().toISOString(),
  });
});

// ── Endpoint para cancelar suscripción ──
app.post('/cancel-subscription', express.json(), async (req, res) => {
  try {
    const decoded = await autenticarFirebase(req, res);
    if (!decoded) return;
    const firebaseUID = decoded.uid;

    // Buscar subscriptionId en miembros o usuarios
    let subscriptionId = null;
    const miembroDoc = await db.collection('miembros').doc(firebaseUID).get();
    if (miembroDoc.exists && miembroDoc.data().stripeSubscriptionId) {
      subscriptionId = miembroDoc.data().stripeSubscriptionId;
    } else {
      const usuarioDoc = await db.collection('usuarios').doc(firebaseUID).get();
      if (usuarioDoc.exists && usuarioDoc.data().stripeSubscriptionId) {
        subscriptionId = usuarioDoc.data().stripeSubscriptionId;
      }
    }

    if (!subscriptionId) {
      return res.status(404).json({ error: 'No se encontró suscripción activa' });
    }

    const subscriptionActual = await stripe.subscriptions.retrieve(subscriptionId);
    if (!subscriptionPerteneceAUid(subscriptionActual, firebaseUID)) {
      return res.status(403).json({ error: 'La suscripción no pertenece a esta cuenta' });
    }

    // Cancelar en Stripe (al final del periodo)
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    const resultado = await sincronizarSubscription(firebaseUID, subscription);
    await Promise.all([
      db.collection('miembros').doc(firebaseUID).set({ canceladoEn: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }),
      db.collection('usuarios').doc(firebaseUID).set({ fechaCancelacion: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }),
    ]);

    console.log(`🚫 Suscripción cancelada (al final del periodo) para ${firebaseUID}`);
    res.json({
      success: true,
      message: 'Suscripción cancelada. Mantienes acceso hasta el final del periodo pagado.',
      accesoHasta: resultado.planVence ? resultado.planVence.toDate().toISOString() : null,
    });
  } catch (error) {
    console.error('❌ Error cancelando:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Endpoint para reactivar suscripción ──
app.post('/reactivate-subscription', express.json(), async (req, res) => {
  try {
    const decoded = await autenticarFirebase(req, res);
    if (!decoded) return;
    const firebaseUID = decoded.uid;

    let subscriptionId = null;
    const miembroDoc = await db.collection('miembros').doc(firebaseUID).get();
    if (miembroDoc.exists && miembroDoc.data().stripeSubscriptionId) {
      subscriptionId = miembroDoc.data().stripeSubscriptionId;
    } else {
      const usuarioDoc = await db.collection('usuarios').doc(firebaseUID).get();
      if (usuarioDoc.exists && usuarioDoc.data().stripeSubscriptionId) {
        subscriptionId = usuarioDoc.data().stripeSubscriptionId;
      }
    }

    if (!subscriptionId) {
      return res.status(404).json({ error: 'No se encontró suscripción' });
    }

    const subscriptionActual = await stripe.subscriptions.retrieve(subscriptionId);
    if (!subscriptionPerteneceAUid(subscriptionActual, firebaseUID)) {
      return res.status(403).json({ error: 'La suscripción no pertenece a esta cuenta' });
    }

    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    const resultado = await sincronizarSubscription(firebaseUID, subscription);
    if (!resultado.planActivo) {
      return res.status(409).json({ error: 'La suscripción ya no puede reanudarse; inicia un nuevo pago.' });
    }
    await db.collection('miembros').doc(firebaseUID).set({
      reanudadoEn: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`✅ Suscripción reactivada para ${firebaseUID}`);
    res.json({ success: true, message: 'Suscripción reactivada exitosamente.' });
  } catch (error) {
    console.error('❌ Error reactivando:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Retos, logros, premios, referidos y directorio (services/rutas-club.js) ──
// Reutiliza la autenticación, las reglas de membresía y el índice de cursos de arriba.
// No toca las rutas de pago ni /api/bunny/embed-token.
// Libros y materiales se leen del disco UNA vez al arrancar (LIBROS_DIR / MATERIALES_DIR solo para pruebas).
const catalogoLibros = libros.cargarLibros(process.env.LIBROS_DIR || path.join(__dirname, 'data', 'libros'));
const catalogoMateriales = materiales.cargarMateriales(process.env.MATERIALES_DIR || path.join(__dirname, 'data', 'materiales'));
const club = montarRutasClub(app, {
  express, db, auth, admin, autenticarFirebase, esAdminPorDocumentos, tienePlanVigente,
  obtenerIndiceVideos, leerEleccionPrueba, errorHttp, catalogoLibros
});

// ── Libros de lectura y materiales PDF que se abren con membresía y retos (services/rutas-materiales.js) ──
montarRutasMateriales(app, { db, autenticarFirebase, autenticarAdmin, errorHttp, club, catalogoLibros, catalogoMateriales });
// ── Libro de registro de ejemplares: inventario, bitácora e informe anual de UMA/PIMVS (services/rutas-registro.js) ──
// Datos por persona en registrosUma/{uid}/... (solo del servidor); solo con membresía vigente o administrador.
montarRutasRegistro(app, { db, autenticarFirebase, errorHttp, club });
montarRutasAuth(app, { auth, autenticarFirebase, errorHttp, panelUrl: process.env.PANEL_URL || 'https://www.zoorigen.com' });
// ── Progreso de cursos, quizzes y certificados firmados por el servidor (services/rutas-certificados.js) ──
// El avance (miembros/{uid}/progresoCursos/{cursoId}) y certificados/{folio} los escribe solo este servidor.
// Sin CERTIFICATE_SIGNING_KEY arranca igual: el progreso funciona y los certificados responden 503.
app.certificados = montarRutasCertificados(app, {
  db, admin, auth, autenticarFirebase, autenticarAdmin, esAdminPorDocumentos, tienePlanVigente,
  reglasPruebaParaVideo, videoEsGratis, obtenerIndiceVideos, errorHttp, club,
  firmaClave: CERTIFICATE_SIGNING_KEY, corteLegado: LEGACY_PROGRESS_IMPORT_BEFORE, limiteAnteriores: CERTIFICADOS_ANTERIORES_HASTA,
  panelUrl: process.env.PANEL_URL || 'https://www.zoorigen.com'
});

// ── Catálogo público, encuesta de la portada y preguntas sin respuesta del chatbot (services/rutas-publico.js) ──
// GET /api/cursos/demo (sin videos ni preguntas), POST /api/encuesta y POST /api/chatbot/sin-respuesta son públicas con
// límite por IP; encuestasProspectos y chatbotSinRespuesta las escribe solo este servidor y las lee solo el administrador.
app.publico = montarRutasPublico(app, {
  db, admin, autenticarAdmin, errorHttp, esVideoGratisFijo: id => BUNNY_FREE_VIDEO_IDS.has(id)
});

// ── Noticias del sector, datos curiosos y avisos (services/rutas-noticias.js) ──
// CRON_KEY abre GET /cron/noticias (sin ella esa ruta responde 401). La tarea diaria corre en este mismo proceso.
montarRutasNoticias(app, {
  express, db, autenticarFirebase, autenticarAdmin, errorHttp,
  cronKey: (process.env.CRON_KEY || '').trim().replace(/^["']|["']$/g, '')
});

// ── Panel de administración: resumen, miembros, comunidad, referidos, retos y estado (services/rutas-admin.js) ──
// Todas las rutas /api/admin/* de este archivo exigen administrador verificado en el servidor (ADMIN_EMAILS o marca en Firestore).
montarRutasAdmin(app, {
  express, db, admin, autenticarAdmin, errorHttp, tieneAccesoVigente, esAdminPorCorreo, correosAdministrador
});

// Solo escucha al ejecutarse directamente (node server.js); las pruebas importan `app`.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Webhook Stripe corriendo en puerto ${PORT}`);
    console.log(`🐰 Bunny Stream: ${BUNNY_VIDEO_IDS.size} videos permitidos · biblioteca ${BUNNY_STREAM_LIBRARY_ID}`);
    console.log(`🎁 Vista gratuita: ${BUNNY_FREE_VIDEO_IDS.size} clase`);
    console.log(CERTIFICATE_SIGNING_KEY
      ? 'Certificados: firma configurada'
      : 'Certificados: falta CERTIFICATE_SIGNING_KEY (el progreso funciona, pero no se emiten ni verifican certificados)');
    console.log(CERTIFICADOS_ANTERIORES_HASTA
      ? `Certificados anteriores sin firma: se aceptan los emitidos hasta ${CERTIFICADOS_ANTERIORES_HASTA}`
      : 'Certificados anteriores sin firma: modo transición (sin límite de fecha); define CERTIFICADOS_ANTERIORES_HASTA al publicar las reglas v6');
    // Tarea diaria (noticias y dato curioso). Se apaga con NOTICIAS_TAREA=off; las pruebas importan `app` y nunca llegan aquí.
    const tarea = iniciarProgramador(db);
    console.log(tarea.activo ? '📰 Tarea diaria de noticias: activa (13:00 UTC y al arrancar)' : '📰 Tarea diaria de noticias: apagada');
  });
}

module.exports = app;
// Para pruebas: acceso al índice de videos y sus constantes (no altera el export de `app`).
app.videosFirestore = {
  obtenerIndiceVideos,
  VIDEO_ID_REGEX,
  INDICE_VIDEOS_TTL_MS,
  INDICE_VIDEOS_REFRESCO_MIN_MS,
};
