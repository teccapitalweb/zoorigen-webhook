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

const CRON_SECRET = process.env.CRON_SECRET || 'zoorigen-2026-reset';

// ══════════════════════════════════════════════════════════════
// 3. DETECCIÓN ROBUSTA DE PLANES ZOORIGEN
// ══════════════════════════════════════════════════════════════
const VARIANT_MENSUAL = '45386138714166';
const VARIANT_ANUAL   = '45386327916598';

const PLANES = {
  mensual: { tipo: 'mensual', dias: 30,  precio: 199 },
  anual:   { tipo: 'anual',   dias: 365, precio: 1899 }
};

function detectarPlan(lineItem) {
  if (!lineItem) return null;
  const variantId = String(lineItem.variant_id || '');
  const sku       = (lineItem.sku || '').toLowerCase();
  const title     = (lineItem.title || '').toLowerCase();
  const name      = (lineItem.name || '').toLowerCase();
  const hay       = title + ' ' + name + ' ' + sku;

  if (variantId === VARIANT_MENSUAL) return PLANES.mensual;
  if (variantId === VARIANT_ANUAL)   return PLANES.anual;

  if (sku.includes('mensual') && sku.includes('zoorigen')) return PLANES.mensual;
  if (sku.includes('anual')   && sku.includes('zoorigen')) return PLANES.anual;

  if (hay.includes('zoorigen')) {
    if (hay.includes('mensual'))  return PLANES.mensual;
    if (hay.includes('anual'))    return PLANES.anual;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 4. HELPERS
// ══════════════════════════════════════════════════════════════
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const hash = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody, 'utf8').digest('base64');
  return hash === hmacHeader;
}

async function activarPlan(email, planTipo, dias, extras = {}) {
  try {
    const emailLower = (email || '').toLowerCase().trim();
    if (!emailLower || !emailLower.includes('@')) {
      console.log('⚠️  Email inválido:', emailLower);
      return { ok: false, motivo: 'email_invalido' };
    }

    const now = new Date();
    const vence = new Date(now.getTime() + dias * 24 * 60 * 60 * 1000);

    const updateData = {
      planActivo: true,
      planStatus: 'active',
      planCancelado: false,
      planTipo: planTipo,
      planInicio: now.toISOString(),
      planActivadoEn: now.toISOString(),
      planVence: vence.toISOString(),
      ultimoPago: now.toISOString(),
      ...extras
    };

    const snap = await db.collection('miembros').where('email', '==', emailLower).limit(1).get();

    if (snap.empty) {
      const tempId = 'pending_' + emailLower.replace(/[^a-z0-9]/g, '_');
      await db.collection('miembros').doc(tempId).set({
        email: emailLower,
        name: extras.nombreComprador || emailLower.split('@')[0],
        nombreCompleto: extras.nombreComprador || '',
        phone: extras.telefonoComprador || '',
        createdAt: now.toISOString(),
        needsLinkToAuth: true,
        ...updateData
      });
      console.log(`✅ MIEMBRO CREADO con plan ${planTipo}: ${emailLower} (doc: ${tempId})`);
      return { ok: true, creado: true, email: emailLower };
    }

    const docRef = snap.docs[0].ref;
    await docRef.update(updateData);
    console.log(`✅ Plan ${planTipo} ACTIVADO para ${emailLower}`);
    return { ok: true, actualizado: true, email: emailLower };

  } catch (err) {
    console.error('❌ Error activando plan:', err);
    return { ok: false, error: err.message };
  }
}

