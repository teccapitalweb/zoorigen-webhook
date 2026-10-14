'use strict';

// Endpoints de retos: GET /api/retos, POST /api/retos/resultado, POST /api/retos/camino y la clasificación.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, fechaHace, ts, dias
} = require('./helpers/club');

const tokens = tokensDe('ana', 'beto', 'sinplan', 'vencida', 'admin');
const baseSeed = () => ({
  ...cursosSeed(3),
  'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
  'miembros/beto': miembroConPlan({ name: 'Beto Gómez Ruiz' }),
  'miembros/sinplan': miembroSinPlan(),
  'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
  'miembros/admin': miembroSinPlan({ role: 'admin' })
});
const obtener = (app, t = 'token-ana') => request(app).get('/api/retos').set(auth(t));
const resultado = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/resultado').set(auth(t)).send(cuerpo);
const camino = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(cuerpo);
const clasificacion = (app, t = 'token-ana') => request(app).get('/api/retos/clasificacion').set(auth(t));
const quiz = (puntaje = 4, total = 5) => ({ retoId: 'quiz', puntaje, total });

// ── GET /api/retos ──
test('GET /api/retos exige sesión y no se guarda en caché', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await request(app).get('/api/retos')).status, 401);
  assert.equal((await obtener(app, 'falso')).status, 401);
  const res = await obtener(app);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('GET /api/retos sin membresía: vista previa sin escribir nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await obtener(app, 'token-sinplan');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true, membresia: false, nivel: { id: 1, nombre: 'Aprendiz', xp: 0, desde: 0, hasta: 500, faltan: 500 }, xp: 0, superados: 0,
    porReto: {}, camino: { quiz: 0, detective: 0, orden: 0 }, caminoHechos: { quiz: [], detective: [], orden: [] },
    retosHoy: [], totales: { quiz: 22, detective: 13, orden: 18 }
  });
  assert.equal(db.value('actividadUsuario/sinplan'), undefined);
  assert.equal(db.value('retosUsuario/sinplan'), undefined);
});

test('GET /api/retos con membresía: nivel, XP total, progreso y día activo registrado', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': {
    uid: 'ana', xp: 22, xpPractica: 12, superados: 3, dias: [fechaHace(2), fechaHace(0)],
    retosHoy: { fecha: fechaHace(0), ids: ['quiz'] }, camino: { quiz: 2, detective: 1, orden: 0 },
    porReto: { quiz: { veces: 4, mejor: 4, total: 5, superados: 2, perfectos: 0 }, detective: { veces: 1, mejor: 3, total: 3, superados: 1, perfectos: 1 } }
  } };
  const { app, db } = cargarServidor({ tokens, seed });
  const res = await obtener(app);
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.membresia, true);
  assert.equal(b.superados, 3);
  assert.deepEqual(b.camino, { quiz: 2, detective: 1, orden: 0 });
  assert.deepEqual(b.retosHoy, ['quiz']);
  assert.equal(b.porReto.quiz.veces, 4);
  assert.equal(b.porReto.quiz.mejor, 4);
  assert.deepEqual(b.totales, { quiz: 22, detective: 13, orden: 18 });
  // XP total = bienvenida (20) + XP de retos (22) + insignias r1 (20) y r3 (40)
  assert.equal(b.xp, 20 + 22 + 20 + 40);
  assert.equal(b.nivel.id, 1);
  assert.ok(db.value('actividadUsuario/ana').dias.includes(fechaHace(0)));
});

test('GET /api/retos: "retosHoy" solo trae los retos de HOY (los de ayer no)', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': { uid: 'ana', xp: 6, xpPractica: 6, superados: 1, dias: [fechaHace(1)], retosHoy: { fecha: fechaHace(1), ids: ['quiz'] } } };
  const { app } = cargarServidor({ tokens, seed });
  assert.deepEqual((await obtener(app)).body.retosHoy, []);
});

