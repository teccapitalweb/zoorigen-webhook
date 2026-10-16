'use strict';

// Calendario de cursos en el servidor: GET /api/calendario, video (embed-token), progreso de clases y los 15 retos para
// abrir el primer curso. Casos pedidos: prueba sin terminar que paga, prueba terminada que paga, nunca eligió prueba,
// miembro antiguo y vencido.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, ts, dias } = require('./helpers/cargar-servidor');
const { miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');

const DIA = 86400000;
const U = n => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tokens = tokensDe('ana', 'beto', 'vieja', 'vencida', 'sinplan', 'admin', 'prueba', 'nueva');

// Cinco cursos con fecha de creación y ordenVip: la fila es c1, c2, c3, c4, c5
function cursos() {
  const seed = {};
  for (let i = 1; i <= 5; i++) {
    seed[`cursos/c${i}`] = {
      title: `Curso ${i}`, area: 'Manejo', ordenVip: i, createdAt: ts(Date.now() - (40 - i) * DIA),
      lecciones: [1, 2, 3].map(k => ({ titulo: `Clase ${k}`, videoId: U(i * 10 + k), provider: 'bunny' }))
    };
  }
  return seed;
}
// Hace que la fila del calendario sea de "plan nuevo": el calendario del servidor se activó hace 10 días
const activo = (extra = {}) => ({ 'config/calendario': { nuevoDesde: ts(Date.now() - 10 * DIA) }, ...extra });

const miembroNuevo = (haceDias, extra = {}) => miembroConPlan({
  name: 'Ana', createdAt: new Date(Date.now() - (haceDias + 5) * DIA).toISOString(), planInicio: ts(Date.now() - haceDias * DIA), ...extra
});

function servidor(seed = {}, env = {}) {
  return cargarServidor({
    tokens, env,
    usuariosAuth: { ana: { creationTime: new Date(Date.now() - 30 * DIA).toUTCString() } },
    seed: {
      ...cursos(), ...activo(),
      'miembros/sinplan': miembroSinPlan(),
      'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)), planInicio: ts(dias(-60)), createdAt: new Date(dias(-90)).toISOString() }),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin' }),
      ...seed
    }
  });
}
const calendario = (app, t = 'token-ana') => request(app).get('/api/calendario').set(auth(t));
const embed = (app, videoId, t = 'token-ana') => request(app).post('/api/bunny/embed-token').set(auth(t)).send({ videoId });
const progreso = (app, cursoId, sessionIndex, t = 'token-ana') => request(app).post(`/api/cursos/${cursoId}/progreso`).set(auth(t)).send({ sessionIndex });
const por = (b, id) => b.cursos.find(c => c.cursoId === id);

/* ───────────── Quién ve qué ───────────── */

test('GET /api/calendario: sin sesión 401; sin plan o vencido no hay calendario; el administrador lo tiene todo abierto', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/calendario')).status, 401);
  for (const t of ['token-sinplan', 'token-vencida']) {
    const r = await calendario(app, t);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.membresia, r.body.cursos, r.body.proximo, r.body.primerCurso.aplica], [false, [], null, false], t);
  }
  const a = await calendario(app, 'token-admin');
  assert.deepEqual([a.body.membresia, a.body.admin, a.body.cursos], [true, true, []]);
  assert.equal(a.headers['cache-control'], 'no-store');
});

test('prueba sin terminar que paga: el calendario y los "Restan N días" se ven de inmediato, con el curso de prueba como el primero', async () => {
  const { app, db } = servidor({
    'miembros/ana': miembroNuevo(3),
    'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c2', elegidoEn: ts(Date.now() - 6 * DIA) }
    // sin terminar: ni una clase vista
  });
  const r = await calendario(app);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.deepEqual([b.membresia, b.calendario.modo, b.calendario.eleccion], [true, 'prueba', 'c2']);
  assert.deepEqual([por(b, 'c2').abierto, por(b, 'c2').esPrueba], [true, true], 'la prueba es el primer curso y está abierto');
  // El resto cuenta desde que pagó (hace 3 días): c1 a los 8, c3 a los 16, c4 a los 24, c5 a los 32
  assert.deepEqual(['c1', 'c3', 'c4', 'c5'].map(id => por(b, id).abierto), [false, false, false, false]);
  assert.deepEqual(['c1', 'c3', 'c4', 'c5'].map(id => por(b, id).diasFalta), [5, 13, 21, 29]);
  assert.equal(b.proximo.cursoId, 'c1');
  assert.equal(b.proximo.diasFalta, 5);
  assert.ok(db.value('calendariosCursos/ana'), 'se guarda en una colección solo del servidor');
});

