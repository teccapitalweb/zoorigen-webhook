'use strict';

// MODO DE 2 CAMBIOS (simulado). La función sale con UN solo cambio (MAX_CAMBIOS_ORDEN = 1, ver test/cambio-orden-uno.test.js); este archivo
// prueba lo que pasará cuando se amplíe a 2, con fijarMaxCambiosOrdenParaPruebas(2). Es la misma regla, solo que con un número más.
//
// Cambiar el orden de los cursos cerrados con retos (services/retos.js · CAMBIOS_ORDEN_DEFINIDOS, services/calendario.js ·
// moverCursoAlSiguiente y rutas en services/rutas-club.js). Reglas:
//   · 2 cambios por miembro: el 1.º con 35 retos y el 2.º con 55 (acumulados, no se gastan), mínimo 8 / 14 de cada tipo
//     (quiz, detective y ordena; historia no cuenta).
//   · Solo cuentan los retos superados DESPUÉS de activar la función (ordenRetos). Uno ya superado antes cuenta si se supera
//     de nuevo, una sola vez y sin XP.
//   · Solo se mueven cursos cerrados; las fechas son las mismas, repartidas de otra manera.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, ts, dias } = require('./helpers/cargar-servidor');
const { miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const R = require('../services/retos');
const cal = require('../services/calendario');

R.fijarMaxCambiosOrdenParaPruebas(2);

const DIA = 86400000;
const tokens = tokensDe('ana', 'vencida', 'sinplan', 'admin');

// Cinco cursos: la fila es c1, c2, c3, c4, c5 (con prueba en c1, c2 se abre a los 8 días del plan, c3 a los 16, c4 a los 24, c5 a los 32)
function cursos() {
  const seed = {};
  for (let i = 1; i <= 5; i++) seed[`cursos/c${i}`] = { title: `Curso ${i}`, area: 'Manejo', ordenVip: i, createdAt: ts(Date.now() - (40 - i) * DIA), lecciones: [{ titulo: 'Clase 1', videoId: `bbbbbbbb-0000-4000-8000-${String(i * 10 + 1).padStart(12, '0')}`, provider: 'bunny' }] };
  return seed;
}
const miembroNuevo = (haceDias, extra = {}) => miembroConPlan({ name: 'Ana', createdAt: new Date(Date.now() - (haceDias + 5) * DIA).toISOString(), planInicio: ts(Date.now() - haceDias * DIA), ...extra });
const PRUEBA_ANA = { 'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c1', elegidoEn: ts(Date.now() - 6 * DIA) } };

function servidor(seed = {}, env = {}) {
  return cargarServidor({
    tokens, env,
    usuariosAuth: { ana: { creationTime: new Date(Date.now() - 30 * DIA).toUTCString() } },
    seed: {
      ...cursos(), 'config/calendario': { nuevoDesde: ts(Date.now() - 10 * DIA) },
      'miembros/sinplan': miembroSinPlan(),
      'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)), planInicio: ts(dias(-60)), createdAt: new Date(dias(-90)).toISOString() }),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin' }),
      ...seed
    }
  });
}

const rango = n => Array.from({ length: n }, (_, i) => i);
// Retos del camino superados en total (caminoHechos) y los que ya cuentan para el cambio de orden (ordenRetos)
function retosCon(q, d, o, { total = null, usados = 0, uid = 'ana' } = {}) {
  const t = total || [q, d, o];
  return {
    uid, xp: 0, xpPractica: 0, superados: t[0] + t[1] + t[2],
    camino: { quiz: t[0], detective: t[1], orden: t[2] }, caminoHechos: { quiz: rango(t[0]), detective: rango(t[1]), orden: rango(t[2]) },
    ordenRetos: { quiz: rango(q), detective: rango(d), orden: rango(o) }, cambiosOrden: usados
  };
}
const estado = (app, t = 'token-ana') => request(app).get('/api/calendario/cambio-orden').set(auth(t));
const cambiar = (app, cuerpo, t = 'token-ana') => request(app).post('/api/calendario/cambiar-orden').set(auth(t)).send(cuerpo);
const calendario = (app, t = 'token-ana') => request(app).get('/api/calendario').set(auth(t));
const camino = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(cuerpo);
const por = (b, id) => b.cursos.find(c => c.cursoId === id);
const fechas = doc => Object.fromEntries(doc.entradas.map(e => [e.cursoId, e.desbloqueoEn]));
// Miembro nuevo SIN prueba gratuita: c1 se abre el día que empieza el plan y c2, c3, c4 y c5 cada 8 días (ningún adelanto de 15 retos)
const base = (extra = {}) => ({ 'miembros/ana': miembroNuevo(2), ...extra });
// Con prueba gratuita en c1: c2 es el primer curso cerrado y se puede abrir antes con 15 retos
const baseConPrueba = (extra = {}) => ({ ...PRUEBA_ANA, 'miembros/ana': miembroNuevo(2), ...extra });

