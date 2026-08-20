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
console.log('🔑 Stripe key starts with:', rawKey.substring(0, 12) + '...');
console.log('🔑 Stripe key ends with:', '...' + rawKey.substring(rawKey.length - 8));
console.log('🔑 Stripe key length:', rawKey.length);
const stripe = Stripe(rawKey);
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim().replace(/^["']|["']$/g, '');
const PORT = process.env.PORT || 3000;
const BUNNY_STREAM_LIBRARY_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || '731751').trim();
const BUNNY_TOKEN_AUTH_KEY = (process.env.BUNNY_TOKEN_AUTH_KEY || '').trim().replace(/^["']|["']$/g, '');
const BUNNY_TOKEN_TTL_SECONDS = Math.min(900, Math.max(60, Number(process.env.BUNNY_TOKEN_TTL_SECONDS) || 300));
const BUNNY_VIDEO_IDS = new Set(
  bunnyCatalog.flatMap(course => (course.lecciones || []).map(lesson => String(lesson.videoId || ''))).filter(Boolean)
);

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
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!firebaseUID) {
          console.error('❌ No firebaseUID en metadata');
          break;
        }

        // Calcular fecha de expiración
        const now = new Date();
        let expDate;
        if (planType === 'anual') {
          expDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
        } else {
          expDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
        }

        // Actualizar Firestore — escribir en AMBAS colecciones
        const dataPlan = {
          planActivo: true,
          planCancelado: false,
          tipoPlan: planType,
          fechaActivacion: admin.firestore.FieldValue.serverTimestamp(),
          fechaExpiracion: admin.firestore.Timestamp.fromDate(expDate),
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          email: email,
          ultimoPago: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Colección "usuarios" (datos de Stripe)
        await db.collection('usuarios').doc(firebaseUID).set(dataPlan, { merge: true });

        // Colección "miembros" (sistema VIP del club)
        await db.collection('miembros').doc(firebaseUID).set({
          planActivo: true,
          planCancelado: false,
          planTipo: planType,
          planInicio: admin.firestore.FieldValue.serverTimestamp(),
          planVence: admin.firestore.Timestamp.fromDate(expDate),
          planStatus: 'active',
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          email: email,
          ultimoPago: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`🎉 Plan ${planType} activado para ${firebaseUID} (${email})`);
        break;
      }

      // ── RENOVACIÓN AUTOMÁTICA ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId || invoice.billing_reason === 'subscription_create') {
          break;
        }

        // Buscar usuario por subscriptionId en ambas colecciones
        let snapshot = await db.collection('usuarios')
          .where('stripeSubscriptionId', '==', subscriptionId)
          .limit(1)
          .get();

        if (snapshot.empty) {
          snapshot = await db.collection('miembros')
            .where('stripeSubscriptionId', '==', subscriptionId)
            .limit(1)
            .get();
        }

        if (snapshot.empty) {
          console.error('❌ No se encontró usuario con subscription:', subscriptionId);
          break;
        }

        const userDoc = snapshot.docs[0];
        const userData = userDoc.data();
        const planType = userData.tipoPlan || userData.planTipo || 'mensual';

        const now = new Date();
        let expDate;
        if (planType === 'anual') {
          expDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
        } else {
          expDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
        }

        const uid = userDoc.id;
        // Actualizar ambas colecciones
        await db.collection('usuarios').doc(uid).update({
          planActivo: true,
          fechaExpiracion: admin.firestore.Timestamp.fromDate(expDate),
          ultimoPago: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        await db.collection('miembros').doc(uid).update({
          planActivo: true,
          planVence: admin.firestore.Timestamp.fromDate(expDate),
          ultimoPago: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});

        console.log(`🔄 Renovación exitosa para ${userDoc.id} (${planType})`);
        break;
      }

      // ── CANCELACIÓN ──
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        let snapCancel = await db.collection('usuarios')
          .where('stripeSubscriptionId', '==', subscriptionId)
          .limit(1)
          .get();

        if (snapCancel.empty) {
          snapCancel = await db.collection('miembros')
            .where('stripeSubscriptionId', '==', subscriptionId)
            .limit(1)
            .get();
        }

        if (snapCancel.empty) {
          console.error('❌ No se encontró usuario para cancelar:', subscriptionId);
          break;
        }

        const cancelUid = snapCancel.docs[0].id;
        // Cancelar en ambas colecciones
        await db.collection('usuarios').doc(cancelUid).update({
          planActivo: false,
          fechaCancelacion: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        await db.collection('miembros').doc(cancelUid).update({
          planActivo: false,
          planCancelado: true,
          canceladoEn: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});

        console.log(`🚫 Suscripción cancelada para ${userDoc.id}`);
        break;
      }

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
    }
  } catch (error) {
    console.error('❌ Error procesando evento:', error);
  }

  res.json({ received: true });
});