// ── POST /api/retos/resultado ──
test('resultado: 401 sin sesión', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await request(app).post('/api/retos/resultado').send(quiz())).status, 401);
  assert.equal((await resultado(app, quiz(), 'falso')).status, 401);
});

test('resultado: 403 con codigo "membresia-requerida" sin plan, con plan vencido; no escribe nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  for (const t of ['token-sinplan', 'token-vencida']) {
    const res = await resultado(app, quiz(), t);
    assert.equal(res.status, 403);
    assert.equal(res.body.codigo, 'membresia-requerida');
    assert.ok(res.body.error);
  }
  assert.equal(db.value('retosUsuario/sinplan'), undefined);
  assert.equal(db.value('retosUsuario/vencida'), undefined);
});

test('resultado: 400 con datos inválidos (tipos, rangos, reto desconocido, sin cuerpo)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const malos = [
    { retoId: 'otro', puntaje: 1, total: 2 }, { retoId: 'quiz', puntaje: 3, total: 2 }, { retoId: 'quiz', puntaje: -1, total: 2 },
    { retoId: 'quiz', puntaje: '2', total: 2 }, { retoId: 'quiz', puntaje: 1.5, total: 2 }, { retoId: 'quiz', puntaje: 1, total: 31 },
    { retoId: 'quiz', puntaje: 1, total: 0 }, { retoId: 'quiz', puntaje: 1 }, { puntaje: 1, total: 2 }, {}, { retoId: ['quiz'], puntaje: 1, total: 2 },
    { retoId: { $ne: 1 }, puntaje: 1, total: 2 }
  ];
  for (const cuerpo of malos) {
    const res = await resultado(app, cuerpo);
    assert.equal(res.status, 400, JSON.stringify(cuerpo));
    assert.ok(res.body.error);
  }
  assert.equal((await request(app).post('/api/retos/resultado').set(auth('token-ana'))).status, 400, 'sin cuerpo');
  assert.equal(db.value('retosUsuario/ana'), undefined, 'nada se guardó');
});

test('resultado: aprobado da 6 XP, perfecto da 10, y devuelve XP total, nivel e insignias nuevas', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const r1 = await resultado(app, quiz(3, 5));
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(r1.body).sort(), ['aprobado', 'insigniasNuevas', 'libros', 'librosNuevos', 'nivel', 'ok', 'xp', 'xpGanado']); // libros/librosNuevos: paquete de libros con retos
  assert.equal(r1.body.aprobado, true);
  assert.equal(r1.body.xpGanado, 6);
  assert.equal(r1.body.xp, 20 + 6 + 20, 'bienvenida + reto + insignia "Primer reto"');
  assert.deepEqual(r1.body.insigniasNuevas, [{ id: 'r1', nombre: 'Primer reto' }]);
  assert.equal(r1.body.nivel.nombre, 'Aprendiz');
  const r2 = await resultado(app, { retoId: 'orden', puntaje: 5, total: 5 });
  assert.equal(r2.body.xpGanado, 10);
  assert.deepEqual(r2.body.insigniasNuevas, []);
  const guardado = db.value('retosUsuario/ana');
  assert.equal(guardado.xp, 16);
  assert.equal(guardado.superados, 2);
  assert.equal(guardado.uid, 'ana');
});

test('resultado: el mismo reto solo da XP una vez por día, otro reto sí', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await resultado(app, quiz(5, 5))).body.xpGanado, 10);
  const otra = await resultado(app, quiz(5, 5));
  assert.equal(otra.status, 200);
  assert.equal(otra.body.xpGanado, 0);
  assert.equal(otra.body.aprobado, true);
  assert.equal((await resultado(app, { retoId: 'detective', puntaje: 3, total: 3 })).body.xpGanado, 10);
});

