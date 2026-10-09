'use strict';

// GET /api/admin/bunny-catalogo: solo administradores, consulta Bunny EN VIVO (fetch simulado),
// solo videos terminados, ordenados por número de clase. Nunca se llama a Bunny de verdad.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor } = require('./helpers/cargar-servidor');

const CLAVE = 'clave-de-gestion-SECRETA-123';
const tokens = {
  'token-ana': { uid: 'u1', email: 'ana@example.com' },
  'token-admin': { uid: 'adm', email: 'admin@example.com' },
  'token-jefa': { uid: 'jefa', email: 'jefa@example.com' }
};
const auth = t => ({ Authorization: `Bearer ${t}` });
const seedAdmins = { 'admins/adm': { activo: true } };
const catalogo = (app, t = 'token-admin') => {
  const req = request(app).get('/api/admin/bunny-catalogo');
  return t ? req.set(auth(t)) : req;
};

const video = (n, titulo, status = 4) => ({ guid: `vid-${n}`, title: titulo, status });

// Bunny simulado: colecciones = [{ guid, name, videos: [...] }]. Registra cada llamada.
function bunnySimulado(colecciones, { fallarEn = null } = {}) {
  const llamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opciones = {}) => {
    llamadas.push({ url: String(url), headers: opciones.headers || {}, metodo: opciones.method || 'GET' });
    const u = new URL(url);
    if (fallarEn && u.pathname.endsWith(fallarEn)) {
      return { ok: false, status: 401, json: async () => ({ message: `clave inválida ${CLAVE}` }), text: async () => CLAVE };
    }
    const pagina = Number(u.searchParams.get('page'));
    const porPagina = Number(u.searchParams.get('itemsPerPage'));
    let todos;
    if (u.pathname.endsWith('/collections')) {
      todos = colecciones.map(c => ({ guid: c.guid, name: c.name }));
    } else if (u.pathname.endsWith('/videos')) {
      todos = colecciones.find(c => c.guid === u.searchParams.get('collection'))?.videos || [];
    } else {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const items = todos.slice((pagina - 1) * porPagina, pagina * porPagina);
    return { ok: true, status: 200, json: async () => ({ items, totalItems: todos.length, currentPage: pagina, itemsPerPage: porPagina }) };
  };
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
}

async function conBunny(colecciones, opciones, prueba) {
  const bunny = bunnySimulado(colecciones, opciones || {});
  try { await prueba(bunny); } finally { bunny.restaurar(); }
}

const servidor = (extra = {}) => cargarServidor({ tokens, seed: seedAdmins, env: { BUNNY_API_KEY: CLAVE }, ...extra });

test('bunny-catalogo: sin token responde 401', async () => {
  const { app } = servidor();
  const res = await catalogo(app, null);
  assert.equal(res.status, 401);
  assert.equal(typeof res.body.error, 'string');
});

test('bunny-catalogo: token inválido responde 401', async () => {
  const { app } = servidor();
  const res = await catalogo(app, 'token-inventado');
  assert.equal(res.status, 401);
});

test('bunny-catalogo: un miembro normal recibe 403 y no se consulta a Bunny', async () => {
  const { app } = servidor({ seed: { ...seedAdmins, 'miembros/u1': { planActivo: true, role: 'member' } } });
  await conBunny([], null, async bunny => {
    const res = await catalogo(app, 'token-ana');
    assert.equal(res.status, 403);
    assert.equal(bunny.llamadas.length, 0);
  });
});

test('bunny-catalogo: un usuario sin ningún documento recibe 403', async () => {
  const { app } = servidor();
  const res = await catalogo(app, 'token-ana');
  assert.equal(res.status, 403);
});

test('bunny-catalogo: administrador por documento admins/{uid} recibe 200', async () => {
  const { app } = servidor();
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [video(1, 'Clase 1.mp4')] }], null, async () => {
    const res = await catalogo(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.catalogo, [
      { titulo: 'Curso 1', collectionId: 'c1', sesiones: [{ numero: 1, titulo: 'Clase 1.mp4', videoId: 'vid-1' }] }
    ]);
  });
});

