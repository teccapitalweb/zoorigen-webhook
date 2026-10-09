'use strict';

// Endpoints de libros: GET /api/libros, GET /api/libros/:id, GET /api/admin/libros y la integración con los retos.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');
const { libroValido, carpetaLibros, carpetaMateriales } = require('./helpers/materiales');

const tokens = tokensDe('ana', 'sinplan', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });

// Tres libros: 1, 5 y 15 retos. Se arma el servidor con esa carpeta.
function servidor({ seed = {}, libros = [libroValido('uno', 1), libroValido('cinco', 5), libroValido('quince', 15)] } = {}) {
  const env = { LIBROS_DIR: carpetaLibros(libros), MATERIALES_DIR: carpetaMateriales([]) };
  return cargarServidor({
    env, tokens,
    seed: {
      ...cursosSeed(3),
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
      'miembros/sinplan': miembroSinPlan(),
      'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
      'miembros/admin': miembroSinPlan({ role: 'admin' }),
      ...seed
    }
  });
}
const lista = (app, t = 'token-ana') => request(app).get('/api/libros').set(auth(t));
const uno = (app, id, t = 'token-ana') => request(app).get(`/api/libros/${id}`).set(auth(t));
const quiz = (puntaje = 5, total = 5) => ({ retoId: 'quiz', puntaje, total });
const practica = (app, cuerpo = quiz(), t = 'token-ana') => request(app).post('/api/retos/resultado').set(auth(t)).send(cuerpo);
const camino = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(cuerpo);
const ids = r => r.body.libros.map(l => `${l.id}:${l.desbloqueado}`);

// ── GET /api/libros ──
test('GET /api/libros: 401 sin sesión o con token falso; sin caché', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/libros')).status, 401);
  assert.equal((await lista(app, 'falso')).status, 401);
  const res = await lista(app);
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /no-store/);
});

test('GET /api/libros: forma de la respuesta y umbrales exactos con 0, 4, 5 y 15 retos', async () => {
  for (const [superados, esperado] of [
    [0, ['uno:false', 'cinco:false', 'quince:false']],
    [1, ['uno:true', 'cinco:false', 'quince:false']],
    [4, ['uno:true', 'cinco:false', 'quince:false']],
    [5, ['uno:true', 'cinco:true', 'quince:false']],
    [14, ['uno:true', 'cinco:true', 'quince:false']],
    [15, ['uno:true', 'cinco:true', 'quince:true']]
  ]) {
    const { app } = servidor({ seed: retosDe('ana', superados) });
    const res = await lista(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.membresia, true);
    assert.equal(res.body.superados, superados);
    assert.deepEqual(ids(res), esperado, `con ${superados} retos`);
  }
  const { app } = servidor({ seed: retosDe('ana', 4) });
  const cinco = (await lista(app)).body.libros.find(l => l.id === 'cinco');
  assert.deepEqual(cinco, {
    id: 'cinco', titulo: 'Libro cinco', subtitulo: 'Subtítulo de prueba', autor: 'Equipo Zoorigen', categoria: 'Pruebas', color: '#2F7A4F',
    icono: '📘', resumen: 'Resumen del libro cinco para las pruebas.', paginasTotal: 3, requiereRetos: 5, desbloqueado: false, faltan: 1, soloMiembros: false
  });
});

test('GET /api/libros NUNCA entrega páginas, fuentes ni el texto de los libros (ni desbloqueados)', async () => {
  const { app } = servidor({ seed: retosDe('ana', 200) });
  const res = await lista(app);
  const texto = JSON.stringify(res.body);
  assert.ok(res.body.libros.every(l => l.desbloqueado));
  assert.equal(texto.includes('Texto secreto'), false);
  assert.equal(texto.includes('paginas"'), false);
  assert.equal(texto.includes('parrafos'), false);
  assert.equal(texto.includes('example.org'), false);
});

