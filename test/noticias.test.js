'use strict';

// Noticias del sector: lector RSS/Atom, filtros, extracto, sincronización (sin internet), limpieza y noticias del equipo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../services/noticias');
const { FakeFirestore } = require('./helpers/fake-firestore');
const { fixture, fuentesSinFixture, fetchFalso, respuestasDeFixtures, FUENTES } = require('./helpers/feeds');

const AHORA = new Date('2026-10-09T13:00:00Z');
const DIA = 86400000;
const hace = d => new Date(AHORA.getTime() - d * DIA);
const sync = (db, extra = {}) => N.syncNoticias(db, { ahora: AHORA, fuentes: fuentesSinFixture(), fetch: fetchFalso(respuestasDeFixtures()), newsdataKey: '', ...extra });
const ids = db => [...db._data.keys()].filter(k => k.startsWith('noticiasSector/')).map(k => k.split('/')[1]);

// ── Entidades, CDATA y extracto ──
test('decodificarEntidades: nombradas, decimales, hexadecimales; lo desconocido o inválido no rompe nada', () => {
  assert.equal(N.decodificarEntidades('a&amp;b &lt;i&gt; &quot;x&quot; &#39;y&#39; &nbsp;z'), "a&b <i> \"x\" 'y'  z");
  assert.equal(N.decodificarEntidades('&aacute;&eacute;&iacute;&oacute;&uacute;&ntilde;&Ntilde;&Aacute;'), 'áéíóúñÑÁ');
  assert.equal(N.decodificarEntidades('&#8230; &#x2014; &#xE1;'), '… — á');
  assert.equal(N.decodificarEntidades('&inventada; &'), '&inventada; &');
  assert.equal(N.decodificarEntidades('&#99999999; &#xD800;'), '   ', 'puntos de código inválidos se vuelven espacio');
});

test('limpiarCampo: CDATA, HTML escapado, etiquetas, scripts y doble codificación', () => {
  assert.equal(N.limpiarCampo('<![CDATA[Hola <b>mundo</b> &amp; todos]]>'), 'Hola mundo & todos');
  assert.equal(N.limpiarCampo('&lt;p&gt;Texto &amp;aacute; escapado&lt;/p&gt;'), 'Texto á escapado');
  assert.equal(N.limpiarCampo('<![CDATA[<p>uno</p><p>dos</p><script>alert(1)</script><style>p{}</style>]]>'), 'uno dos');
  assert.equal(N.limpiarCampo('Manglar &amp;amp; costa'), 'Manglar & costa');
  assert.equal(N.limpiarCampo('a < b y c > d'), 'a < b y c > d', 'un "<" suelto no es una etiqueta');
  assert.equal(N.limpiarCampo(null), '');
  assert.equal(N.limpiarCampo('  varias \n\n  líneas\t aquí '), 'varias líneas aquí');
});

test('extractoDe: máximo 280 caracteres, sin HTML, sin colas de WordPress ni "leer más"', () => {
  const largo = 'La conservación de la fauna silvestre requiere trabajo constante. '.repeat(10);
  const e = N.extractoDe(largo);
  assert.ok(e.length <= 280, String(e.length));
  assert.ok(e.endsWith('…'));
  assert.ok(!/\s…$/.test(e), 'no deja espacio antes de los puntos suspensivos');
  assert.equal(N.extractoDe('Un jaguar cruzó el río. The post Jaguar appeared first on Mongabay.'), 'Un jaguar cruzó el río.');
  assert.equal(N.extractoDe('Resumen corto. La entrada Jaguares se publicó primero en Ambientum.'), 'Resumen corto.');
  assert.equal(N.extractoDe('Resumen de la nota. Leer más »'), 'Resumen de la nota.');
  assert.equal(N.extractoDe('Texto […]'), 'Texto…');
  assert.equal(N.extractoDe('Mismo título', 'mismo título'), '', 'si repite el título no sirve como extracto');
  assert.equal(N.extractoDe('x'.repeat(500)).length, 280);
});

