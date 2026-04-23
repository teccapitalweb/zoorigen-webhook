// ═══════════════════════════════════════════════════════════
// WEBHOOK STRIPE — Club VIP Zoorigen
// Railway: zoorigen-webhook (reemplaza webhook Shopify)
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');

// ── Config ──────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;

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

        // Actualizar Firestore
        await db.collection('usuarios').doc(firebaseUID).set({
          planActivo: true,
          tipoPlan: planType,
          fechaActivacion: admin.firestore.FieldValue.serverTimestamp(),
          fechaExpiracion: admin.firestore.Timestamp.fromDate(expDate),
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

        // Buscar usuario por subscriptionId
        const snapshot = await db.collection('usuarios')
          .where('stripeSubscriptionId', '==', subscriptionId)
          .limit(1)
          .get();

        if (snapshot.empty) {
          console.error('❌ No se encontró usuario con subscription:', subscriptionId);
          break;
        }

        const userDoc = snapshot.docs[0];
        const userData = userDoc.data();
        const planType = userData.tipoPlan || 'mensual';

        const now = new Date();
        let expDate;
        if (planType === 'anual') {
          expDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
        } else {
          expDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
        }

        await userDoc.ref.update({
          planActivo: true,
          fechaExpiracion: admin.firestore.Timestamp.fromDate(expDate),
          ultimoPago: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`🔄 Renovación exitosa para ${userDoc.id} (${planType})`);
        break;
      }

      // ── CANCELACIÓN ──
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        const snapshot = await db.collection('usuarios')
          .where('stripeSubscriptionId', '==', subscriptionId)
          .limit(1)
          .get();

        if (snapshot.empty) {
          console.error('❌ No se encontró usuario para cancelar:', subscriptionId);
          break;
        }

        const userDoc = snapshot.docs[0];
        await userDoc.ref.update({
          planActivo: false,
          fechaCancelacion: admin.firestore.FieldValue.serverTimestamp(),
        });

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

// ── Endpoint para crear Checkout Session (llamado desde el frontend) ──
app.post('/create-checkout-session', express.json(), async (req, res) => {
  try {
    const { priceId, firebaseUID, email, planType } = req.body;

    if (!priceId || !firebaseUID || !email) {
      return res.status(400).json({ error: 'Faltan datos: priceId, firebaseUID, email' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        firebaseUID: firebaseUID,
        planType: planType || 'mensual',
      },
      success_url: 'https://www.zoorigen.com/pages/club-gracias.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.zoorigen.com/pages/club-suscripcion.html?cancelado=true',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error creando sesión:', error);
    res.status(500).json({ error: error.message });
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

app.listen(PORT, () => {
  console.log(`🚀 Webhook Stripe corriendo en puerto ${PORT}`);
});