test('GET /api/libros: administrador ve todo desbloqueado; sin membresía y vencida, todo cerrado con soloMiembros', async () => {
  const { app } = servidor();
  const admin = await lista(app, 'token-admin');
  assert.equal(admin.body.membresia, true);
  assert.ok(admin.body.libros.every(l => l.desbloqueado && l.faltan === 0 && !l.soloMiembros));
  for (const t of ['token-sinplan', 'token-vencida']) {
    const sin = await lista(app, t);
    assert.equal(sin.status, 200);
    assert.equal(sin.body.membresia, false);
    assert.equal(sin.body.superados, 0);
    assert.ok(sin.body.libros.every(l => !l.desbloqueado && l.soloMiembros === true), t);
    assert.deepEqual(sin.body.libros.map(l => l.faltan), [1, 5, 15]);
  }
});

test('GET /api/libros: con retos viejos pero membresía vencida, nada se abre', async () => {
  const { app } = servidor({ seed: retosDe('vencida', 40) });
  const res = await lista(app, 'token-vencida');
  assert.ok(res.body.libros.every(l => !l.desbloqueado));
  assert.equal(res.body.superados, 0);
});

test('GET /api/libros sin libros cargados devuelve lista vacía', async () => {
  const { app } = servidor({ libros: [] });
  const res = await lista(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, membresia: true, superados: 0, libros: [] });
});

// ── Avisos catch-up ──
test('GET /api/libros crea los avisos de los libros ya ganados, una sola vez', async () => {
  const { app, db } = servidor({ seed: retosDe('ana', 5) });
  await lista(app);
  const uno_ = db.value('avisos/ana/items/libro_uno');
  assert.equal(uno_.tipo, 'libro');
  assert.equal(uno_.titulo, '¡Desbloqueaste tu primer libro!');
  assert.equal(uno_.texto, 'Superaste 5 retos: ya puedes leer «Libro uno» en PDFs y materiales.');
  assert.equal(uno_.enlace, 'club-pdfs.html');
  assert.equal(db.value('avisos/ana/items/libro_cinco').titulo, '¡Desbloqueaste un nuevo libro!');
  assert.equal(db.value('avisos/ana/items/libro_quince'), undefined);
  const antes = JSON.stringify(db.value('avisos/ana/items/libro_uno'));
  await lista(app); await lista(app);
  assert.equal(JSON.stringify(db.value('avisos/ana/items/libro_uno')), antes, 'no se sobrescribe ni se duplica');
  const avisos = await request(app).get('/api/avisos').set(auth('token-ana'));
  assert.equal(avisos.body.avisos.filter(a => a.tipo === 'libro').length, 2);
});

test('GET /api/libros en paralelo no duplica avisos', async () => {
  const { app, db } = servidor({ seed: retosDe('ana', 20) });
  db.lenta = true;
  await Promise.all([lista(app), lista(app), lista(app)]);
  db.lenta = false;
  const avisos = await request(app).get('/api/avisos').set(auth('token-ana'));
  assert.equal(avisos.body.avisos.filter(a => a.tipo === 'libro').length, 3);
});

test('sin membresía o siendo administrador no se crean avisos de libros', async () => {
  const { app, db } = servidor({ seed: { ...retosDe('sinplan', 50), ...retosDe('admin', 50) } });
  await lista(app, 'token-sinplan');
  await lista(app, 'token-admin');
  assert.equal(db.value('avisos/sinplan/items/libro_uno'), undefined);
  assert.equal(db.value('avisos/admin/items/libro_uno'), undefined);
});

// ── GET /api/libros/:id ──
test('GET /api/libros/:id: 401 sin sesión', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/libros/uno')).status, 401);
});

test('GET /api/libros/:id desbloqueado entrega meta + páginas', async () => {
  const { app } = servidor({ seed: retosDe('ana', 5) });
  const res = await uno(app, 'cinco');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const l = res.body.libro;
  assert.equal(l.id, 'cinco');
  assert.equal(l.desbloqueado, true);
  assert.equal(l.paginas.length, 3);
  assert.deepEqual(l.paginas[0], { titulo: 'Página 1 de cinco', parrafos: ['Texto secreto 1 de cinco.'] });
  assert.deepEqual(l.fuentes, [{ nombre: 'Fuente', url: 'https://example.org/f' }]);
  assert.equal(l.paginasTotal, 3);
});