// ── Lector de feeds ──
test('parsearFeed RSS (Mongabay): CDATA, imagen de media:content, enlace con parámetros y fecha', () => {
  const items = N.parsearFeed(fixture('feed-mongabay').toString('utf8'));
  assert.equal(items.length, 6);
  const j = items[0];
  assert.equal(j.titulo, 'Jaguares regresan a la selva Maya tras años de reforestación');
  assert.equal(j.link, 'https://es.mongabay.com/2026/10/jaguares-selva-maya/?utm_source=rss&utm_medium=rss');
  assert.equal(j.imagen, 'https://es.mongabay.com/wp-content/uploads/2026/10/jaguar.jpg', 'media:content gana a la <img> del contenido');
  assert.equal(j.fecha, '2026-10-07T14:30:00.000Z');
  assert.ok(!/<|CDATA/.test(j.resumen));
  assert.ok(!j.resumen.includes('Texto completo'), 'nunca se toma el artículo completo');
});

test('parsearFeed: imágenes http se descartan (solo https)', () => {
  const manglar = N.parsearFeed(fixture('feed-mongabay').toString('utf8')).find(i => i.link.includes('manglar'));
  assert.equal(manglar.imagen, '');
  assert.ok(manglar.resumen.includes('manglar & vigilan'), 'doble codificación resuelta');
});

test('parsearFeed RDF (DW): items con rdf:about, HTML escapado y entidades acentuadas', () => {
  const items = N.parsearFeed(fixture('feed-dw-rdf').toString('utf8'));
  assert.equal(items.length, 2, 'el <items> del canal no cuenta como nota');
  assert.equal(items[0].titulo, 'Descubren una nueva especie de rana en los Andes de Ecuador');
  assert.equal(items[0].link, 'https://www.dw.com/es/nueva-especie-rana-ecuador/a-100000001');
  assert.equal(items[0].resumen, 'Hallazgo en el bosque nublado: una rana de color intenso que solo vive allí — según biólogos "ya está amenazada".');
  assert.equal(items[0].fecha, '2026-10-08T09:00:00.000Z');
});

test('parsearFeed Atom: enlace alternate (no self), enlace enclosure como imagen, summary html, miniatura', () => {
  const items = N.parsearFeed(fixture('feed-atom-apicultura').toString('utf8'));
  assert.equal(items.length, 3);
  assert.equal(items[0].titulo, 'Abejas melíferas en riesgo por plaguicidas, alertan apicultores');
  assert.equal(items[0].link, 'https://apicultura.example.org/abejas-plaguicidas');
  assert.equal(items[0].imagen, 'https://apicultura.example.org/img/abejas.jpg');
  assert.equal(items[0].fecha, '2026-10-06T07:00:00.000Z', 'published gana a updated');
  assert.ok(items[0].resumen.startsWith('Las colmenas pierden población'));
  assert.equal(items[1].link, 'https://apicultura.example.org/receta-pastel');
  assert.equal(items[1].imagen, 'https://apicultura.example.org/img/pastel.jpg', 'media:thumbnail');
});

test('parsearFeed RSS con enclosure de imagen y fecha GMT', () => {
  const items = N.parsearFeed(fixture('feed-natgeo').toString('utf8'));
  assert.equal(items.length, 5);
  assert.equal(items[0].imagen, 'https://www.nationalgeographic.com.es/img/aguila.jpg');
  assert.equal(items[0].fecha, '2026-10-08T12:00:00.000Z');
});

test('parsearFeed: basura, XML vacío o a medias no lanza; sin título o sin enlace se omite', () => {
  assert.deepEqual(N.parsearFeed(''), []);
  assert.deepEqual(N.parsearFeed(null), []);
  assert.deepEqual(N.parsearFeed('<html><body>No soy un feed</body></html>'), []);
  assert.deepEqual(N.parsearFeed('<rss><channel><item><title>Sin cierre'), []);
  assert.deepEqual(N.parsearFeed('<rss><item><title>Solo título</title></item></rss>'), []);
  assert.deepEqual(N.parsearFeed('<rss><item><link>https://a.com/x</link></item></rss>'), []);
  const javascript = N.parsearFeed('<rss><item><title>Enlace malo para probar</title><link>javascript:alert(1)</link></item></rss>');
  assert.deepEqual(javascript, []);
});

test('descargar respeta la codificación declarada (ISO-8859-1) y falla con HTTP de error', async () => {
  const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><rss><item><title>Año de la tortuga marina</title><link>https://a.com/x</link></item></rss>';
  const f = fetchFalso({ 'https://a.com/feed': Buffer.from(xml, 'latin1') });
  const texto = await N.descargar('https://a.com/feed', { fetch: f });
  assert.equal(N.parsearFeed(texto)[0].titulo, 'Año de la tortuga marina');
  await assert.rejects(N.descargar('https://a.com/otro', { fetch: f }), /HTTP 404/);
});

