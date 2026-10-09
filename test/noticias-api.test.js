'use strict';
// Estas pruebas usan un banco de prueba de 6 datos, no el banco real de data/.
process.env.DATOS_CURIOSOS_BANCO_RUTA = require('node:path').join(__dirname, 'fixtures', 'datos-curiosos-banco-prueba.json');
// Estas pruebas cuentan con cuatro fuentes conocidas: usan una lista de prueba, no la lista real de data/.
process.env.NOTICIAS_FUENTES_RUTA = require('node:path').join(__dirname, 'fixtures', 'noticias-fuentes-prueba.json');

// Endpoints de noticias, datos curiosos y avisos: seguridad (401 / 403 / 400), contrato de respuestas y tarea manual.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe
} = require('./helpers/club');
const avisosSvc = require('../services/avisos');
const datosSvc = require('../services/datos-curiosos');

const DIA = 86400000;
const tokens = tokensDe('ana', 'sinplan', 'admin', 'beto');
const montar = (seed = {}, extra = {}) => cargarServidor({
  tokens,
  seed: {
    'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
    'miembros/beto': miembroConPlan({ name: 'Beto' }),
    'miembros/sinplan': miembroSinPlan(),
    'miembros/admin': miembroSinPlan({ role: 'admin' }),
    ...seed
  },
  ...extra
});
const noticiaSeed = (n, extra = {}) => ({
  titulo: `Nota ${n}`, extracto: 'Extracto', link: 'https://a.com/x', fuente: 'Fuente', imagen: 'https://a.com/i.jpg', categoria: 'fauna',
  categoriaNombre: 'Fauna silvestre', color: '#2F7A4F', fecha: new Date(Date.now() - (100 - n) * 60000).toISOString(), origen: 'auto',
  creadoEn: new Date(Date.now() - (100 - n) * 60000), ...extra
});
const get = (app, ruta, t = 'token-ana') => request(app).get(ruta).set(auth(t));
const post = (app, ruta, cuerpo, t = 'token-admin') => request(app).post(ruta).set(auth(t)).send(cuerpo);

// ── Miembro ──
test('GET /api/noticias y GET /api/avisos exigen sesión y no se guardan en caché', async () => {
  const { app } = montar();
  for (const ruta of ['/api/noticias', '/api/avisos']) {
    assert.equal((await request(app).get(ruta)).status, 401, ruta);
    assert.equal((await get(app, ruta, 'token-falso')).status, 401, ruta);
    const ok = await get(app, ruta);
    assert.equal(ok.status, 200, ruta);
    assert.equal(ok.headers['cache-control'], 'no-store');
  }
});

test('GET /api/noticias: forma del contrato, 7 por defecto, ?limit hasta 30, también sin membresía', async () => {
  const seed = {};
  for (let i = 0; i < 40; i++) seed[`noticiasSector/n${String(i).padStart(2, '0')}`] = noticiaSeed(i);
  seed['noticiasSector/adm_1'] = noticiaSeed(99, { origen: 'admin', plantilla: 'naranja', resumen: ['Idea uno', 'Idea dos'] });
  const { app } = montar(seed);
  const res = await get(app, '/api/noticias', 'token-sinplan');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.noticias.length, 7);
  assert.deepEqual(res.body.noticias[0], {
    id: 'adm_1', titulo: 'Nota 99', extracto: 'Extracto', link: 'https://a.com/x', fuente: 'Fuente', imagen: 'https://a.com/i.jpg', categoria: 'fauna',
    categoriaNombre: 'Fauna silvestre', color: '#2F7A4F', fecha: res.body.noticias[0].fecha, origen: 'admin', plantilla: 'naranja', resumen: ['Idea uno', 'Idea dos']
  });
  assert.match(res.body.noticias[0].fecha, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(res.body.noticias[1].id, 'n39');
  assert.equal((await get(app, '/api/noticias?limit=3')).body.noticias.length, 3);
  assert.equal((await get(app, '/api/noticias?limit=500')).body.noticias.length, 30);
  assert.equal((await get(app, '/api/noticias?limit=abc')).body.noticias.length, 7);
  assert.equal((await get(app, '/api/noticias?limit=-4')).body.noticias.length, 7);
});