/* ───────────── Reglas puras ───────────── */

test('retos: sin ordenRetos guardado nadie hereda retos viejos (aunque tenga 100 superados)', () => {
  const e = R.normalizarEstado({ ...retosCon(0, 0, 0, { total: [40, 40, 20] }), ordenRetos: undefined });
  const p = R.progresoCambioOrden(e);
  assert.deepEqual(p.contados, { quiz: 0, detective: 0, orden: 0, total: 0 });
  assert.equal(p.siguiente.n, 1);
  assert.equal(p.siguiente.cumple, false);
  assert.equal(R.normalizarEstado(null).cambiosOrden, 0);
});

test('retos: umbrales y variedad (34/35, 7/8 de cada tipo, 54/55, 13/14)', () => {
  const cumple = (q, d, o, usados = 0) => R.progresoCambioOrden(retosCon(q, d, o, { usados })).siguiente;
  assert.equal(cumple(18, 8, 8).cumple, false, '34 retos');
  assert.equal(cumple(19, 8, 8).cumple, true, '35 retos con 8 de cada tipo');
  assert.equal(cumple(20, 8, 7).cumple, false, '35 retos pero solo 7 de ordena');
  assert.equal(cumple(13, 11, 11).cumple, true);
  assert.deepEqual(cumple(18, 8, 8).faltan, { total: 1, quiz: 0, detective: 0, orden: 0, libres: 1 });
  assert.deepEqual(cumple(20, 8, 7).faltan, { total: 1, quiz: 0, detective: 0, orden: 1, libres: 0 });
  assert.equal(cumple(26, 14, 14, 1).cumple, false, '54 retos');
  assert.equal(cumple(27, 14, 14, 1).cumple, true, '55 retos con 14 de cada tipo');
  assert.equal(cumple(28, 14, 13, 1).cumple, false, '55 retos pero 13 de ordena');
  assert.equal(cumple(27, 14, 14, 1).n, 2);
  assert.equal(cumple(27, 14, 14, 2), null, 'ya no hay más cambios');
  // el segundo cambio no se puede adelantar al primero: sin usar el 1.º, el siguiente sigue siendo el 1.º
  assert.equal(cumple(27, 14, 14, 0).n, 1);
});

test('retos: aplicarCaminoResultado cuenta un reto ya superado una sola vez y sin XP', () => {
  let e = R.normalizarEstado(retosCon(0, 0, 0, { total: [10, 0, 0] }));
  const antes = e.xp;
  let r = R.aplicarCaminoResultado(e, { modo: 'quiz', indice: 3, puntaje: 5, total: 5 });
  assert.deepEqual([r.aceptado, r.xpGanado, r.cuentaOrden], [false, 0, true]);
  assert.deepEqual(r.estado.ordenRetos.quiz, [3]);
  assert.equal(r.estado.xp, antes, 'sin XP nuevo');
  assert.equal(r.estado.superados, 10, 'no suma a superados');
  r = R.aplicarCaminoResultado(r.estado, { modo: 'quiz', indice: 3, puntaje: 5, total: 5 });
  assert.deepEqual([r.cuentaOrden, r.estado.ordenRetos.quiz], [false, [3]], 'la segunda vez ya no cuenta');
  r = R.aplicarCaminoResultado(r.estado, { modo: 'quiz', indice: 4, puntaje: 2, total: 5 });
  assert.deepEqual([r.cuentaOrden, r.estado.ordenRetos.quiz], [false, [3]], 'reprobado no cuenta');
  r = R.aplicarCaminoResultado(r.estado, { modo: 'quiz', indice: 40, puntaje: 5, total: 5 });
  assert.equal(r.xpGanado, 10, 'uno nuevo sí da XP y cuenta');
  assert.deepEqual(r.estado.ordenRetos.quiz, [3, 40]);
});

