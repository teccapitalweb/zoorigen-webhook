'use strict';

// POST /api/premios/usar: canje de un premio por un curso adelantado.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, certificado, ts, dias
} = require('./helpers/club');

const tokens = tokensDe('ana', 'sinplan', 'vencida', 'admin');
const baseSeed = (extra = {}) => ({
  ...cursosSeed(15, {
    'cursos/siempre': { titulo: 'Siempre abierto', area: 'Manejo', disponibleSiempre: true, lecciones: [] },
    'cursos/muestra': { titulo: 'Curso de muestra', area: 'Manejo', cursoMuestraGratis: true, lecciones: [] }
  }),
  'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
  'miembros/sinplan': miembroSinPlan(),
  'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
  'miembros/admin': miembroSinPlan({ role: 'admin' }),
  ...extra
});
const ganados = (...claves) => ({ 'premiosUsuario/ana': { uid: 'ana', ganados: claves, usados: [] } });
const usar = (app, cursoId, t = 'token-ana') => request(app).post('/api/premios/usar').set(auth(t)).send({ cursoId });
const premiosDe = (app, t = 'token-ana') => request(app).get('/api/premios').set(auth(t));

test('usar: 401 sin sesión', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')) });
  assert.equal((await request(app).post('/api/premios/usar').send({ cursoId: 'c1' })).status, 401);
  assert.equal((await usar(app, 'c1', 'falso')).status, 401);
});

test('usar: 400 si falta el curso o no es texto', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')) });
  for (const cuerpo of [{}, { cursoId: '' }, { cursoId: '   ' }, { cursoId: 5 }, { cursoId: ['c1'] }, { cursoId: { a: 1 } }, { cursoId: null }, { cursoId: 'x'.repeat(300) }]) {
    const res = await request(app).post('/api/premios/usar').set(auth('token-ana')).send(cuerpo);
    assert.equal(res.status, 400, JSON.stringify(cuerpo).slice(0, 40));
    assert.ok(res.body.error);
  }
  assert.equal((await request(app).post('/api/premios/usar').set(auth('token-ana'))).status, 400, 'sin cuerpo');
  assert.deepEqual(db.value('premiosUsuario/ana').usados, []);
});

test('usar: un administrador recibe 400 (ya tiene todo abierto)', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed({ 'premiosUsuario/admin': { uid: 'admin', ganados: ['profesional'], usados: [] } }) });
  const res = await usar(app, 'c1', 'token-admin');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /administrador/i);
});

test('usar: SIN membresía vigente no se puede canjear aunque el premio ya esté ganado (403 membresia-requerida)', async () => {
  const seed = baseSeed({
    'premiosUsuario/sinplan': { uid: 'sinplan', ganados: ['profesional'], usados: [] },
    'premiosUsuario/vencida': { uid: 'vencida', ganados: ['profesional', 'maestro'], usados: [] }
  });
  const { app, db } = cargarServidor({ tokens, seed });
  for (const [t, uid] of [['token-sinplan', 'sinplan'], ['token-vencida', 'vencida']]) {
    const res = await usar(app, 'c1', t);
    assert.equal(res.status, 403);
    assert.equal(res.body.codigo, 'membresia-requerida');
    assert.deepEqual(db.value(`premiosUsuario/${uid}`).usados, [], 'no se gastó el premio');
  }
});

test('usar: 404 si el curso no existe en `cursos`', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')) });
  const res = await usar(app, 'curso-fantasma');
  assert.equal(res.status, 404);
  assert.deepEqual(db.value('premiosUsuario/ana').usados, []);
});

test('usar: 403 si no hay ningún premio ganado', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await usar(app, 'c1');
  assert.equal(res.status, 403);
  assert.match(res.body.error, /premios disponibles/i);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 0);
});

test('usar: con un premio ganado abre el curso (200 { ok, cursoId, clave }) y queda registrado con fecha', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')) });
  const res = await usar(app, 'c3');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { ok: true, cursoId: 'c3', clave: 'profesional' });
  const g = db.value('premiosUsuario/ana');
  assert.deepEqual(g.ganados, ['profesional']);
  assert.equal(g.usados.length, 1);
  assert.deepEqual([g.usados[0].clave, g.usados[0].cursoId], ['profesional', 'c3']);
  assert.ok(!Number.isNaN(Date.parse(g.usados[0].fecha)));
  // Y GET /api/premios lo refleja
  const lista = (await premiosDe(app)).body;
  const p = lista.premios.find(x => x.clave === 'profesional');
  assert.equal(p.usado.cursoId, 'c3');
  assert.equal(p.disponible, false);
  assert.equal(lista.disponibles, 0);
});