// ── Filtros ──
test('esEspanol: reconoce español y rechaza inglés', () => {
  assert.equal(N.esEspanol('Los jaguares regresan a la selva tras años de reforestación'), true);
  assert.equal(N.esEspanol('Wild jaguars return to the Maya forest and the camera traps confirm it'), false);
  assert.equal(N.esEspanol('Jaguar'), false);
  assert.equal(N.esEspanol('¡Increíble! Año nuevo'), true);
});

test('esRelevante: temas del sector sí; ruido (deportes, farándula, política, bolsa) no; palabras cortas solo completas', () => {
  const si = [
    'Rescate de fauna silvestre en Jalisco', 'La Profepa decomisa especies protegidas', 'Nueva norma de la Semarnat para la vida silvestre',
    'Abejas y apicultura: un año difícil', 'Veterinarios del zoológico operan a un oso', 'CITES amplía la protección de tiburones',
    'Una rana endémica reaparece', 'Biodiversidad en riesgo por la deforestación', 'Los lobos regresan'
  ];
  const no = [
    'El fútbol mexicano vive su mejor torneo', 'La actriz famosa se casa en secreto', 'Elecciones: el candidato presenta su plan', 'La bolsa de valores sube',
    'Receta de pastel para el domingo', 'El famoso cantante estrena disco', 'Netflix estrena una serie', 'Un modelo de teléfono nuevo en el mercado',
    'La osorio gana la copa', 'Crece el uso de la moneda digital'
  ];
  for (const t of si) assert.equal(N.esRelevante(t), true, t);
  for (const t of no) assert.equal(N.esRelevante(t), false, t);
  assert.equal(N.esRelevante('Tigres de la UANL y su fauna de mascota', 'Resumen sobre fútbol'), false, 'el ruido gana');
});

test('clasificar: categoría por palabras y ciencia por defecto', () => {
  assert.equal(N.clasificar('Abejas y colmenas en peligro'), 'apicultura');
  assert.equal(N.clasificar('La Semarnat publica un nuevo decreto y reglamento'), 'normativa');
  assert.equal(N.clasificar('Clínica veterinaria atiende un caso de zoonosis'), 'veterinaria');
  assert.equal(N.clasificar('Algo sin pistas claras'), 'ciencia');
});

test('idDeLink: determinista, ignora parámetros de seguimiento, mayúsculas del dominio y la barra final', () => {
  const a = N.idDeLink('https://Es.Mongabay.com/2026/10/jaguares/?utm_source=rss&utm_medium=x#comentarios');
  assert.equal(a, N.idDeLink('https://es.mongabay.com/2026/10/jaguares'));
  assert.notEqual(a, N.idDeLink('https://es.mongabay.com/2026/10/otra-nota'));
  assert.match(a, /^n_[0-9a-f]{20}$/);
});

// ── Fuentes ──
test('data/noticias-fuentes.json es válido y trae las fuentes de partida', () => {
  const f = N.leerFuentes();
  assert.ok(f.length >= 4);
  assert.deepEqual(f.map(x => x.id).slice(0, 3), ['mongabay-latam', 'dw-ambiente', 'natgeo-animales']);
  for (const x of f) {
    assert.match(x.url, /^https:\/\//);
    assert.ok(N.CATEGORIAS[x.categoria], x.id);
  }
});

test('leerFuentes descarta lo inválido (http, categoría desconocida, repetidos) y no lanza con archivo roto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuentes-'));
  const ruta = path.join(dir, 'f.json');
  fs.writeFileSync(ruta, JSON.stringify([
    { id: 'ok', nombre: 'Buena', url: 'https://a.com/feed', categoria: 'fauna' },
    { id: 'http', nombre: 'Sin https', url: 'http://a.com/feed', categoria: 'fauna' },
    { id: 'cat', nombre: 'Categoría mala', url: 'https://a.com/f2', categoria: 'deportes' },
    { id: 'ok', nombre: 'Repetida', url: 'https://a.com/f3', categoria: 'fauna' },
    { id: 'x y', nombre: 'Id raro', url: 'https://a.com/f4', categoria: 'fauna' },
    null, 5, { id: 'sin-url', nombre: 'n', categoria: 'fauna' }
  ]));
  assert.deepEqual(N.leerFuentes(ruta).map(x => x.id), ['ok']);
  fs.writeFileSync(ruta, '{ no es json');
  const original = console.error; console.error = () => {};
  try { assert.deepEqual(N.leerFuentes(ruta), []); assert.deepEqual(N.leerFuentes(path.join(dir, 'no-existe.json')), []); } finally { console.error = original; }
  fs.writeFileSync(ruta, '{"a":1}');
  assert.deepEqual(N.leerFuentes(ruta), []);
});

