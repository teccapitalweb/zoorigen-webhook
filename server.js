const express = require('express');
const crypto  = require('crypto');
const admin   = require('firebase-admin');
const https   = require('https');

const app = express();

// ══════════════════════════════════════════════════════════════
// 1. FIREBASE ADMIN
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
  console.error('❌ FALTA SHOPIFY_WEBHOOK_SECRET');
  process.exit(1);
}

// Secret para proteger el endpoint de cron (cualquier string largo random)
const CRON_SECRET = process.env.CRON_SECRET || 'zoorigen-cron-' + Math.random().toString(36);

// ══════════════════════════════════════════════════════════════
// 3. MAPEO PRODUCTOS SHOPIFY → PLAN
// ══════════════════════════════════════════════════════════════
const PRODUCT_PLAN_MAP = {
  'membresia-mensual-club-vip-zoorigen': { tipo: 'mensual', dias: 30 },
  'membresia-anual-club-vip-zoorigen':   { tipo: 'anual',   dias: 365 }
};

// ══════════════════════════════════════════════════════════════
// 4. HELPERS SHOPIFY
// ══════════════════════════════════════════════════════════════
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const hash = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody, 'utf8').digest('base64');
  return hash === hmacHeader;
}

async function activarPlan(email, planTipo, dias) {
  try {
    const emailLower = (email || '').toLowerCase().trim();
    const snap = await db.collection('miembros').where('email', '==', emailLower).limit(1).get();
    if (snap.empty) {
      console.log(`⚠️  Sin miembro: ${emailLower}`);
      return false;
    }
    const docRef = snap.docs[0].ref;
    const now = new Date();
    const vence = new Date(now.getTime() + dias * 24 * 60 * 60 * 1000);
    await docRef.update({
      planActivo: true,
      planCancelado: false,
      planTipo: planTipo,
      planInicio: now.toISOString(),
      planVence: vence.toISOString(),
      ultimoPago: now.toISOString()
    });
    console.log(`✅ Plan ${planTipo} activado para ${emailLower}`);
    return true;
  } catch (err) {
    console.error('❌ Error activando plan:', err);
    return false;
  }
}

async function cancelarPlan(email) {
  try {
    const emailLower = (email || '').toLowerCase().trim();
    const snap = await db.collection('miembros').where('email', '==', emailLower).limit(1).get();
    if (snap.empty) return null;
    const docRef = snap.docs[0].ref;
    const data = snap.docs[0].data();
    const accesoHasta = data.planVence || new Date().toISOString();
    await docRef.update({
      planCancelado: true,
      canceladoEn: new Date().toISOString(),
      accesoHasta: accesoHasta
    });
    return accesoHasta;
  } catch (err) {
    console.error('❌ Error cancelando:', err);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// 5. NOTICIAS AUTOMÁTICAS — RSS SCRAPER
// ══════════════════════════════════════════════════════════════

// Fuentes RSS de fauna/biodiversidad/conservación
const RSS_FEEDS = [
  { name: 'Mongabay Latam', url: 'https://es.mongabay.com/feed/', icon: '🌎' },
  { name: 'SciDev.Net', url: 'https://www.scidev.net/america-latina/feed/', icon: '🔬' },
  { name: 'DW Ambiente', url: 'https://rss.dw.com/rdf/rss-sp-eco', icon: '🌱' },
  { name: 'BBC Mundo Ciencia', url: 'https://feeds.bbci.co.uk/mundo/ciencia_tecnologia/rss.xml', icon: '🧪' }
];

// Palabras clave para filtrar solo noticias relevantes a Zoorigen
const KEYWORDS = [
  'fauna', 'silvestre', 'biodiversidad', 'conservaci', 'espec', 'animal',
  'bosque', 'selva', 'ecosistema', 'tortug', 'abej', 'apicul', 'vete',
  'zoo', 'jaguar', 'lobo', 'ave', 'rept', 'anfib', 'mamifero', 'mamífero',
  'extinci', 'hábitat', 'habitat', 'reserva natural', 'manglar', 'arrecife',
  'serpiente', 'araña', 'insect', 'polinizad', 'ballenas', 'tiburones',
  'monarca', 'abandon', 'rescat', 'fauna ponzo'
];

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 ZoorigenBot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseRSSItems(xml, sourceName) {
  const items = [];
  // Regex simple para extraer items de RSS (suficiente para feeds estándar)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const linkRegex = /<link>([\s\S]*?)<\/link>/;
  const descRegex = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/;
  const dateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/;

  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(titleRegex) || [])[1] || '';
    const link  = (block.match(linkRegex) || [])[1] || '';
    const desc  = (block.match(descRegex) || [])[1] || '';
    const date  = (block.match(dateRegex) || [])[1] || '';

    // Limpiar HTML del description
    const cleanDesc = desc.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim().substring(0, 220);

    items.push({
      title: title.trim(),
      link: link.trim(),
      summary: cleanDesc,
      date: date.trim(),
      source: sourceName
    });
  }
  return items;
}

function isRelevant(item) {
  const haystack = (item.title + ' ' + item.summary).toLowerCase();
  return KEYWORDS.some(kw => haystack.includes(kw));
}

function hashItem(item) {
  // ID estable basado en el link para evitar duplicados
  return crypto.createHash('md5').update(item.link).digest('hex').substring(0, 20);
}

