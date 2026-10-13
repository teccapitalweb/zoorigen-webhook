'use strict';

// ══ NOTICIAS DEL SECTOR ══
// noticiasSector/{id} (solo del servidor). Se llenan de dos formas:
//   · origen 'auto'  -> syncNoticias lee los RSS/Atom de data/noticias-fuentes.json (y NewsData.io si hay llave),
//                       guarda hasta 4 nuevas por corrida y borra las de más de 21 días.
//   · origen 'admin' -> las publica el equipo desde el panel; nunca caducan ni las borra la limpieza.
// Solo se guarda titular + extracto corto (≤280, sin HTML) + enlace a la nota original + la imagen que
// entregue la propia fuente (solo https) o, si el feed no trae, la og:image de la página de la nota
// (services/noticias-imagen.js, solo durante la sincronización). Jamás el artículo completo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { limpiarTexto, texto, recortar, urlHttps, aIso } = require('./texto');
const imagenes = require('./noticias-imagen');

// La búsqueda de imagen en la página de la nota solo sale a internet con el transporte real. Si alguien reemplazó el fetch global
// (pruebas) se respeta el reemplazo, y si el llamador pasó su propio fetch para los feeds no se busca nada salvo que también pase
// `fetchPagina`: así ninguna prueba toca la red por accidente.
const FETCH_NATIVO = globalThis.fetch;
const INTENTOS_IMAGEN = 2;
const RELLENO_POR_CORRIDA = 8;

function transporteImagenes(opciones) {
  if (opciones.buscarImagenes === false || (process.env.NOTICIAS_IMAGENES || '').toLowerCase() === 'off') return null;
  if (typeof opciones.fetchPagina === 'function') return { fetch: opciones.fetchPagina, resolver: opciones.resolver || imagenes.resolverSimulado };
  if (opciones.fetch) return null;
  if (globalThis.fetch !== FETCH_NATIVO) return { fetch: globalThis.fetch, resolver: opciones.resolver || imagenes.resolverSimulado };
  return { fetch: imagenes.transporteFijado, resolver: opciones.resolver || imagenes.resolverDns };
}

const RUTA_FUENTES = process.env.NOTICIAS_FUENTES_RUTA || path.join(__dirname, '..', 'data', 'noticias-fuentes.json');

const CATEGORIAS = Object.freeze({
  fauna: { nombre: 'Fauna silvestre', color: '#2F7A4F' },
  conservacion: { nombre: 'Conservación', color: '#6FBF73' },
  veterinaria: { nombre: 'Veterinaria y medicina zoológica', color: '#2AA4D5' },
  normativa: { nombre: 'Normatividad ambiental', color: '#E8A317' },
  apicultura: { nombre: 'Apicultura', color: '#D4A017' },
  ciencia: { nombre: 'Ciencia y biodiversidad', color: '#8B7FBA' }
});
const ORDEN_CATEGORIAS = Object.freeze(Object.keys(CATEGORIAS));
const PLANTILLAS = Object.freeze(['verde', 'naranja', 'bicolor']);

const TOPE_NUEVAS = 4;
const DIAS_RETENCION = 21;
const MAX_EXTRACTO = 280;
const TIMEOUT_FEED_MS = 12000;
const MAX_BYTES_FEED = 3 * 1024 * 1024;
const CANDIDATAS_POR_CATEGORIA = 12;
const LOTE_BORRADO = 400;
const MAX_PUBLICAS = 30;
const POR_DEFECTO_PUBLICAS = 7;
const MAX_ADMIN = 60;

// ── Fuentes ──
// Lee y valida data/noticias-fuentes.json: [{ id, nombre, url (https), categoria }]. Lo inválido se descarta.
function leerFuentes(ruta = RUTA_FUENTES) {
  let lista;
  try { lista = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (error) {
    console.error('[Noticias] No se pudo leer la lista de fuentes:', error && error.message);
    return [];
  }
  if (!Array.isArray(lista)) return [];
  const vistas = new Set();
  const validas = [];
  for (const f of lista) {
    if (!f || typeof f !== 'object') continue;
    const id = typeof f.id === 'string' && /^[a-z0-9_-]{2,40}$/i.test(f.id) ? f.id : '';
    const url = urlHttps(f.url, 500);
    const nombre = texto(f.nombre, 60);
    if (!id || !url || !nombre || !CATEGORIAS[f.categoria] || vistas.has(id)) continue;
    vistas.add(id);
    validas.push({ id, nombre, url, categoria: f.categoria });
  }
  return validas;
}

// ── Entidades HTML y limpieza ──
const NOMBRADAS = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', iexcl: '¡', iquest: '¿', copy: '©', reg: '®', deg: '°', middot: '·', bull: '•',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç', euro: '€', times: '×'
};
for (const [base, conAcento] of [['a', 'á'], ['e', 'é'], ['i', 'í'], ['o', 'ó'], ['u', 'ú']]) {
  NOMBRADAS[`${base}acute`] = conAcento;
  NOMBRADAS[`${base.toUpperCase()}acute`] = conAcento.toUpperCase();
}