test('calendario: moverCursoAlSiguiente deja las mismas fechas y no toca cursos abiertos', () => {
  const t0 = Date.UTC(2026, 10, 1);
  const f = k => new Date(t0 + k * 8 * DIA).toISOString();
  const entradas = [{ cursoId: 'a', desbloqueoEn: f(-1) }, { cursoId: 'b', desbloqueoEn: f(1) }, { cursoId: 'c', desbloqueoEn: f(2) }, { cursoId: 'd', desbloqueoEn: f(3) }, { cursoId: 'e', desbloqueoEn: f(4) }];
  const estados = cal.estadoDeCursos({ lista: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })), entradas, eleccion: null, premios: [], adelantado: null, esAdmin: false, ahoraMs: t0 });
  const cerrados = cal.cursosCerradosEnOrden(estados);
  assert.deepEqual(cerrados.map(c => [c.cursoId, c.lugar]), [['b', 1], ['c', 2], ['d', 3], ['e', 4]], 'a ya está abierto');
  const m = cal.moverCursoAlSiguiente(entradas, cerrados, 'd');
  assert.equal(m.ok, true);
  assert.deepEqual([m.deLugar, m.aLugar], [3, 1]);
  const f2 = Object.fromEntries(m.entradas.map(e => [e.cursoId, e.desbloqueoEn]));
  assert.deepEqual([f2.a, f2.d, f2.b, f2.c, f2.e], [f(-1), f(1), f(2), f(3), f(4)]);
  assert.deepEqual(m.entradas.map(e => e.desbloqueoEn).sort(), entradas.map(e => e.desbloqueoEn).sort(), 'mismo conjunto de fechas');
  assert.equal(cal.moverCursoAlSiguiente(entradas, cerrados, 'b').motivo, 'ya-es-el-siguiente');
  assert.equal(cal.moverCursoAlSiguiente(entradas, cerrados, 'a').motivo, 'no-cerrado');
  assert.equal(cal.moverCursoAlSiguiente(entradas, cerrados, 'zzz').motivo, 'no-cerrado');
});

/* ───────────── GET /api/calendario/cambio-orden ───────────── */

test('estado: exige sesión; sin plan o administrador no aplica; con plan muestra avance y cursos cerrados', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(5, 3, 2) }));
  assert.equal((await request(app).get('/api/calendario/cambio-orden')).status, 401);
  for (const t of ['token-sinplan', 'token-vencida', 'token-admin']) {
    const r = await estado(app, t);
    assert.equal(r.status, 200, t);
    assert.deepEqual([r.body.aplica, r.body.disponible, r.body.cursosCerrados], [false, false, []], t);
  }
  const r = await estado(app);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.body.aplica, true);
  assert.deepEqual(r.body.contados, { quiz: 5, detective: 3, orden: 2, total: 10 });
  assert.deepEqual([r.body.usados, r.body.maximo, r.body.siguiente.n, r.body.siguiente.total, r.body.siguiente.porTipo], [0, 2, 1, 35, 8]);
  assert.equal(r.body.siguiente.cumple, false);
  assert.equal(r.body.disponible, false);
  assert.deepEqual(r.body.cursosCerrados.map(c => [c.cursoId, c.lugar]), [['c2', 1], ['c3', 2], ['c4', 3], ['c5', 4]]);
  assert.deepEqual(r.body.xpInsignias, { 1: 40, 2: 60 });
});

/* ───────────── POST /api/calendario/cambiar-orden ───────────── */

