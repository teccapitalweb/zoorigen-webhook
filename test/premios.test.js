'use strict';

// GET /api/premios: nivel, XP, logros y premios. Firestore, Stripe y Firebase Auth simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe,
  fechaHace, diasSeguidosHasta, certificado, ts, dias
} = require('./helpers/club');

const tokens = tokensDe('ana', 'sinplan', 'admin', 'vencida', 'ajena');
const baseSeed = () => ({
  ...cursosSeed(15),
  'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
  'miembros/sinplan': miembroSinPlan(),
  'miembros/admin': miembroSinPlan({ role: 'admin' }),
  'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
  'miembros/ajena': miembroConPlan({ name: 'Otra Persona' })
});
const premiosDe = (app, t = 'token-ana') => request(app).get('/api/premios').set(auth(t));
const sembrarCertificados = (seed, uid, ids) => ids.forEach(id => { const c = { ...require('./helpers/club').certificado(uid, id) }; seed[`certificados/${c.folio}`] = c; });

test('GET /api/premios exige sesión de Firebase (401) y no se guarda en caché', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await request(app).get('/api/premios')).status, 401);
  assert.equal((await premiosDe(app, 'falso')).status, 401);
  const ok = await premiosDe(app);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('sin membresía: vista previa (nivel 1, 0 XP, logros sin XP ni "ganado") y no escribe nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await premiosDe(app, 'token-sinplan');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.membresia, false);
  assert.deepEqual(res.body.nivel, { id: 1, nombre: 'Aprendiz', xp: 0, desde: 0, hasta: 300, faltan: 300 });
  assert.deepEqual(res.body.xp, { total: 0, logros: 0, retos: 0, referidos: 0, cursos: 0, bienvenida: 0 });
  assert.deepEqual(res.body.cursos, { terminados: 0, lista: [] });
  assert.equal(res.body.logros.length, 36);
  for (const l of res.body.logros) assert.ok(!('ganado' in l) && !('xp' in l), `${l.id} no debe traer XP ni ganado`);
  assert.equal(res.body.disponibles, 0);
  assert.equal(res.body.premios.length, 3);
  assert.ok(res.body.premios.every(p => !p.ganado && !p.disponible && p.usado === null));
  assert.equal(db.value('actividadUsuario/sinplan'), undefined, 'sin membresía no se registra actividad');
  assert.equal(db.value('premiosUsuario/sinplan'), undefined);
});

test('con membresía vigente: forma completa de la respuesta del contrato', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await premiosDe(app);
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.membresia, true);
  assert.deepEqual(Object.keys(b.nivel).sort(), ['desde', 'faltan', 'hasta', 'id', 'nombre', 'xp']);
  assert.deepEqual(Object.keys(b.xp).sort(), ['bienvenida', 'cursos', 'logros', 'referidos', 'retos', 'total']);
  assert.equal(typeof b.racha, 'number');
  assert.equal(typeof b.diasActivos, 'number');
  assert.equal(b.logros.length, 36);
  for (const l of b.logros) {
    assert.deepEqual(Object.keys(l).sort(), ['categoria', 'descripcion', 'ganado', 'id', 'nombre', 'xp']);
  }
  assert.deepEqual(b.premios.map(p => p.clave), ['profesional', 'maestro', 'referidos-1']);
  for (const p of b.premios) {
    assert.deepEqual(Object.keys(p).sort(), ['clave', 'descripcion', 'disponible', 'ganado', 'requisito', 'titulo', 'usado']);
  }
  assert.equal(b.disponibles, 0);
});

test('un miembro nuevo: registra el día de hoy, gana la bienvenida (20 XP) y sigue como Aprendiz', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await premiosDe(app);
  assert.equal(res.body.xp.total, 20);
  assert.equal(res.body.nivel.id, 1);
  assert.equal(res.body.nivel.faltan, 280);
  assert.deepEqual(res.body.logros.filter(l => l.ganado).map(l => l.id), ['l1']);
  assert.equal(res.body.racha, 1);
  assert.equal(res.body.diasActivos, 1);
  assert.deepEqual(db.value('actividadUsuario/ana').dias, [fechaHace(0)]);
});

test('el día activo se registra una sola vez por día aunque se consulte muchas veces', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  for (let i = 0; i < 4; i++) await premiosDe(app);
  assert.deepEqual(db.value('actividadUsuario/ana').dias, [fechaHace(0)]);
});

test('la racha y los días activos salen de la actividad guardada por el servidor (fechas de México)', async () => {
  const seed = { ...baseSeed(), 'actividadUsuario/ana': { uid: 'ana', dias: diasSeguidosHasta(6, 1) } }; // ayer hacia atrás, 6 días
  const { app, db } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app);
  assert.equal(res.body.racha, 7, '6 días anteriores + hoy');
  assert.equal(res.body.diasActivos, 7);
  assert.ok(res.body.logros.find(l => l.id === 'l10').ganado, 'semana de campo');
  assert.equal(db.value('actividadUsuario/ana').dias.length, 7);
});