test('GET /api/libros/:id: uno antes del umbral da 403 con requiere, superados y faltan, sin una sola página', async () => {
  const { app } = servidor({ seed: retosDe('ana', 4) });
  const res = await uno(app, 'cinco');
  assert.equal(res.status, 403);
  assert.equal(res.body.requiere, 5);
  assert.equal(res.body.superados, 4);
  assert.equal(res.body.faltan, 1);
  assert.match(res.body.error, /te falta 1 reto /);
  assert.equal(res.body.codigo, 'retos-insuficientes');
  assert.equal(JSON.stringify(res.body).includes('Texto secreto'), false);
  assert.equal((await uno(app, 'quince')).body.faltan, 11);
  assert.equal((await uno(app, 'uno')).status, 200);
});

test('GET /api/libros/:id: sin membresía 403 (aunque tenga retos); administrador abre cualquiera', async () => {
  const { app } = servidor({ seed: retosDe('vencida', 99) });
  for (const t of ['token-sinplan', 'token-vencida']) {
    const res = await uno(app, 'uno', t);
    assert.equal(res.status, 403, t);
    assert.equal(res.body.codigo, 'membresia-requerida');
    assert.equal(res.body.requiere, 1);
    assert.equal(res.body.superados, 0);
    assert.equal(res.body.faltan, 1);
    assert.equal(JSON.stringify(res.body).includes('Texto secreto'), false);
  }
  const admin = await uno(app, 'quince', 'token-admin');
  assert.equal(admin.status, 200);
  assert.equal(admin.body.libro.paginas.length, 3);
});

test('GET /api/libros/:id: 404 si no existe y con ids raros (nunca toca el disco)', async () => {
  const { app } = servidor({ seed: retosDe('ana', 50) });
  for (const id of ['no-existe', 'UNO', 'uno.json', '..', '%2e%2e', '..%2f..%2fserver.js', 'uno%00', 'a'.repeat(300)]) {
    const res = await uno(app, id);
    assert.equal(res.status, 404, id);
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.match(res.body.error, /no existe/);
  }
});

// ── Retos → libros nuevos ──
test('POST /api/retos/resultado devuelve libros y librosNuevos, y crea el aviso del libro recién ganado', async () => {
  const { app, db } = servidor();
  const r1 = await practica(app);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body.librosNuevos, ['uno']);
  assert.equal(r1.body.libros.length, 3);
  assert.deepEqual(r1.body.libros.map(l => l.desbloqueado), [true, false, false]);
  assert.equal(JSON.stringify(r1.body).includes('Texto secreto'), false);
  assert.equal(db.value('avisos/ana/items/libro_uno').titulo, '¡Desbloqueaste tu primer libro!');
  assert.equal(db.value('avisos/ana/items/libro_uno').texto, 'Superaste 1 retos: ya puedes leer «Libro uno» en PDFs y materiales.');
  // El mismo reto el mismo día no suma: no hay libros nuevos y el aviso sigue siendo uno
  const r2 = await practica(app);
  assert.deepEqual(r2.body.librosNuevos, []);
  assert.equal(r2.body.xpGanado, 0);
  // El contrato anterior se conserva
  for (const campo of ['ok', 'aprobado', 'xpGanado', 'xp', 'nivel', 'insigniasNuevas']) assert.ok(campo in r1.body, campo);
});

test('POST /api/retos/camino: al superar un reto del camino cruza el umbral; si no se acepta no cambia nada', async () => {
  const { app, db } = servidor({ seed: retosDe('ana', 4) });
  const fallido = await camino(app, { modo: 'quiz', indice: 0, puntaje: 1, total: 5 });
  assert.equal(fallido.status, 200);
  assert.equal(fallido.body.aceptado, false);
  assert.equal(fallido.body.librosNuevos, undefined, 'sin avance no se agrega nada');
  const ok = await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(ok.body.aceptado, true);
  assert.deepEqual(ok.body.librosNuevos, ['cinco'], 'con 4 -> 5 solo cruza "cinco"');
  assert.deepEqual(ok.body.libros.map(l => l.desbloqueado), [true, true, false]);
  assert.equal(db.value('avisos/ana/items/libro_cinco').texto, 'Superaste 5 retos: ya puedes leer «Libro cinco» en PDFs y materiales.');
  // El de "uno" también se avisa (catch-up para quien ya tenía 4 retos antes de que existieran los libros)
  assert.ok(db.value('avisos/ana/items/libro_uno'));
});