test('prueba terminada que paga: mismo calendario, sin esperar nada más', async () => {
  const { app } = servidor({
    'miembros/ana': miembroNuevo(3),
    'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c2', elegidoEn: ts(Date.now() - 6 * DIA) },
    'miembros/ana/progresoCursos/c2': { cursoId: 'c2', uid: 'ana', sesionesVistas: [0, 1, 2], completado: true, completadoEn: ts(Date.now() - DIA) }
  });
  const b = (await calendario(app)).body;
  assert.equal(b.calendario.modo, 'prueba');
  assert.deepEqual(['c1', 'c3'].map(id => por(b, id).diasFalta), [5, 13]);
});

test('nunca eligió prueba: el primer curso se abre al hacerse miembro y el siguiente a los 8 días', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2) });
  const b = (await calendario(app)).body;
  assert.equal(b.calendario.modo, 'nuevo');
  assert.equal(por(b, 'c1').abierto, true);
  assert.deepEqual(['c2', 'c3', 'c4', 'c5'].map(id => por(b, id).diasFalta), [6, 14, 22, 30]);
  assert.equal(b.proximo.cursoId, 'c2');
});

test('miembro antiguo (plan anterior a la activación del calendario): conserva la cuenta de siempre y no pierde ningún curso', async () => {
  const { app } = servidor({ 'miembros/vieja': miembroConPlan({ name: 'Vieja', createdAt: new Date(Date.now() - 100 * DIA).toISOString(), planInicio: ts(Date.now() - 60 * DIA) }) });
  const b = (await calendario(app, 'token-vieja')).body;
  assert.equal(b.calendario.modo, 'legado');
  assert.ok(b.cursos.every(c => c.abierto), 'con 100 días de cuenta, los 5 cursos ya estaban abiertos');
  assert.equal(b.proximo, null);
  assert.equal(b.primerCurso.aplica, false, 'nada que adelantar');
});

test('miembro de siempre con pocos días: el primer curso abierto y los demás cada 8 días desde que se creó la cuenta', async () => {
  const { app } = servidor({ 'miembros/vieja': miembroConPlan({ createdAt: new Date(Date.now() - 12 * DIA - 3600000).toISOString(), planInicio: ts(Date.now() - 12 * DIA) }) });
  const b = (await calendario(app, 'token-vieja')).body;
  assert.equal(b.calendario.modo, 'legado');
  assert.deepEqual(b.cursos.map(c => c.abierto), [true, true, false, false, false], '12 días: los dos primeros');
  assert.deepEqual(['c3', 'c4', 'c5'].map(id => por(b, id).diasFalta), [4, 12, 20]);
});

test('vencido: sin calendario ni acceso a videos', async () => {
  const { app } = servidor({}, { CALENDARIO_MODO: 'estricto' });
  assert.equal((await calendario(app, 'token-vencida')).body.membresia, false);
  assert.equal((await embed(app, U(11), 'token-vencida')).status, 403);
});

/* ───────────── Persistencia y reanudación ───────────── */

test('el calendario se guarda una vez y no se mueve: las fechas no cambian entre consultas ni cuando cambia la hora de pago', async () => {
  const { app, db } = servidor({ 'miembros/ana': miembroNuevo(2) });
  const a = (await calendario(app)).body;
  const guardado = db.value('calendariosCursos/ana');
  const b = (await calendario(app)).body;
  assert.deepEqual(a.cursos.map(c => c.desbloqueoEn), b.cursos.map(c => c.desbloqueoEn));
  assert.deepEqual(db.value('calendariosCursos/ana').entradas, guardado.entradas);
  assert.equal(guardado.modo, 'nuevo');
});