test('1.er cambio: con 34 retos no; con 35 (8 de cada tipo) sí, reordena las mismas fechas y deja todo registrado', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(18, 8, 8) }));
  const antesCal = await calendario(app);
  const fechasAntes = Object.fromEntries(antesCal.body.cursos.map(c => [c.cursoId, c.desbloqueoEn]));
  let r = await cambiar(app, { cursoId: 'c4', confirmar: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.codigo, 'retos-insuficientes');
  assert.match(r.body.error, /35 retos nuevos/);
  assert.equal(r.body.faltan.total, 1);
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 0, 'no se gastó nada');

  // un reto más (uno que no tenía antes) y ya se puede
  const uno = await camino(app, { modo: 'quiz', indice: 50, puntaje: 5, total: 5 });
  assert.equal(uno.body.aceptado, true);
  assert.equal(uno.body.cambioOrden.contados.total, 35);
  assert.equal(uno.body.cambioOrden.siguiente.cumple, true);
  assert.equal((await estado(app)).body.disponible, true);

  r = await cambiar(app, { cursoId: 'c4', confirmar: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.deepEqual([r.body.cambio.n, r.body.cambio.cursoId, r.body.cambio.deLugar, r.body.cambio.aLugar], [1, 'c4', 3, 1]);
  assert.deepEqual(r.body.insigniasNuevas.map(i => i.id), ['r11']);
  assert.equal(r.body.cambioOrden.usados, 1);
  assert.equal(r.body.cambioOrden.siguiente.n, 2);

  // c4 toma la fecha de c2 y c2 y c3 se recorren; c5 y los cursos abiertos no cambian
  const nueva = (await calendario(app)).body;
  assert.equal(por(nueva, 'c4').desbloqueoEn, fechasAntes.c2);
  assert.equal(por(nueva, 'c2').desbloqueoEn, fechasAntes.c3);
  assert.equal(por(nueva, 'c3').desbloqueoEn, fechasAntes.c4);
  assert.equal(por(nueva, 'c5').desbloqueoEn, fechasAntes.c5);
  assert.equal(por(nueva, 'c1').abierto, true);
  assert.deepEqual(nueva.proximo && nueva.proximo.cursoId, 'c4');
  const guardado = db.value('calendariosCursos/ana');
  assert.deepEqual(Object.values(fechas(guardado)).sort(), antesCal.body.cursos.filter(c => c.desbloqueoEn).map(c => c.desbloqueoEn).sort());
  // auditoría: en el calendario, en la colección de cambios y en la campana
  assert.equal(guardado.cambiosOrden.length, 1);
  assert.deepEqual([guardado.cambiosOrden[0].n, guardado.cambiosOrden[0].cursoId, guardado.cambiosOrden[0].deLugar], [1, 'c4', 3]);
  assert.equal(guardado.cambiosOrden[0].retos.total, 35);
  const cambios = [...db._data.entries()].filter(([k]) => k.startsWith('calendarioCambios/')).map(([, v]) => v);
  assert.equal(cambios.length, 1);
  assert.deepEqual([cambios[0].uid, cambios[0].cursoId, cambios[0].n], ['ana', 'c4', 1]);
  const aviso = db.value('avisos/ana/items/cambio_orden_1');
  assert.ok(aviso && /Curso 4/.test(aviso.texto));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(aviso.titulo + aviso.texto), 'sin emojis');
  // el servidor guardó el cambio en retos (la insignia sale de ahí) y da su XP
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 1);
  const premios = (await request(app).get('/api/premios').set(auth('token-ana'))).body;
  const r11 = premios.logros.find(l => l.id === 'r11');
  assert.deepEqual([r11.ganado, r11.xp], [true, 40]);
  assert.equal(premios.logros.find(l => l.id === 'r12').ganado, false);
});

test('variedad: 35 retos pero solo 7 de ordena (o 7 de detective) no alcanza para el 1.er cambio', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(20, 8, 7) }));
  const r = await cambiar(app, { cursoId: 'c4', confirmar: true });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body.faltan, { total: 1, quiz: 0, detective: 0, orden: 1, libres: 0 });
  assert.match(r.body.error, /1 de ordena/);
  const { app: app2 } = servidor(base({ 'retosUsuario/ana': retosCon(20, 7, 8) }));
  assert.equal((await cambiar(app2, { cursoId: 'c4', confirmar: true })).status, 403);
});

test('retos viejos NO cuentan: 100 retos superados antes sin ordenRetos = 0 contados; superarlos otra vez cuenta una sola vez y sin XP', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': { ...retosCon(0, 0, 0, { total: [40, 40, 19] }), xp: 590 } }));
  assert.deepEqual((await estado(app)).body.contados, { quiz: 0, detective: 0, orden: 0, total: 0 });
  assert.equal((await cambiar(app, { cursoId: 'c4', confirmar: true })).status, 403);
  const xpAntes = db.value('retosUsuario/ana').xp;
  let r = await camino(app, { modo: 'quiz', indice: 5, puntaje: 5, total: 5 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.aceptado, r.body.xpGanado], [false, 0], 'sin XP porque ya lo tenía');
  assert.deepEqual(r.body.cambioOrden.contados, { quiz: 1, detective: 0, orden: 0, total: 1 }, 'pero ya cuenta para el cambio');
  r = await camino(app, { modo: 'quiz', indice: 5, puntaje: 5, total: 5 });
  assert.equal(r.body.cambioOrden.contados.total, 1, 'el mismo reto no cuenta dos veces');
  assert.equal(db.value('retosUsuario/ana').xp, xpAntes, 'el XP no cambió');
  assert.equal(db.value('retosUsuario/ana').superados, 99, 'superados tampoco');
});