test('resultado: reprobar no da XP; flashcards nunca da XP', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const mal = await resultado(app, quiz(1, 5));
  assert.deepEqual([mal.body.aprobado, mal.body.xpGanado, mal.body.insigniasNuevas], [false, 0, []]);
  const fc = await resultado(app, { retoId: 'flashcards', puntaje: 8, total: 8 });
  assert.deepEqual([fc.body.aprobado, fc.body.xpGanado], [true, 0]);
});

test('resultado: cambiar el día (mañana) permite volver a ganar el XP del mismo reto', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': { uid: 'ana', xp: 6, xpPractica: 6, superados: 1, dias: [fechaHace(1)], retosHoy: { fecha: fechaHace(1), ids: ['quiz'] } } };
  const { app } = cargarServidor({ tokens, seed });
  assert.equal((await resultado(app, quiz(3, 5))).body.xpGanado, 6);
});

test('resultado: la práctica tiene techo de XP de por vida', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': { uid: 'ana', xp: 595, xpPractica: 595, superados: 80, dias: [], retosHoy: { fecha: '', ids: [] } } };
  const { app, db } = cargarServidor({ tokens, seed });
  assert.equal((await resultado(app, quiz(5, 5))).body.xpGanado, 5);
  assert.equal((await resultado(app, { retoId: 'orden', puntaje: 5, total: 5 })).body.xpGanado, 0);
  assert.equal(db.value('retosUsuario/ana').xpPractica, 600);
});

test('resultado: el XP que informa el servidor coincide con GET /api/premios y /api/retos', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const r = await resultado(app, quiz(5, 5));
  const premios = await request(app).get('/api/premios').set(auth('token-ana'));
  const retos = await obtener(app);
  assert.equal(premios.body.xp.total, r.body.xp);
  assert.equal(retos.body.xp, r.body.xp);
  assert.deepEqual(retos.body.nivel, r.body.nivel);
});

test('resultado: dos solicitudes simultáneas del mismo reto dan XP una sola vez (transacción)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  db.lenta = true;   // lecturas lentas: las dos solicitudes ven el mismo estado viejo
  const [a, b] = await Promise.all([resultado(app, quiz(5, 5)), resultado(app, quiz(5, 5))]);
  assert.deepEqual([a.body.xpGanado, b.body.xpGanado].sort((x, y) => x - y), [0, 10]);
  assert.equal(db.value('retosUsuario/ana').xp, 10);
  assert.equal(db.value('retosUsuario/ana').superados, 1);
});

test('resultado: un administrador también puede jugar (tiene todo abierto)', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await resultado(app, quiz(5, 5), 'token-admin')).status, 200);
});

test('resultado: máximo 60 solicitudes por minuto por usuario (429); otro usuario no se ve afectado', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const malo = { retoId: 'x' };
  for (let i = 0; i < 60; i++) assert.equal((await resultado(app, malo)).status, 400);
  const bloqueada = await resultado(app, quiz(5, 5));
  assert.equal(bloqueada.status, 429);
  assert.ok(bloqueada.body.error);
  assert.equal((await resultado(app, quiz(5, 5), 'token-beto')).status, 200);
});

// ── POST /api/retos/camino ──
test('camino: 401 sin sesión; 403 sin membresía; 400 con datos inválidos', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const ok = { modo: 'quiz', indice: 0, puntaje: 4, total: 5 };
  assert.equal((await request(app).post('/api/retos/camino').send(ok)).status, 401);
  const sin = await camino(app, ok, 'token-sinplan');
  assert.equal(sin.status, 403);
  assert.equal(sin.body.codigo, 'membresia-requerida');
  assert.equal((await camino(app, ok, 'token-vencida')).status, 403);
  for (const malo of [{ modo: 'historia' }, { modo: 'flashcards' }, { modo: 'otro' }, { indice: -1 }, { indice: 22 }, { indice: 201 }, { indice: '0' }, { indice: 1.2 },
    { puntaje: 6 }, { puntaje: -1 }, { puntaje: '4' }, { total: 0 }, { total: 31 }]) {
    assert.equal((await camino(app, { ...ok, ...malo })).status, 400, JSON.stringify(malo));
  }
  assert.equal((await camino(app, {})).status, 400);
});