test('la fecha de activación se fija sola la primera vez: quien ya era miembro antes conserva su regla', async () => {
  const { app, db } = cargarServidor({
    tokens, seed: { ...cursos(), 'miembros/vieja': miembroConPlan({ createdAt: new Date(Date.now() - 50 * DIA).toISOString(), planInicio: ts(Date.now() - 20 * DIA) }) }
  });
  const b = (await calendario(app, 'token-vieja')).body;
  assert.equal(b.calendario.modo, 'legado');
  const cfg = db.value('config/calendario');
  assert.ok(cfg && cfg.nuevoDesde, 'se creó config/calendario con el momento de activación');
});

test('CALENDARIO_NUEVO_DESDE fija la fecha a mano', async () => {
  const { app } = cargarServidor({
    tokens, env: { CALENDARIO_NUEVO_DESDE: new Date(Date.now() - 30 * DIA).toISOString() },
    seed: { ...cursos(), 'miembros/ana': miembroConPlan({ createdAt: new Date(Date.now() - 50 * DIA).toISOString(), planInicio: ts(Date.now() - 20 * DIA) }) }
  });
  const b = (await calendario(app)).body;
  assert.equal(b.calendario.modo, 'nuevo', 'su plan empezó después de la fecha fijada');
  assert.equal(por(b, 'c1').abierto, true);
  assert.equal(por(b, 'c4').abierto, false, 'c4 se abre a los 24 días');
});

test('al volver a pagar, lo que estaba cerrado al vencer cuenta 8 días por curso desde la reactivación y lo abierto se conserva', async () => {
  const inicio = Date.now() - 20 * DIA;
  const entradas = [0, 8, 16, 24, 32].map((d, i) => ({ cursoId: 'c' + (i + 1), desbloqueoEn: new Date(inicio + d * DIA).toISOString() }));
  const { app, db } = servidor({
    // pagó de nuevo hace 1 día; el plan anterior venció hace 10 días: c1 y c2 ya estaban abiertos; c3, c4 y c5 no
    'miembros/ana': miembroNuevo(1),
    'calendariosCursos/ana': { uid: 'ana', version: 1, modo: 'nuevo', inicioMs: inicio, planInicioMs: inicio, venceMs: Date.now() - 10 * DIA, entradas, primerCursoId: null, cursoAdelantado: null, eleccion: null }
  });
  const b = (await calendario(app)).body;
  assert.deepEqual(['c1', 'c2'].map(id => por(b, id).abierto), [true, true]);
  assert.deepEqual(['c3', 'c4', 'c5'].map(id => por(b, id).abierto), [false, false, false]);
  assert.deepEqual(['c3', 'c4', 'c5'].map(id => por(b, id).diasFalta), [7, 15, 23], 'ocho días por curso desde que volvió a pagar (hace 1 día)');
  // y queda guardado: una consulta posterior no vuelve a mover nada
  const antes = db.value('calendariosCursos/ana').entradas;
  await calendario(app);
  assert.deepEqual(db.value('calendariosCursos/ana').entradas, antes);
});

test('un curso publicado después se agrega al final de la fila sin mover los demás', async () => {
  const { app, db } = servidor({ 'miembros/ana': miembroNuevo(2) });
  const antes = (await calendario(app)).body;
  db._data.set('cursos/c6', { title: 'Curso 6', ordenVip: 6, createdAt: ts(Date.now()), lecciones: [{ videoId: U(61) }, { videoId: U(62) }] });
  // el índice de cursos se guarda 60 s: se pide uno nuevo
  const { app: app2 } = cargarServidor({ tokens, usuariosAuth: {}, seed: Object.fromEntries([...db._data.entries()]) });
  const despues = (await calendario(app2)).body;
  assert.deepEqual(['c1', 'c2', 'c3', 'c4', 'c5'].map(id => por(despues, id).desbloqueoEn), ['c1', 'c2', 'c3', 'c4', 'c5'].map(id => por(antes, id).desbloqueoEn));
  assert.equal(por(despues, 'c6').diasFalta, 38);
});

