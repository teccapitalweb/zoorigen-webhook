'use strict';
// Estas pruebas cuentan con cuatro fuentes conocidas: usan una lista de prueba, no la lista real de data/.
process.env.NOTICIAS_FUENTES_RUTA = require('node:path').join(__dirname, 'fixtures', 'noticias-fuentes-prueba.json');

// Imagen de las noticias: extracción de og:image de la página de la nota con fetch y DNS simulados (jamás internet),
// reglas de seguridad (SSRF, redirecciones, tiempo, tamaño) e integración con la sincronización.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../services/noticias-imagen');
const N = require('../services/noticias');
const { FakeFirestore } = require('./helpers/fake-firestore');
const { fuentesSinFixture, fetchFalso, respuestasDeFixtures } = require('./helpers/feeds');

const PUBLICA = [{ address: '93.184.216.34', family: 4 }];
const html = (cabecera, relleno = '') => `<!doctype html><html><head><title>Nota</title>${cabecera}</head><body>${relleno}</body></html>`;
const ok = (cuerpo, tipo = 'text/html; charset=utf-8') => new Response(cuerpo, { status: 200, headers: { 'content-type': tipo } });
const redireccion = (destino, estado = 302) => new Response(null, { status: estado, headers: { location: destino } });

// paginas: { url: string | Response | función }; resolutor: { host: [direcciones] } (lo que no está resuelve a una pública)
function entorno(paginas, hosts = {}) {
  const llamadas = [];
  const consultas = [];
  const fetch = async (url, opciones = {}) => {
    llamadas.push(String(url));
    let r = paginas[url];
    if (typeof r === 'function') r = await r(url, opciones);
    if (r instanceof Error) throw r;
    if (r === undefined) return new Response('no', { status: 404 });
    return typeof r === 'string' ? ok(r) : r;
  };
  const resolver = async nombre => {
    consultas.push(nombre);
    const v = hosts[nombre];
    if (v instanceof Error) throw v;
    return v === undefined ? PUBLICA : v.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
  };
  return { fetch, resolver, llamadas, consultas };
}
const buscar = (enlace, paginas, hosts, extra = {}) => {
  const e = entorno(paginas, hosts);
  return I.analizarPagina(enlace, { fetch: e.fetch, resolver: e.resolver, ...extra }).then(r => ({ ...r, e }));
};

// ── Direcciones ──
test('esIpNoPublica: privadas, bucle local, link-local, metadatos, multicast y reservadas (IPv4 e IPv6)', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::1',
    '2001:db8::1', 'no-es-ip', '']) {
    assert.equal(I.esIpNoPublica(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8']) {
    assert.equal(I.esIpNoPublica(ip), false, ip);
  }
});

// ── Extracción ──
test('caso feliz: toma og:image de la página', async () => {
  const r = await buscar('https://medio.ejemplo.com/nota-1', {
    'https://medio.ejemplo.com/nota-1': html('<meta property="og:image" content="https://cdn.ejemplo.com/fotos/jaguar-selva.jpg">')
  });
  assert.equal(r.imagen, 'https://cdn.ejemplo.com/fotos/jaguar-selva.jpg');
  assert.equal(r.motivo, 'ok');
  assert.deepEqual(r.e.llamadas, ['https://medio.ejemplo.com/nota-1']);
});

test('lee comillas simples, orden distinto de atributos, entidades y mayúsculas', async () => {
  const r = await buscar('https://medio.ejemplo.com/n', {
    'https://medio.ejemplo.com/n': html(`<META CONTENT='https://cdn.ejemplo.com/f.jpg?a=1&amp;b=2' Property='og:image' />`)
  });
  assert.equal(r.imagen, 'https://cdn.ejemplo.com/f.jpg?a=1&b=2');
});

test('URL relativa y sin esquema se resuelven contra la dirección final de la página', async () => {
  const a = await buscar('https://medio.ejemplo.com/2026/10/nota', {
    'https://medio.ejemplo.com/2026/10/nota': html('<meta property="og:image" content="/subidas/jaguar-grande.jpg">')
  });
  assert.equal(a.imagen, 'https://medio.ejemplo.com/subidas/jaguar-grande.jpg');
  const b = await buscar('https://medio.ejemplo.com/n', {
    'https://medio.ejemplo.com/n': html('<meta name="twitter:image" content="//cdn.ejemplo.com/img/oso-grande.jpg">')
  });
  assert.equal(b.imagen, 'https://cdn.ejemplo.com/img/oso-grande.jpg');
  const c = await buscar('https://corto.ejemplo.com/x', {
    'https://corto.ejemplo.com/x': redireccion('https://medio.ejemplo.com/2026/nota/'),
    'https://medio.ejemplo.com/2026/nota/': html('<meta property="og:image" content="portada-grande.jpg">')
  });
  assert.equal(c.imagen, 'https://medio.ejemplo.com/2026/nota/portada-grande.jpg', 'relativa a la página donde terminó la redirección');
});