// ── Sincronización ──
test('syncNoticias guarda como máximo 4, una por categoría, y solo lo relevante, en español y reciente', async () => {
  const db = new FakeFirestore();
  const r = await sync(db);
  assert.equal(r.guardadas, 4);
  assert.deepEqual(r.fuentes, [
    { id: 'mongabay', ok: true, items: 2 },   // jaguares y manglar (fútbol, inglés, repetido y nota de 2025 quedan fuera)
    { id: 'dw', ok: true, items: 1 },
    { id: 'natgeo', ok: true, items: 5 },
    { id: 'apicultura', ok: true, items: 2 }
  ]);
  assert.equal(r.omitidas, 16 - 4, '16 notas leídas en total, 4 guardadas');
  const docs = ids(db).map(id => db.value(`noticiasSector/${id}`));
  assert.equal(docs.length, 4);
  assert.deepEqual(docs.map(d => d.categoria).sort(), ['apicultura', 'ciencia', 'conservacion', 'fauna']);
  for (const d of docs) {
    assert.equal(d.origen, 'auto');
    assert.equal(d.idioma, 'es');
    assert.equal(d.categoriaNombre, N.CATEGORIAS[d.categoria].nombre);
    assert.equal(d.color, N.CATEGORIAS[d.categoria].color);
    assert.ok(d.extracto.length <= 280 && !/[<>]/.test(d.extracto));
    assert.ok(d.titulo && d.link.startsWith('http') && d.fuente);
    assert.ok(d.imagen === '' || d.imagen.startsWith('https://'));
    assert.match(d.id, /^n_[0-9a-f]{20}$/);
    assert.ok(!('contenido' in d) && !('resumen' in d), 'solo titular y extracto, nunca el artículo');
  }
  const jaguar = docs.find(d => d.categoria === 'conservacion');
  assert.equal(jaguar.titulo, 'Jaguares regresan a la selva Maya tras años de reforestación');
  assert.equal(jaguar.fuente, 'Mongabay Latam');
  assert.equal(jaguar.fecha, '2026-10-07T14:30:00.000Z');
  assert.equal(db.value('config/noticiasSector').ultimaSync, AHORA.toISOString());
});

test('syncNoticias no duplica: cada corrida trae noticias distintas hasta agotar las nuevas', async () => {
  const db = new FakeFirestore();
  const guardadas = [];
  for (let i = 0; i < 4; i++) { guardadas.push((await sync(db)).guardadas); }
  assert.deepEqual(guardadas, [4, 4, 2, 0], '10 notas útiles en total, tope de 4 por corrida');
  assert.equal(new Set(ids(db)).size, 10);
});

test('syncNoticias: lo que ya existe no se reescribe', async () => {
  const db = new FakeFirestore();
  const id = N.idDeLink('https://es.mongabay.com/2026/10/jaguares-selva-maya/');
  const previo = { id, titulo: 'EDITADA A MANO', origen: 'admin', link: 'https://es.mongabay.com/2026/10/jaguares-selva-maya/', creadoEn: hace(1) };
  db._data.set(`noticiasSector/${id}`, previo);
  await sync(db, { tope: 20 });
  assert.equal(db.value(`noticiasSector/${id}`).titulo, 'EDITADA A MANO');
  assert.equal(ids(db).length, 10);
});