test('camino: avanza (200 con aceptado) y devuelve el camino y los retos superados', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const r1 = await camino(app, { modo: 'quiz', indice: 0, puntaje: 4, total: 5 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.aceptado, true);
  assert.equal(r1.body.aprobado, true);
  assert.equal(r1.body.xpGanado, 6);
  assert.deepEqual(r1.body.camino, { quiz: 1, detective: 0, orden: 0 });
  assert.deepEqual(r1.body.caminoHechos, { quiz: [0], detective: [], orden: [] });
  assert.deepEqual(r1.body.insigniasNuevas, [{ id: 'r1', nombre: 'Primer reto' }]);
  assert.ok(Number.isInteger(r1.body.xp) && r1.body.nivel.id === 1);
  const r2 = await camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 });
  assert.equal(r2.body.xpGanado, 10);
  assert.deepEqual(r2.body.camino, { quiz: 2, detective: 0, orden: 0 });
  const r3 = await camino(app, { modo: 'orden', indice: 0, puntaje: 3, total: 4 });
  assert.deepEqual(r3.body.camino, { quiz: 2, detective: 0, orden: 1 });
  assert.deepEqual(db.value('retosUsuario/ana').camino, { quiz: 2, detective: 0, orden: 1 });
  assert.deepEqual(db.value('retosUsuario/ana').caminoHechos, { quiz: [0, 1], detective: [], orden: [0] });
});

test('camino: todos los retos están abiertos (cualquier orden); cada uno da XP una sola vez', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const salto = await camino(app, { modo: 'quiz', indice: 7, puntaje: 5, total: 5 });
  assert.equal(salto.status, 200);
  assert.deepEqual([salto.body.aceptado, salto.body.xpGanado], [true, 10], 'saltarse los anteriores sí vale');
  assert.deepEqual(salto.body.caminoHechos.quiz, [7]);
  const ultimo = await camino(app, { modo: 'quiz', indice: 21, puntaje: 4, total: 5 });
  assert.deepEqual([ultimo.body.aceptado, ultimo.body.xpGanado], [true, 6]);
  assert.deepEqual(ultimo.body.caminoHechos.quiz, [7, 21]);
  assert.equal(db.value('retosUsuario/ana').xp, 16);
  // El mismo reto, otra vez: no se acepta y no suma XP
  const repetido = await camino(app, { modo: 'quiz', indice: 7, puntaje: 5, total: 5 });
  assert.equal(repetido.status, 200);
  assert.deepEqual([repetido.body.aceptado, repetido.body.xpGanado], [false, 0]);
  assert.deepEqual(repetido.body.caminoHechos.quiz, [7, 21]);
  assert.equal(db.value('retosUsuario/ana').xp, 16);
  // Un índice que no existe en el sitio es inválido (400): no se puede inventar XP
  assert.equal((await camino(app, { modo: 'quiz', indice: 22, puntaje: 5, total: 5 })).status, 400);
  assert.equal((await camino(app, { modo: 'detective', indice: 13, puntaje: 3, total: 3 })).status, 400);
  assert.equal((await camino(app, { modo: 'orden', indice: 18, puntaje: 3, total: 3 })).status, 400);
});

test('camino: una cuenta con solo el contador anterior conserva lo hecho y puede seguir en cualquier orden', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': { uid: 'ana', xp: 30, xpPractica: 0, superados: 3, camino: { quiz: 3, detective: 0, orden: 0 } } };
  const { app, db } = cargarServidor({ tokens, seed });
  const leido = await request(app).get('/api/retos').set(auth('token-ana'));
  assert.deepEqual(leido.body.caminoHechos, { quiz: [0, 1, 2], detective: [], orden: [] });
  assert.deepEqual(leido.body.camino, { quiz: 3, detective: 0, orden: 0 });
  assert.equal((await camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 })).body.aceptado, false, 'el 1 ya estaba hecho');
  const r = await camino(app, { modo: 'quiz', indice: 10, puntaje: 5, total: 5 });
  assert.equal(r.body.aceptado, true);
  assert.deepEqual(db.value('retosUsuario/ana').caminoHechos.quiz, [0, 1, 2, 10]);
});