test('orden de preferencia: og:image, og:image:secure_url, twitter:image, link image_src', async () => {
  const cab = [
    '<link rel="image_src" href="https://c.ejemplo.com/link-grande.jpg">',
    '<meta name="twitter:image" content="https://c.ejemplo.com/twitter-grande.jpg">',
    '<meta property="og:image:secure_url" content="https://c.ejemplo.com/secure-grande.jpg">',
    '<meta property="og:image" content="https://c.ejemplo.com/og-grande.jpg">'
  ];
  const probar = async lista => (await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': html(lista.join('')) })).imagen;
  assert.equal(await probar(cab), 'https://c.ejemplo.com/og-grande.jpg');
  assert.equal(await probar(cab.slice(0, 3)), 'https://c.ejemplo.com/secure-grande.jpg');
  assert.equal(await probar(cab.slice(0, 2)), 'https://c.ejemplo.com/twitter-grande.jpg');
  assert.equal(await probar(cab.slice(0, 1)), 'https://c.ejemplo.com/link-grande.jpg');
});

test('http se rechaza; si hay og:image:secure_url https, esa se usa', async () => {
  const sola = await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': html('<meta property="og:image" content="http://c.ejemplo.com/foto-grande.jpg">') });
  assert.equal(sola.imagen, '');
  assert.equal(sola.motivo, 'sin-imagen');
  const conSecure = await buscar('https://m.ejemplo.com/n', {
    'https://m.ejemplo.com/n': html('<meta property="og:image" content="http://c.ejemplo.com/foto-grande.jpg"><meta property="og:image:secure_url" content="https://c.ejemplo.com/foto-grande.jpg">')
  });
  assert.equal(conSecure.imagen, 'https://c.ejemplo.com/foto-grande.jpg');
});

test('descarta íconos y logos evidentes, vectores, miniaturas de menos de 200 px y direcciones largas', async () => {
  for (const malo of [
    'https://c.ejemplo.com/favicon.png', 'https://c.ejemplo.com/img/logo-medio.png', 'https://c.ejemplo.com/img/sprite.png',
    'https://c.ejemplo.com/img/portada.svg', 'https://c.ejemplo.com/img/marca.ico', 'https://c.ejemplo.com/img/nota-150x150.jpg',
    'https://c.ejemplo.com/img/nota-1200x100.jpg', 'https://c.ejemplo.com/img.jpg?w=120', 'https://c.ejemplo.com/img/icon-512.png',
    'https://c.ejemplo.com/img/default.jpg', `https://c.ejemplo.com/${'a'.repeat(400)}.jpg`
  ]) {
    const r = await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': html(`<meta property="og:image" content="${malo}">`) });
    assert.equal(r.imagen, '', malo.slice(0, 60));
  }
  // el descartado cede el paso al siguiente candidato válido
  const r = await buscar('https://m.ejemplo.com/n', {
    'https://m.ejemplo.com/n': html('<meta property="og:image" content="https://c.ejemplo.com/logo.png"><meta name="twitter:image" content="https://c.ejemplo.com/nota-1200x630.jpg">')
  });
  assert.equal(r.imagen, 'https://c.ejemplo.com/nota-1200x630.jpg');
  // y lo legítimo no se descarta
  for (const bueno of ['https://c.ejemplo.com/2026/10/jaguar-iconic.jpg', 'https://c.ejemplo.com/img/oso-800x450.jpg', 'https://c.ejemplo.com/f.jpg?w=1200&h=630']) {
    const b = await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': html(`<meta property="og:image" content="${bueno}">`) });
    assert.equal(b.imagen, bueno);
  }
});

test('sin og:image la nota queda sin imagen (cadena vacía); una meta fuera del <head> no cuenta', async () => {
  const sin = await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': html('<meta name="description" content="algo">') });
  assert.deepEqual([sin.imagen, sin.motivo], ['', 'sin-imagen']);
  const enCuerpo = await buscar('https://m.ejemplo.com/n', {
    'https://m.ejemplo.com/n': html('', '<meta property="og:image" content="https://c.ejemplo.com/del-cuerpo-grande.jpg">')
  });
  assert.equal(enCuerpo.imagen, '');
});

test('solo text/html; JSON, imágenes y errores HTTP no se analizan', async () => {
  const cuerpo = html('<meta property="og:image" content="https://c.ejemplo.com/foto-grande.jpg">');
  assert.equal((await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': ok(cuerpo, 'application/json') })).motivo, 'no-es-html');
  assert.equal((await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': ok(cuerpo, 'application/pdf') })).imagen, '');
  assert.equal((await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': new Response(cuerpo, { status: 403, headers: { 'content-type': 'text/html' } }) })).motivo, 'http-403');
  assert.equal((await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': ok(cuerpo, 'application/xhtml+xml') })).imagen, 'https://c.ejemplo.com/foto-grande.jpg');
});

// ── Seguridad ──
test('el enlace de la nota debe ser https, sin credenciales y de puerto 443: http no se pide', async () => {
  for (const enlace of ['http://m.ejemplo.com/n', 'ftp://m.ejemplo.com/n', 'javascript:alert(1)', '', 'https://u:p@m.ejemplo.com/n', 'https://sin-punto/n']) {
    const r = await buscar(enlace, {});
    assert.equal(r.imagen, '', enlace);
    assert.equal(r.e.llamadas.length, 0, `no se pidió: ${enlace}`);
  }
  const puerto = await buscar('https://m.ejemplo.com:8443/n', {});
  assert.deepEqual([puerto.motivo, puerto.e.llamadas.length], ['puerto', 0]);
});

test('IP privada: si el nombre resuelve a una dirección interna ni se conecta', async () => {
  const pag = html('<meta property="og:image" content="https://c.ejemplo.com/foto-grande.jpg">');
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.0.10', '::1', 'fd00::5', '::ffff:10.0.0.1']) {
    const r = await buscar('https://interno.ejemplo.com/n', { 'https://interno.ejemplo.com/n': pag }, { 'interno.ejemplo.com': [ip] });
    assert.deepEqual([r.imagen, r.motivo, r.e.llamadas.length], ['', 'ip-privada', 0], ip);
  }
  // basta UNA dirección interna entre varias
  const mixta = await buscar('https://doble.ejemplo.com/n', { 'https://doble.ejemplo.com/n': pag }, { 'doble.ejemplo.com': ['93.184.216.34', '10.0.0.9'] });
  assert.equal(mixta.motivo, 'ip-privada');
  // IP literal, nombres internos y DNS que falla
  for (const enlace of ['https://127.0.0.1/n', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/n', 'https://localhost.ejemplo.com.localhost/n', 'https://intranet.corp/n', 'https://2130706433/n']) {
    const r = await buscar(enlace, {});
    assert.deepEqual([r.imagen, r.e.llamadas.length], ['', 0], enlace);
  }
  const caido = await buscar('https://caido.ejemplo.com/n', { 'https://caido.ejemplo.com/n': pag }, { 'caido.ejemplo.com': new Error('ENOTFOUND') });
  assert.deepEqual([caido.imagen, caido.e.llamadas.length], ['', 0]);
});

test('redirección a un destino interno se rechaza (y la imagen de ese destino no se toma)', async () => {
  const pag = html('<meta property="og:image" content="https://c.ejemplo.com/foto-grande.jpg">');
  const r = await buscar('https://corto.ejemplo.com/x', {
    'https://corto.ejemplo.com/x': redireccion('https://rebote.ejemplo.com/n'),
    'https://rebote.ejemplo.com/n': pag
  }, { 'rebote.ejemplo.com': ['192.168.1.20'] });
  assert.deepEqual([r.imagen, r.motivo], ['', 'redireccion-interna']);
  assert.deepEqual(r.e.llamadas, ['https://corto.ejemplo.com/x']);
  // redirección directa a una IP de metadatos y a http
  const meta = await buscar('https://corto.ejemplo.com/x', { 'https://corto.ejemplo.com/x': redireccion('https://169.254.169.254/latest/meta-data/') });
  assert.equal(meta.motivo, 'redireccion-interna');
  const http = await buscar('https://corto.ejemplo.com/x', { 'https://corto.ejemplo.com/x': redireccion('http://m.ejemplo.com/n'), 'http://m.ejemplo.com/n': pag });
  assert.deepEqual([http.motivo, http.e.llamadas.length], ['redireccion-http', 1]);
});

test('hasta 2 redirecciones; la tercera se rechaza', async () => {
  const pag = html('<meta property="og:image" content="https://c.ejemplo.com/foto-grande.jpg">');
  const dos = await buscar('https://a.ejemplo.com/1', { 'https://a.ejemplo.com/1': redireccion('/2'), 'https://a.ejemplo.com/2': redireccion('/3', 301), 'https://a.ejemplo.com/3': pag });
  assert.equal(dos.imagen, 'https://c.ejemplo.com/foto-grande.jpg');
  const tres = await buscar('https://a.ejemplo.com/1', {
    'https://a.ejemplo.com/1': redireccion('/2'), 'https://a.ejemplo.com/2': redireccion('/3'), 'https://a.ejemplo.com/3': redireccion('/4'), 'https://a.ejemplo.com/4': pag
  });
  assert.deepEqual([tres.imagen, tres.motivo, tres.e.llamadas.length], ['', 'demasiadas-redirecciones', 3]);
  const bucle = await buscar('https://a.ejemplo.com/1', { 'https://a.ejemplo.com/1': redireccion('/1') });
  assert.equal(bucle.imagen, '');
});

test('tiempo agotado: una página que no responde se abandona a tiempo (con y sin respetar la señal)', async () => {
  const colgada = (url, { signal }) => new Promise((resolver, rechazar) => {
    signal.addEventListener('abort', () => rechazar(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const ini = Date.now();
  const r = await buscar('https://lenta.ejemplo.com/n', { 'https://lenta.ejemplo.com/n': colgada }, {}, { timeoutMs: 60 });
  assert.deepEqual([r.imagen, r.motivo], ['', 'tiempo']);
  const sorda = await buscar('https://lenta.ejemplo.com/n', { 'https://lenta.ejemplo.com/n': () => new Promise(() => {}) }, {}, { timeoutMs: 60 });
  assert.deepEqual([sorda.imagen, sorda.motivo], ['', 'tiempo']);
  assert.ok(Date.now() - ini < 1500);
  // por defecto el límite es de 4 s
  assert.equal(I.TIMEOUT_PAGINA_MS, 4000);
});

test('un cuerpo que se queda a medias después de los encabezados también vence por tiempo', async () => {
  const cuerpoLento = () => new Response(new ReadableStream({ start() { /* nunca entrega nada */ } }), { status: 200, headers: { 'content-type': 'text/html' } });
  const r = await buscar('https://lenta.ejemplo.com/n', { 'https://lenta.ejemplo.com/n': cuerpoLento }, {}, { timeoutMs: 60 });
  assert.deepEqual([r.imagen, r.motivo], ['', 'tiempo']);
});

test('HTML enorme: se leen como máximo 400 KB; lo que está más allá no se ve y la lectura se corta', async () => {
  let enviados = 0;
  const trozo = Buffer.from('<p>' + 'x'.repeat(16 * 1024) + '</p>');
  const flujo = cabecera => new Response(new ReadableStream({
    pull(c) {
      if (enviados === 0 && cabecera) { enviados += 1; c.enqueue(Buffer.from(`<html><head>${cabecera}`)); return; }
      enviados += trozo.length;
      c.enqueue(trozo);
      if (enviados > 5 * 1024 * 1024) c.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/html' } });

  // og:image al principio de un documento de varios MB: se encuentra
  enviados = 0;
  const temprana = await buscar('https://grande.ejemplo.com/n', {
    'https://grande.ejemplo.com/n': () => flujo('<meta property="og:image" content="https://c.ejemplo.com/foto-grande.jpg">')
  });
  assert.equal(temprana.imagen, 'https://c.ejemplo.com/foto-grande.jpg');
  assert.ok(enviados <= 400 * 1024 + 64 * 1024, `se leyó demasiado: ${enviados}`);

  // og:image pasados los 400 KB (sin </head> antes): no se ve
  const tarde = new Response(Buffer.concat([Buffer.from('<html><head>'), Buffer.from('<!-- ' + 'y'.repeat(450 * 1024) + ' -->'),
    Buffer.from('<meta property="og:image" content="https://c.ejemplo.com/tarde-grande.jpg"></head>')]), { status: 200, headers: { 'content-type': 'text/html' } });
  const r = await buscar('https://grande.ejemplo.com/t', { 'https://grande.ejemplo.com/t': tarde });
  assert.equal(r.imagen, '');
});

test('jamás lanza: errores de red o respuestas raras dejan la nota sin imagen', async () => {
  const r1 = await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': new Error('ECONNRESET') });
  assert.deepEqual([r1.imagen, r1.motivo], ['', 'error']);
  const r2 = await buscar('https://m.ejemplo.com/n', { 'https://m.ejemplo.com/n': redireccion('') });
  assert.equal(r2.imagen, '');
  assert.equal(await I.buscarImagenPagina(null), '');
  assert.equal(await I.buscarImagenPagina(undefined, { fetch: async () => { throw new Error('x'); } }), '');
});

test('transporte real: la conexión se rechaza dentro del propio lookup si el nombre resuelve a una IP interna (sin red)', async () => {
  await assert.rejects(
    I.transporteFijado('https://rebinding.ejemplo.com/n', { resolver: async () => [{ address: '127.0.0.1', family: 4 }], headers: {} }),
    /Destino no permitido/
  );
  await assert.rejects(
    I.transporteFijado('https://rebinding.ejemplo.com/n', { resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], headers: {} }),
    /Destino no permitido/
  );
});

// ── Lote ──
test('completarImagenes: 3 a la vez, solo las que no traen imagen y que ya tienen no se piden', async () => {
  let activas = 0; let pico = 0;
  const paginas = {};
  const notas = [];
  for (let i = 0; i < 8; i++) {
    const url = `https://m.ejemplo.com/n${i}`;
    paginas[url] = async () => {
      activas++; pico = Math.max(pico, activas);
      await new Promise(r => setTimeout(r, 15));
      activas--;
      return ok(html(`<meta property="og:image" content="https://c.ejemplo.com/foto-grande-${i}.jpg">`));
    };
    notas.push({ link: url, imagen: '' });
  }
  notas.push({ link: 'https://m.ejemplo.com/ya', imagen: 'https://c.ejemplo.com/propia-grande.jpg' });
  const e = entorno(paginas);
  const r = await I.completarImagenes(notas, { fetch: e.fetch, resolver: e.resolver });
  assert.deepEqual(r, { buscadas: 8, encontradas: 8 });
  assert.equal(pico, 3, 'concurrencia de 3');
  assert.equal(notas[8].imagen, 'https://c.ejemplo.com/propia-grande.jpg');
  assert.ok(!e.llamadas.includes('https://m.ejemplo.com/ya'), 'si ya hay imagen no se repite la búsqueda');
  assert.equal(notas[3].imagen, 'https://c.ejemplo.com/foto-grande-3.jpg');
});

// ── Integración con la sincronización ──
const AHORA = new Date('2026-10-09T13:00:00Z');
const sync = (db, extra = {}) => N.syncNoticias(db, { ahora: AHORA, fuentes: fuentesSinFixture(), fetch: fetchFalso(respuestasDeFixtures()), newsdataKey: '', tope: 20, ...extra });
const docs = db => [...db._data.keys()].filter(k => k.startsWith('noticiasSector/')).map(k => db.value(k));

test('syncNoticias con fetchPagina: las notas sin imagen reciben la de su página; las que ya traían no se piden', async () => {
  const antes = docs(await (async () => { const d = new FakeFirestore(); await sync(d); return d; })());
  const conImagen = antes.filter(n => n.imagen), sinImagen = antes.filter(n => !n.imagen);
  assert.ok(conImagen.length > 0 && sinImagen.length > 0, 'las fixtures mezclan notas con y sin imagen');

  const pedidos = [];
  const fetchPagina = async url => {
    pedidos.push(url);
    return ok(html(`<meta property="og:image" content="https://cdn.ejemplo.com/${encodeURIComponent(new URL(url).pathname.replace(/\W+/g, '-'))}-grande.jpg">`));
  };
  const db = new FakeFirestore();
  const r = await sync(db, { fetchPagina });
  const guardadas = docs(db);
  assert.equal(guardadas.length, antes.length);
  assert.ok(guardadas.every(n => n.imagen.startsWith('https://')), 'todas quedaron con imagen');
  assert.equal(r.imagenes.buscadas, sinImagen.length);
  assert.equal(r.imagenes.encontradas, sinImagen.length);
  assert.deepEqual(pedidos.sort(), sinImagen.map(n => n.link).sort(), 'solo se pidieron las páginas de las notas sin imagen');
  for (const n of conImagen) assert.equal(guardadas.find(g => g.id === n.id).imagen, n.imagen, 'la imagen del feed no se toca');
});

test('syncNoticias: si la página no trae imagen la nota se guarda igual, con un intento anotado; el segundo intento es el último', async () => {
  const db = new FakeFirestore();
  const fetchPagina = async () => ok(html('<meta name="description" content="sin imagen">'));
  const r1 = await sync(db, { fetchPagina });
  const vacias = docs(db).filter(n => !n.imagen);
  assert.ok(vacias.length > 0);
  assert.ok(vacias.every(n => n.imagenIntentos === 1));
  assert.equal(r1.imagenes.encontradas, 0);

  const pedidos = [];
  const f2 = async url => { pedidos.push(url); return ok(html('<meta name="description" content="sin imagen">')); };
  await sync(db, { fetchPagina: f2 });                   // segunda corrida: rellena y marca 2 intentos
  assert.equal(pedidos.length, vacias.length);
  assert.ok(docs(db).filter(n => !n.imagen).every(n => n.imagenIntentos === 2));
  pedidos.length = 0;
  await sync(db, { fetchPagina: f2 });                   // tercera: ya no insiste
  assert.equal(pedidos.length, 0);
});

test('syncNoticias completa las notas anteriores sin imagen (con tope por corrida) y no toca las que ya tienen', async () => {
  const db = new FakeFirestore();
  const mk = (n, extra = {}) => ({
    id: `n_viejo${n}`, titulo: `Nota anterior ${n}`, extracto: '', link: `https://m.ejemplo.com/viejo-${n}`, fuente: 'F', imagen: '', categoria: 'fauna',
    categoriaNombre: 'Fauna silvestre', color: '#2F7A4F', fecha: AHORA.toISOString(), origen: 'auto', idioma: 'es',
    creadoEn: new Date(AHORA.getTime() - n * 1000), ...extra
  });
  for (let n = 1; n <= 10; n++) db._data.set(`noticiasSector/n_viejo${n}`, mk(n));
  db._data.set('noticiasSector/n_conimagen', mk(11, { id: 'n_conimagen', imagen: 'https://c.ejemplo.com/propia-grande.jpg' }));
  db._data.set('noticiasSector/adm_1', mk(12, { id: 'adm_1', origen: 'admin' }));
  const pedidos = [];
  const fetchPagina = async url => { pedidos.push(url); return ok(html(`<meta property="og:image" content="https://cdn.ejemplo.com/${url.split('/').pop()}-grande.jpg">`)); };
  const r = await N.syncNoticias(db, { ahora: AHORA, fuentes: [], newsdataKey: '', fetchPagina });
  assert.equal(r.imagenes.rellenadas, 8, 'como máximo 8 por corrida');
  assert.equal(pedidos.length, 8);
  assert.ok(!pedidos.some(u => u.includes('conimagen') || u.includes('adm_1')));
  assert.equal(db.value('noticiasSector/n_viejo1').imagen, 'https://cdn.ejemplo.com/viejo-1-grande.jpg');
  assert.equal(db.value('noticiasSector/n_conimagen').imagen, 'https://c.ejemplo.com/propia-grande.jpg');
  assert.equal(db.value('noticiasSector/adm_1').imagen, '');
  await N.syncNoticias(db, { ahora: AHORA, fuentes: [], newsdataKey: '', fetchPagina });
  assert.equal(db.value('noticiasSector/n_viejo10').imagen, 'https://cdn.ejemplo.com/viejo-10-grande.jpg', 'la siguiente corrida termina el resto');
});

test('syncNoticias: con un fetch propio (sin fetchPagina), con buscarImagenes:false o NOTICIAS_IMAGENES=off no se busca nada', async () => {
  const pedidos = [];
  const globalOriginal = globalThis.fetch;
  globalThis.fetch = async url => { pedidos.push(String(url)); return new Response('no', { status: 404 }); };
  try {
    const a = await sync(new FakeFirestore());                       // `fetch` propio para los feeds
    assert.deepEqual(a.imagenes, { buscadas: 0, encontradas: 0, rellenadas: 0 });
    const b = await N.syncNoticias(new FakeFirestore(), { ahora: AHORA, fuentes: [], newsdataKey: '', buscarImagenes: false });
    assert.deepEqual(b.imagenes, { buscadas: 0, encontradas: 0, rellenadas: 0 });
    process.env.NOTICIAS_IMAGENES = 'off';
    const c = await N.syncNoticias(new FakeFirestore(), { ahora: AHORA, fuentes: [], newsdataKey: '' });
    assert.deepEqual(c.imagenes, { buscadas: 0, encontradas: 0, rellenadas: 0 });
  } finally {
    delete process.env.NOTICIAS_IMAGENES;
    globalThis.fetch = globalOriginal;
  }
  assert.deepEqual(pedidos, []);
});