test('syncNoticias: un feed que falla (red, HTTP 500, tiempo agotado) no tumba a los demás', async () => {
  const respuestas = respuestasDeFixtures();
  respuestas['https://es.mongabay.com/feed/'] = new Error('ECONNRESET con datos internos');
  respuestas['https://rss.dw.com/rdf/rss-sp-eco'] = new Response('error', { status: 500 });
  respuestas['https://www.nationalgeographic.com.es/rss/animales'] = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const db = new FakeFirestore();
  const r = await sync(db, { fetch: fetchFalso(respuestas), timeoutMs: 40 });
  assert.deepEqual(r.fuentes, [
    { id: 'mongabay', ok: false, items: 0, error: 'No se pudo conectar' },
    { id: 'dw', ok: false, items: 0, error: 'HTTP 500' },
    { id: 'natgeo', ok: false, items: 0, error: 'Tiempo agotado' },
    { id: 'apicultura', ok: true, items: 2 }
  ]);
  assert.equal(r.guardadas, 2, 'solo las 2 de apicultura');
  assert.ok(!JSON.stringify(r).includes('datos internos'), 'el mensaje interno del error no se expone');
});

test('syncNoticias: XML basura de una fuente no lanza', async () => {
  const respuestas = respuestasDeFixtures();
  respuestas['https://es.mongabay.com/feed/'] = '<html>404 disfrazado</html>';
  const r = await sync(new FakeFirestore(), { fetch: fetchFalso(respuestas) });
  assert.deepEqual(r.fuentes[0], { id: 'mongabay', ok: true, items: 0 });
  assert.equal(r.guardadas, 4);
});

test('syncNoticias descarga las fuentes en paralelo (una lenta no suma el tiempo de todas)', async () => {
  let activas = 0; let maximo = 0;
  const lenta = async () => {
    activas++; maximo = Math.max(maximo, activas);
    await new Promise(r => setTimeout(r, 20));
    activas--;
    return fixture('feed-natgeo');
  };
  const respuestas = Object.fromEntries(FUENTES.map(f => [f.url, lenta]));
  await sync(new FakeFirestore(), { fetch: fetchFalso(respuestas) });
  assert.equal(maximo, 4);
});

test('syncNoticias: dos llamadas a la vez comparten la misma sincronización', async () => {
  const f = fetchFalso(respuestasDeFixtures());
  const db = new FakeFirestore();
  const [a, b] = await Promise.all([sync(db, { fetch: f }), sync(db, { fetch: f })]);
  assert.equal(a, b);
  assert.equal(f.llamadas.length, 4);
  assert.equal(ids(db).length, 4);
});

test('syncNoticias: sin fuentes o con la lista vacía guarda cero y no falla', async () => {
  const r = await sync(new FakeFirestore(), { fuentes: [] });
  assert.deepEqual([r.guardadas, r.omitidas, r.fuentes], [0, 0, []]);
});

test('syncNoticias: las notas de más de 21 días no se guardan y una fecha futura se pone en "ahora"', async () => {
  const xml = `<rss><channel>
    <item><title>Tortugas marinas anidan en una playa de Michoacán</title><link>https://a.com/vieja</link><pubDate>${hace(25).toUTCString()}</pubDate><description>Las tortugas marinas llegaron a la playa durante la noche con apoyo de la comunidad.</description></item>
    <item><title>Jaguares captados por cámaras trampa en Campeche hoy</title><link>https://a.com/futura</link><pubDate>${new Date(AHORA.getTime() + 5 * DIA).toUTCString()}</pubDate><description>Las cámaras de la reserva registraron al jaguar con sus crías en la selva baja.</description></item>
    <item><title>Rescatan fauna silvestre atrapada tras un incendio forestal</title><link>https://a.com/sinfecha</link><description>Los rescatistas liberaron a varios animales silvestres en un bosque de la sierra.</description></item>
  </channel></rss>`;
  const db = new FakeFirestore();
  const r = await sync(db, { fuentes: [{ id: 'x', nombre: 'X', url: 'https://a.com/feed', categoria: 'fauna' }], fetch: fetchFalso({ 'https://a.com/feed': xml }) });
  assert.equal(r.guardadas, 2);
  const fechas = ids(db).map(id => db.value(`noticiasSector/${id}`).fecha);
  assert.deepEqual(fechas, [AHORA.toISOString(), AHORA.toISOString()]);
});