async function cancelarPlan(email) {
  try {
    const emailLower = (email || '').toLowerCase().trim();
    const snap = await db.collection('miembros').where('email', '==', emailLower).limit(1).get();
    if (snap.empty) {
      console.log(`⚠️ No se encontró miembro para cancelar: ${emailLower}`);
      return null;
    }
    const docRef = snap.docs[0].ref;
    const data = snap.docs[0].data();
    const accesoHasta = data.planVence || new Date().toISOString();
    await docRef.update({
      planCancelado: true,
      planStatus: 'cancelled',
      canceladoEn: new Date().toISOString(),
      accesoHasta: accesoHasta
    });
    console.log(`✅ Plan cancelado para ${emailLower}`);
    return accesoHasta;
  } catch (err) {
    console.error('❌ Error cancelando:', err);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// 5. NOTICIAS RSS (igual que antes)
// ══════════════════════════════════════════════════════════════
const RSS_FEEDS = [
  { name: 'Mongabay Latam',         url: 'https://es.mongabay.com/feed/',                          icon: '🌎' },
  { name: 'Ambientum',              url: 'https://www.ambientum.com/feed/',                        icon: '🌱' },
  { name: 'National Geographic ES', url: 'https://www.nationalgeographic.com.es/rss/animales',      icon: '🦒' },
  { name: 'DW Ambiente',            url: 'https://rss.dw.com/rdf/rss-sp-eco',                      icon: '🌿' },
  { name: 'SciDev Latam',           url: 'https://www.scidev.net/america-latina/feed/',            icon: '🔬' }
];

const KEYWORDS_POSITIVAS = [
  'fauna', 'silvestre', 'biodiversidad', 'conservaci', 'especie',
  'animal', 'bosque', 'selva', 'ecosistema', 'tortug', 'abej', 'apicul',
  'veterinar', 'zoo', 'jaguar', 'lobo', 'ave ', 'aves', 'reptil', 'anfib',
  'mamífero', 'mamifero', 'extinci', 'hábitat', 'habitat', 'reserva natural',
  'manglar', 'arrecife', 'serpiente', 'araña', 'insect', 'polinizad',
  'ballena', 'tiburón', 'tiburon', 'monarca', 'rescate de fauna', 'vida silvestre',
  'mariposa', 'abeja', 'coral', 'ecología', 'ecologia', 'parque nacional',
  'área natural', 'zoológico', 'refugio', 'endémic', 'endemic', 'pangolín',
  'felino', 'primate', 'anfibio', 'reptiles', 'murciélago', 'murcielago',
  'lince', 'oso', 'cóndor', 'condor', 'águila', 'aguila', 'lechuza',
  'tortuga', 'cocodrilo', 'iguana', 'rana', 'salamandra', 'delfín', 'delfin',
  'foca', 'lobo marino', 'polinización', 'polinizacion', 'flora y fauna',
  'reintroducción', 'reintroduccion', 'protección animal', 'maltrato animal',
  'semarnat', 'conanp', 'uma ', 'cites', 'iucn', 'wwf', 'greenpeace'
];

const KEYWORDS_NEGATIVAS = [
  'trump', 'biden', 'presidente', 'elecci', 'campaña política', 'campaña electoral',
  'fútbol', 'futbol', 'selección', 'mundial', 'liga', 'champions',
  'bolsa', 'nasdaq', 'dólar', 'inflación', 'petróleo', 'petroleo',
  'guerra en', 'bombardeo', 'invasión', 'invasion',
  'papa', 'vaticano',
  'netflix', 'disney', 'hollywood', 'actriz', 'actor', 'celebridad',
  'apple', 'google', 'meta ', 'tesla', 'microsoft',
  'ciberataque', 'hack', 'criptomoneda', 'bitcoin',
  'accident', 'muerto', 'muerte', 'asesin', 'homicidio'
];

function fetchURL(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const timeout = setTimeout(() => reject(new Error('Timeout')), 12000);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Accept-Encoding': 'identity'
      }
    };
    const req = https.request(options, (res) => {
      clearTimeout(timeout);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return fetchURL(nextUrl, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', (err) => { clearTimeout(timeout); reject(err); });
    req.end();
  });
}

async function scrapeOgImage(articleUrl) {
  if (!articleUrl || !articleUrl.startsWith('http')) return '';
  try {
    const html = await fetchURL(articleUrl);
    if (html.length < 500) return fallbackImageService(articleUrl);
    const head = html.substring(0, 50000);
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    ];
    for (const p of patterns) {
      const m = head.match(p);
      if (m && m[1]) return resolveImageUrl(m[1], articleUrl);
    }
    return fallbackImageService(articleUrl);
  } catch {
    return fallbackImageService(articleUrl);
  }
}