test('solo se guardan los últimos 120 días de actividad', async () => {
  const viejos = Array.from({ length: 130 }, (_, i) => fechaHace(200 - i)); // muy anteriores, sin huecos hacia hoy
  const { app, db } = cargarServidor({ tokens, seed: { ...baseSeed(), 'actividadUsuario/ana': { uid: 'ana', dias: viejos } } });
  await premiosDe(app);
  const guardados = db.value('actividadUsuario/ana').dias;
  assert.equal(guardados.length, 120);
  assert.equal(guardados.at(-1), fechaHace(0));
});

test('cursos terminados: cuentan los certificados de cursos que existen, una vez cada uno, y solo los del miembro', async () => {
  const seed = baseSeed();
  sembrarCertificados(seed, 'ana', ['c1', 'c2', 'c3', 'c4']);
  seed['certificados/duplicado'] = certificado('ana', 'c1', { folio: 'dup' });           // mismo curso otra vez
  seed['certificados/inventado'] = certificado('ana', 'curso-que-no-existe', { folio: 'x1' }); // curso inexistente
  seed['certificados/sin-curso'] = { folio: 'x2', memberUid: 'ana' };
  sembrarCertificados(seed, 'ajena', ['c5', 'c6', 'c7']);
  const { app } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app);
  const ganados = res.body.logros.filter(l => l.ganado).map(l => l.id);
  assert.ok(ganados.includes('l6'), '4 cursos distintos');
  assert.ok(!ganados.includes('l7'), 'no llegan a 6');
  assert.ok(ganados.includes('l8') && ganados.includes('l25'), 'los 4 cursos son de 4 áreas distintas');
  assert.equal(res.body.xp.logros, 20 + 60 + 80 + 140 + 50 + 150);
});

test('un certificado de un curso retirado de Firestore ya no cuenta (se exige que el curso exista)', async () => {
  const seed = baseSeed();
  delete seed['cursos/c1'];
  sembrarCertificados(seed, 'ana', ['c1']);
  const { app } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app);
  assert.ok(!res.body.logros.find(l => l.id === 'l4').ganado);
});

test('foro y directorio: sus discusiones, me gusta recibidos (sin los propios ni repetidos) y su tarjeta', async () => {
  const seed = baseSeed();
  seed['foroPosts/p1'] = { authorUid: 'ana', title: 't', content: 'c', likes: ['u1', 'u2', 'u2', 'ana'], repliesCount: 3 };
  seed['foroPosts/p2'] = { authorUid: 'ana', title: 't', content: 'c', likes: [], repliesCount: 2 };
  seed['foroPosts/p3'] = { authorUid: 'ajena', title: 't', content: 'c', likes: ['ana', 'u1', 'u3'], repliesCount: 9 };
  seed['directorio/ana'] = { uid: 'ana', nombre: 'Ana Pérez' };
  const { app } = cargarServidor({ tokens, seed });
  const ganados = (await premiosDe(app)).body.logros.filter(l => l.ganado).map(l => l.id);
  assert.ok(ganados.includes('l15'), 'primera discusión');
  assert.ok(!ganados.includes('l16'), '3 discusiones aún no');
  assert.ok(ganados.includes('l18'), '5 respuestas recibidas (3 + 2)');
  assert.ok(!ganados.includes('l19'), 'solo 2 me gusta válidos');
  assert.ok(ganados.includes('l3'), 'tarjeta en el directorio');
});

test('retos: el XP, las insignias y el XP de retos entran al total', async () => {
  const seed = baseSeed();
  seed['retosUsuario/ana'] = { uid: 'ana', xp: 40, xpPractica: 40, superados: 5, dias: ['2026-09-01'], retosHoy: { fecha: '', ids: [] }, camino: { quiz: 4, detective: 0, orden: 0 },
    porReto: { quiz: { veces: 5, mejor: 5, total: 5, superados: 5, perfectos: 1 } } };
  const { app } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app);
  assert.equal(res.body.xp.retos, 40 + 20, 'XP de retos + insignia "Primer reto"');
  assert.equal(res.body.xp.total, 20 + 60);
  assert.ok(res.body.logros.find(l => l.id === 'r1').ganado);
  assert.ok(!res.body.logros.find(l => l.id === 'r2').ganado);
});

test('referidos: sin invitados no suman XP y el premio por invitar no se gana', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await premiosDe(app);
  assert.equal(res.body.xp.referidos, 0);
  assert.ok(res.body.premios.filter(p => p.clave.startsWith('referidos')).every(p => !p.ganado));
});