// ── NewsData.io (opcional) ──
const respuestaNewsdata = () => JSON.stringify({
  status: 'success',
  results: [
    { title: 'Nueva ley protege a las abejas y la apicultura en la región', link: 'https://nd.example.com/abejas', description: 'El congreso aprobó medidas para proteger la apicultura y las colmenas en todo el país.', pubDate: '2026-10-08 10:00:00', image_url: 'https://nd.example.com/abejas.jpg', source_name: 'Diario Verde' },
    { title: 'Resultados del fútbol del fin de semana en la liga', link: 'https://nd.example.com/futbol', description: 'Todos los goles del torneo.', pubDate: '2026-10-08 10:00:00' }
  ]
});

test('NewsData.io: solo se consulta si hay llave; usa language=es y clasifica la nota', async () => {
  const f = fetchFalso({ ...respuestasDeFixtures(), 'https://newsdata.io/api/1/latest': respuestaNewsdata() });
  const db = new FakeFirestore();
  const r = await sync(db, { fuentes: [], fetch: f, newsdataKey: 'llave-secreta-123' });
  assert.deepEqual(r.fuentes, [{ id: 'newsdata', ok: true, items: 1 }]);
  assert.equal(r.guardadas, 1);
  const url = f.llamadas[0];
  assert.match(url, /^https:\/\/newsdata\.io\/api\/1\/latest\?/);
  assert.match(url, /language=es/);
  assert.match(url, /q=/);
  const d = db.value(`noticiasSector/${ids(db)[0]}`);
  assert.equal(d.categoria, 'apicultura');
  assert.equal(d.fuente, 'Diario Verde');
  assert.equal(d.imagen, 'https://nd.example.com/abejas.jpg');
  assert.equal(d.fecha, '2026-10-08T10:00:00.000Z');

  const sinLlave = fetchFalso({});
  await sync(new FakeFirestore(), { fuentes: [], fetch: sinLlave, newsdataKey: '' });
  assert.equal(sinLlave.llamadas.length, 0, 'sin llave no se llama a NewsData.io');
});

test('NewsData.io: si falla, el error no revela la llave y no afecta a los RSS', async () => {
  const f = fetchFalso({ ...respuestasDeFixtures(), 'https://newsdata.io/api/1/latest': new Response('{"status":"error"}', { status: 401 }) });
  const r = await sync(new FakeFirestore(), { fetch: f, newsdataKey: 'llave-secreta-123' });
  const nd = r.fuentes.find(x => x.id === 'newsdata');
  assert.deepEqual(nd, { id: 'newsdata', ok: false, items: 0, error: 'HTTP 401' });
  assert.equal(r.guardadas, 4);
  assert.ok(!JSON.stringify(r).includes('llave-secreta-123'));
});

// ── Limpieza ──
test('limpiarAntiguas borra las auto de más de 21 días y NUNCA las del equipo', async () => {
  const db = new FakeFirestore({
    'noticiasSector/vieja': { origen: 'auto', creadoEn: hace(22), titulo: 'vieja' },
    'noticiasSector/limite': { origen: 'auto', creadoEn: hace(20.9), titulo: 'casi' },
    'noticiasSector/nueva': { origen: 'auto', creadoEn: hace(2), titulo: 'nueva' },
    'noticiasSector/adm_vieja': { origen: 'admin', creadoEn: hace(300), titulo: 'del equipo' },
    'noticiasSector/adm_nueva': { origen: 'admin', creadoEn: hace(1), titulo: 'del equipo 2' }
  });
  const borradas = await N.limpiarAntiguas(db, { ahora: AHORA });
  assert.equal(borradas, 1);
  assert.deepEqual(ids(db).sort(), ['adm_nueva', 'adm_vieja', 'limite', 'nueva']);
});

test('limpiarAntiguas borra en lotes de 400 como máximo', async () => {
  const seed = {};
  for (let i = 0; i < 950; i++) seed[`noticiasSector/v${i}`] = { origen: 'auto', creadoEn: hace(40), titulo: `v${i}` };
  seed['noticiasSector/adm'] = { origen: 'admin', creadoEn: hace(400) };
  const db = new FakeFirestore(seed);
  const tamanos = [];
  const crear = db.batch.bind(db);
  db.batch = () => {
    const lote = crear(); let n = 0;
    const borrar = lote.delete; lote.delete = ref => { n++; return borrar(ref); };
    const confirmar = lote.commit; lote.commit = async () => { tamanos.push(n); return confirmar(); };
    return lote;
  };
  assert.equal(await N.limpiarAntiguas(db, { ahora: AHORA }), 950);
  assert.ok(tamanos.length >= 3 && tamanos.every(t => t <= 400), String(tamanos));
  assert.deepEqual(ids(db), ['adm']);
});

