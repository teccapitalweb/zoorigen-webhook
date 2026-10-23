'use strict';

// Reglas puras de los retos: XP, camino abierto (cualquier orden, XP una vez por reto), topes e insignias.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../services/retos');

const dia = n => new Date(Date.UTC(2026, 8, n, 18, 0, 0)); // 18:00 UTC = mediodía en México

test('un reto solo da XP la primera vez que se supera cada día', () => {
  let r = R.aplicarResultado(R.estadoInicial(), { retoId: 'quiz', puntaje: 3, total: 5 }, dia(1));
  assert.equal(r.xpGanado, R.XP_SUPERADO);
  assert.equal(r.aprobado, true);
  r = R.aplicarResultado(r.estado, { retoId: 'quiz', puntaje: 5, total: 5 }, dia(1));
  assert.equal(r.xpGanado, 0, 'repetir el mismo día no suma');
  r = R.aplicarResultado(r.estado, { retoId: 'quiz', puntaje: 5, total: 5 }, dia(2));
  assert.equal(r.xpGanado, R.XP_PERFECTO, 'al día siguiente vuelve a sumar');
  assert.equal(r.estado.superados, 2);
  assert.equal(r.estado.dias.length, 2);
});

test('reprobar (menos de 60 %) no suma XP ni cuenta como superado, pero registra el intento', () => {
  const r = R.aplicarResultado(R.estadoInicial(), { retoId: 'orden', puntaje: 2, total: 5 }, dia(1));
  assert.equal(r.xpGanado, 0);
  assert.equal(r.aprobado, false);
  assert.equal(r.estado.superados, 0);
  assert.equal(r.estado.porReto.orden.veces, 1);
  // 60 % exacto sí aprueba
  assert.equal(R.aplicarResultado(R.estadoInicial(), { retoId: 'orden', puntaje: 3, total: 5 }, dia(1)).aprobado, true);
  assert.equal(R.aplicarResultado(R.estadoInicial(), { retoId: 'orden', puntaje: 18, total: 30 }, dia(1)).aprobado, true);
});

test('la fecha de "hoy" usa la hora de México (no salta de día a medianoche UTC)', () => {
  assert.equal(R.fechaMexico(new Date('2026-09-25T05:59:00Z')), '2026-09-24');
  assert.equal(R.fechaMexico(new Date('2026-09-25T06:00:00Z')), '2026-09-25');
});

test('validación: solo retos conocidos y puntajes enteros dentro del total', () => {
  assert.equal(R.validarResultado({ retoId: 'quiz', puntaje: 3, total: 5 }), null);
  for (const retoId of ['quiz', 'detective', 'orden', 'flashcards', 'historia']) assert.equal(R.validarResultado({ retoId, puntaje: 1, total: 1 }), null);
  assert.ok(R.validarResultado({ retoId: 'x', puntaje: 3, total: 5 }));
  assert.ok(R.validarResultado({ retoId: undefined, puntaje: 3, total: 5 }));
  assert.ok(R.validarResultado({ retoId: ['quiz'], puntaje: 3, total: 5 }));
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: 6, total: 5 }));
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: -1, total: 5 }));
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: 3, total: 31 }));
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: 3, total: 0 }));
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: '3', total: 5 }), 'números como texto no valen');
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: 2.5, total: 5 }));
  assert.ok(R.validarResultado({ retoId: 'quiz', puntaje: NaN, total: 5 }));
  assert.equal(R.validarResultado({ retoId: 'quiz', puntaje: 30, total: 30 }), null);
});

test('flashcards es repaso libre: nunca da XP ni cuenta como reto superado', () => {
  const r = R.aplicarResultado(R.estadoInicial(), { retoId: 'flashcards', puntaje: 8, total: 8 }, dia(1));
  assert.equal(r.xpGanado, 0);
  assert.equal(r.estado.superados, 0);
  assert.equal(r.estado.xp, 0);
  assert.deepEqual(r.estado.dias, [], 'tampoco cuenta como día de retos');
  assert.equal(r.estado.porReto.flashcards.veces, 1);
});

test('los niveles no se alcanzan rápido: el tope diario de XP por práctica es pequeño', () => {
  let e = R.estadoInicial();
  for (const retoId of R.RETOS_VALIDOS) e = R.aplicarResultado(e, { retoId, puntaje: 5, total: 5 }, dia(1)).estado;
  assert.equal(e.xp, R.XP_PERFECTO * 4, 'quiz + detective + orden + historia; flashcards no suma');
  assert.ok(e.xp <= 40);
  for (let i = 0; i < 30; i++) e = R.aplicarResultado(e, { retoId: 'quiz', puntaje: 5, total: 5 }, dia(1)).estado;
  assert.equal(e.xp, 40, 'repetir el mismo día no suma nada');
});