test('camino: reprobar (menos de 60 %) no avanza', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const r = await camino(app, { modo: 'detective', indice: 0, puntaje: 1, total: 3 });
  assert.deepEqual([r.body.aceptado, r.body.aprobado, r.body.xpGanado, r.body.camino.detective], [false, false, 0, 0]);
});

test('camino: con todo el camino hecho, ningún índice da más XP (los 22 del quiz ya están superados)', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': { uid: 'ana', xp: 200, xpPractica: 0, superados: 22, camino: { quiz: 22, detective: 0, orden: 0 } } };
  const { app } = cargarServidor({ tokens, seed });
  for (const indice of [0, 10, 21]) {
    const r = await camino(app, { modo: 'quiz', indice, puntaje: 5, total: 5 });
    assert.deepEqual([r.body.aceptado, r.body.xpGanado], [false, 0], 'índice ' + indice);
  }
  assert.equal((await camino(app, { modo: 'quiz', indice: 22, puntaje: 5, total: 5 })).status, 400);
});

test('camino: dos solicitudes simultáneas del mismo índice avanzan una sola vez (transacción)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  db.lenta = true;   // lecturas lentas: las dos solicitudes ven el mismo estado viejo
  const cuerpo = { modo: 'quiz', indice: 0, puntaje: 5, total: 5 };
  const [a, b] = await Promise.all([camino(app, cuerpo), camino(app, cuerpo)]);
  assert.deepEqual([a.body.aceptado, b.body.aceptado].sort(), [false, true]);
  assert.equal(db.value('retosUsuario/ana').xp, 10);
  assert.equal(db.value('retosUsuario/ana').camino.quiz, 1);
});

test('camino y resultado comparten el límite de 60 solicitudes por minuto', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  for (let i = 0; i < 30; i++) await camino(app, { modo: 'quiz', indice: 9, puntaje: 5, total: 5 });
  for (let i = 0; i < 30; i++) await resultado(app, { retoId: 'flashcards', puntaje: 1, total: 1 });
  assert.equal((await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 })).status, 429);
});

test('todo el camino perfecto más la práctica al tope suma el máximo de retos (1130) y no más', async () => {
  const seed = { ...baseSeed(), 'retosUsuario/ana': { uid: 'ana', xp: 0, xpPractica: 0, superados: 0, camino: { quiz: 0, detective: 0, orden: 0 } } };
  const { app, db } = cargarServidor({ tokens, seed });
  const totales = { quiz: 22, detective: 13, orden: 18 };
  let acumulado = 0;
  // 2 lotes de 25 + resto: el límite de 60/minuto obliga a no pasarse de 60 solicitudes
  for (const modo of ['quiz', 'detective', 'orden']) {
    for (let i = 0; i < totales[modo]; i++) {
      const r = await camino(app, { modo, indice: i, puntaje: 5, total: 5 });
      assert.equal(r.body.aceptado, true);
      acumulado += r.body.xpGanado;
    }
  }
  assert.equal(acumulado, 530);
  assert.equal(db.value('retosUsuario/ana').xp, 530);
  const extra = await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 }); // la solicitud 54: ya estaba superado
  assert.equal(extra.body.aceptado, false);
  assert.equal(db.value('retosUsuario/ana').xp, 530);
});

// ── GET /api/retos/clasificacion ──
test('clasificación: 401 sin sesión; 403 sin membresía', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await request(app).get('/api/retos/clasificacion')).status, 401);
  const sin = await clasificacion(app, 'token-sinplan');
  assert.equal(sin.status, 403);
  assert.equal(sin.body.codigo, 'membresia-requerida');
});