// ── Endpoint para crear Checkout Session (redirect o embedded) ──
app.post('/create-checkout-session', express.json(), async (req, res) => {
  try {
    const { priceId, firebaseUID, email, planType, embedded } = req.body;

    if (!priceId || !firebaseUID || !email) {
      return res.status(400).json({ error: 'Faltan datos: priceId, firebaseUID, email' });
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
        planType: planType || 'mensual',
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
  const noHaVencido = !vence || vence.getTime() > Date.now();
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
    const esAdmin = adminDoc.exists;
    const tienePlan = (miembroDoc.exists && tieneAccesoVigente(miembroDoc.data())) ||
      (usuarioDoc.exists && tieneAccesoVigente(usuarioDoc.data()));

    if (!esAdmin && !tienePlan) {
      return res.status(403).json({ error: 'Necesitas una membresía activa para ver esta clase' });
    }

    const expires = Math.floor(Date.now() / 1000) + BUNNY_TOKEN_TTL_SECONDS;
    const token = crypto
      .createHash('sha256')
      .update(BUNNY_TOKEN_AUTH_KEY + videoId + expires)
      .digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${videoId}?token=${token}&expires=${expires}`;

    return res.json({ embedUrl, expires });
  } catch (error) {
    console.error('[Bunny embed-token]', error);
    return res.status(500).json({ error: 'No se pudo preparar la reproducción' });
  }
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Club VIP Zoorigen — Stripe Webhook',
    timestamp: new Date().toISOString(),
  });
});

// ── Endpoint para cancelar suscripción ──
app.post('/cancel-subscription', express.json(), async (req, res) => {
  try {
    const { firebaseUID } = req.body;
    if (!firebaseUID) {
      return res.status(400).json({ error: 'Falta firebaseUID' });
    }

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

    // Cancelar en Stripe (al final del periodo)
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    // Actualizar Firestore
    await db.collection('miembros').doc(firebaseUID).update({
      planCancelado: true,
      canceladoEn: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    await db.collection('usuarios').doc(firebaseUID).update({
      planCancelado: true,
      fechaCancelacion: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    console.log(`🚫 Suscripción cancelada (al final del periodo) para ${firebaseUID}`);
    res.json({ success: true, message: 'Suscripción cancelada. Mantienes acceso hasta el final del periodo pagado.' });
  } catch (error) {
    console.error('❌ Error cancelando:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Endpoint para reactivar suscripción ──
app.post('/reactivate-subscription', express.json(), async (req, res) => {
  try {
    const { firebaseUID } = req.body;
    if (!firebaseUID) {
      return res.status(400).json({ error: 'Falta firebaseUID' });
    }

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

    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    await db.collection('miembros').doc(firebaseUID).update({
      planActivo: true,
      planCancelado: false,
      reanudadoEn: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    await db.collection('usuarios').doc(firebaseUID).update({
      planActivo: true,
      planCancelado: false,
    }).catch(() => {});

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
});