test('premios: el curso abierto con un premio aparece abierto y los demás conservan su fecha', async () => {
  const { app } = servidor({
    'miembros/ana': miembroNuevo(2),
    'premiosUsuario/ana': { uid: 'ana', ganados: ['profesional'], usados: [{ clave: 'profesional', cursoId: 'c4', fecha: new Date().toISOString() }] }
  });
  const b = (await calendario(app)).body;
  assert.deepEqual([por(b, 'c4').abierto, por(b, 'c4').porPremio], [true, true]);
  assert.equal(por(b, 'c2').diasFalta, 6);
  assert.equal(por(b, 'c3').diasFalta, 14);
});

/* ───────────── Video y progreso: modo transición y estricto ───────────── */

test('modo transición (por defecto): un curso cerrado NO se rechaza, solo se anota lo que se habría rechazado', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2), 'miembros/admin': miembroSinPlan({ role: 'admin' }) });
  const r = await embed(app, U(31));          // c3 todavía cerrado
  assert.equal(r.status, 200);
  assert.ok(r.body.embedUrl);
  const estado = await request(app).get('/api/admin/calendario').set(auth('token-admin'));
  assert.equal(estado.status, 200);
  assert.deepEqual([estado.body.modo, estado.body.rechazosSimulados, estado.body.rechazos], ['transicion', 1, 0]);
  // las rutas de administración exigen administrador
  assert.equal((await request(app).get('/api/admin/calendario').set(auth('token-ana'))).status, 403);
  assert.equal((await request(app).get('/api/admin/calendario')).status, 401);
});

test('modo estricto: el curso cerrado se rechaza con motivo claro; el abierto, el de prueba y el del administrador pasan', async () => {
  const { app } = servidor({
    'miembros/ana': miembroNuevo(3),
    'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c2', elegidoEn: ts(Date.now() - 6 * DIA) },
    'miembros/admin': miembroSinPlan({ role: 'admin' })
  }, { CALENDARIO_MODO: 'estricto' });
  const cerrado = await embed(app, U(11));     // c1 se abre en 5 días
  assert.equal(cerrado.status, 403);
  assert.equal(cerrado.body.codigo, 'curso-bloqueado');
  assert.equal(cerrado.body.cursoId, 'c1');
  assert.equal(cerrado.body.diasFalta, 5);
  assert.match(cerrado.body.error, /todavía no está abierto.*en 5 días/);
  assert.match(cerrado.body.error, /15 retos/);
  assert.equal((await embed(app, U(21))).status, 200, 'el curso de prueba está abierto (incluida su última clase)');
  assert.equal((await embed(app, U(23))).status, 200);
  assert.equal((await embed(app, U(11), 'token-admin')).status, 200);
});

test('modo estricto: sin cambio para el miembro de siempre (todo abierto) ni para los videos gratis o del catálogo estático', async () => {
  const { app } = servidor({
    'miembros/vieja': miembroConPlan({ createdAt: new Date(Date.now() - 100 * DIA).toISOString(), planInicio: ts(Date.now() - 60 * DIA) }),
    'miembros/ana': miembroNuevo(2)
  }, { CALENDARIO_MODO: 'estricto' });
  for (const n of [11, 21, 31, 41, 51]) assert.equal((await embed(app, U(n), 'token-vieja')).status, 200, 'video ' + n);
  // el video gratis fijo del catálogo sigue siendo gratis para quien tiene plan
  assert.equal((await embed(app, 'befd1641-850a-4099-88a8-047a1badc703')).status, 200);
  // un video de otro curso del catálogo estático (sin curso en la fila) no se toca
  assert.equal((await embed(app, 'b9b4a50a-9cec-45c2-b66f-e965eb97aebe')).status, 200);
});