test('syncNoticias también limpia y reporta cuántas borró; con limpiar:false no toca nada', async () => {
  const seed = { 'noticiasSector/vieja': { origen: 'auto', creadoEn: hace(30) }, 'noticiasSector/adm': { origen: 'admin', creadoEn: hace(30) } };
  const db = new FakeFirestore(seed);
  const r = await sync(db, { limpiar: false });
  assert.equal(r.eliminadas, 0);
  assert.ok(db.value('noticiasSector/vieja'));
  const r2 = await sync(db);
  assert.equal(r2.eliminadas, 1);
  assert.equal(db.value('noticiasSector/vieja'), undefined);
  assert.ok(db.value('noticiasSector/adm'));
});

// ── Elección por categorías ──
test('elegirNuevas reparte entre categorías y respeta el tope', () => {
  const c = (id, categoria) => ({ id, categoria });
  const porCategoria = new Map([
    ['fauna', [c('f1', 'fauna'), c('f2', 'fauna'), c('f3', 'fauna'), c('f4', 'fauna')]],
    ['apicultura', [c('a1', 'apicultura')]]
  ]);
  const e = N.elegirNuevas(porCategoria, new Set(['f1']), 4, AHORA);
  assert.equal(e.length, 4);
  assert.ok(!e.some(x => x.id === 'f1'), 'las que ya existen se saltan');
  assert.ok(e.some(x => x.id === 'a1'), 'la categoría con una sola nota entra');
  assert.deepEqual(N.elegirNuevas(new Map(), new Set(), 4, AHORA), []);
  assert.equal(N.elegirNuevas(porCategoria, new Set(), 0, AHORA).length, 0);
});

// ── Noticias del equipo ──
const valida = (extra = {}) => ({
  titulo: 'Nueva guía para el manejo de fauna', resumen: 'Primera idea importante del tema.\nSegunda idea con más detalle.', categoria: 'fauna',
  fuente: 'Zoorigen', imagen: 'https://cdn.example.com/a.jpg', link: 'https://example.com/nota', plantilla: 'bicolor', avisar: true, ...extra
});

test('validarNoticiaAdmin acepta una noticia correcta y normaliza', () => {
  const r = N.validarNoticiaAdmin(valida({ titulo: '  Nueva   guía para el manejo de fauna ', resumen: 'Idea uno de la nota.\r\n\r\n\r\nIdea dos de la nota.' }));
  assert.equal(r.error, undefined);
  assert.equal(r.datos.titulo, 'Nueva guía para el manejo de fauna');
  assert.deepEqual(r.datos.resumen, ['Idea uno de la nota.', 'Idea dos de la nota.']);
  assert.equal(r.datos.avisar, true);
  const minima = N.validarNoticiaAdmin({ titulo: 'Título de ocho', resumen: 'Resumen de veinte caracteres', categoria: 'ciencia' });
  assert.deepEqual([minima.datos.fuente, minima.datos.imagen, minima.datos.link, minima.datos.plantilla, minima.datos.avisar], ['Zoorigen', '', '', 'verde', false]);
});

test('validarNoticiaAdmin rechaza entradas inválidas', () => {
  const malas = [
    null, undefined, 'x', 5, [], {},
    valida({ titulo: 'corto' }), valida({ titulo: 'x'.repeat(141) }), valida({ titulo: 5 }), valida({ titulo: undefined }),
    valida({ resumen: 'muy corto' }), valida({ resumen: 'x'.repeat(1501) }), valida({ resumen: 5 }), valida({ resumen: undefined }),
    valida({ resumen: Array.from({ length: 13 }, (_, i) => `Idea número ${i} con texto`).join('\n') }),
    valida({ resumen: 'x'.repeat(401) }),
    valida({ categoria: 'deportes' }), valida({ categoria: undefined }), valida({ categoria: ['fauna'] }),
    valida({ plantilla: 'rosa' }), valida({ plantilla: 5 }),
    valida({ imagen: 'http://a.com/x.jpg' }), valida({ imagen: 'javascript:alert(1)' }), valida({ imagen: 5 }), valida({ imagen: 'https://a.com/"x' }),
    valida({ link: 'ftp://a.com' }), valida({ link: 'no es enlace' }), valida({ link: 'https://user:pass@a.com/x' }),
    valida({ fuente: 5 }), valida({ fuente: 'x' })
  ];
  for (const m of malas) {
    const r = N.validarNoticiaAdmin(m);
    assert.ok(r.error && !r.datos, String(JSON.stringify(m)).slice(0, 90));
  }
});