test('bunny-catalogo: administrador por miembros/{uid}.role === admin recibe 200', async () => {
  const { app } = servidor({ seed: { 'miembros/jefa': { role: 'admin' } } });
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [video(1, 'Clase 1')] }], null, async () => {
    const res = await catalogo(app, 'token-jefa');
    assert.equal(res.status, 200);
    assert.equal(res.body.catalogo.length, 1);
  });
});

test('bunny-catalogo: sin BUNNY_API_KEY responde 503 con codigo sin_api_key', async () => {
  const { app } = cargarServidor({ tokens, seed: seedAdmins });
  await conBunny([], null, async bunny => {
    const res = await catalogo(app);
    assert.equal(res.status, 503);
    assert.equal(res.body.codigo, 'sin_api_key');
    assert.match(res.body.error, /BUNNY_API_KEY/);
    assert.equal(bunny.llamadas.length, 0);
  });
});

test('bunny-catalogo: sin BUNNY_API_KEY un no administrador sigue recibiendo 403 (no se revela la configuración)', async () => {
  const { app } = cargarServidor({ tokens, seed: seedAdmins });
  assert.equal((await catalogo(app, 'token-ana')).status, 403);
});

test('bunny-catalogo: si Bunny responde error devuelve 502 sin filtrar la clave ni el cuerpo de Bunny', async () => {
  const { app } = servidor();
  const registro = [];
  const errorOriginal = console.error;
  console.error = (...args) => registro.push(args.join(' '));
  try {
    await conBunny([], { fallarEn: '/collections' }, async () => {
      const res = await catalogo(app);
      assert.equal(res.status, 502);
      assert.equal(typeof res.body.error, 'string');
      assert.ok(!JSON.stringify(res.body).includes(CLAVE));
      assert.ok(!JSON.stringify(res.body).includes('inválida'));
      assert.ok(!JSON.stringify(res.headers).includes(CLAVE));
    });
  } finally { console.error = errorOriginal; }
  assert.ok(registro.length > 0, 'el fallo debe quedar en el registro del servidor');
  assert.ok(!registro.join('\n').includes(CLAVE), 'la clave no debe aparecer en el registro');
});

test('bunny-catalogo: un fallo de red de fetch también es 502', async () => {
  const { app } = servidor();
  const original = globalThis.fetch;
  const errorOriginal = console.error;
  const registro = [];
  console.error = (...args) => registro.push(args.join(' '));
  globalThis.fetch = async () => { throw new Error(`ECONNRESET con AccessKey ${CLAVE}`); };
  try {
    const res = await catalogo(app);
    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(res.body).includes(CLAVE));
    assert.ok(!registro.join('\n').includes(CLAVE));
  } finally { globalThis.fetch = original; console.error = errorOriginal; }
});

test('bunny-catalogo: falla en los videos de una colección también es 502', async () => {
  const { app } = servidor();
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [video(1, 'Clase 1')] }], { fallarEn: '/videos' }, async () => {
      assert.equal((await catalogo(app)).status, 502);
    });
  } finally { console.error = errorOriginal; }
});

test('bunny-catalogo: pagina de 100 en 100 (más de 100 videos y más de 100 colecciones)', async () => {
  const { app } = servidor();
  const videos = Array.from({ length: 250 }, (_, i) => video(i + 1, `Clase ${i + 1}`));
  const colecciones = [{ guid: 'grande', name: 'Curso grande', videos }];
  for (let i = 0; i < 100; i++) colecciones.push({ guid: `extra-${i}`, name: `Extra ${i}`, videos: [video(1000 + i, 'Clase 1')] });
  await conBunny(colecciones, null, async bunny => {
    const res = await catalogo(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.catalogo.length, 101);
    const grande = res.body.catalogo.find(c => c.collectionId === 'grande');
    assert.equal(grande.sesiones.length, 250);
    assert.equal(grande.sesiones[249].numero, 250);
    const paginasVideos = bunny.llamadas.filter(l => l.url.includes('collection=grande')).map(l => new URL(l.url).searchParams.get('page'));
    assert.deepEqual(paginasVideos, ['1', '2', '3']);
    assert.ok(bunny.llamadas.every(l => new URL(l.url).searchParams.get('itemsPerPage') === '100'));
    const paginasColecciones = bunny.llamadas.filter(l => new URL(l.url).pathname.endsWith('/collections')).length;
    assert.equal(paginasColecciones, 2, '101 colecciones requieren 2 páginas');
  });
});