test('modo estricto: el progreso y el quiz de un curso cerrado se rechazan; el de un curso abierto avanza', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2) }, { CALENDARIO_MODO: 'estricto' });
  const cerrado = await progreso(app, 'c3', 0);
  assert.equal(cerrado.status, 403);
  assert.equal(cerrado.body.codigo, 'curso-bloqueado');
  const quiz = await request(app).post('/api/cursos/c3/quiz').set(auth('token-ana')).send({ sessionIndex: 0, respuestas: [] });
  assert.equal(quiz.status, 403);
  const abierto = await progreso(app, 'c1', 0);
  assert.equal(abierto.status, 200);
  assert.deepEqual(abierto.body.sesionesVistas, [0]);
});

test('modo transición: el progreso de un curso cerrado sigue funcionando como hoy', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2) });
  assert.equal((await progreso(app, 'c3', 0)).status, 200);
});

test('si el catálogo no se puede leer o la persona no está en la fila, nunca se cierra nada', async () => {
  const { app } = cargarServidor({ tokens, env: { CALENDARIO_MODO: 'estricto' }, seed: { 'miembros/ana': miembroNuevo(2) } });   // sin cursos
  assert.equal((await embed(app, 'b9b4a50a-9cec-45c2-b66f-e965eb97aebe')).status, 200);
  const b = (await calendario(app)).body;
  assert.deepEqual([b.membresia, b.cursos, b.calendario], [true, [], null]);
});

/* ───────────── 15 retos ───────────── */

const rango = n => Array.from({ length: n }, (_, i) => i);
const retosHechos = (q, d, o) => ({ uid: 'ana', xp: 0, xpPractica: 0, superados: q + d + o, camino: { quiz: q, detective: d, orden: o }, caminoHechos: { quiz: rango(q), detective: rango(d), orden: rango(o) } });
const camino = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(cuerpo);
const leerRetos = (app, t = 'token-ana') => request(app).get('/api/retos').set(auth(t));

test('15 retos: el primer curso cerrado muestra su avance (N de 15) y sigue cerrado hasta cumplirlos', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2), 'retosUsuario/ana': retosHechos(6, 3, 2) });
  const r = await leerRetos(app);
  const p = r.body.primerCurso;
  assert.deepEqual([p.aplica, p.estado, p.cursoId, p.titulo], [true, 'pendiente', 'c2', 'Curso 2']);
  assert.equal(p.diasFalta, 6);
  assert.deepEqual([p.progreso.hechos, p.progreso.meta, p.progreso.completo], [4 + 3 + 2 + 2, 15, false]);
  assert.deepEqual(p.progreso.tipos, { quiz: { hechos: 4, meta: 4 }, detective: { hechos: 3, meta: 4 }, orden: { hechos: 2, meta: 4 } });
  // también en el calendario
  const c = (await calendario(app)).body;
  assert.equal(c.primerCurso.estado, 'pendiente');
  assert.equal(por(c, 'c2').abierto, false);
});