test('validarNoticiaAdmin: el texto se guarda tal cual (sin escapar) pero sin caracteres de control', () => {
  const r = N.validarNoticiaAdmin(valida({ titulo: 'Guía <b>nueva</b> & "útil"\u0000‮', resumen: 'Idea <i>uno</i> importante​ de la nota.' }));
  assert.equal(r.datos.titulo, 'Guía <b>nueva</b> & "útil"');
  assert.deepEqual(r.datos.resumen, ['Idea <i>uno</i> importante de la nota.']);
});

test('publicarNoticiaAdmin guarda origen admin con id adm_<ts>, plantilla y resumen por ideas; dos en el mismo milisegundo no chocan', async () => {
  const db = new FakeFirestore();
  const datos = N.validarNoticiaAdmin(valida()).datos;
  const a = await N.publicarNoticiaAdmin(db, datos, { ahora: AHORA });
  const b = await N.publicarNoticiaAdmin(db, datos, { ahora: AHORA });
  assert.equal(a.id, `adm_${AHORA.getTime()}`);
  assert.notEqual(a.id, b.id);
  assert.equal(a.origen, 'admin');
  assert.equal(a.plantilla, 'bicolor');
  assert.deepEqual(a.resumen, ['Primera idea importante del tema.', 'Segunda idea con más detalle.']);
  assert.equal(a.categoriaNombre, 'Fauna silvestre');
  assert.equal(a.color, '#2F7A4F');
  assert.equal(a.extracto, 'Primera idea importante del tema. Segunda idea con más detalle.');
  assert.equal(a.fecha, AHORA.toISOString());
  assert.equal(a.imagen, 'https://cdn.example.com/a.jpg');
  assert.equal(db.value(`noticiasSector/${a.id}`).idioma, 'es');
});

test('listarNoticias: más recientes primero, máximo 30, por defecto 7, y la imagen solo si es https', async () => {
  const seed = {};
  for (let i = 0; i < 40; i++) {
    seed[`noticiasSector/n${String(i).padStart(2, '0')}`] = {
      titulo: `Nota ${i}`, extracto: 'e', link: 'https://a.com/x', fuente: 'F', imagen: i === 39 ? 'http://inseguro.com/a.jpg' : (i === 38 ? 'javascript:alert(1)' : 'https://a.com/i.jpg'),
      categoria: 'fauna', categoriaNombre: 'Fauna silvestre', color: '#2F7A4F', fecha: hace(40 - i).toISOString(), origen: 'auto', creadoEn: hace(40 - i)
    };
  }
  const db = new FakeFirestore(seed);
  const porDefecto = await N.listarNoticias(db);
  assert.equal(porDefecto.length, 7);
  assert.equal(porDefecto[0].id, 'n39');
  assert.equal(porDefecto[0].imagen, '', 'http no pasa');
  assert.equal(porDefecto[1].imagen, '', 'javascript: no pasa');
  assert.equal(porDefecto[2].imagen, 'https://a.com/i.jpg');
  assert.equal((await N.listarNoticias(db, 100)).length, 30);
  assert.equal((await N.listarNoticias(db, 3)).length, 3);
  assert.equal((await N.listarNoticias(db, 0)).length, 7);
  assert.equal((await N.listarNoticias(db, 'x')).length, 7);
  assert.deepEqual(Object.keys(porDefecto[2]).sort(), ['categoria', 'categoriaNombre', 'color', 'extracto', 'fecha', 'fuente', 'id', 'imagen', 'link', 'origen', 'titulo']);
});

test('eliminarNoticia: true si existía, false si no', async () => {
  const db = new FakeFirestore({ 'noticiasSector/a': { titulo: 'x' } });
  assert.equal(await N.eliminarNoticia(db, 'a'), true);
  assert.equal(await N.eliminarNoticia(db, 'a'), false);
});