test('la práctica diaria tiene un techo de XP de por vida (se sigue jugando, pero ya no suma)', () => {
  let e = { ...R.estadoInicial(), xp: 597, xpPractica: 597 };
  let r = R.aplicarResultado(e, { retoId: 'quiz', puntaje: 5, total: 5 }, dia(1));
  assert.equal(r.xpGanado, 3, 'solo cabe lo que falta para el techo');
  assert.equal(r.estado.xpPractica, R.TOPE_XP_PRACTICA);
  r = R.aplicarResultado(r.estado, { retoId: 'orden', puntaje: 5, total: 5 }, dia(1));
  assert.equal(r.xpGanado, 0);
  assert.equal(r.estado.superados, 2, 'pero el reto sí cuenta como superado para las insignias');
  assert.equal(r.estado.xp, 600);
});

test('insignias: se desbloquean por constancia real, no por repetir el mismo día', () => {
  let e = R.estadoInicial();
  const ids = () => R.insignias(e).filter(i => i.desbloqueada).map(i => i.id);
  for (const retoId of R.RETOS_VALIDOS) e = R.aplicarResultado(e, { retoId, puntaje: 5, total: 5 }, dia(1)).estado;
  // quiz, detective, orden e historia superados el mismo día (flashcards no cuenta)
  assert.deepEqual(ids().sort(), ['r1', 'r3', 'r7']);
  for (let i = 0; i < 20; i++) e = R.aplicarResultado(e, { retoId: 'quiz', puntaje: 5, total: 5 }, dia(1)).estado;
  assert.equal(e.superados, 4);
  for (let d = 2; d <= 5; d++) e = R.aplicarResultado(e, { retoId: 'quiz', puntaje: 5, total: 5 }, dia(d)).estado;
  assert.ok(ids().includes('r5'), '5 días distintos');
  assert.ok(ids().includes('r4'), '3 quizzes perfectos');
  assert.ok(!ids().includes('r6'), '50 retos superados requieren mucho más tiempo');
  assert.ok(!ids().includes('r9'), '15 días distintos tampoco');
});

test('modo historia: da XP una vez al día, r8 pide 3 casos y no cuenta para "Todoterreno"', () => {
  let r = R.aplicarResultado(R.estadoInicial(), { retoId: 'historia', puntaje: 3, total: 4 }, dia(1));
  assert.equal(r.xpGanado, R.XP_SUPERADO);
  r = R.aplicarResultado(r.estado, { retoId: 'historia', puntaje: 4, total: 4 }, dia(1));
  assert.equal(r.xpGanado, 0, 'un segundo caso el mismo día no vuelve a dar XP');
  const ins = e => Object.fromEntries(R.insignias(e).map(i => [i.id, i.desbloqueada]));
  assert.equal(ins(r.estado).r7, false);
  assert.equal(ins(r.estado).r8, false);
  let e = r.estado;
  e = R.aplicarResultado(e, { retoId: 'historia', puntaje: 3, total: 4 }, dia(2)).estado;
  e = R.aplicarResultado(e, { retoId: 'historia', puntaje: 3, total: 4 }, dia(3)).estado;
  assert.equal(ins(e).r8, true);
});

test('insignias: r10 y r6 piden 100 y 50 retos superados; las nuevas se detectan comparando antes y después', () => {
  const con = n => ({ ...R.estadoInicial(), superados: n });
  const ids = n => R.insignias(con(n)).filter(i => i.desbloqueada).map(i => i.id);
  assert.deepEqual(ids(0), []);
  assert.deepEqual(ids(1), ['r1']);
  assert.deepEqual(ids(10), ['r1', 'r2']);
  assert.deepEqual(ids(50), ['r1', 'r2', 'r6']);
  assert.deepEqual(ids(100), ['r1', 'r2', 'r6', 'r10']);
  assert.deepEqual(R.insigniasNuevas(con(9), con(10)).map(i => i.id), ['r2']);
  assert.deepEqual(R.insigniasNuevas(con(10), con(11)), []);
  assert.deepEqual(R.insigniasNuevas(null, undefined), []);
});

// ── Camino ──
test('camino: cualquier reto se puede resolver en cualquier orden, aprobado, y da XP una sola vez', () => {
  let e = R.estadoInicial();
  let r = R.aplicarCaminoResultado(e, { modo: 'quiz', indice: 5, puntaje: 5, total: 5 }, dia(1));
  assert.deepEqual([r.aceptado, r.xpGanado], [true, R.XP_CAMINO_PERFECTO], 'saltarse los anteriores sí vale');
  assert.deepEqual(r.estado.caminoHechos.quiz, [5]);
  assert.equal(r.estado.camino.quiz, 1, 'camino es la cantidad de retos superados');
  r = R.aplicarCaminoResultado(e, { modo: 'quiz', indice: 0, puntaje: 2, total: 5 }, dia(1));
  assert.deepEqual([r.aceptado, r.aprobado, r.xpGanado], [false, false, 0], 'reprobado no cuenta');
  r = R.aplicarCaminoResultado(e, { modo: 'quiz', indice: 0, puntaje: 3, total: 5 }, dia(1));
  assert.deepEqual([r.aceptado, r.aprobado, r.xpGanado, r.estado.camino.quiz], [true, true, R.XP_CAMINO, 1]);
  r = R.aplicarCaminoResultado(r.estado, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 }, dia(2));
  assert.equal(r.aceptado, false, 'repetir el mismo reto no da XP de nuevo, ni otro día');
  r = R.aplicarCaminoResultado(r.estado, { modo: 'quiz', indice: 7, puntaje: 5, total: 5 }, dia(2));
  assert.deepEqual([r.aceptado, r.xpGanado, r.estado.camino.quiz], [true, R.XP_CAMINO_PERFECTO, 2]);
  assert.deepEqual(r.estado.caminoHechos.quiz, [0, 7]);
  assert.equal(r.estado.superados, 2);
  assert.equal(r.estado.camino.orden, 0, 'cada modo lleva su propia lista');
});