async function syncNews() {
  console.log('🗞️  Iniciando sync de noticias...');
  let totalNuevas = 0;
  let totalDescartadas = 0;

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`  → ${feed.name}`);
      const xml = await fetchURL(feed.url);
      const items = parseRSSItems(xml, feed.name);
      const relevantes = items.filter(isRelevant);

      console.log(`     ${items.length} items, ${relevantes.length} relevantes`);

      // Guardar en Firestore (máximo 5 por feed por corrida para no saturar)
      for (const item of relevantes.slice(0, 5)) {
        const id = hashItem(item);
        const docRef = db.collection('noticias').doc(id);
        const exists = await docRef.get();
        if (exists.exists) { totalDescartadas++; continue; }

        await docRef.set({
          ...item,
          icon: feed.icon,
          createdAt: new Date().toISOString(),
          auto: true
        });
        totalNuevas++;
      }
    } catch (err) {
      console.error(`  ❌ Error con ${feed.name}:`, err.message);
    }
  }

  // Limpiar noticias viejas (más de 30 días) para no acumular basura
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const oldSnap = await db.collection('noticias')
      .where('auto', '==', true)
      .where('createdAt', '<', cutoff)
      .limit(20)
      .get();
    const batch = db.batch();
    oldSnap.forEach(doc => batch.delete(doc.ref));
    if (oldSnap.size > 0) await batch.commit();
    console.log(`🧹 Eliminadas ${oldSnap.size} noticias viejas`);
  } catch (err) {
    console.warn('⚠️ No se pudo limpiar (puede que falte un índice en Firestore, no es crítico)');
  }

  console.log(`✅ Sync completo: ${totalNuevas} nuevas, ${totalDescartadas} ya existían`);
  return { nuevas: totalNuevas, existentes: totalDescartadas };
}

// ══════════════════════════════════════════════════════════════
// 6. MIDDLEWARE
// ══════════════════════════════════════════════════════════════
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
app.use('/webhook/shopify/cancelacion', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════════
// 7. ENDPOINTS
// ══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    service: 'Zoorigen Webhook Server',
    status: 'online',
    features: ['shopify-webhook', 'news-cron', 'cancel-api'],
    timestamp: new Date().toISOString()
  });
});

// --- Pago Shopify → activar plan ---
app.post('/webhook/shopify', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(req.body, hmacHeader)) {
    return res.status(401).send('Invalid signature');
  }
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Invalid JSON'); }

  const email = payload.email || (payload.customer && payload.customer.email);
  if (!email) return res.status(200).send('OK (no email)');

  const lineItems = payload.line_items || [];
  let planConfig = null;
  for (const item of lineItems) {
    const sku = (item.sku || '').toLowerCase();
    if (PRODUCT_PLAN_MAP[sku]) { planConfig = PRODUCT_PLAN_MAP[sku]; break; }
    const title = (item.title || '').toLowerCase();
    if (title.includes('mensual') && title.includes('vip')) { planConfig = PRODUCT_PLAN_MAP['membresia-mensual-club-vip-zoorigen']; break; }
    if (title.includes('anual') && title.includes('vip'))   { planConfig = PRODUCT_PLAN_MAP['membresia-anual-club-vip-zoorigen']; break; }
  }
  if (!planConfig) return res.status(200).send('OK (not VIP)');

  await activarPlan(email, planConfig.tipo, planConfig.dias);
  res.status(200).send('OK');
});

// --- Cancelación Shopify ---
app.post('/webhook/shopify/cancelacion', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(req.body, hmacHeader)) return res.status(401).send('Invalid');
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Invalid'); }
  const email = payload.email || (payload.customer && payload.customer.email);
  if (email) await cancelarPlan(email);
  res.status(200).send('OK');
});

// --- Cancelación desde frontend ---
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const idToken = (req.headers.authorization || '').replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'No autenticado' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const doc = await db.collection('miembros').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
    const accesoHasta = doc.data().planVence || new Date().toISOString();
    await db.collection('miembros').doc(uid).update({
      planCancelado: true,
      canceladoEn: new Date().toISOString(),
      accesoHasta: accesoHasta
    });
    res.status(200).json({ success: true, accesoHasta });
  } catch (err) {
    console.error('Cancel API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- CRON: Sync de noticias ---
// Se protege con secret para que no cualquiera lo dispare
app.post('/cron/sync-news', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  try {
    const result = await syncNews();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- MANUAL: Sync de noticias con secret en URL (para dispararlo manualmente) ---
app.get('/cron/sync-news', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  try {
    const result = await syncNews();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 8. AUTO-SYNC al arrancar + cada 6 horas
// ══════════════════════════════════════════════════════════════
const SIX_HOURS = 6 * 60 * 60 * 1000;

// Primera sync a los 30 segundos de arrancar (da tiempo a Firebase)
setTimeout(() => {
  syncNews().catch(e => console.error('Initial sync error:', e.message));
}, 30000);

// Sync recurrente cada 6 horas
setInterval(() => {
  syncNews().catch(e => console.error('Scheduled sync error:', e.message));
}, SIX_HOURS);

// ══════════════════════════════════════════════════════════════
// 9. ARRANCAR
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦒 Zoorigen Server v2 en puerto ${PORT}`);
  console.log(`📦 Firebase: ${serviceAccount.project_id || 'NO CONFIG'}`);
  console.log(`🗞️  Auto-sync noticias cada 6 horas`);
});
