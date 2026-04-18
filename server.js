const express = require('express');
const crypto  = require('crypto');
const admin   = require('firebase-admin');

const app = express();

// ══════════════════════════════════════════════════════════════
// 1. INICIALIZAR FIREBASE ADMIN
// ══════════════════════════════════════════════════════════════
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});
const db = admin.firestore();

// ══════════════════════════════════════════════════════════════
// 2. SHOPIFY WEBHOOK SECRET
// ══════════════════════════════════════════════════════════════
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('❌ FALTA SHOPIFY_WEBHOOK_SECRET en variables de entorno');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// 3. MAPEO DE PRODUCTOS SHOPIFY → PLAN
// Cada producto Shopify corresponde a un plan específico
// ══════════════════════════════════════════════════════════════
const PRODUCT_PLAN_MAP = {
  'membresia-mensual-club-vip-zoorigen': { tipo: 'mensual', dias: 30 },
  'membresia-anual-club-vip-zoorigen':   { tipo: 'anual',   dias: 365 }
};

// ══════════════════════════════════════════════════════════════
// 4. VERIFICAR FIRMA SHOPIFY
// ══════════════════════════════════════════════════════════════
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const hash = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}

// ══════════════════════════════════════════════════════════════
// 5. ACTIVAR PLAN EN FIREBASE
// ══════════════════════════════════════════════════════════════
async function activarPlan(email, planTipo, dias) {
  try {
    const emailLower = (email || '').toLowerCase().trim();
    const snap = await db.collection('miembros')
      .where('email', '==', emailLower)
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`⚠️  No se encontró miembro con email: ${emailLower}`);
      return false;
    }

    const docRef = snap.docs[0].ref;
    const now    = new Date();
    const vence  = new Date(now.getTime() + dias * 24 * 60 * 60 * 1000);

    await docRef.update({
      planActivo:    true,
      planCancelado: false,
      planTipo:      planTipo,
      planInicio:    now.toISOString(),
      planVence:     vence.toISOString(),
      ultimoPago:    now.toISOString()
    });

    console.log(`✅ Plan ${planTipo} activado para ${emailLower} — vence ${vence.toLocaleDateString('es-MX')}`);
    return true;
  } catch (err) {
    console.error('❌ Error activando plan:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// 6. CANCELAR PLAN EN FIREBASE
// ══════════════════════════════════════════════════════════════
async function cancelarPlan(email) {
  try {
    const emailLower = (email || '').toLowerCase().trim();
    const snap = await db.collection('miembros')
      .where('email', '==', emailLower)
      .limit(1)
      .get();

    if (snap.empty) return null;

    const docRef = snap.docs[0].ref;
    const data   = snap.docs[0].data();
    const accesoHasta = data.planVence || new Date().toISOString();

    await docRef.update({
      planCancelado: true,
      canceladoEn:   new Date().toISOString(),
      accesoHasta:   accesoHasta
    });

    console.log(`🚫 Plan cancelado para ${emailLower} · Acceso hasta ${accesoHasta}`);
    return accesoHasta;
  } catch (err) {
    console.error('❌ Error cancelando plan:', err);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// 7. MIDDLEWARE: raw body SOLO para /webhook/shopify*
//                JSON body para /api/*
// ══════════════════════════════════════════════════════════════
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
app.use('/webhook/shopify/cancelacion', express.raw({ type: 'application/json' }));
app.use(express.json());

// CORS simple para que el frontend pueda llamar a /api/*
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════════
// 8. ENDPOINTS
// ══════════════════════════════════════════════════════════════

// --- Health check ---
app.get('/', (req, res) => {
  res.json({
    service: 'Zoorigen Webhook Server',
    status: 'online',
    timestamp: new Date().toISOString()
  });
});

// --- Pago de Shopify → activar plan ---
app.post('/webhook/shopify', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const rawBody    = req.body;

  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    console.warn('❌ Firma Shopify inválida');
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (err) { return res.status(400).send('Invalid JSON'); }

  const email = payload.email || (payload.customer && payload.customer.email);
  if (!email) {
    console.warn('⚠️ Webhook recibido sin email');
    return res.status(200).send('OK (no email)');
  }

  // Identificar el plan por el handle del producto en line_items
  const lineItems = payload.line_items || [];
  let planConfig = null;
  for (const item of lineItems) {
    const handle = (item.sku || '').toLowerCase() || (item.product_handle || '').toLowerCase();
    if (PRODUCT_PLAN_MAP[handle]) { planConfig = PRODUCT_PLAN_MAP[handle]; break; }
    // Fallback: buscar por título
    const title = (item.title || '').toLowerCase();
    if (title.includes('mensual') && title.includes('vip')) { planConfig = PRODUCT_PLAN_MAP['membresia-mensual-club-vip-zoorigen']; break; }
    if (title.includes('anual') && title.includes('vip'))   { planConfig = PRODUCT_PLAN_MAP['membresia-anual-club-vip-zoorigen']; break; }
  }

  if (!planConfig) {
    console.log(`⚠️ Pedido sin producto VIP reconocido (email: ${email})`);
    return res.status(200).send('OK (not a VIP product)');
  }

  await activarPlan(email, planConfig.tipo, planConfig.dias);
  res.status(200).send('OK');
});

// --- Cancelación de Shopify → cancelar plan ---
app.post('/webhook/shopify/cancelacion', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const rawBody    = req.body;

  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (err) { return res.status(400).send('Invalid JSON'); }

  const email = payload.email || (payload.customer && payload.customer.email);
  if (email) await cancelarPlan(email);
  res.status(200).send('OK');
});

// --- Cancelación desde el frontend (Bearer token del usuario) ---
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'No autenticado' });

    // Verificar el ID token contra Firebase
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email;

    const doc = await db.collection('miembros').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Miembro no encontrado' });

    const data = doc.data();
    const accesoHasta = data.planVence || new Date().toISOString();

    await db.collection('miembros').doc(uid).update({
      planCancelado: true,
      canceladoEn: new Date().toISOString(),
      accesoHasta: accesoHasta
    });

    console.log(`🚫 Cancelación solicitada por usuario ${email} · Acceso hasta ${accesoHasta}`);
    res.status(200).json({ success: true, accesoHasta });
  } catch (err) {
    console.error('Cancel API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 9. ARRANCAR SERVIDOR
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦒 Zoorigen Webhook Server corriendo en puerto ${PORT}`);
  console.log(`📦 Firebase project: ${serviceAccount.project_id || 'NO CONFIGURADO'}`);
});