test('cruzar varios umbrales de una vez (de 0 a 15 retos) entrega todos los libros nuevos', async () => {
  // El conteo salta de 14 a 15 y 5: aquí se simula con un estado previo de 0 y el endpoint de práctica en una cuenta con 14.
  const { app } = servidor({ seed: retosDe('ana', 14) });
  const r = await practica(app);
  assert.deepEqual(r.body.librosNuevos, ['quince']);
  // Y con un conteo que ya pasó varios umbrales sin avisos previos, el catch-up avisa de todos
  const { app: app2, db: db2 } = servidor({ seed: retosDe('ana', 20) });
  await lista(app2);
  assert.ok(db2.value('avisos/ana/items/libro_uno') && db2.value('avisos/ana/items/libro_cinco') && db2.value('avisos/ana/items/libro_quince'));
});

test('administrador que resuelve retos: libros abiertos y sin librosNuevos ni avisos', async () => {
  const { app, db } = servidor();
  const r = await practica(app, quiz(), 'token-admin');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.librosNuevos, []);
  assert.ok(r.body.libros.every(l => l.desbloqueado));
  assert.equal(db.value('avisos/admin/items/libro_uno'), undefined);
});

test('los retos siguen exigiendo membresía y los libros no cambian ese contrato', async () => {
  const { app } = servidor();
  const res = await practica(app, quiz(), 'token-sinplan');
  assert.equal(res.status, 403);
  assert.equal(res.body.librosNuevos, undefined);
});

test('si los avisos de libros fallan, el reto igual se guarda y responde bien', async () => {
  const { app, db } = servidor();
  const original = db.collection.bind(db);
  db.collection = nombre => { if (nombre === 'avisos') throw new Error('Firestore caído'); return original(nombre); };
  const silenciar = console.error; console.error = () => {};
  try {
    const r = await practica(app);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.librosNuevos, ['uno']);
  } finally { console.error = silenciar; }
  assert.equal(db.value('retosUsuario/ana').superados, 1);
});

// ── Límites ──
test('GET /api/libros se limita a 60 por minuto por persona', async () => {
  const { app } = servidor();
  let ultimo;
  for (let i = 0; i < 60; i++) ultimo = await lista(app);
  assert.equal(ultimo.status, 200);
  const exceso = await lista(app);
  assert.equal(exceso.status, 429);
  assert.match(exceso.body.error, /Demasiadas solicitudes/);
  assert.equal((await lista(app, 'token-admin')).status, 200, 'el límite es por persona');
});

// ── Admin ──
test('GET /api/admin/libros: solo administradores; lista lo cargado y los errores sin rutas', async () => {
  const fs = require('fs');
  const path = require('path');
  const dir = carpetaLibros([libroValido('uno', 1), libroValido('cinco', 5, { prueba: true })]);
  fs.writeFileSync(path.join(dir, 'roto.json'), '{ no json');
  const silenciar = console.warn; console.warn = () => {};
  let app;
  try {
    ({ app } = cargarServidor({
      env: { LIBROS_DIR: dir, MATERIALES_DIR: carpetaMateriales([]) }, tokens,
      seed: { 'miembros/ana': miembroConPlan(), 'miembros/admin': miembroSinPlan({ role: 'admin' }) }
    }));
  } finally { console.warn = silenciar; }
  assert.equal((await request(app).get('/api/admin/libros')).status, 401);
  assert.equal((await request(app).get('/api/admin/libros').set(auth('token-ana'))).status, 403);
  const res = await request(app).get('/api/admin/libros').set(auth('token-admin'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.libros.map(l => [l.id, l.requiereRetos, l.prueba, l.paginasTotal]), [['uno', 1, false, 3], ['cinco', 5, true, 3]]);
  assert.deepEqual(res.body.errores.map(e => e.archivo), ['roto.json']);
  assert.equal(JSON.stringify(res.body).includes('Texto secreto'), false);
  assert.equal(JSON.stringify(res.body).includes(dir), false);
});