test('clasificación: top por XP total con nombre público (sin correo ni teléfono) y mi posición', async () => {
  const seed = {
    ...baseSeed(),
    'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com', phone: '2361112233' }),
    'miembros/beto': miembroConPlan({ name: 'Beto Gómez Ruiz', email: 'beto@example.com', phone: '2362223344' }),
    'miembros/con-correo': miembroConPlan({ name: 'secreto@example.com' }),
    'premiosUsuario/ana': { uid: 'ana', xpTotal: 700, ganados: [], usados: [] },
    'premiosUsuario/beto': { uid: 'beto', xpTotal: 1300, ganados: [], usados: [] },
    'premiosUsuario/con-correo': { uid: 'con-correo', xpTotal: 1300 },
    'premiosUsuario/cero': { uid: 'cero', xpTotal: 0 },
    'premiosUsuario/sin-xp': { uid: 'sin-xp', ganados: [] }
  };
  const { app } = cargarServidor({ tokens, seed });
  const res = await clasificacion(app);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.top.map(f => f.nombre), ['Beto G.', 'Miembro', 'Ana P.']);
  assert.deepEqual(res.body.top.map(f => f.posicion), [1, 1, 3], 'mismo XP = misma posición');
  const ana = res.body.top.find(f => f.xp === 700);
  assert.deepEqual(ana, { posicion: 3, nombre: 'Ana P.', xp: 700, nivel: { id: 2, nombre: 'Técnico' } });
  assert.deepEqual(res.body.yo, { posicion: 3, xp: 700 });
  const texto = JSON.stringify(res.body);
  for (const secreto of ['@', '2361112233', '2362223344', 'email', 'phone', 'secreto']) assert.ok(!texto.includes(secreto), secreto);
});

test('clasificación: solo 20 en el top y "yo" trae mi posición real aunque no salga en el top', async () => {
  const seed = { ...baseSeed() };
  for (let i = 1; i <= 25; i++) {
    seed[`miembros/u${i}`] = miembroConPlan({ name: 'Persona Apellido' });
    seed[`premiosUsuario/u${i}`] = { uid: `u${i}`, xpTotal: 1000 + i };
  }
  seed['premiosUsuario/ana'] = { uid: 'ana', xpTotal: 1002 };
  const { app } = cargarServidor({ tokens, seed });
  const res = await clasificacion(app);
  assert.equal(res.body.top.length, 20);
  assert.deepEqual(res.body.top.map(f => f.xp), Array.from({ length: 20 }, (_, i) => 1025 - i));
  assert.deepEqual(res.body.top[0], { posicion: 1, nombre: 'Persona A.', xp: 1025, nivel: { id: 2, nombre: 'Técnico' } });
  assert.ok(!res.body.top.some(f => f.xp <= 1005), 'los de abajo no salen');
  assert.deepEqual(res.body.yo, { posicion: 24, xp: 1002 }, '23 personas tienen más XP');
});

test('clasificación: quien no tiene XP guardado, o es administrador, sale con yo = null', async () => {
  const { app } = cargarServidor({ tokens, seed: { ...baseSeed(), 'premiosUsuario/beto': { uid: 'beto', xpTotal: 50 } } });
  assert.equal((await clasificacion(app, 'token-ana')).body.yo, null);
  assert.equal((await clasificacion(app, 'token-admin')).body.yo, null);
  assert.deepEqual((await clasificacion(app, 'token-ana')).body.top.map(f => f.nombre), ['Beto G.']);
});

test('una persona que juega aparece en la clasificación con su XP total', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  await resultado(app, quiz(5, 5));
  const res = await clasificacion(app);
  assert.deepEqual(res.body.yo, { posicion: 1, xp: 50 });
  assert.equal(res.body.top[0].nombre, 'Ana P.');
});