test('GET /api/noticias solo entrega imágenes https', async () => {
  const { app } = montar({ 'noticiasSector/a': noticiaSeed(1, { imagen: 'http://inseguro.com/a.jpg' }), 'noticiasSector/b': noticiaSeed(2, { imagen: 'javascript:alert(1)' }) });
  const res = await get(app, '/api/noticias');
  assert.deepEqual(res.body.noticias.map(n => n.imagen), ['', '']);
});

test('GET /api/avisos: personales propios + globales, orden por fecha, nunca los de otra persona', async () => {
  const { app, db } = montar();
  await avisosSvc.crearAviso(db, 'ana', { id: 'logro_l1', tipo: 'logro', titulo: '🏅 ¡Nueva insignia!', texto: 'Bienvenido a la manada · +20 XP', enlace: 'club-logros.html' }, { ahora: new Date(Date.now() - 3000) });
  await avisosSvc.crearAviso(db, 'beto', { id: 'logro_l1', tipo: 'logro', titulo: 'de Beto' }, { ahora: new Date(Date.now() - 2000) });
  await avisosSvc.crearNotificacionGlobal(db, { id: 'dato_1', tipo: 'dato', titulo: '💡 Dato curioso', descripcion: 'Algo curioso de verdad' }, { ahora: new Date(Date.now() - 1000) });
  const res = await get(app, '/api/avisos');
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.avisos.map(a => [a.id, a.ambito]), [['dato_1', 'global'], ['logro_l1', 'personal']]);
  assert.deepEqual(Object.keys(res.body.avisos[1]).sort(), ['ambito', 'color', 'enlace', 'fecha', 'icono', 'id', 'texto', 'tipo', 'titulo']);
  assert.equal(res.body.avisos[1].titulo, '🏅 ¡Nueva insignia!');
  assert.equal(res.body.avisos[0].texto, 'Algo curioso de verdad');
  const deBeto = await get(app, '/api/avisos', 'token-beto');
  assert.deepEqual(deBeto.body.avisos.map(a => a.titulo).sort(), ['de Beto', '💡 Dato curioso']);
});

test('los endpoints de miembro limitan las peticiones (60 por minuto por persona)', async () => {
  const { app } = montar();
  let ultimo;
  for (let i = 0; i < 61; i++) ultimo = await get(app, '/api/avisos');
  assert.equal(ultimo.status, 429);
  assert.match(ultimo.body.error, /Demasiadas solicitudes/);
  assert.equal((await get(app, '/api/avisos', 'token-beto')).status, 200, 'el límite es por persona');
});

// ── Seguridad de /api/admin/* ──
const RUTAS_ADMIN = [
  ['get', '/api/admin/noticias'],
  ['post', '/api/admin/noticias'],
  ['post', '/api/admin/noticias/sync'],
  ['post', '/api/admin/noticias/abc/eliminar'],
  ['get', '/api/admin/datos-curiosos'],
  ['post', '/api/admin/datos-curiosos'],
  ['post', '/api/admin/datos-curiosos/abc/actualizar'],
  ['post', '/api/admin/datos-curiosos/abc/eliminar'],
  ['post', '/api/admin/datos-curiosos/abc/enviar'],
  ['get', '/api/admin/avisos'],
  ['post', '/api/admin/avisos'],
  ['post', '/api/admin/avisos/abc/eliminar']
];

test('/api/admin/*: sin sesión 401, con sesión inválida 401, miembro normal (con o sin plan) 403 y no cambia nada', async () => {
  const { app, db } = montar({ 'noticiasSector/abc': noticiaSeed(1), 'datosCuriosos/abc': { texto: 'x'.repeat(30), tema: 'T', activo: true, veces: 0 }, 'notificacionesGlobales/abc': { tipo: 'general', titulo: 'T' } });
  const antes = JSON.stringify([...db._data.entries()]);
  for (const [metodo, ruta] of RUTAS_ADMIN) {
    assert.equal((await request(app)[metodo](ruta).send({})).status, 401, `${metodo} ${ruta} sin token`);
    assert.equal((await request(app)[metodo](ruta).set(auth('falso')).send({})).status, 401, `${metodo} ${ruta} token falso`);
    for (const t of ['token-ana', 'token-sinplan']) {
      const r = await request(app)[metodo](ruta).set(auth(t)).send({ titulo: 'Título válido', resumen: 'Resumen válido de la nota', categoria: 'fauna' });
      assert.equal(r.status, 403, `${metodo} ${ruta} ${t}`);
    }
  }
  assert.equal(JSON.stringify([...db._data.entries()]), antes, 'ningún intento cambió datos');
});