test('2.º cambio: necesita el 1.º usado, 55 retos y 14 de cada tipo; el 3.º se rechaza', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(26, 14, 14, { usados: 1 }) }));   // 54
  let r = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /cambio 2: necesitas 55 retos nuevos \(mínimo 14 de cada tipo\)/);
  db._data.set('retosUsuario/ana', { ...db.value('retosUsuario/ana'), ordenRetos: { quiz: rango(28), detective: rango(14), orden: rango(13) } });   // 55 pero 13 de ordena
  assert.equal((await cambiar(app, { cursoId: 'c5', confirmar: true })).status, 403);
  db._data.set('retosUsuario/ana', { ...db.value('retosUsuario/ana'), ordenRetos: { quiz: rango(27), detective: rango(14), orden: rango(14) } });   // 55 con variedad
  r = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.cambio.n, r.body.insigniasNuevas.map(i => i.id)], [2, ['r12']]);
  assert.equal(r.body.cambioOrden.siguiente, null);
  assert.equal(r.body.cambioOrden.disponible, false);
  // tercero: rechazado aunque haya muchos retos
  db._data.set('retosUsuario/ana', { ...db.value('retosUsuario/ana'), ordenRetos: { quiz: rango(60), detective: rango(55), orden: rango(55) } });
  r = await cambiar(app, { cursoId: 'c3', confirmar: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'sin-cambios');
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 2);
  assert.equal(db.value('calendariosCursos/ana').cambiosOrden.length, 1, 'el calendario solo anota el cambio hecho aquí (el 1.º vino sembrado)');
});

test('el 2.º cambio no se salta el 1.º: con 55 retos y ningún cambio usado se aplica el 1.º', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(27, 14, 14, { usados: 0 }) }));
  const r = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.cambio.n, 1);
  assert.equal(r.body.cambioOrden.usados, 1);
});

test('solo cursos cerrados: abierto, ya siguiente o inexistente se rechazan y no gastan el cambio', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }));
  let r = await cambiar(app, { cursoId: 'c1', confirmar: true });
  assert.deepEqual([r.status, r.body.codigo], [400, 'no-cerrado'], 'el curso de prueba ya está abierto');
  r = await cambiar(app, { cursoId: 'c2', confirmar: true });
  assert.deepEqual([r.status, r.body.codigo], [409, 'ya-es-el-siguiente']);
  r = await cambiar(app, { cursoId: 'no-existe', confirmar: true });
  assert.deepEqual([r.status, r.body.codigo], [400, 'no-cerrado']);
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 0, 'ningún intento gastó el cambio');
  assert.equal(db.value('calendariosCursos/ana').cambiosOrden, undefined);
});

test('un curso abierto antes (por fecha) no se toca y los cerrados se reparten sus fechas', async () => {
  // c2 ya se abrió por fecha (plan de hace 9 días); quedan cerrados c3, c4 y c5
  const { app } = servidor({ 'miembros/ana': miembroNuevo(9), 'retosUsuario/ana': retosCon(19, 8, 8) });
  const antes = (await calendario(app)).body;
  assert.equal(por(antes, 'c2').abierto, true);
  const r = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.cambio.deLugar, r.body.cambio.aLugar], [3, 1]);
  const despues = (await calendario(app)).body;
  assert.equal(por(despues, 'c2').desbloqueoEn, por(antes, 'c2').desbloqueoEn);
  assert.equal(por(despues, 'c5').desbloqueoEn, por(antes, 'c3').desbloqueoEn);
  assert.equal(por(despues, 'c3').desbloqueoEn, por(antes, 'c4').desbloqueoEn);
  assert.equal(por(despues, 'c4').desbloqueoEn, por(antes, 'c5').desbloqueoEn);
});

test('con 35 retos nuevos el primer curso ya se abrió con sus 15 retos: el cambio mueve solo lo que sigue cerrado', async () => {
  const { app, db } = servidor(baseConPrueba({ 'retosUsuario/ana': retosCon(19, 8, 8) }));   // cuenta nueva con prueba: elegible para los 15 retos
  const r = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ficha = db.value('calendariosCursos/ana');
  assert.equal(ficha.cursoAdelantado.cursoId, 'c2', 'el adelanto de 15 retos se aplicó antes de reordenar');
  assert.deepEqual([r.body.cambio.deLugar, r.body.cambio.aLugar], [3, 1], 'entre los cerrados c3, c4 y c5 (c2 ya está abierto)');
  const c = (await calendario(app)).body;
  assert.deepEqual([por(c, 'c2').abierto, por(c, 'c2').porRetos], [true, true]);
  assert.equal(por(c, 'c5').diasFalta, 14, 'c5 toma la fecha de c3 (a 14 días del plan)');
});