test('15 retos: al superar el reto número 15 el primer curso se abre, se avisa y el contador de días desaparece', async () => {
  const { app, db } = servidor({ 'miembros/ana': miembroNuevo(2), 'retosUsuario/ana': retosHechos(6, 4, 4) }, { CALENDARIO_MODO: 'estricto' });   // 6 + 4 + 4 = 14 retos
  assert.equal((await embed(app, U(21))).status, 403, 'antes: cerrado');
  assert.equal((await leerRetos(app)).body.primerCurso.estado, 'pendiente');
  const r = await camino(app, { modo: 'quiz', indice: 20, puntaje: 5, total: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.aceptado, true);
  assert.deepEqual([r.body.primerCurso.estado, r.body.primerCurso.abierto, r.body.primerCurso.cursoId], ['abierto-ahora', true, 'c2']);
  assert.equal(r.body.primerCurso.progreso.completo, true);
  // el servidor lo guardó
  const ficha = db.value('calendariosCursos/ana');
  assert.equal(ficha.cursoAdelantado.cursoId, 'c2');
  assert.equal(ficha.cursoAdelantado.via, 'retos');
  assert.equal(db.value('miembros/ana').cursoAdelantado, 'c2', 'copia visible en la ficha del miembro');
  // aviso en la campana
  const aviso = db.value('avisos/ana/items/primer_curso_retos');
  assert.ok(aviso && aviso.tipo === 'curso' && /Curso 2/.test(aviso.texto));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(aviso.titulo + aviso.texto), 'sin emojis');
  // el curso adelantado se abre en el video y en el progreso; el contador desaparece
  const c = (await calendario(app)).body;
  assert.deepEqual([por(c, 'c2').abierto, por(c, 'c2').porRetos, por(c, 'c2').diasFalta], [true, true, 0]);
  assert.equal(c.primerCurso.aplica, false, 'la tarjeta de los 15 retos desaparece');
  assert.equal((await embed(app, U(21))).status, 200);
  assert.equal((await progreso(app, 'c2', 0)).status, 200);
  // los demás conservan su fecha: el adelanto no corre el turno de nadie
  assert.deepEqual(['c3', 'c4', 'c5'].map(id => por(c, id).diasFalta), [14, 22, 30]);
  assert.equal((await embed(app, U(31))).status, 403);
  // un segundo curso NO se abre aunque sigan los retos: solo el primero
  await camino(app, { modo: 'quiz', indice: 21, puntaje: 5, total: 5 });
  assert.equal(por((await calendario(app)).body, 'c3').abierto, false);
});

test('15 retos: no basta con 15 de un solo tipo (mínimo 4 de quiz, detective y ordena)', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2), 'retosUsuario/ana': retosHechos(20, 0, 0) });
  const p = (await leerRetos(app)).body.primerCurso;
  assert.deepEqual([p.estado, p.progreso.completo, p.progreso.hechos], ['pendiente', false, 7]);
  assert.equal(por((await calendario(app)).body, 'c2').abierto, false);
});

test('15 retos: lo que no cuenta (flashcards, historia, práctica diaria) no suma', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(2), 'retosUsuario/ana': { ...retosHechos(4, 4, 4), superados: 40, porReto: { flashcards: { veces: 20, mejor: 8, total: 8, superados: 20, perfectos: 0 }, historia: { veces: 20, mejor: 4, total: 4, superados: 20, perfectos: 0 } } } });
  const p = (await leerRetos(app)).body.primerCurso;
  assert.deepEqual([p.estado, p.progreso.hechos], ['pendiente', 12]);
  const r = await request(app).post('/api/retos/resultado').set(auth('token-ana')).send({ retoId: 'flashcards', puntaje: 8, total: 8 });
  assert.equal(r.status, 200);
  assert.equal((await leerRetos(app)).body.primerCurso.progreso.hechos, 12);
});

test('15 retos: los 15 retos con la prueba elegida abren el primer curso de la fila (no el de prueba)', async () => {
  const { app } = servidor({
    'miembros/ana': miembroNuevo(3), 'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c2', elegidoEn: ts(Date.now() - 6 * DIA) },
    'retosUsuario/ana': retosHechos(7, 4, 4)
  });
  const p = (await leerRetos(app)).body.primerCurso;
  assert.deepEqual([p.estado, p.cursoId], ['abierto-ahora', 'c1']);
  const c = (await calendario(app)).body;
  assert.deepEqual([por(c, 'c1').abierto, por(c, 'c3').abierto, por(c, 'c2').esPrueba], [true, false, true]);
});

test('15 retos: miembro de siempre con todo abierto o administrador o sin plan: no aplica y no se modifica nada', async () => {
  const { app, db } = servidor({
    'miembros/vieja': miembroConPlan({ createdAt: new Date(Date.now() - 100 * DIA).toISOString(), planInicio: ts(Date.now() - 60 * DIA) }),
    'retosUsuario/vieja': { ...retosHechos(10, 10, 10), uid: 'vieja' }, 'retosUsuario/sinplan': { ...retosHechos(10, 10, 10), uid: 'sinplan' }
  });
  for (const t of ['token-vieja', 'token-sinplan']) assert.equal((await leerRetos(app, t)).body.primerCurso.aplica, false, t);
  assert.equal((await camino(app, { modo: 'quiz', indice: 20, puntaje: 5, total: 5 }, 'token-sinplan')).status, 403);
  assert.equal(db.value('calendariosCursos/vieja').cursoAdelantado, null);
  assert.equal(db.value('calendariosCursos/sinplan'), undefined);
});