function decodificarEntidades(t) {
  return String(t).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (todo, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return ' ';
      return String.fromCodePoint(n);
    }
    return Object.prototype.hasOwnProperty.call(NOMBRADAS, e) ? NOMBRADAS[e] : todo;
  });
}

function quitarEtiquetas(t) {
  return String(t)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|blockquote|figure|figcaption)\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-zA-Z!][^>]*>/g, '');
}

// Contenido de un campo del feed -> texto plano de una línea (CDATA, HTML escapado y entidades incluidos)
function limpiarCampo(crudo) {
  if (crudo == null) return '';
  let t = String(crudo);
  let cdata = false;
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, dentro) => { cdata = true; return dentro; });
  if (!cdata) t = decodificarEntidades(t);
  const antes = t;
  t = quitarEtiquetas(t);
  if (cdata || t !== antes) t = decodificarEntidades(t);
  // Algunos feeds codifican dos veces ("&amp;amp;"): si quedó una entidad conocida, una pasada más
  if (/&(?:amp|lt|gt|quot|apos|nbsp|#d+|#x[0-9a-f]+);/i.test(t)) t = decodificarEntidades(t);
  return limpiarTexto(t);
}

// Quita colas de WordPress ("The post ... appeared first on ...") y marcas de "leer más"
function extractoDe(textoPlano, titulo = '') {
  let t = limpiarTexto(textoPlano)
    .replace(/\s*The post .{0,200}? appeared first on .{0,120}$/i, '')
    .replace(/\s*La entrada .{0,200}? se public[óo] primero en .{0,120}$/i, '')
    .replace(/\s*(?:\[(?:…|\.\.\.|&#8230;)\]|\(…\)|\.\.\.\s*$)\s*/g, '… ')
    .replace(/\s*(?:Leer m[aá]s|Seguir leyendo|Sigue leyendo|Continuar leyendo|Read more)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > MAX_EXTRACTO) {
    const corte = t.slice(0, MAX_EXTRACTO - 1);
    const espacio = corte.lastIndexOf(' ');
    t = (espacio > MAX_EXTRACTO * 0.6 ? corte.slice(0, espacio) : corte).replace(/[\s,.;:–—-]+$/, '') + '…';
  }
  t = recortar(t, MAX_EXTRACTO);
  return titulo && t.toLowerCase() === limpiarTexto(titulo).toLowerCase() ? '' : t;
}

// ── Lectura de RSS / Atom / RDF ──
function atributos(etiqueta) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(etiqueta)) !== null) attrs[m[1].toLowerCase()] = decodificarEntidades(m[2] !== undefined ? m[2] : m[3]);
  return attrs;
}

// Contenido crudo de la primera etiqueta <nombre ...>...</nombre> (no confunde con <link href=".."/>)
function contenidoDe(bloque, nombre) {
  const n = nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = bloque.match(new RegExp(`<${n}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${n}\\s*>`, 'i'));
  return m ? m[1] : '';
}

function etiquetasDe(bloque, nombre) {
  const n = nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return bloque.match(new RegExp(`<${n}(?=[\\s/>])[^>]*>`, 'gi')) || [];
}

const ES_IMAGEN = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#].*)?$/i;
const esTipoImagen = a => (a.medium === 'image') || /^image\//i.test(a.type || '') || (!a.type && !a.medium && ES_IMAGEN.test(a.url || ''));

function imagenDe(bloque) {
  const candidatas = [];
  for (const et of etiquetasDe(bloque, 'media:content')) { const a = atributos(et); if (a.url && esTipoImagen(a)) candidatas.push(a.url); }
  for (const et of etiquetasDe(bloque, 'media:thumbnail')) { const a = atributos(et); if (a.url) candidatas.push(a.url); }
  for (const et of etiquetasDe(bloque, 'enclosure')) { const a = atributos(et); if (a.url && esTipoImagen(a)) candidatas.push(a.url); }
  for (const et of etiquetasDe(bloque, 'link')) { const a = atributos(et); if (a.href && /enclosure/i.test(a.rel || '') && esTipoImagen({ ...a, url: a.href })) candidatas.push(a.href); }
  // Última opción: la primera <img> del contenido
  const html = [contenidoDe(bloque, 'content:encoded'), contenidoDe(bloque, 'description'), contenidoDe(bloque, 'content'), contenidoDe(bloque, 'summary')].join(' ');
  const visible = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (const fuente of [visible, decodificarEntidades(visible)]) {
    const m = fuente.match(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    if (m) { candidatas.push(decodificarEntidades(m[1] || m[2])); break; }
  }
  for (const c of candidatas) { const u = urlHttps(c.trim(), 400); if (u) return u; }
  return '';
}

function enlaceDe(bloque) {
  const original = limpiarCampo(contenidoDe(bloque, 'feedburner:origLink'));
  if (/^https?:\/\//i.test(original)) return original;
  const enTexto = limpiarCampo(contenidoDe(bloque, 'link'));
  if (/^https?:\/\//i.test(enTexto)) return enTexto;
  const atom = etiquetasDe(bloque, 'link').map(atributos).filter(a => a.href);
  const preferido = atom.find(a => !a.rel || a.rel === 'alternate') || atom[0];
  if (preferido && /^https?:\/\//i.test(preferido.href)) return preferido.href.trim();
  const guid = limpiarCampo(contenidoDe(bloque, 'guid') || contenidoDe(bloque, 'id'));
  return /^https?:\/\//i.test(guid) ? guid : '';
}

function fechaDe(bloque) {
  for (const n of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
    const t = limpiarCampo(contenidoDe(bloque, n));
    if (!t) continue;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// xml -> [{ titulo, link, resumen, imagen, fecha|null }]. No filtra: solo lee.
function parsearFeed(xml) {
  const items = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const bloque = m[2];
    const titulo = limpiarCampo(contenidoDe(bloque, 'title'));
    const link = enlaceDe(bloque);
    if (!titulo || !link) continue;
    const resumen = limpiarCampo(contenidoDe(bloque, 'description') || contenidoDe(bloque, 'summary') ||
      contenidoDe(bloque, 'content:encoded') || contenidoDe(bloque, 'content'));
    items.push({ titulo, link, resumen, imagen: imagenDe(bloque), fecha: fechaDe(bloque) });
  }
  return items;
}

// ── Filtros: español, relevancia y ruido ──
const plegar = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Prefijos de palabras (ya sin acentos): "conservaci" cubre conservación/conservacionista…
const RAICES = [
  'fauna', 'silvestre', 'biodiversidad', 'conservaci', 'especie', 'animal', 'bosque', 'selva', 'ecosistema', 'tortug',
  'abeja', 'apicul', 'apicola', 'colmena', 'polinizad', 'polinizaci', 'veterinari', 'zoologic', 'jaguar', 'felino', 'primate',
  'reptil', 'anfibi', 'mamifer', 'extinci', 'habitat', 'manglar', 'arrecife', 'serpiente', 'insecto', 'ballena', 'tiburon',
  'mariposa', 'monarca', 'coral', 'ecologi', 'parque nacional', 'area natural protegida', 'endemic', 'pangolin', 'murcielago',
  'aguila', 'condor', 'cocodril', 'iguana', 'delfin', 'cetace', 'ornitolog', 'conanp', 'conabio', 'semarnat', 'profepa',
  'zoonosis', 'trafico de fauna', 'trafico de especies', 'reintroduc', 'rescate de fauna', 'maltrato animal', 'biolog',
  'deforestaci', 'vida salvaje', 'depredador', 'cria en cautiverio'
];
// Palabras cortas que solo cuentan completas (para no coincidir dentro de otras: "oso" en "famoso")
const EXACTAS = ['ave', 'aves', 'oso', 'osos', 'lobo', 'lobos', 'rana', 'ranas', 'zoo', 'zoos', 'uma', 'umas', 'cites', 'wwf',
  'iucn', 'uicn', 'lince', 'foca', 'focas', 'loro', 'loros', 'tigre', 'tigres', 'puma', 'pumas'];
const RUIDO_RAICES = [
  'futbol', 'liga mx', 'champions league', 'seleccion nacional', 'deportiv', 'beisbol', 'nba', 'nfl', 'farandula', 'celebridad',
  'famoso', 'famosa', 'actriz', 'telenovela', 'reality', 'horoscopo', 'loteria', 'elecciones', 'candidato', 'campana electoral',
  'partido politico', 'diputad', 'senador', 'trump', 'biden', 'bitcoin', 'criptomoneda', 'bolsa de valores', 'nasdaq', 'netflix',
  'hollywood', 'videojuego', 'iphone', 'homicidio', 'asesinato', 'narcotraf', 'guerra en', 'bombardeo', 'receta de'
];

const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reRaices = new RegExp(`(?<![a-z0-9])(?:${RAICES.map(escapar).join('|')})`);
const reExactas = new RegExp(`(?<![a-z0-9])(?:${EXACTAS.map(escapar).join('|')})(?![a-z0-9])`);
const reRuido = new RegExp(`(?<![a-z0-9])(?:${RUIDO_RAICES.map(escapar).join('|')})`);

function esRelevante(titulo, extracto = '') {
  const t = plegar(`${titulo} ${extracto}`);
  if (reRuido.test(plegar(titulo)) || reRuido.test(t)) return false;
  return reRaices.test(t) || reExactas.test(t);
}

const PALABRAS_ES = ['de', 'la', 'el', 'en', 'que', 'los', 'las', 'del', 'y', 'con', 'por', 'una', 'un', 'para', 'se', 'su', 'al', 'es', 'como', 'más', 'sus', 'este', 'esta'];
const PALABRAS_EN = ['the', 'and', 'of', 'to', 'in', 'is', 'for', 'with', 'that', 'are', 'on', 'as', 'by', 'from', 'this', 'its', 'has', 'was', 'new', 'at'];
const setEs = new Set(PALABRAS_ES);
const setEn = new Set(PALABRAS_EN);

// Español si hay más palabras comunes del español que del inglés (y al menos 2); ñ, ¿ y ¡ ayudan
function esEspanol(t) {
  const palabras = String(t).toLowerCase().match(/[a-záéíóúüñ]+/g) || [];
  let es = 0; let en = 0;
  for (const p of palabras) { if (setEs.has(p)) es++; if (setEn.has(p)) en++; }
  if (/[ñ¿¡]/i.test(t)) es += 2;
  return es >= 2 && es > en;
}

const PISTAS_CATEGORIA = {
  apicultura: ['abeja', 'apicul', 'apicola', 'colmena', 'miel', 'polinizad'],
  veterinaria: ['veterinari', 'zoonosis', 'clinica', 'enfermedad', 'sanidad', 'zoologic', 'cirugia'],
  normativa: ['semarnat', 'profepa', 'norma oficial', 'nom-', 'ley ', 'reglamento', 'decreto', 'cites', 'normativ', 'legislaci', 'permiso'],
  conservacion: ['conservaci', 'extinci', 'reserva', 'area natural', 'proteccion', 'deforestaci', 'amenazad', 'restauraci'],
  fauna: ['fauna', 'jaguar', 'tortug', 'ave', 'aves', 'felino', 'reptil', 'mamifer', 'silvestre', 'serpiente', 'animal'],
  ciencia: ['biodiversidad', 'investigaci', 'cientific', 'estudio', 'genom', 'ecosistema', 'especie']
};

// Categoría por palabras (para fuentes sin categoría fija, como NewsData.io). Por defecto: ciencia.
function clasificar(t) {
  const p = plegar(t);
  let mejor = 'ciencia'; let puntos = 0;
  for (const cat of ORDEN_CATEGORIAS) {
    const n = (PISTAS_CATEGORIA[cat] || []).filter(k => p.includes(k)).length;
    if (n > puntos) { mejor = cat; puntos = n; }
  }
  return mejor;
}

// ── Identificador determinista: el mismo enlace da siempre el mismo id (no se duplica) ──
function normalizarLink(link) {
  try {
    const u = new URL(String(link).trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    return u.href.replace(/\/$/, '');
  } catch (_) { return String(link || '').trim(); }
}
function idDeLink(link) {
  return 'n_' + crypto.createHash('sha1').update(normalizarLink(link)).digest('hex').slice(0, 20);
}

// ── Descarga (fetch de Node, con tiempo máximo) ──
function mensajeDeError(error) {
  if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'Tiempo agotado';
  if (error && /^HTTP \d+$/.test(error.message || '')) return error.message;
  if (error && error.codigo) return error.codigo;
  return 'No se pudo conectar';
}

// Algunos medios (Mongabay, por ejemplo) bloquean a los lectores que no se identifican como navegador: se manda un User-Agent de navegador.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ZoorigenNoticias/1.0 (+https://www.zoorigen.com)';

async function descargar(url, { fetch: fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_FEED_MS, aceptar = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' } = {}) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, {
      signal: control.signal, redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: aceptar, 'Accept-Language': 'es' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const largo = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (Number.isFinite(largo) && largo > MAX_BYTES_FEED) throw Object.assign(new Error('grande'), { codigo: 'Respuesta demasiado grande' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES_FEED) throw Object.assign(new Error('grande'), { codigo: 'Respuesta demasiado grande' });
    // Codificación: la del encabezado, o la del prólogo XML; por defecto UTF-8
    const tipo = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
    const declarada = (tipo.match(/charset=([\w-]+)/i) || buf.subarray(0, 200).toString('latin1').match(/encoding=["']([\w-]+)["']/i) || [])[1];
    let decodificador;
    try { decodificador = new TextDecoder(declarada || 'utf-8'); } catch (_) { decodificador = new TextDecoder('utf-8'); }
    return decodificador.decode(buf);
  } finally {
    clearTimeout(reloj);
  }
}

// ── NewsData.io (opcional: solo si hay NEWSDATA_API_KEY) ──
const CONSULTA_NEWSDATA = '"fauna silvestre" OR biodiversidad OR "vida silvestre" OR veterinaria OR apicultura OR conservación';

async function leerNewsdata(llave, opciones) {
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(llave)}&language=es&q=${encodeURIComponent(CONSULTA_NEWSDATA)}`;
  const cuerpo = await descargar(url, { ...opciones, aceptar: 'application/json' });
  let datos;
  try { datos = JSON.parse(cuerpo); } catch (_) { throw Object.assign(new Error('json'), { codigo: 'Respuesta inválida' }); }
  if (!datos || datos.status === 'error' || !Array.isArray(datos.results)) throw Object.assign(new Error('api'), { codigo: 'Respuesta inválida' });
  return datos.results.map(r => ({
    titulo: limpiarCampo(r && r.title), link: String((r && r.link) || '').trim(), resumen: limpiarCampo(r && r.description),
    imagen: urlHttps(String((r && r.image_url) || '').trim(), 400),
    fecha: r && r.pubDate ? (Number.isNaN(new Date(String(r.pubDate).replace(' ', 'T') + 'Z').getTime()) ? null : new Date(String(r.pubDate).replace(' ', 'T') + 'Z').toISOString()) : null,
    nombreFuente: limpiarCampo(r && (r.source_name || r.source_id)) || 'NewsData.io'
  }));
}

// ── Sincronización ──
let sincronizacionEnCurso = null;

// Hasta `tope` noticias nuevas repartidas entre categorías (una por categoría en cada ronda; el orden
// de las categorías cambia con el día para no favorecer siempre a la misma).
function elegirNuevas(porCategoria, existentes, tope, ahora) {
  const dia = Math.floor(ahora.getTime() / 86400000);
  const n = ORDEN_CATEGORIAS.length;
  const orden = ORDEN_CATEGORIAS.map((_, i) => ORDEN_CATEGORIAS[(i + dia) % n]);
  const colas = new Map(orden.map(c => [c, (porCategoria.get(c) || []).filter(x => !existentes.has(x.id))]));
  const elegidas = [];
  while (elegidas.length < tope && [...colas.values()].some(q => q.length)) {
    for (const cat of orden) {
      const siguiente = colas.get(cat).shift();
      if (siguiente) elegidas.push(siguiente);
      if (elegidas.length >= tope) break;
    }
  }
  return elegidas;
}

// Borra las 'auto' de más de `dias` días (en lotes). Nunca toca origen:'admin'. Devuelve cuántas borró.
async function limpiarAntiguas(db, { ahora = new Date(), dias = DIAS_RETENCION } = {}) {
  const limite = ahora.getTime() - dias * 86400000;
  let borradas = 0;
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const snap = await db.collection('noticiasSector').where('origen', '==', 'auto').limit(500).get();
    const viejas = snap.docs.filter(d => {
      const iso = aIso((d.data() || {}).creadoEn);
      return !iso || Date.parse(iso) < limite;
    });
    for (let i = 0; i < viejas.length; i += LOTE_BORRADO) {
      const lote = db.batch();
      for (const d of viejas.slice(i, i + LOTE_BORRADO)) lote.delete(d.ref);
      await lote.commit();
    }
    borradas += viejas.length;
    if (!viejas.length || snap.docs.length < 500) break;
  }
  return borradas;
}

// Notas automáticas recientes que no tienen imagen y a las que aún les quedan intentos: se busca la de su página.
// Como máximo `RELLENO_POR_CORRIDA` por corrida, para no alargar la sincronización. Devuelve cuántas quedaron con imagen.
async function rellenarImagenes(db, opcionesImagen, { maximo = RELLENO_POR_CORRIDA, excluir = new Set() } = {}) {
  const snap = await db.collection('noticiasSector').orderBy('creadoEn', 'desc').limit(60).get();
  const pendientes = snap.docs
    .filter(d => {
      const x = d.data() || {};
      return !excluir.has(d.id) && x.origen === 'auto' && !urlHttps(String(x.imagen || ''), 400) && urlHttps(String(x.link || ''), 500) && (Number(x.imagenIntentos) || 0) < INTENTOS_IMAGEN;
    })
    .slice(0, maximo);
  if (!pendientes.length) return 0;
  const notas = pendientes.map(d => ({ ref: d.ref, link: String((d.data() || {}).link), intentos: Number((d.data() || {}).imagenIntentos) || 0, imagen: '' }));
  await imagenes.completarImagenes(notas, opcionesImagen);
  let rellenadas = 0;
  for (const n of notas) {
    await n.ref.set(n.imagen ? { imagen: n.imagen } : { imagenIntentos: n.intentos + 1 }, { merge: true });
    if (n.imagen) rellenadas++;
  }
  return rellenadas;
}

async function sincronizar(db, opciones) {
  const {
    ahora = new Date(), tope = TOPE_NUEVAS, maxDias = DIAS_RETENCION, timeoutMs = TIMEOUT_FEED_MS, limpiar = true
  } = opciones;
  const fuentesLista = Array.isArray(opciones.fuentes) ? opciones.fuentes : leerFuentes(opciones.fuentesRuta);
  const llave = opciones.newsdataKey !== undefined ? opciones.newsdataKey : (process.env.NEWSDATA_API_KEY || '').trim();
  const descarga = { fetch: opciones.fetch || globalThis.fetch, timeoutMs };
  const desde = ahora.getTime() - maxDias * 86400000;

  // Cada fuente en paralelo; una que falla no tumba a las demás
  const trabajos = fuentesLista.map(async f => {
    try {
      const items = parsearFeed(await descargar(f.url, descarga)).map(i => ({ ...i, nombreFuente: f.nombre, categoria: f.categoria }));
      return { id: f.id, ok: true, items };
    } catch (error) {
      return { id: f.id, ok: false, items: [], error: mensajeDeError(error) };
    }
  });
  if (llave) {
    trabajos.push((async () => {
      try {
        const items = (await leerNewsdata(llave, descarga)).map(i => ({ ...i, categoria: clasificar(`${i.titulo} ${i.resumen}`) }));
        return { id: 'newsdata', ok: true, items };
      } catch (error) {
        return { id: 'newsdata', ok: false, items: [], error: mensajeDeError(error) };
      }
    })());
  }
  const resultados = await Promise.all(trabajos);

  // Filtro: español, relevante, reciente, con título y enlace válidos; sin repetidos
  const vistos = new Set();
  const porCategoria = new Map();
  let leidos = 0;
  const fuentes = resultados.map(r => {
    leidos += r.items.length;
    let utiles = 0;
    for (const i of r.items) {
      const link = /^https?:\/\//i.test(i.link) ? i.link.trim().slice(0, 500) : '';
      const titulo = texto(i.titulo, 140);
      if (!link || titulo.length < 10) continue;
      const extracto = extractoDe(i.resumen, titulo);
      if (!esEspanol(`${titulo} ${extracto}`) || !esRelevante(titulo, extracto)) continue;
      const t = i.fecha ? Date.parse(i.fecha) : NaN;
      const fecha = Number.isNaN(t) ? ahora.toISOString() : new Date(Math.min(t, ahora.getTime())).toISOString();
      if (Date.parse(fecha) < desde) continue;
      const id = idDeLink(link);
      if (vistos.has(id)) continue;
      vistos.add(id);
      utiles++;
      const cat = CATEGORIAS[i.categoria] ? i.categoria : 'ciencia';
      const lista = porCategoria.get(cat) || [];
      lista.push({ id, titulo, extracto, link, fuente: texto(i.nombreFuente, 60), imagen: i.imagen || '', categoria: cat, fecha });
      porCategoria.set(cat, lista);
    }
    const salida = { id: r.id, ok: r.ok, items: utiles };
    if (!r.ok) salida.error = r.error;
    return salida;
  });
  for (const [cat, lista] of porCategoria) {
    porCategoria.set(cat, lista.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0)).slice(0, CANDIDATAS_POR_CATEGORIA));
  }

  // Cuáles ya existen (una sola lectura por lote) y cuáles se guardan
  const candidatas = [...porCategoria.values()].flat();
  const existentes = new Set();
  if (candidatas.length) {
    const docs = await db.getAll(...candidatas.map(c => db.collection('noticiasSector').doc(c.id)));
    docs.forEach((d, i) => { if (d.exists) existentes.add(candidatas[i].id); });
  }
  const elegidas = elegirNuevas(porCategoria, existentes, Math.max(0, tope), ahora);

  // Las que el feed no trajo con imagen: se busca la de su propia página (og:image). Solo durante la sincronización.
  const transporte = transporteImagenes(opciones);
  const opcionesImagen = transporte ? { ...transporte, timeoutMs: opciones.timeoutPaginaMs || imagenes.TIMEOUT_PAGINA_MS } : null;
  const resumenImagenes = { buscadas: 0, encontradas: 0, rellenadas: 0 };
  const buscadas = new Set(opcionesImagen ? elegidas.filter(n => !n.imagen && n.link).map(n => n.id) : []);
  if (opcionesImagen && buscadas.size) {
    try {
      const r = await imagenes.completarImagenes(elegidas, opcionesImagen);
      resumenImagenes.buscadas = r.buscadas;
      resumenImagenes.encontradas = r.encontradas;
    } catch (error) {
      console.error('[Noticias] No se pudo buscar las imágenes de las notas:', error && error.message);
    }
  }

  const nuevas = [];
  for (const [i, n] of elegidas.entries()) {
    const cat = CATEGORIAS[n.categoria];
    const doc = {
      id: n.id, titulo: n.titulo, extracto: n.extracto, link: n.link, fuente: n.fuente, imagen: n.imagen,
      categoria: n.categoria, categoriaNombre: cat.nombre, color: cat.color, fecha: n.fecha, origen: 'auto', idioma: 'es',
      // un milisegundo de diferencia por noticia para que el orden de la lista sea estable
      creadoEn: new Date(ahora.getTime() + i)
    };
    if (buscadas.has(n.id) && !n.imagen) doc.imagenIntentos = 1;
    await db.collection('noticiasSector').doc(n.id).set(doc);
    nuevas.push({ id: n.id, titulo: n.titulo, categoria: n.categoria });
  }

  // Las notas guardadas antes de esta función (o cuyo intento falló) reciben su imagen en la siguiente corrida
  if (opcionesImagen) {
    try {
      resumenImagenes.rellenadas = await rellenarImagenes(db, opcionesImagen, { excluir: new Set(nuevas.map(n => n.id)) });
    } catch (error) {
      console.error('[Noticias] No se pudo completar las imágenes de notas anteriores:', error && error.message);
    }
  }

  if (resumenImagenes.buscadas || resumenImagenes.rellenadas) {
    console.log(`[Noticias] Imágenes de la página de la nota: buscadas ${resumenImagenes.buscadas}, encontradas ${resumenImagenes.encontradas}, rellenadas en notas anteriores ${resumenImagenes.rellenadas}`);
  }

  let eliminadas = 0;
  if (limpiar) {
    try { eliminadas = await limpiarAntiguas(db, { ahora }); } catch (error) {
      console.error('[Noticias] No se pudo limpiar las noticias viejas:', error && error.message);
    }
  }
  try {
    await db.collection('config').doc('noticiasSector').set({ ultimaSync: ahora.toISOString(), ultimasGuardadas: nuevas.length, ultimasEliminadas: eliminadas }, { merge: true });
  } catch (error) {
    console.error('[Noticias] No se pudo guardar la fecha de la sincronización:', error && error.message);
  }
  return { guardadas: nuevas.length, omitidas: Math.max(0, leidos - nuevas.length), fuentes, eliminadas, nuevas, imagenes: resumenImagenes };
}

// Sincroniza ahora. Si ya hay una en curso, devuelve esa misma (no se encimen la tarea diaria y el botón del panel).
function syncNoticias(db, opciones = {}) {
  if (sincronizacionEnCurso) return sincronizacionEnCurso;
  sincronizacionEnCurso = sincronizar(db, opciones).finally(() => { sincronizacionEnCurso = null; });
  return sincronizacionEnCurso;
}

// ── Lectura para el sitio y el panel ──
function vistaNoticia(doc) {
  const d = doc.data() || {};
  const cat = CATEGORIAS[d.categoria] || CATEGORIAS.ciencia;
  const salida = {
    id: doc.id, titulo: String(d.titulo || ''), extracto: String(d.extracto || ''), link: String(d.link || ''),
    fuente: String(d.fuente || ''), imagen: urlHttps(String(d.imagen || ''), 400),
    categoria: CATEGORIAS[d.categoria] ? d.categoria : 'ciencia', categoriaNombre: String(d.categoriaNombre || cat.nombre),
    color: String(d.color || cat.color), fecha: aIso(d.fecha) || aIso(d.creadoEn), origen: d.origen === 'admin' ? 'admin' : 'auto'
  };
  if (d.plantilla) salida.plantilla = PLANTILLAS.includes(d.plantilla) ? d.plantilla : 'verde';
  if (Array.isArray(d.resumen)) salida.resumen = d.resumen.filter(x => typeof x === 'string').map(x => x.slice(0, 400)).slice(0, 12);
  return salida;
}

async function listarNoticias(db, limite = POR_DEFECTO_PUBLICAS) {
  const pedido = Math.floor(Number(limite));
  const n = pedido >= 1 ? Math.min(MAX_PUBLICAS, pedido) : POR_DEFECTO_PUBLICAS;
  const snap = await db.collection('noticiasSector').orderBy('creadoEn', 'desc').limit(n).get();
  return snap.docs.map(vistaNoticia);
}

async function listarNoticiasAdmin(db) {
  const snap = await db.collection('noticiasSector').orderBy('creadoEn', 'desc').limit(MAX_ADMIN).get();
  return snap.docs.map(vistaNoticia);
}

// ── Noticias propias del equipo ──
// Valida el cuerpo de POST /api/admin/noticias. Devuelve { error } o { datos }.
function validarNoticiaAdmin(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return { error: 'Faltan los datos de la noticia' };
  if (typeof cuerpo.titulo !== 'string') return { error: 'El título es obligatorio (de 8 a 140 caracteres)' };
  const titulo = limpiarTexto(cuerpo.titulo);
  if (titulo.length < 8 || titulo.length > 140) return { error: 'El título debe tener entre 8 y 140 caracteres' };

  const crudoResumen = Array.isArray(cuerpo.resumen) ? cuerpo.resumen.join('\n') : cuerpo.resumen;
  if (typeof crudoResumen !== 'string') return { error: 'El resumen es obligatorio (de 20 a 1500 caracteres)' };
  const lineas = limpiarTexto(crudoResumen, { saltos: true }).split('\n').map(l => l.trim()).filter(Boolean);
  const total = lineas.join('\n');
  if (total.length < 20 || total.length > 1500) return { error: 'El resumen debe tener entre 20 y 1500 caracteres' };
  if (lineas.length > 12) return { error: 'El resumen puede tener hasta 12 ideas (una por línea)' };
  if (lineas.some(l => l.length > 400)) return { error: 'Cada idea del resumen puede tener hasta 400 caracteres' };

  if (typeof cuerpo.categoria !== 'string' || !CATEGORIAS[cuerpo.categoria]) return { error: 'La categoría no es válida' };

  let fuente = 'Zoorigen';
  if (cuerpo.fuente !== undefined && cuerpo.fuente !== null && cuerpo.fuente !== '') {
    if (typeof cuerpo.fuente !== 'string') return { error: 'La fuente no es válida' };
    fuente = texto(cuerpo.fuente, 80);
    if (fuente.length < 2) return { error: 'La fuente debe tener al menos 2 caracteres' };
  }
  const enlaceOpcional = (valor, etiqueta) => {
    if (valor === undefined || valor === null || valor === '') return { valor: '' };
    const u = urlHttps(valor, 400);
    return u ? { valor: u } : { error: `${etiqueta} debe ser un enlace https válido` };
  };
  const imagen = enlaceOpcional(cuerpo.imagen, 'La imagen');
  if (imagen.error) return imagen;
  const link = enlaceOpcional(cuerpo.link, 'El enlace');
  if (link.error) return link;

  let plantilla = 'verde';
  if (cuerpo.plantilla !== undefined && cuerpo.plantilla !== null && cuerpo.plantilla !== '') {
    if (!PLANTILLAS.includes(cuerpo.plantilla)) return { error: 'La plantilla no es válida (verde, naranja o bicolor)' };
    plantilla = cuerpo.plantilla;
  }
  return { datos: { titulo, resumen: lineas, categoria: cuerpo.categoria, fuente, imagen: imagen.valor, link: link.valor, plantilla, avisar: cuerpo.avisar === true } };
}

// Guarda una noticia del equipo (id adm_<ms>, origen 'admin', nunca caduca). Devuelve el documento en vista.
async function publicarNoticiaAdmin(db, datos, { ahora = new Date() } = {}) {
  const cat = CATEGORIAS[datos.categoria];
  const base = `adm_${ahora.getTime()}`;
  const doc = {
    titulo: datos.titulo, extracto: extractoDe(datos.resumen.join(' ')), link: datos.link, fuente: datos.fuente, imagen: datos.imagen,
    categoria: datos.categoria, categoriaNombre: cat.nombre, color: cat.color, fecha: ahora.toISOString(), origen: 'admin',
    plantilla: datos.plantilla, resumen: datos.resumen, idioma: 'es', creadoEn: ahora
  };
  for (let n = 0; n < 5; n++) {
    const id = n ? `${base}_${n + 1}` : base;
    const ref = db.collection('noticiasSector').doc(id);
    const creada = await db.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) return false;
      tx.set(ref, { id, ...doc });
      return true;
    });
    if (creada) return vistaNoticia(await ref.get());
  }
  throw new Error('No se pudo asignar un identificador a la noticia');
}

// Borra una noticia (propia o automática). Devuelve false si no existía.
async function eliminarNoticia(db, id) {
  const ref = db.collection('noticiasSector').doc(id);
  if (!(await ref.get()).exists) return false;
  await ref.delete();
  return true;
}

module.exports = {
  CATEGORIAS, ORDEN_CATEGORIAS, PLANTILLAS, TOPE_NUEVAS, DIAS_RETENCION, MAX_EXTRACTO, RUTA_FUENTES,
  leerFuentes, decodificarEntidades, limpiarCampo, extractoDe, parsearFeed, esRelevante, esEspanol, clasificar,
  normalizarLink, idDeLink, descargar, elegirNuevas, limpiarAntiguas, rellenarImagenes, syncNoticias,
  vistaNoticia, listarNoticias, listarNoticiasAdmin, validarNoticiaAdmin, publicarNoticiaAdmin, eliminarNoticia
};