test('quién puede: sin sesión 401; sin plan, vencido o administrador no cambian nada; hay que confirmar', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8), 'retosUsuario/vencida': retosCon(19, 8, 8, { uid: 'vencida' }), 'retosUsuario/sinplan': retosCon(19, 8, 8, { uid: 'sinplan' }) }));
  assert.equal((await request(app).post('/api/calendario/cambiar-orden').send({ cursoId: 'c4', confirmar: true })).status, 401);
  for (const t of ['token-sinplan', 'token-vencida']) {
    const r = await cambiar(app, { cursoId: 'c4', confirmar: true }, t);
    assert.deepEqual([r.status, r.body.codigo], [403, 'membresia-requerida'], t);
  }
  assert.equal((await cambiar(app, { cursoId: 'c4', confirmar: true }, 'token-admin')).status, 400);
  assert.equal((await cambiar(app, { cursoId: 'c4' })).status, 400, 'sin confirmar');
  assert.equal((await cambiar(app, { cursoId: 'c4', confirmar: 'true' })).status, 400, 'confirmar debe ser true');
  assert.equal((await cambiar(app, { confirmar: true })).status, 400, 'sin curso');
  assert.equal((await cambiar(app, { cursoId: 'x'.repeat(300), confirmar: true })).status, 400);
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 0);
  assert.equal(db.value('retosUsuario/vencida').cambiosOrden, 0);
});

test('doble clic: dos solicitudes a la vez gastan un solo cambio', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }));
  await calendario(app);   // arma el calendario
  db.lenta = true;
  const dos = await Promise.all([cambiar(app, { cursoId: 'c4', confirmar: true }), cambiar(app, { cursoId: 'c4', confirmar: true })]);
  db.lenta = false;
  const malo = dos.find(r => r.status !== 200);
  assert.deepEqual(dos.map(r => r.status).sort(), [200, 403], JSON.stringify(dos.map(r => r.body)));
  assert.equal(malo.body.codigo, 'retos-insuficientes', 'la segunda ya pide el cambio 2 (55 retos)');
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 1);
  assert.equal(db.value('calendariosCursos/ana').cambiosOrden.length, 1);
  const cambios = [...db._data.keys()].filter(k => k.startsWith('calendarioCambios/'));
  assert.equal(cambios.length, 1);
});

test('dos clics a la vez con cursos distintos: solo uno se aplica (el segundo pide más retos)', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }));
  await calendario(app);
  db.lenta = true;
  const dos = await Promise.all([cambiar(app, { cursoId: 'c4', confirmar: true }), cambiar(app, { cursoId: 'c5', confirmar: true })]);
  db.lenta = false;
  assert.equal(dos.filter(r => r.status === 200).length, 1);
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 1);
});

/* ───────────── Administración ───────────── */

test('admin: GET /api/admin/cambios-orden es solo para administradores y lista lo que cambió cada miembro', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }), { ADMIN_EMAILS: 'admin@example.com' });
  assert.equal((await request(app).get('/api/admin/cambios-orden')).status, 401);
  assert.equal((await request(app).get('/api/admin/cambios-orden').set(auth('token-ana'))).status, 403);
  await cambiar(app, { cursoId: 'c4', confirmar: true });
  const r = await request(app).get('/api/admin/cambios-orden').set(auth('token-admin'));
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.deepEqual([r.body.cambios[0].uid, r.body.cambios[0].cursoId, r.body.cambios[0].n, r.body.cambios[0].curso], ['ana', 'c4', 1, 'Curso 4']);
});

/* ───────────── La oferta va ligada al SIGUIENTE curso por abrirse ───────────── */

const esperar = ms => new Promise(r => setTimeout(r, ms));
// Calendario ya guardado: c1 abierto, c2 se abre en medio segundo y c3, c4 y c5 mucho después
function calendarioQueAbreC2Pronto() {
  const ahora = Date.now();
  const f = ms => new Date(ahora + ms).toISOString();
  return {
    'calendariosCursos/ana': {
      uid: 'ana', version: 1, modo: 'nuevo', fuente: 'plan', inicioMs: ahora - 2 * DIA, eleccion: null, planInicioMs: ahora - 2 * DIA, primerCursoId: null, cursoAdelantado: null,
      entradas: [
        { cursoId: 'c1', desbloqueoEn: f(-2 * DIA) }, { cursoId: 'c2', desbloqueoEn: f(600) }, { cursoId: 'c3', desbloqueoEn: f(8 * DIA) },
        { cursoId: 'c4', desbloqueoEn: f(16 * DIA) }, { cursoId: 'c5', desbloqueoEn: f(24 * DIA) }
      ]
    }
  };
}

test('estado: siempre trae el siguiente curso por abrirse (el primero de los cerrados)', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(5, 3, 2) }));
  const r = (await estado(app)).body;
  assert.equal(r.siguienteCurso.cursoId, 'c2');
  assert.deepEqual([r.siguienteCurso.lugar, r.siguienteCurso.titulo], [1, 'Curso 2']);
  assert.ok(r.siguienteCurso.diasFalta >= 1);
  assert.deepEqual(r.cursosCerrados[0], r.siguienteCurso);
  for (const t of ['token-sinplan', 'token-admin']) assert.equal((await estado(app, t)).body.siguienteCurso, null, t);
});

