// ═══════════════════════════════════════════════════════════
// WEBHOOK STRIPE — Club VIP Zoorigen
// Railway: zoorigen-webhook (reemplaza webhook Shopify)
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const crypto = require('crypto');
const bunnyCatalog = require('./data/zoorigen-bunny-catalog.json');

// ── Config ──────────────────────────────────────────────
const rawKey = (process.env.STRIPE_SECRET_KEY || '').trim().replace(/^["']|["']$/g, '');
const stripe = Stripe(rawKey);
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim().replace(/^["']|["']$/g, '');
const PORT = process.env.PORT || 3000;
const STRIPE_PRICES = Object.freeze({
  mensual: String(process.env.STRIPE_PRICE_MENSUAL || 'price_1TRcJnA7If2CqXs9dMBGRmDF').trim(),
  anual: String(process.env.STRIPE_PRICE_ANUAL || 'price_1TRcJlA7If2CqXs97WQNmKFq').trim(),
});
const BUNNY_STREAM_LIBRARY_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || '731751').trim();
const BUNNY_TOKEN_AUTH_KEY = (process.env.BUNNY_TOKEN_AUTH_KEY || '').trim().replace(/^["']|["']$/g, '');
const BUNNY_TOKEN_TTL_SECONDS = Math.min(900, Math.max(60, Number(process.env.BUNNY_TOKEN_TTL_SECONDS) || 300));
const BUNNY_VIDEO_IDS = new Set(
  bunnyCatalog.flatMap(course => (course.lecciones || []).map(lesson => String(lesson.videoId || ''))).filter(Boolean)
);
// Única clase gratuita de toda la plataforma: primera clase del primer curso.
const BUNNY_FREE_VIDEO_IDS = new Set(['befd1641-850a-4099-88a8-047a1badc703']);

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

async function autenticarFirebase(req, res) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Sesión requerida' });
    return null;
  }
  try {
    return await auth.verifyIdToken(match[1]);
  } catch (_) {
    res.status(401).json({ error: 'Sesión inválida o vencida' });
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
  if (['past_due', 'unpaid', 'incomplete', 'expired', 'cancelled', 'pending_payment'].includes(data.planStatus)) return false;
  if (data.planStatus === 'cancelled_active') return Boolean(vence && noHaVencido);
  if (data.planStatus === 'active') return noHaVencido;
  return data.planActivo === true && noHaVencido;
}

// Reproductor privado: el navegador nunca recibe la clave secreta de Bunny.
app.post('/api/bunny/embed-token', express.json(), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!BUNNY_TOKEN_AUTH_KEY || !BUNNY_STREAM_LIBRARY_ID) {
      return res.status(503).json({ error: 'Bunny Stream no está configurado en Railway' });
    }

    const videoId = String(req.body?.videoId || '').trim();
    if (!videoId || !BUNNY_VIDEO_IDS.has(videoId)) {
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
    const esAdmin = adminDoc.exists || miembroDoc.data()?.role === 'admin';
    const tienePlan = (miembroDoc.exists && tieneAccesoVigente(miembroDoc.data())) ||
      (usuarioDoc.exists && tieneAccesoVigente(usuarioDoc.data()));
    const esClaseGratis = BUNNY_FREE_VIDEO_IDS.has(videoId);

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

app.listen(PORT, () => {
  console.log(`🚀 Webhook Stripe corriendo en puerto ${PORT}`);
  console.log(`🐰 Bunny Stream: ${BUNNY_VIDEO_IDS.size} videos permitidos · biblioteca ${BUNNY_STREAM_LIBRARY_ID}`);
  console.log(`🎁 Vista gratuita: ${BUNNY_FREE_VIDEO_IDS.size} clase`);
});