test('15 retos: una cuenta que ya tenía 15 retos hechos antes recibe su curso la primera vez que se consulta', async () => {
  const { app } = servidor({ 'miembros/ana': miembroNuevo(1), 'retosUsuario/ana': retosHechos(8, 6, 5) });
  assert.equal((await calendario(app)).body.primerCurso.estado, 'abierto-ahora');
});

test('15 retos: dos solicitudes a la vez abren el curso una sola vez', async () => {
  const { app, db } = servidor({ 'miembros/ana': miembroNuevo(2), 'retosUsuario/ana': retosHechos(7, 4, 4) });
  db.lenta = true;
  const [a, b] = await Promise.all([leerRetos(app), leerRetos(app)]);
  assert.ok([a, b].some(x => x.body.primerCurso.estado === 'abierto-ahora'));
  assert.equal(db.value('calendariosCursos/ana').cursoAdelantado.cursoId, 'c2');
  assert.equal((await calendario(app)).body.primerCurso.aplica, false);
});

/* ───────────── Solo miembros nuevos pueden abrir el curso con 15 retos ───────────── */

test('15 retos: un miembro de antes (plan anterior a la activación del calendario) NO abre su curso con retos, aunque ya tenga 15 hechos', async () => {
  // La activación del calendario fue hace 10 días (ver activo()); este miembro empezó su plan hace 20 días y se registró hace 22
  const { app, db } = servidor({
    'miembros/ana': miembroConPlan({ name: 'Ana', createdAt: new Date(Date.now() - 22 * DIA).toISOString(), planInicio: ts(Date.now() - 20 * DIA) }),
    'retosUsuario/ana': retosHechos(8, 6, 5)
  });
  const r = await leerRetos(app);
  assert.equal(r.body.primerCurso.aplica, false, 'la tarjeta de los 15 retos no aplica a miembros de antes');
  const c = (await calendario(app)).body;
  assert.equal(c.primerCurso.aplica, false);
  const calDoc = db.value('calendariosCursos/ana');
  assert.ok(!calDoc || !calDoc.cursoAdelantado, 'no se adelantó ningún curso');
  assert.ok(!db.value('miembros/ana').cursoAdelantado, 'la ficha no se tocó');
});

test('15 retos: el curso cerrado de un miembro de antes no ofrece la vía de los 15 retos en su mensaje; el de un miembro nuevo sí', async () => {
  const antiguo = servidor({ 'miembros/ana': miembroConPlan({ name: 'Ana', createdAt: new Date(Date.now() - 12 * DIA).toISOString(), planInicio: ts(Date.now() - 20 * DIA) }) }, { CALENDARIO_MODO: 'estricto' });
  const c0 = (await calendario(antiguo.app)).body;
  const cerrado0 = c0.cursos.find(x => !x.abierto);
  if (cerrado0) {
    const rr = await request(antiguo.app).post('/api/bunny/embed-token').set(auth('token-ana')).send({ videoId: cerrado0.videoIds ? cerrado0.videoIds[0] : '00000000-0000-0000-0000-000000000000', cursoId: cerrado0.cursoId });
    if (rr.status === 403 && rr.body && rr.body.error) assert.doesNotMatch(rr.body.error, /15 retos/, 'un miembro de antes no ve la oferta de 15 retos');
  }
  const nuevo = servidor({ 'miembros/ana': miembroNuevo(2) }, { CALENDARIO_MODO: 'estricto' });
  const c1 = (await calendario(nuevo.app)).body;
  assert.equal(c1.primerCurso.aplica, true, 'el miembro nuevo sí tiene la vía de los 15 retos');
});