test('un administrador que tiene doc en admins/{uid} también pasa', async () => {
  const { app } = montar({ 'admins/beto': { activo: true } });
  assert.equal((await get(app, '/api/admin/noticias', 'token-beto')).status, 200);
});

// ── Noticias (administrador) ──
const noticiaValida = (extra = {}) => ({
  titulo: 'Nueva guía para el manejo de fauna', resumen: 'Primera idea importante.\nSegunda idea con detalle.', categoria: 'fauna', fuente: 'Zoorigen',
  imagen: 'https://cdn.example.com/a.jpg', link: 'https://example.com/nota', plantilla: 'verde', avisar: false, ...extra
});

test('POST /api/admin/noticias publica una noticia del equipo (origen admin) sin aviso si avisar es false', async () => {
  const { app, db } = montar();
  const res = await post(app, '/api/admin/noticias', noticiaValida());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.noticia.id, /^adm_\d+/);
  assert.equal(res.body.noticia.origen, 'admin');
  assert.deepEqual(res.body.noticia.resumen, ['Primera idea importante.', 'Segunda idea con detalle.']);
  assert.equal(res.body.avisoCreado, false);
  assert.ok(db.value(`noticiasSector/${res.body.noticia.id}`));
  assert.equal([...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/')).length, 0);
  const lista = await get(app, '/api/noticias', 'token-sinplan');
  assert.equal(lista.body.noticias[0].id, res.body.noticia.id, 'la ve cualquier persona con sesión');
});

test('POST /api/admin/noticias con avisar:true crea el aviso global que ven todos', async () => {
  const { app, db } = montar();
  const res = await post(app, '/api/admin/noticias', noticiaValida({ avisar: true }));
  assert.equal(res.body.avisoCreado, true);
  const aviso = db.value(`notificacionesGlobales/noticia_${res.body.noticia.id}`);
  assert.equal(aviso.tipo, 'noticia');
  assert.equal(aviso.titulo, '📰 Nueva guía para el manejo de fauna');
  assert.equal(aviso.origen, 'admin');
  assert.equal(aviso.enlace, 'club-noticias.html');
  const avisos = await get(app, '/api/avisos', 'token-beto');
  assert.equal(avisos.body.avisos.length, 1);
  assert.equal(avisos.body.avisos[0].tipo, 'noticia');
});

test('POST /api/admin/noticias rechaza entradas inválidas con 400 y mensaje en español, sin guardar nada', async () => {
  const { app, db } = montar();
  const malas = [
    {}, { titulo: 'corto' }, noticiaValida({ titulo: 'x'.repeat(141) }), noticiaValida({ resumen: 'corto' }), noticiaValida({ resumen: 'x'.repeat(1501) }),
    noticiaValida({ categoria: 'inventada' }), noticiaValida({ plantilla: 'rosa' }), noticiaValida({ imagen: 'http://a.com/i.jpg' }),
    noticiaValida({ imagen: 'javascript:alert(1)' }), noticiaValida({ link: 'ftp://a.com' }), noticiaValida({ titulo: ['a', 'b'] }), noticiaValida({ resumen: { a: 1 } })
  ];
  for (const m of malas) {
    const r = await post(app, '/api/admin/noticias', m);
    assert.equal(r.status, 400, JSON.stringify(m).slice(0, 80));
    assert.ok(typeof r.body.error === 'string' && r.body.error.length > 5);
  }
  assert.equal((await post(app, '/api/admin/noticias', 'texto plano')).status, 400);
  assert.equal([...db._data.keys()].filter(k => k.startsWith('noticiasSector/')).length, 0);
});

test('GET /api/admin/noticias lista las últimas 60 (auto y propias) con su origen', async () => {
  const seed = {};
  for (let i = 0; i < 70; i++) seed[`noticiasSector/n${String(i).padStart(2, '0')}`] = noticiaSeed(i, { origen: i % 2 ? 'admin' : 'auto' });
  const { app } = montar(seed);
  const res = await get(app, '/api/admin/noticias', 'token-admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.noticias.length, 60);
  assert.deepEqual([res.body.noticias[0].origen, res.body.noticias[1].origen], ['admin', 'auto']);
});

test('POST /api/admin/noticias/:id/eliminar: borra, 404 si no existe, 400 con id raro', async () => {
  const { app, db } = montar({ 'noticiasSector/n1': noticiaSeed(1), 'noticiasSector/adm_5': noticiaSeed(2, { origen: 'admin' }) });
  assert.deepEqual((await post(app, '/api/admin/noticias/n1/eliminar', {})).body, { ok: true });
  assert.equal(db.value('noticiasSector/n1'), undefined);
  assert.ok(db.value('noticiasSector/adm_5'));
  assert.equal((await post(app, '/api/admin/noticias/n1/eliminar', {})).status, 404);
  assert.equal((await post(app, `/api/admin/noticias/${'x'.repeat(101)}/eliminar`, {})).status, 400);
  assert.equal((await post(app, '/api/admin/noticias/a%20b/eliminar', {})).status, 400);
});

// ── Sincronización manual y tarea (con fetch simulado: nunca internet) ──
const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map(i => `<item><title>${i.t}</title><link>${i.l}</link><pubDate>${new Date(Date.now() - i.d * DIA).toUTCString()}</pubDate><description>${i.e}</description></item>`).join('')}</channel></rss>`;
const FEEDS = {
  'https://es.mongabay.com/feed/': rss([{ t: 'Los jaguares vuelven a la selva tras años de conservación', l: 'https://es.mongabay.com/a1', d: 1, e: 'Una nueva investigación confirma que el jaguar recupera su territorio en la selva.' }]),
  'https://rss.dw.com/rdf/rss-sp-eco': rss([{ t: 'Descubren una nueva especie de rana en los Andes', l: 'https://dw.com/a2', d: 1, e: 'Los biólogos encontraron una rana endémica que vive en el bosque nublado.' }]),
  'https://www.nationalgeographic.com.es/rss/animales': rss([{ t: 'Las ballenas jorobadas cantan canciones nuevas cada año', l: 'https://ng.com/a3', d: 2, e: 'Los científicos descubrieron que las ballenas cambian su canto con las temporadas.' }]),
  'https://www.scidev.net/america-latina/feed/': rss([{ t: 'La biodiversidad de los Andes sorprende a los investigadores', l: 'https://sd.com/a4', d: 2, e: 'Un estudio muestra que la biodiversidad de la región es mayor de lo que se creía.' }])
};
async function conFetch(respuestas, cuerpo) {
  const original = globalThis.fetch;
  const llamadas = [];
  globalThis.fetch = async (url) => {
    llamadas.push(String(url));
    const r = respuestas[url];
    return r === undefined ? new Response('no', { status: 404 }) : new Response(r, { status: 200, headers: { 'content-type': 'application/xml' } });
  };
  try { return await cuerpo(llamadas); } finally { globalThis.fetch = original; }
}

test('POST /api/admin/noticias/sync sincroniza ahora y devuelve { guardadas, omitidas, fuentes }', async () => {
  const { app, db } = montar();
  await conFetch(FEEDS, async () => {
    const res = await post(app, '/api/admin/noticias/sync', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.guardadas, 4);
    assert.equal(typeof res.body.omitidas, 'number');
    assert.deepEqual(res.body.fuentes.map(f => [f.id, f.ok, f.items]), [
      ['mongabay-latam', true, 1], ['dw-ambiente', true, 1], ['natgeo-animales', true, 1], ['scidev-latam', true, 1]
    ]);
    assert.equal([...db._data.keys()].filter(k => k.startsWith('noticiasSector/')).length, 4);
    assert.equal(res.body.avisoCreado, true, 'avisa a todos que hay noticias nuevas');
    const fecha = datosSvc.fechaMexico();
    assert.equal(db.value(`notificacionesGlobales/noticias_${fecha}`).titulo, '📰 Nuevas noticias del sector');
  });
});

test('POST /api/admin/noticias/sync: un feed caído se reporta y los demás siguen', async () => {
  const { app } = montar();
  await conFetch({ ...FEEDS, 'https://rss.dw.com/rdf/rss-sp-eco': undefined }, async () => {
    const res = await post(app, '/api/admin/noticias/sync', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.guardadas, 3);
    assert.deepEqual(res.body.fuentes.find(f => f.id === 'dw-ambiente'), { id: 'dw-ambiente', ok: false, items: 0, error: 'HTTP 404' });
  });
});

test('la sincronización manual está limitada a 3 por minuto', async () => {
  const { app } = montar();
  await conFetch(FEEDS, async () => {
    const estados = [];
    for (let i = 0; i < 4; i++) estados.push((await post(app, '/api/admin/noticias/sync', {})).status);
    assert.deepEqual(estados, [200, 200, 200, 429]);
  });
});

// ── Disparo manual de la tarea diaria ──
test('GET /cron/noticias sin CRON_KEY configurada responde 401 siempre', async () => {
  const { app } = montar();
  for (const q of ['', '?key=', '?key=algo', '?key=undefined']) assert.equal((await request(app).get(`/cron/noticias${q}`)).status, 401, q);
  assert.equal((await request(app).get('/cron/noticias').set('x-cron-key', 'algo')).status, 401);
  assert.equal((await request(app).get('/cron/noticias').set('x-cron-key', '')).status, 401);
});

test('GET /cron/noticias con CRON_KEY: llave mala 401; llave buena (query o cabecera) corre la tarea', async () => {
  const { app, db } = montar({}, { env: { CRON_KEY: 'llave-de-prueba-123' } });
  await conFetch(FEEDS, async llamadas => {
    assert.equal((await request(app).get('/cron/noticias?key=otra')).status, 401);
    assert.equal((await request(app).get('/cron/noticias?key=llave-de-prueba-12')).status, 401);
    assert.equal((await request(app).get('/cron/noticias?key[]=llave-de-prueba-123')).status, 401);
    assert.equal((await request(app).get('/cron/noticias').set('x-cron-key', 'mala')).status, 401);
    assert.equal(llamadas.length, 0, 'sin llave correcta no se ejecuta nada');

    const porQuery = await request(app).get('/cron/noticias?key=llave-de-prueba-123');
    assert.equal(porQuery.status, 200);
    assert.equal(porQuery.body.ok, true);
    assert.equal(porQuery.body.noticias.guardadas, 4);
    assert.equal(porQuery.body.aviso.creado, true);
    assert.ok(porQuery.body.dato && typeof porQuery.body.dato.enviado === 'boolean');
    assert.equal(porQuery.headers['cache-control'], 'no-store');

    const porCabecera = await request(app).get('/cron/noticias').set('x-cron-key', 'llave-de-prueba-123');
    assert.equal(porCabecera.status, 200);
    assert.equal(porCabecera.body.noticias.guardadas, 0, 'lo ya guardado no se repite');
    assert.equal(porCabecera.body.aviso, null, 'sin noticias nuevas no hay aviso');
    assert.equal([...db._data.keys()].filter(k => k.startsWith('noticiasSector/')).length, 4);
    assert.equal([...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/noticias_')).length, 1, 'un solo aviso de noticias por día');
  });
});

test('la llave del cron no se compara con == (timingSafeEqual con el mismo largo)', () => {
  const { clavesIguales } = require('../services/rutas-noticias');
  assert.equal(clavesIguales('abc', 'abc'), true);
  assert.equal(clavesIguales('abc', 'abd'), false);
  assert.equal(clavesIguales('abc', 'abcd'), false);
  assert.equal(clavesIguales('', 'x'), false);
});

// ── Datos curiosos (administrador) ──
const datoValido = (extra = {}) => ({ texto: 'Los murciélagos polinizan más de quinientas especies de plantas.', tema: 'Murciélagos', fuente: 'Fuente de prueba', ...extra });

test('datos curiosos: crear, listar, actualizar, enviar y eliminar', async () => {
  const { app, db } = montar();
  const vacio = await get(app, '/api/admin/datos-curiosos', 'token-admin');
  assert.deepEqual(vacio.body, { ok: true, datos: [] });

  const creado = await post(app, '/api/admin/datos-curiosos', datoValido());
  assert.equal(creado.status, 200);
  assert.equal(creado.body.enviado, false);
  const id = creado.body.dato.id;
  assert.deepEqual([creado.body.dato.activo, creado.body.dato.veces, creado.body.dato.ultimoEnvio, creado.body.dato.origen], [true, 0, null, 'admin']);

  const lista = await get(app, '/api/admin/datos-curiosos', 'token-admin');
  assert.deepEqual(Object.keys(lista.body.datos[0]).sort(), ['activo', 'creadoEn', 'fuente', 'fuenteUrl', 'id', 'origen', 'tema', 'texto', 'ultimoEnvio', 'veces']);

  const act = await post(app, `/api/admin/datos-curiosos/${id}/actualizar`, { tema: 'Quirópteros', activo: false });
  assert.equal(act.status, 200);
  assert.deepEqual([act.body.dato.tema, act.body.dato.activo], ['Quirópteros', false]);

  const envio = await post(app, `/api/admin/datos-curiosos/${id}/enviar`, {});
  assert.deepEqual(envio.body, { ok: true, enviado: true });
  const fecha = datosSvc.fechaMexico();
  assert.equal(db.value(`notificacionesGlobales/dato_${fecha}_${id}`).tipo, 'dato');
  assert.equal(db.value(`datosCuriosos/${id}`).veces, 1);
  assert.deepEqual((await post(app, `/api/admin/datos-curiosos/${id}/enviar`, {})).body, { ok: true, enviado: false, yaEnviado: true });
  assert.equal(db.value(`datosCuriosos/${id}`).veces, 1, 'no se cuenta dos veces el mismo día');

  assert.deepEqual((await post(app, `/api/admin/datos-curiosos/${id}/eliminar`, {})).body, { ok: true });
  assert.equal(db.value(`datosCuriosos/${id}`), undefined);
});

test('datos curiosos: crear con enviarYa avisa a todos en el momento', async () => {
  const { app, db } = montar();
  const res = await post(app, '/api/admin/datos-curiosos', datoValido({ enviarYa: true }));
  assert.equal(res.body.enviado, true);
  assert.equal(res.body.dato.veces, 1);
  assert.equal(res.body.dato.ultimoEnvio, datosSvc.fechaMexico());
  assert.equal([...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/dato_')).length, 1);
});

test('datos curiosos: entradas inválidas dan 400 y ids inexistentes 404', async () => {
  const { app, db } = montar();
  const malas = [
    {}, datoValido({ texto: 'corto' }), datoValido({ texto: 'x'.repeat(301) }), datoValido({ texto: 5 }), datoValido({ tema: 'x' }), datoValido({ tema: undefined }),
    datoValido({ fuente: 5 }), datoValido({ fuenteUrl: 'http://x.com' })
  ];
  for (const m of malas) assert.equal((await post(app, '/api/admin/datos-curiosos', m)).status, 400, JSON.stringify(m).slice(0, 70));
  assert.equal([...db._data.keys()].filter(k => k.startsWith('datosCuriosos/')).length, 0);

  db._data.set('datosCuriosos/d1', { texto: 'Un dato curioso con largo suficiente.', tema: 'Tema', activo: true, veces: 0, ultimoEnvio: null, origen: 'admin' });
  for (const cuerpo of [{}, { activo: 'si' }, { texto: 'corto' }, { tema: 'x' }, { texto: 5 }]) {
    assert.equal((await post(app, '/api/admin/datos-curiosos/d1/actualizar', cuerpo)).status, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await post(app, '/api/admin/datos-curiosos/nada/actualizar', { activo: true })).status, 404);
  assert.equal((await post(app, '/api/admin/datos-curiosos/nada/eliminar', {})).status, 404);
  assert.equal((await post(app, '/api/admin/datos-curiosos/nada/enviar', {})).status, 404);
  assert.equal((await post(app, '/api/admin/datos-curiosos/a%20b/enviar', {})).status, 400);
});

// ── Avisos globales (administrador) ──
test('avisos del equipo: crear, ver en la campana de todos y eliminar', async () => {
  const { app, db } = montar();
  const creado = await post(app, '/api/admin/avisos', { tipo: 'clase', titulo: 'Nueva clase en vivo', descripcion: 'Mañana a las 7 p.m. clase de manejo.', enlace: 'club-sesiones.html' });
  assert.equal(creado.status, 200);
  assert.equal(creado.body.ok, true);
  const id = creado.body.id;
  assert.equal(db.value(`notificacionesGlobales/${id}`).origen, 'admin');
  assert.equal(db.value(`notificacionesGlobales/${id}`).icono, '🎬');

  const admin = await get(app, '/api/admin/avisos', 'token-admin');
  assert.equal(admin.body.avisos[0].id, id);
  assert.equal(admin.body.avisos[0].origen, 'admin');
  const miembro = await get(app, '/api/avisos', 'token-ana');
  assert.deepEqual(miembro.body.avisos.map(a => [a.id, a.ambito, a.tipo, a.enlace]), [[id, 'global', 'clase', 'club-sesiones.html']]);

  assert.deepEqual((await post(app, `/api/admin/avisos/${id}/eliminar`, {})).body, { ok: true });
  assert.equal((await post(app, `/api/admin/avisos/${id}/eliminar`, {})).status, 404);
  assert.deepEqual((await get(app, '/api/avisos', 'token-ana')).body.avisos, []);
});

test('avisos del equipo: tipos de persona, textos fuera de rango y enlaces peligrosos dan 400', async () => {
  const { app, db } = montar();
  const base = { tipo: 'general', titulo: 'Aviso para todos', descripcion: 'Descripción del aviso.' };
  const malos = [
    {}, { ...base, tipo: 'logro' }, { ...base, tipo: 'inventado' }, { ...base, tipo: undefined }, { ...base, titulo: 'ab' }, { ...base, titulo: 't'.repeat(121) },
    { ...base, titulo: 5 }, { ...base, descripcion: 'ab' }, { ...base, descripcion: 'd'.repeat(321) }, { ...base, descripcion: undefined },
    { ...base, enlace: 'javascript:alert(1)' }, { ...base, enlace: 'https://evil.com/phishing-que-es-largo-largo' }, { ...base, enlace: 'con espacio' }, { ...base, enlace: 5 }, { ...base, enlace: 'a'.repeat(41) }
  ];
  for (const m of malos) {
    const r = await post(app, '/api/admin/avisos', m);
    assert.equal(r.status, 400, JSON.stringify(m).slice(0, 80));
  }
  assert.equal([...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/')).length, 0);
  const ok = await post(app, '/api/admin/avisos', { ...base, enlace: '' });
  assert.equal(ok.status, 200);
});

test('el texto de los avisos se guarda tal cual (el sitio lo escapa) pero sin caracteres de control', async () => {
  const { app, db } = montar();
  const r = await post(app, '/api/admin/avisos', { tipo: 'sistema', titulo: 'Mantenimiento <b>hoy</b> & mañana\u0000', descripcion: 'Texto con "comillas" y <etiquetas>‮' });
  assert.equal(r.status, 200);
  const g = db.value(`notificacionesGlobales/${r.body.id}`);
  assert.equal(g.titulo, 'Mantenimiento <b>hoy</b> & mañana');
  assert.equal(g.descripcion, 'Texto con "comillas" y <etiquetas>');
});

test('/api/admin/*: las escrituras del administrador tienen límite por minuto (30)', async () => {
  const { app } = montar();
  let ultimo;
  for (let i = 0; i < 31; i++) ultimo = await post(app, '/api/admin/noticias/nada/eliminar', {});
  assert.equal(ultimo.status, 429);
});

test('el servidor completo carga sin arrancar la tarea diaria ni dejar temporizadores', () => {
  const { app } = montar();
  assert.equal(typeof app, 'function');
});