test('si el siguiente curso se abre solo con 20 retos acumulados, la oferta pasa al nuevo siguiente y nada se pierde', async () => {
  const { app, db } = servidor(base({ ...calendarioQueAbreC2Pronto(), 'retosUsuario/ana': retosCon(8, 6, 6) }));   // 20 retos nuevos
  const antes = (await estado(app)).body;
  assert.equal(antes.siguienteCurso.cursoId, 'c2');
  assert.deepEqual([antes.contados.total, antes.usados, antes.siguiente.n], [20, 0, 1]);
  await esperar(900);   // c2 se abre por su fecha
  const despues = (await estado(app)).body;
  assert.equal(despues.siguienteCurso.cursoId, 'c3', 'la oferta pasó al nuevo siguiente');
  assert.deepEqual(despues.cursosCerrados.map(c => c.cursoId), ['c3', 'c4', 'c5']);
  assert.deepEqual(despues.cursosCerrados.map(c => c.lugar), [1, 2, 3]);
  assert.deepEqual(despues.contados, antes.contados, 'los 20 retos contados se conservan');
  assert.deepEqual([despues.usados, despues.maximo, despues.siguiente.n, despues.siguiente.total], [0, 2, 1, 35], 'los 2 cambios siguen disponibles');
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 0, 'dejar pasar el tiempo no gasta ningún cambio');
  assert.equal(db.value('calendariosCursos/ana').cambiosOrden, undefined);
  // y los retos que siga resolviendo se suman a los de antes
  const uno = await camino(app, { modo: 'quiz', indice: 40, puntaje: 5, total: 5 });
  assert.equal(uno.body.cambioOrden.contados.total, 21);
});

test('con 35 retos ya cumplidos, si el siguiente curso se abre solo, sigue pudiendo elegir sobre el nuevo siguiente', async () => {
  const { app, db } = servidor(base({ ...calendarioQueAbreC2Pronto(), 'retosUsuario/ana': retosCon(19, 8, 8) }));
  const antes = (await estado(app)).body;
  assert.deepEqual([antes.siguienteCurso.cursoId, antes.disponible], ['c2', true]);
  await esperar(900);
  const despues = (await estado(app)).body;
  assert.deepEqual([despues.siguienteCurso.cursoId, despues.disponible, despues.contados.total, despues.usados], ['c3', true, 35, 0]);
  // elegir c2 ya no se puede (se abrió solo) pero c5 sí, y pasa a ser el siguiente
  const mal = await cambiar(app, { cursoId: 'c2', confirmar: true });
  assert.deepEqual([mal.status, mal.body.codigo], [400, 'no-cerrado']);
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 0, 'el intento no gastó nada');
  const ok = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.cambio.deLugar, ok.body.cambio.aLugar], [3, 1]);
  assert.equal(ok.body.cambioOrden.siguienteCurso.cursoId, 'c5');
  assert.equal(ok.body.cambioOrden.usados, 1);
});

test('calendario puro: pasan los días y el siguiente cambia sin tocar fechas ni retos', () => {
  const t0 = Date.UTC(2026, 10, 1);
  const entradas = [{ cursoId: 'a', desbloqueoEn: new Date(t0 + 1 * DIA).toISOString() }, { cursoId: 'b', desbloqueoEn: new Date(t0 + 9 * DIA).toISOString() }, { cursoId: 'c', desbloqueoEn: new Date(t0 + 17 * DIA).toISOString() }];
  const lista = ['a', 'b', 'c'].map(id => ({ id }));
  const en = ms => cal.cursosCerradosEnOrden(cal.estadoDeCursos({ lista, entradas, eleccion: null, premios: [], adelantado: null, esAdmin: false, ahoraMs: ms })).map(c => c.cursoId);
  assert.deepEqual(en(t0), ['a', 'b', 'c']);
  assert.deepEqual(en(t0 + 2 * DIA), ['b', 'c']);
  assert.deepEqual(en(t0 + 10 * DIA), ['c']);
  assert.deepEqual(en(t0 + 20 * DIA), []);
});

/* ───────────── Las insignias no muestran su XP (se otorga igual) ───────────── */