test('usar: cada llamada gasta UN solo premio (el primero ganado sin usar) aunque haya varios', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional', 'referidos-1', 'maestro')) });
  assert.equal((await usar(app, 'c1')).body.clave, 'profesional');
  assert.equal(db.value('premiosUsuario/ana').usados.length, 1);
  assert.equal((await usar(app, 'c2')).body.clave, 'referidos-1');
  assert.equal((await usar(app, 'c3')).body.clave, 'maestro');
  const cuarto = await usar(app, 'c4');
  assert.equal(cuarto.status, 403, 'ya no quedan premios');
  assert.equal(db.value('premiosUsuario/ana').usados.length, 3);
});

test('usar: 409 si el curso ya fue adelantado con otro premio (y no se gasta el premio)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional', 'maestro')) });
  assert.equal((await usar(app, 'c5')).status, 200);
  const otra = await usar(app, 'c5');
  assert.equal(otra.status, 409);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 1, 'el segundo premio sigue libre');
  assert.equal((await usar(app, 'c6')).status, 200);
});

test('usar: 409 para cursos que ya están abiertos para todos (disponibleSiempre y curso de muestra)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')) });
  assert.equal((await usar(app, 'siempre')).status, 409);
  assert.equal((await usar(app, 'muestra')).status, 409);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 0);
});

test('usar: 409 para el curso que la persona eligió como prueba gratuita', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed({ ...ganados('profesional'), 'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c7' } }) });
  const res = await usar(app, 'c7');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /prueba/i);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 0);
  assert.equal((await usar(app, 'c8')).status, 200);
});

test('usar: el nivel alcanzado ese mismo momento ya cuenta (no hace falta abrir antes la pantalla de logros)', async () => {
  const seed = baseSeed();
  for (let i = 1; i <= 15; i++) { const c = certificado('ana', `c${i}`); seed[`certificados/${c.folio}`] = c; }
  const { app, db } = cargarServidor({ tokens, seed });
  const res = await usar(app, 'c2');
  assert.equal(res.status, 200);
  assert.equal(res.body.clave, 'profesional');
  assert.deepEqual(db.value('premiosUsuario/ana').ganados, ['profesional']);
});

test('usar: doble canje simultáneo con UN premio gasta uno solo (el otro recibe 403)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')) });
  const [a, b] = await Promise.all([usar(app, 'c1'), usar(app, 'c2')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 403]);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 1);
});

test('usar: doble canje simultáneo del MISMO curso con dos premios gasta uno solo (409 al otro)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional', 'maestro')) });
  const [a, b] = await Promise.all([usar(app, 'c1'), usar(app, 'c1')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 1);
  assert.equal(db.value('premiosUsuario/ana').usados[0].cursoId, 'c1');
});

test('usar: seis canjes simultáneos con dos premios gastan exactamente dos', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional', 'maestro')) });
  const resultados = await Promise.all(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(c => usar(app, c)));
  assert.equal(resultados.filter(r => r.status === 200).length, 2);
  assert.equal(resultados.filter(r => r.status === 403).length, 4);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 2);
});

test('usar: el canje no pisa lo ya ganado ni toca la membresía de la persona', async () => {
  const seed = baseSeed(ganados('profesional', 'referidos-1'));
  const { app, db } = cargarServidor({ tokens, seed });
  const antes = { miembro: db.value('miembros/ana'), usuario: db.value('usuarios/ana') };
  await usar(app, 'c1');
  assert.deepEqual(db.value('premiosUsuario/ana').ganados, ['profesional', 'referidos-1']);
  assert.deepEqual(db.value('miembros/ana'), antes.miembro);
  assert.equal(db.value('usuarios/ana'), antes.usuario);
});

test('usar: límite de 10 canjes por minuto (429)', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  for (let i = 0; i < 10; i++) assert.equal((await usar(app, 'c1')).status, 403);
  assert.equal((await usar(app, 'c1')).status, 429);
});

test('usar: no cambia el acceso a videos de quien ya paga (embed-token intacto)', async () => {
  const { VIDEO_PREMIUM } = require('./helpers/cargar-servidor');
  const { app } = cargarServidor({ tokens, seed: baseSeed(ganados('profesional')), env: {} });
  await usar(app, 'c1');
  const conPlan = await request(app).post('/api/bunny/embed-token').set(auth('token-ana')).send({ videoId: VIDEO_PREMIUM });
  assert.equal(conPlan.status, 200);
  assert.equal(conPlan.body.freePreview, false);
  const sinPlan = await request(app).post('/api/bunny/embed-token').set(auth('token-sinplan')).send({ videoId: VIDEO_PREMIUM });
  assert.equal(sinPlan.status, 403);
});