test('camino: las cuentas anteriores (solo un contador) conservan su avance como los primeros N retos', () => {
  const viejo = { xp: 30, superados: 5, camino: { quiz: 3, detective: 0, orden: 2 } };
  const e = R.normalizarEstado(viejo);
  assert.deepEqual(e.caminoHechos, { quiz: [0, 1, 2], detective: [], orden: [0, 1] });
  assert.deepEqual(e.camino, { quiz: 3, detective: 0, orden: 2 });
  assert.equal(R.aplicarCaminoResultado(viejo, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 }).aceptado, false, 'los ya hechos no se cobran otra vez');
  const r = R.aplicarCaminoResultado(viejo, { modo: 'quiz', indice: 3, puntaje: 5, total: 5 });
  assert.equal(r.aceptado, true);
  assert.deepEqual(r.estado.caminoHechos.quiz, [0, 1, 2, 3]);
  assert.deepEqual(r.estado.camino, { quiz: 4, detective: 0, orden: 2 });
});

test('camino: el índice debe existir en el sitio y la lista guardada se limpia', () => {
  R.CAMINO_MODOS.forEach(m => {
    assert.equal(R.validarCaminoResultado({ modo: m, indice: 0, puntaje: 1, total: 1 }), null);
    assert.equal(R.validarCaminoResultado({ modo: m, indice: R.TOTALES_CAMINO[m] - 1, puntaje: 1, total: 1 }), null);
    assert.equal(R.validarCaminoResultado({ modo: m, indice: R.TOTALES_CAMINO[m], puntaje: 1, total: 1 }), 'Índice no válido');
  });
  const sucio = R.normalizarEstado({ camino: { quiz: 9 }, caminoHechos: { quiz: [4, 4, 1, -2, 'x', 2.5, 999], detective: 'no', orden: [] } });
  assert.deepEqual(sucio.caminoHechos.quiz, [1, 4]);
  assert.deepEqual(sucio.caminoHechos.detective, []);
  assert.equal(sucio.camino.quiz, 2, 'el contador siempre sale de la lista de retos superados');
  assert.deepEqual(R.TOTALES_CAMINO, { quiz: 32, detective: 60, orden: 24 });
});

test('camino: validación de modo, índice, total y puntaje', () => {
  const ok = { modo: 'orden', indice: 0, puntaje: 3, total: 4 };
  assert.equal(R.validarCaminoResultado(ok), null);
  assert.equal(R.validarCaminoResultado({ ...ok, indice: 17 }), null);
  for (const malo of [{ modo: 'historia' }, { modo: 'flashcards' }, { modo: 7 }, { indice: -1 }, { indice: 24 }, { indice: 201 }, { indice: '0' }, { indice: 0.5 },
    { total: 0 }, { total: 31 }, { puntaje: 5 }, { puntaje: -1 }, { puntaje: '3' }]) {
    assert.ok(R.validarCaminoResultado({ ...ok, ...malo }), JSON.stringify(malo));
  }
});

test('el estado guardado se limpia: valores raros no rompen ni inflan nada', () => {
  const e = R.normalizarEstado({ xp: -5, xpPractica: 'mucho', superados: 2.5, dias: ['2026-01-01', 5, null], camino: { quiz: -3, detective: 'x', orden: 4 },
    porReto: { quiz: { veces: 3, mejor: 5, total: 5, superados: 2, perfectos: 1 }, inventado: { veces: 99 }, orden: 'no' }, retosHoy: { fecha: 7, ids: ['quiz', 'zzz'] } });
  assert.equal(e.xp, 0);
  assert.equal(e.xpPractica, 0);
  assert.equal(e.superados, 0);
  assert.deepEqual(e.dias, ['2026-01-01']);
  assert.deepEqual(e.camino, { quiz: 0, detective: 0, orden: 4 });
  assert.deepEqual(e.caminoHechos.orden, [0, 1, 2, 3], 'un contador viejo se vuelve lista');
  assert.deepEqual(Object.keys(e.porReto), ['quiz']);
  assert.deepEqual(e.retosHoy.ids, ['quiz']);
  assert.deepEqual(R.normalizarEstado(null), R.estadoInicial());
});

test('el XP máximo de los retos es el techo de práctica más todo el camino perfecto', () => {
  assert.equal(R.XP_MAXIMO_RETOS, 600 + (32 + 60 + 24) * 10);
});