function fallbackImageService(articleUrl) {
  try { return `https://api.microlink.io/?url=${encodeURIComponent(articleUrl)}&screenshot=true&embed=screenshot.url`; } catch { return ''; }
}

function resolveImageUrl(imgUrl, baseUrl) {
  if (!imgUrl) return '';
  if (imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) return imgUrl;
  if (imgUrl.startsWith('//')) return 'https:' + imgUrl;
  try { return new URL(imgUrl, baseUrl).href; } catch { return ''; }
}

function parseRSSItems(xml, sourceName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const linkRegex = /<link>([\s\S]*?)<\/link>/;
  const descRegex = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/;
  const dateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/;
  const mediaContentRegex = /<media:content[^>]*url="([^"]+)"[^>]*>/i;
  const enclosureRegex = /<enclosure[^>]*url="([^"]+)"[^>]*type="image[^"]*"[^>]*>/i;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(titleRegex) || [])[1] || '';
    const link = (block.match(linkRegex) || [])[1] || '';
    const desc = (block.match(descRegex) || [])[1] || '';
    const date = (block.match(dateRegex) || [])[1] || '';
    const cleanDesc = desc.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim().substring(0, 220);
    let image = '';
    const m_media = block.match(mediaContentRegex);
    const m_encl = block.match(enclosureRegex);
    if (m_media) image = m_media[1];
    else if (m_encl) image = m_encl[1];
    let pubDate = new Date().toISOString();
    if (date) { const p = new Date(date); if (!isNaN(p.getTime())) pubDate = p.toISOString(); }
    items.push({ title: title.trim(), link: link.trim(), summary: cleanDesc, image: image.trim(), pubDate, source: sourceName });
  }
  return items;
}

function isRelevant(item) {
  const haystack = (item.title + ' ' + item.summary).toLowerCase();
  const hasPositive = KEYWORDS_POSITIVAS.some(kw => haystack.includes(kw));
  if (!hasPositive) return false;
  const hasNegative = KEYWORDS_NEGATIVAS.some(kw => haystack.includes(kw));
  return !hasNegative;
}

function hashItem(item) {
  return crypto.createHash('md5').update(item.link).digest('hex').substring(0, 20);
}

async function syncNews() {
  console.log('🗞️  Iniciando sync de noticias...');
  let totalNuevas = 0, totalActualizadas = 0, totalExistentes = 0;
  for (const feed of RSS_FEEDS) {
    try {
      console.log(`  → ${feed.name}`);
      const xml = await fetchURL(feed.url);
      const items = parseRSSItems(xml, feed.name);
      const relevantes = items.filter(isRelevant);
      console.log(`     ${items.length} items, ${relevantes.length} relevantes`);
      for (const item of relevantes.slice(0, 5)) {
        const id = hashItem(item);
        const docRef = db.collection('noticias').doc(id);
        const exists = await docRef.get();
        if (exists.exists && exists.data().image) { totalExistentes++; continue; }
        if (!item.image && item.link) item.image = await scrapeOgImage(item.link);
        if (exists.exists) {
          if (item.image) { await docRef.update({ image: item.image, pubDate: item.pubDate, summary: item.summary }); totalActualizadas++; }
          continue;
        }
        await docRef.set({ ...item, icon: feed.icon, createdAt: new Date().toISOString(), auto: true });
        totalNuevas++;
      }
    } catch (err) {
      console.error(`  ❌ Error con ${feed.name}:`, err.message);
    }
  }
  console.log(`✅ Sync completo: ${totalNuevas} nuevas, ${totalActualizadas} actualizadas, ${totalExistentes} ya completas`);
  return { nuevas: totalNuevas, actualizadas: totalActualizadas, existentes: totalExistentes };
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
    service: 'Zoorigen Webhook Server v3',
    status: 'online',
    features: ['shopify-webhook', 'subscription-webhooks', 'news-cron', 'cancel-api', 'verify-payment'],
    timestamp: new Date().toISOString()
  });
});