test('insignias r11 y r12: descripción corta, XP otorgado (+40 y +60) y el aviso de la campana no menciona el XP', async () => {
  const [r11, r12] = ['r11', 'r12'].map(id => R.INSIGNIAS.find(i => i.id === id));
  assert.deepEqual([r11.xp, r12.xp], [40, 60]);
  for (const i of [r11, r12]) { assert.ok(i.desc.length <= 60, i.desc); assert.equal(/XP|\d+ retos|solo hay/i.test(i.desc), false, 'la descripción no trae cifras ni reglas: ' + i.desc); }
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }));
  const r = await cambiar(app, { cursoId: 'c4', confirmar: true });
  assert.equal(r.status, 200);
  const aviso = db.value('avisos/ana/items/logro_r11');
  assert.ok(aviso, 'avisó la insignia');
  assert.equal(/XP/.test(aviso.texto), false, 'sin XP en el aviso: ' + aviso.texto);
  assert.equal(aviso.texto, 'Calendario a tu medida');
  const premios = (await request(app).get('/api/premios').set(auth('token-ana'))).body;
  const l = premios.logros.find(x => x.id === 'r11');
  assert.deepEqual([l.ganado, l.xp, l.categoria], [true, 40, 'Retos'], 'el servidor sigue otorgando el XP');
  assert.equal(premios.logros.length, 38, '26 logros + 12 insignias de retos');
});

/* ───────────── Retos «de cualquier tipo» (los libres) ───────────── */

test('libres: 35 - 3 × 8 = 11 en el primer cambio y 55 - 3 × 14 = 13 en el segundo; 8/8/8 son 24 de 35 y no alcanza', () => {
  const p = R.progresoCambioOrden(retosCon(8, 8, 8));
  assert.deepEqual([p.contados.total, p.tramos[0].libres, p.tramos[0].cumple], [24, { hechos: 0, meta: 11 }, false]);
  assert.deepEqual(p.tramos[1].libres, { hechos: 0, meta: 13 });
  assert.equal(p.tramos[0].faltan.libres, 11);
  assert.equal(p.tramos[0].faltan.total, 11, 'faltan 11 para llegar a 35');
});

test('libres: lo que pasa del mínimo de cada tipo llena los libres (20 quiz + 8 + 8 = 36 sí alcanza; los 12 extras de quiz llenan los 11)', () => {
  const p = R.progresoCambioOrden(retosCon(20, 8, 8));
  assert.deepEqual([p.contados.total, p.tramos[0].libres, p.tramos[0].cumple], [36, { hechos: 11, meta: 11 }, true], 'tope en 11');
  const medio = R.progresoCambioOrden(retosCon(12, 9, 8));
  assert.deepEqual(medio.tramos[0].libres, { hechos: 5, meta: 11 }, '4 de quiz + 1 de detective');
  assert.equal(medio.tramos[0].faltan.libres, 6);
  assert.equal(medio.tramos[0].cumple, false);
  const dos = R.progresoCambioOrden(retosCon(26, 14, 14, { usados: 1 }));
  assert.deepEqual(dos.tramos[1].libres, { hechos: 12, meta: 13 }, '54 retos: falta 1 libre');
  assert.equal(dos.siguiente.cumple, false);
  assert.deepEqual(R.progresoCambioOrden(retosCon(27, 14, 14, { usados: 1 })).tramos[1].libres, { hechos: 13, meta: 13 });
});

test('libres: coinciden con la regla real de elegibilidad en todas las combinaciones (cumple ⇔ cada tipo en su mínimo y libres completos)', () => {
  let revisadas = 0;
  for (let q = 0; q <= 40; q += 3) for (let d = 0; d <= 40; d += 3) for (let o = 0; o <= 40; o += 3) {
    const tr = R.progresoCambioOrden(retosCon(q, d, o)).tramos;
    for (const t of tr) {
      const porTipoOk = q >= t.porTipo && d >= t.porTipo && o >= t.porTipo;
      assert.equal(t.cumple, porTipoOk && t.libres.hechos >= t.libres.meta, `${q}/${d}/${o} cambio ${t.n}`);
      assert.ok(t.libres.hechos >= 0 && t.libres.hechos <= t.libres.meta);
      assert.equal(t.libres.meta, t.total - 3 * t.porTipo);
    }
    revisadas++;
  }
  assert.ok(revisadas > 2000);
});

test('estado: el servidor devuelve los libres por cambio (no se calculan solo en el navegador)', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(8, 8, 8) }));
  const r = (await estado(app)).body;
  assert.deepEqual(r.tramos.map(t => t.libres), [{ hechos: 0, meta: 11 }, { hechos: 0, meta: 13 }]);
  assert.equal(r.siguiente.libres.meta, 11);
  const camino = await request(app).post('/api/retos/camino').set(auth('token-ana')).send({ modo: 'quiz', indice: 30, puntaje: 5, total: 5 });
  assert.deepEqual(camino.body.cambioOrden.tramos[0].libres, { hechos: 1, meta: 11 }, 'un quiz más de los ya 8 cuenta como libre');
});