test('bunny-catalogo: solo incluye videos terminados (status 4) y omite colecciones sin videos listos', async () => {
  const { app } = servidor();
  await conBunny([
    { guid: 'c1', name: 'Curso 1', videos: [
      video(1, 'Clase 1', 4), video(2, 'Clase 2', 3), video(3, 'Clase 3', 5), video(4, 'Clase 4', 0), video(5, 'Clase 5', 4)
    ] },
    { guid: 'c2', name: 'En proceso', videos: [video(9, 'Clase 1', 2)] },
    { guid: 'c3', name: 'Vacío', videos: [] }
  ], null, async () => {
    const res = await catalogo(app);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.catalogo.map(c => c.titulo), ['Curso 1']);
    assert.deepEqual(res.body.catalogo[0].sesiones.map(s => s.videoId), ['vid-1', 'vid-5']);
  });
});

test('bunny-catalogo: ordena por número de clase y, a igualdad, por título', async () => {
  const { app } = servidor();
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [
    video(1, 'Clase 10.mp4'),
    video(2, 'Clase 2.mp4'),
    video(3, 'Introducción'),          // sin número -> 0, primero
    video(4, 'B Sesión 3'),
    video(5, 'A Sesión 3'),            // mismo número 3, desempata por título
    video(6, 'Clase 1')
  ] }], null, async () => {
    const res = await catalogo(app);
    const s = res.body.catalogo[0].sesiones;
    assert.deepEqual(s.map(x => x.titulo), ['Introducción', 'Clase 1', 'Clase 2.mp4', 'A Sesión 3', 'B Sesión 3', 'Clase 10.mp4']);
    assert.deepEqual(s.map(x => x.numero), [0, 1, 2, 3, 3, 10]);
  });
});

test('bunny-catalogo: el número sale del primer entero del título sin extensión', async () => {
  const { app } = servidor();
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [
    video(1, 'Clase 07 - parte 2.mp4'),
    video(2, 'video.mp4'),
    video(3, 'Módulo 2.mov')
  ] }], null, async () => {
    const res = await catalogo(app);
    const porId = Object.fromEntries(res.body.catalogo[0].sesiones.map(s => [s.videoId, s.numero]));
    assert.deepEqual(porId, { 'vid-1': 7, 'vid-2': 0, 'vid-3': 2 });
  });
});

test('bunny-catalogo: envía la cabecera AccessKey a la librería correcta, solo con GET', async () => {
  const { app } = servidor();
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [video(1, 'Clase 1')] }], null, async bunny => {
    await catalogo(app);
    assert.ok(bunny.llamadas.length >= 2);
    for (const l of bunny.llamadas) {
      assert.ok(l.url.startsWith('https://video.bunnycdn.com/library/731751/'), l.url);
      assert.equal(l.headers.AccessKey, CLAVE);
      assert.equal(l.metodo, 'GET');
    }
    assert.ok(bunny.llamadas.some(l => l.url.includes('/collections?')));
    assert.ok(bunny.llamadas.some(l => l.url.includes('/videos?collection=c1')));
  });
});

test('bunny-catalogo: la clave nunca aparece en la respuesta (cuerpo ni cabeceras) y no se cachea', async () => {
  const { app } = servidor();
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [video(1, 'Clase 1')] }], null, async () => {
    const res = await catalogo(app);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(CLAVE));
    assert.ok(!JSON.stringify(res.headers).includes(CLAVE));
    assert.equal(res.headers['cache-control'], 'no-store');
  });
  const sin = await catalogo(cargarServidor({ tokens, seed: seedAdmins, env: { BUNNY_API_KEY: CLAVE } }).app, null);
  assert.equal(sin.headers['cache-control'], 'no-store');
});

test('bunny-catalogo: no escribe nada en Firestore', async () => {
  const { app, db } = servidor();
  const antes = JSON.stringify([...db._data]);
  await conBunny([{ guid: 'c1', name: 'Curso 1', videos: [video(1, 'Clase 1')] }], null, async () => {
    await catalogo(app);
  });
  assert.equal(JSON.stringify([...db._data]), antes);
});