// ────────────────────────────────────────────────────────────
// WEBHOOK PRINCIPAL
// ────────────────────────────────────────────────────────────
app.post('/webhook/shopify', async (req, res) => {
  const topic = req.headers['x-shopify-topic'] || 'desconocido';
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  console.log('═══════════════════════════════════════════════');
  console.log(`📬 WEBHOOK RECIBIDO: ${topic}`);

  if (!verifyShopifyWebhook(req.body, hmacHeader)) {
    console.log('❌ Firma HMAC inválida');
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try { payload = JSON.parse(req.body); } catch {
    console.log('❌ JSON inválido');
    return res.status(400).send('Invalid JSON');
  }

  try {
    // ═══════════════ SUSCRIPCIONES ═══════════════
    if (topic.startsWith('subscription_contracts/')) {
      console.log(`🔄 Evento de suscripción: ${topic}`);
      const email = payload.customer?.email || payload.email;
      const status = (payload.status || '').toLowerCase();
      console.log(`   Email: ${email}, Status: ${status}`);

      if (!email) return res.status(200).send('OK (no email)');

      if (topic.includes('cancel') || status === 'cancelled' || status === 'expired') {
        await cancelarPlan(email);
        return res.status(200).send('OK (cancelled)');
      }

      if (status === 'active' || topic.includes('create') || topic.includes('activate')) {
        const lines = payload.lines?.edges?.map(e => e.node) || payload.lines?.nodes || payload.lines || [];
        let planConfig = null;
        for (const line of lines) {
          const p = detectarPlan(line);
          if (p) { planConfig = p; break; }
        }
        if (!planConfig) planConfig = PLANES.mensual;
        await activarPlan(email, planConfig.tipo, planConfig.dias, {
          viaShopify: true,
          shopifySubscriptionId: payload.id
        });
        return res.status(200).send('OK (subscription)');
      }
      return res.status(200).send('OK (other status)');
    }

    // ═══════════════ PAGO DE PEDIDO ═══════════════
    const email = payload.email || payload.customer?.email;
    const financialStatus = payload.financial_status || '';

    console.log(`   Pedido #${payload.order_number || payload.id}, Email: ${email}, Pago: ${financialStatus}`);

    if (!email) {
      console.log('   ⚠️ Sin email');
      return res.status(200).send('OK (no email)');
    }

    if (topic === 'orders/create' && financialStatus !== 'paid') {
      console.log('   ⏸️ Pedido creado pero no pagado aún');
      return res.status(200).send('OK (not paid yet)');
    }

    const lineItems = payload.line_items || [];
    console.log(`   📦 Productos: ${lineItems.length}`);

    let planConfig = null;
    for (const item of lineItems) {
      console.log(`      - ${item.title} (variant: ${item.variant_id}, sku: ${item.sku})`);
      const p = detectarPlan(item);
      if (p) { planConfig = p; break; }
    }

    if (!planConfig) {
      console.log('   ℹ️ No es producto Zoorigen, ignorando');
      return res.status(200).send('OK (not Zoorigen)');
    }

    console.log(`   🎯 Plan detectado: ${planConfig.tipo} (${planConfig.dias} días)`);

    const nombreComprador = [
      payload.customer?.first_name,
      payload.customer?.last_name
    ].filter(Boolean).join(' ') || payload.billing_address?.name || '';

    const telefonoComprador = payload.customer?.phone || payload.billing_address?.phone || '';

    const result = await activarPlan(email, planConfig.tipo, planConfig.dias, {
      nombreComprador,
      telefonoComprador,
      shopifyOrderId: payload.id,
      shopifyOrderNumber: payload.order_number
    });

    console.log(`   Resultado:`, result);
    console.log('═══════════════════════════════════════════════');
    res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Error procesando webhook:', err);
    res.status(200).send('OK (handled error)');
  }
});

// ────────────────────────────────────────────────────────────
// WEBHOOK CANCELACIÓN
// ────────────────────────────────────────────────────────────
app.post('/webhook/shopify/cancelacion', async (req, res) => {
  const topic = req.headers['x-shopify-topic'] || 'desconocido';
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  console.log('═══════════════════════════════════════════════');
  console.log(`📬 WEBHOOK CANCELACIÓN: ${topic}`);

  if (!verifyShopifyWebhook(req.body, hmacHeader)) return res.status(401).send('Invalid');

  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Invalid'); }

  const email = payload.email || payload.customer?.email;
  console.log(`   Email: ${email}`);
  if (email) await cancelarPlan(email);
  console.log('═══════════════════════════════════════════════');
  res.status(200).send('OK');
});

// ────────────────────────────────────────────────────────────
// NUEVO: VERIFICAR PAGO (para el frontend)
// ────────────────────────────────────────────────────────────
app.post('/api/verificar-pago', async (req, res) => {
  try {
    const email = (req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const snap = await db.collection('miembros').where('email', '==', email).limit(1).get();
    if (snap.empty) return res.json({ existe: false, activo: false });

    const data = snap.docs[0].data();
    res.json({
      existe: true,
      activo: data.planActivo === true || data.planStatus === 'active',
      planTipo: data.planTipo || null,
      planVence: data.planVence || null,
      planStatus: data.planStatus || null
    });
  } catch (err) {
    console.error('verificar-pago error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// CANCELACIÓN DESDE FRONTEND
// ────────────────────────────────────────────────────────────
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
      planStatus: 'cancelled',
      canceladoEn: new Date().toISOString(),
      accesoHasta: accesoHasta
    });
    res.status(200).json({ success: true, accesoHasta });
  } catch (err) {
    console.error('Cancel API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// CRON NOTICIAS
// ────────────────────────────────────────────────────────────
app.post('/cron/sync-news', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret' });
  try { const result = await syncNews(); res.json({ success: true, ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/cron/sync-news', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret' });
  try { const result = await syncNews(); res.json({ success: true, ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// 8. AUTO-SYNC NOTICIAS
// ══════════════════════════════════════════════════════════════
const SIX_HOURS = 6 * 60 * 60 * 1000;
setTimeout(() => { syncNews().catch(e => console.error('Initial sync error:', e.message)); }, 30000);
setInterval(() => { syncNews().catch(e => console.error('Scheduled sync error:', e.message)); }, SIX_HOURS);

// ══════════════════════════════════════════════════════════════
// 9. ARRANCAR
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════');
  console.log(`🦒 Zoorigen Webhook Server v3 en puerto ${PORT}`);
  console.log(`📦 Firebase: ${serviceAccount.project_id || 'NO CONFIG'}`);
  console.log(`🔑 Webhook secret: ${WEBHOOK_SECRET ? 'OK ✓' : '❌ FALTA'}`);
  console.log(`📬 Endpoints activos:`);
  console.log(`   POST /webhook/shopify (orders/paid + subscriptions)`);
  console.log(`   POST /webhook/shopify/cancelacion`);
  console.log(`   POST /api/verificar-pago (frontend)`);
  console.log(`   POST /api/cancel-subscription`);
  console.log(`🗞️  Auto-sync noticias cada 6 horas`);
  console.log('═══════════════════════════════════════════════');
});