test('al llegar a Profesional (1200 XP) se gana el premio, queda guardado y está disponible', async () => {
  const seed = baseSeed();
  sembrarCertificados(seed, 'ana', Array.from({ length: 15 }, (_, i) => `c${i + 1}`)); // todos los cursos: 1900+ XP en cursos y maestría
  const { app, db } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app);
  assert.ok(res.body.nivel.id >= 3, `nivel ${res.body.nivel.nombre} con ${res.body.xp.total} XP`);
  const profesional = res.body.premios.find(p => p.clave === 'profesional');
  assert.deepEqual([profesional.ganado, profesional.disponible, profesional.usado], [true, true, null]);
  assert.ok(!res.body.premios.find(p => p.clave === 'maestro').ganado, 'Maestro exige 4500');
  assert.equal(res.body.disponibles, 1);
  assert.deepEqual(db.value('premiosUsuario/ana').ganados, ['profesional']);
});

test('un premio ganado no se pierde aunque el XP baje después', async () => {
  const seed = baseSeed();
  sembrarCertificados(seed, 'ana', Array.from({ length: 15 }, (_, i) => `c${i + 1}`));
  const { app, db } = cargarServidor({ tokens, seed });
  assert.ok((await premiosDe(app)).body.nivel.id >= 3);
  // Se borran los certificados: el XP baja, el premio se queda
  for (const path of [...db._data.keys()]) if (path.startsWith('certificados/')) db._data.delete(path);
  const despues = await premiosDe(app);
  assert.ok(despues.body.nivel.id < 3, 'el nivel se recalcula y baja');
  const profesional = despues.body.premios.find(p => p.clave === 'profesional');
  assert.deepEqual([profesional.ganado, profesional.disponible], [true, true]);
});

test('el premio usado aparece con su curso y GET no pisa los premios ya usados', async () => {
  const seed = baseSeed();
  sembrarCertificados(seed, 'ana', Array.from({ length: 15 }, (_, i) => `c${i + 1}`));
  seed['premiosUsuario/ana'] = { uid: 'ana', ganados: ['profesional'], usados: [{ clave: 'profesional', cursoId: 'c9', fecha: '2026-10-01T00:00:00.000Z' }] };
  const { app, db } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app);
  const profesional = res.body.premios.find(p => p.clave === 'profesional');
  assert.deepEqual(profesional.usado, { cursoId: 'c9', fecha: '2026-10-01T00:00:00.000Z' });
  assert.equal(profesional.disponible, false);
  assert.equal(res.body.disponibles, 0);
  assert.equal(db.value('premiosUsuario/ana').usados.length, 1);
});

test('membresía vencida: vista previa; los premios ya ganados se muestran pero no están disponibles', async () => {
  const seed = { ...baseSeed(), 'premiosUsuario/vencida': { uid: 'vencida', ganados: ['profesional'], usados: [] } };
  const { app } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app, 'token-vencida');
  assert.equal(res.body.membresia, false);
  assert.equal(res.body.nivel.id, 1);
  const profesional = res.body.premios.find(p => p.clave === 'profesional');
  assert.deepEqual([profesional.ganado, profesional.disponible], [true, false]);
  assert.equal(res.body.disponibles, 0);
});

test('un administrador ve su panel pero no entra a la clasificación ni puede canjear', async () => {
  const seed = { ...baseSeed() };
  sembrarCertificados(seed, 'admin', ['c1', 'c2']);
  const { app, db } = cargarServidor({ tokens, seed });
  const res = await premiosDe(app, 'token-admin');
  assert.equal(res.body.membresia, true);
  assert.equal(res.body.premios.every(p => !p.disponible), true);
  assert.equal(db.value('premiosUsuario/admin').xpTotal, undefined, 'los administradores no se clasifican');
});

test('el XP total queda guardado para la clasificación solo si cambia', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  await premiosDe(app);
  assert.equal(db.value('premiosUsuario/ana').xpTotal, 20);
  const version = db._version('premiosUsuario/ana');
  await premiosDe(app);
  assert.equal(db._version('premiosUsuario/ana'), version, 'sin cambios no se vuelve a escribir');
});

test('si el índice de cursos no responde, no revienta: simplemente no cuenta cursos', async () => {
  const seed = baseSeed();
  sembrarCertificados(seed, 'ana', ['c1']);
  const { app, db } = cargarServidor({ tokens, seed });
  const original = db.collection.bind(db);
  db.collection = n => { if (n === 'cursos') throw new Error('Firestore caído'); return original(n); };
  const res = await premiosDe(app);
  assert.equal(res.status, 200);
  assert.ok(!res.body.logros.find(l => l.id === 'l4').ganado);
});

test('no cambia el acceso a los videos: embed-token sigue exigiendo plan igual que antes', async () => {
  const { app } = cargarServidor({ tokens, seed: { ...baseSeed(), 'premiosUsuario/sinplan': { uid: 'sinplan', ganados: ['profesional', 'maestro'], usados: [] } } });
  const { VIDEO_PREMIUM } = require('./helpers/cargar-servidor');
  const sin = await request(app).post('/api/bunny/embed-token').set(auth('token-sinplan')).send({ videoId: VIDEO_PREMIUM });
  assert.equal(sin.status, 403, 'tener premios no abre videos: el sitio los adelanta, el servidor de videos no cambia');
});
