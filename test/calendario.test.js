'use strict';

// Reglas puras del calendario de cursos del miembro (services/calendario.js) y avance de los 15 retos (services/retos.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../services/calendario');
const R = require('../services/retos');

const DIA = 86400000;
const AHORA = Date.parse('2026-10-20T12:00:00Z');
const hace = n => AHORA - n * DIA;
const ts = ms => ({ toMillis: () => ms });

// Curso con la forma de Firestore; createdAt más reciente = número más bajo
function doc(n, extra = {}) {
  return { title: 'Curso ' + n, createdAt: new Date(AHORA - (100 - n) * DIA).toISOString(), lecciones: [{ videoId: `bbbbbbbb-0000-4000-8000-${String(n * 10 + 1).padStart(12, '0')}` }, { videoId: `bbbbbbbb-0000-4000-8000-${String(n * 10 + 2).padStart(12, '0')}` }], ...extra };
}
const resumen = (n, extra) => C.resumirCursoCalendario('c' + n, doc(n, extra));

test('aMs entiende Timestamp, texto ISO, Date, milisegundos y rechaza lo demás', () => {
  assert.equal(C.aMs(ts(5)), 5);
  assert.equal(C.aMs('2026-10-20T12:00:00Z'), AHORA);
  assert.equal(C.aMs(new Date(AHORA)), AHORA);
  assert.equal(C.aMs(AHORA), AHORA);
  assert.equal(C.aMs({ _seconds: 10 }), 10000);
  for (const malo of [null, undefined, '', 'no es fecha', {}, true, NaN]) assert.equal(C.aMs(malo), null, String(malo));
});

test('orden de cursos: igual que orderBy(createdAt desc), sin los que no tienen createdAt', () => {
  const lista = [resumen(1), resumen(3), resumen(2), C.resumirCursoCalendario('sinfecha', { title: 'x' })];
  const orden = C.ordenPorCreacion(lista).map(c => c.id);
  assert.deepEqual(orden, ['c3', 'c2', 'c1'], 'el más nuevo primero y el que no trae createdAt queda fuera');
  // Igual fecha: por id, en la misma dirección (descendente)
  const mismo = '2026-10-01T00:00:00Z';
  const a = C.resumirCursoCalendario('a', { createdAt: mismo }), b = C.resumirCursoCalendario('b', { createdAt: mismo });
  assert.deepEqual(C.ordenPorCreacion([a, b]).map(c => c.id), ['b', 'a']);
});

test('fila de desbloqueo: los de siempre conservan su orden, los nuevos (ordenVip) van después y el de la clase gratis de siempre, primero', () => {
  const viejo1 = resumen(9), viejo2 = resumen(8);               // sin ordenVip
  const nuevo2 = resumen(7, { ordenVip: 2 }), nuevo1 = resumen(6, { ordenVip: 1 });
  const fijo = C.resumirCursoCalendario('fijo', { createdAt: '2020-01-01', lecciones: [{ videoId: C.VIDEO_GRATIS_FIJO }] });
  const orden = C.ordenParaDesbloqueo([viejo1, viejo2, nuevo2, nuevo1, fijo]).map(c => c.id);
  assert.deepEqual(orden, ['fijo', 'c9', 'c8', 'c6', 'c7']);
  assert.equal(fijo.gratisDeSiempre, true);
  // Curso de muestra con clase marcada gratis también cuenta
  assert.equal(C.resumirCursoCalendario('m', { cursoMuestraGratis: true, lecciones: [{ videoId: 'x', gratis: true }] }).gratisDeSiempre, true);
  assert.equal(C.resumirCursoCalendario('m', { cursoMuestraGratis: false, lecciones: [{ videoId: 'x', gratis: true }] }).gratisDeSiempre, false);
});

test('inicio del calendario: regla de siempre, plan nuevo y prueba elegida', () => {
  const nuevoDesdeMs = hace(10);
  // miembro de siempre: cuenta desde que se creó la cuenta
  const legado = C.inicioDelCalendario({ miembro: { createdAt: new Date(hace(60)).toISOString(), planInicio: ts(hace(20)) }, nuevoDesdeMs, ahoraMs: AHORA });
  assert.deepEqual([legado.modo, legado.inicioMs, legado.fuente], ['legado', hace(60), 'registro']);
  // si el plan empezó antes que la cuenta (migraciones), cuenta el más antiguo: nunca más tarde que lo que ya veía
  assert.equal(C.inicioDelCalendario({ miembro: { createdAt: new Date(hace(5)).toISOString(), planInicio: ts(hace(20)) }, nuevoDesdeMs: hace(1), ahoraMs: AHORA }).inicioMs, hace(20));
  // plan que empieza DESPUÉS de activar el calendario: cuenta desde el inicio del plan, aunque la cuenta sea vieja
  const nuevo = C.inicioDelCalendario({ miembro: { createdAt: new Date(hace(60)).toISOString(), planInicio: ts(hace(3)) }, nuevoDesdeMs, ahoraMs: AHORA });
  assert.deepEqual([nuevo.modo, nuevo.inicioMs], ['nuevo', hace(3)]);
  // con prueba elegida cuenta desde el inicio del plan en cualquier caso
  const prueba = C.inicioDelCalendario({ miembro: { createdAt: new Date(hace(60)).toISOString(), planInicio: ts(hace(30)) }, tieneEleccion: true, nuevoDesdeMs, ahoraMs: AHORA });
  assert.deepEqual([prueba.modo, prueba.inicioMs, prueba.fuente], ['prueba', hace(30), 'plan']);
  // activación a mano y espejo de usuarios cuentan como inicio del plan
  assert.equal(C.inicioDePlanMs({ planActivadoEn: ts(7) }, null), 7);
  assert.equal(C.inicioDePlanMs({}, { fechaActivacion: ts(9) }), 9);
  assert.equal(C.inicioDePlanMs({}, null), null);
  // sin ningún dato: hoy (y como respaldo, la fecha de la cuenta)
  assert.deepEqual(C.inicioDelCalendario({ miembro: {}, nuevoDesdeMs, ahoraMs: AHORA }), { inicioMs: AHORA, modo: 'legado', fuente: 'hoy' });
  assert.equal(C.inicioDelCalendario({ miembro: {}, nuevoDesdeMs, cuentaCreadaMs: hace(4), ahoraMs: AHORA }).inicioMs, hace(4));
  // sin fecha de activación del calendario (falló su lectura) nunca se marca "nuevo"
  assert.equal(C.inicioDelCalendario({ miembro: { createdAt: new Date(hace(60)).toISOString(), planInicio: ts(hace(1)) }, nuevoDesdeMs: null, ahoraMs: AHORA }).modo, 'legado');
});

test('fila sin prueba: el primer curso se abre al empezar y los demás cada 8 días', () => {
  const lista = C.ordenParaDesbloqueo(C.ordenPorCreacion([1, 2, 3, 4].map(n => resumen(n, { ordenVip: n }))));
  const e = C.construirEntradas({ lista, eleccion: null, inicioMs: hace(10) });
  assert.deepEqual(e.map(x => x.cursoId), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(e.map(x => Date.parse(x.desbloqueoEn)), [hace(10), hace(2), AHORA + 6 * DIA, AHORA + 14 * DIA]);
});

test('fila con prueba elegida: el curso de prueba es el primero (abierto) y el siguiente se abre a los 8 días del inicio del plan', () => {
  const lista = C.ordenParaDesbloqueo([1, 2, 3, 4].map(n => resumen(n, { ordenVip: n })));
  const e = C.construirEntradas({ lista, eleccion: 'c2', inicioMs: hace(3) });
  assert.deepEqual(e.map(x => x.cursoId), ['c1', 'c3', 'c4'], 'el curso de prueba no entra a la fila');
  assert.deepEqual(e.map(x => Date.parse(x.desbloqueoEn)), [hace(3) + 8 * DIA, hace(3) + 16 * DIA, hace(3) + 24 * DIA]);
  const estados = C.estadoDeCursos({ lista, entradas: e, eleccion: 'c2', ahoraMs: AHORA });
  const por = id => estados.find(x => x.cursoId === id);
  assert.deepEqual([por('c2').abierto, por('c2').esPrueba], [true, true]);
  assert.deepEqual([por('c1').abierto, por('c1').motivo, por('c1').diasFalta], [false, 'tiempo', 5], 'Restan 5 días');
  assert.equal(por('c3').diasFalta, 13);
  assert.equal(por('c4').diasFalta, 21);
  assert.equal(C.proximoDesbloqueo(estados).cursoId, 'c1');
});

test('"Restan N días" coincide con la cuenta del sitio (días completos hacia arriba)', () => {
  const lista = C.ordenParaDesbloqueo([resumen(1, { ordenVip: 1 }), resumen(2, { ordenVip: 2 })]);
  const entradas = [{ cursoId: 'c1', desbloqueoEn: new Date(hace(1)).toISOString() }, { cursoId: 'c2', desbloqueoEn: new Date(AHORA + 3 * DIA - 1000).toISOString() }];
  const [a, b] = C.estadoDeCursos({ lista, entradas, ahoraMs: AHORA });
  assert.equal(a.abierto, true);
  assert.deepEqual([b.abierto, b.diasFalta], [false, 3]);
  assert.equal(C.textoBloqueado(b), 'Este curso se abre en 3 días');
  assert.equal(C.textoBloqueado({ abierto: false, diasFalta: 1 }), 'Este curso se abre en 1 día');
});

test('premios, 15 retos, administrador y cursos siempre disponibles abren sin tocar la fila de los demás', () => {
  const lista = C.ordenParaDesbloqueo([resumen(1, { ordenVip: 1 }), resumen(2, { ordenVip: 2 }), resumen(3, { ordenVip: 3 }), resumen(4, { ordenVip: 4, disponibleSiempre: true })]);
  const entradas = C.construirEntradas({ lista, eleccion: null, inicioMs: AHORA });
  assert.deepEqual(entradas.map(e => e.cursoId), ['c1', 'c2', 'c3'], 'el siempre disponible no gasta turno');
  const base = C.estadoDeCursos({ lista, entradas, ahoraMs: AHORA });
  assert.deepEqual(base.map(e => e.abierto), [true, false, false, true]);
  const premio = C.estadoDeCursos({ lista, entradas, premios: ['c3'], ahoraMs: AHORA });
  assert.deepEqual(premio.map(e => [e.abierto, e.porPremio]), [[true, false], [false, false], [true, true], [true, false]]);
  assert.equal(premio[1].diasFalta, 8, 'el adelanto no corre el turno de nadie');
  const retos = C.estadoDeCursos({ lista, entradas, adelantado: 'c2', ahoraMs: AHORA });
  assert.deepEqual([retos[1].abierto, retos[1].porRetos, retos[2].diasFalta], [true, true, 16]);
  assert.ok(C.estadoDeCursos({ lista, entradas, esAdmin: true, ahoraMs: AHORA }).every(e => e.abierto));
});

test('cursos nuevos se agregan al final de la fila sin mover lo ya guardado', () => {
  const lista3 = C.ordenParaDesbloqueo([1, 2, 3].map(n => resumen(n, { ordenVip: n })));
  const guardadas = C.construirEntradas({ lista: lista3, eleccion: null, inicioMs: hace(20) });
  const lista4 = C.ordenParaDesbloqueo([1, 2, 3, 4].map(n => resumen(n, { ordenVip: n })));
  const r = C.completarEntradas({ entradas: guardadas, lista: lista4, eleccion: null, inicioMs: hace(20) });
  assert.equal(r.cambio, true);
  assert.deepEqual(r.entradas.slice(0, 3), guardadas);
  assert.equal(Date.parse(r.entradas[3].desbloqueoEn), hace(20) + 24 * DIA, 'ocho días después del último');
  assert.equal(C.completarEntradas({ entradas: r.entradas, lista: lista4, eleccion: null, inicioMs: hace(20) }).cambio, false, 'idempotente');
});

test('al volver a pagar tras vencer, lo que seguía cerrado se vuelve a fechar y lo abierto se conserva', () => {
  const entradas = [{ cursoId: 'c1', desbloqueoEn: new Date(hace(40)).toISOString() }, { cursoId: 'c2', desbloqueoEn: new Date(hace(10)).toISOString() }, { cursoId: 'c3', desbloqueoEn: new Date(hace(2)).toISOString() }, { cursoId: 'c4', desbloqueoEn: new Date(AHORA + 6 * DIA).toISOString() }];
  const r = C.reanudarEntradas(entradas, hace(12), AHORA);
  assert.equal(r.cambio, true);
  const por = id => r.entradas.find(e => e.cursoId === id);
  assert.equal(por('c1').desbloqueoEn, entradas[0].desbloqueoEn, 'abierto antes de vencer: se conserva');
  assert.equal(Date.parse(por('c2').desbloqueoEn), AHORA + 8 * DIA);
  assert.equal(Date.parse(por('c3').desbloqueoEn), AHORA + 16 * DIA);
  assert.equal(Date.parse(por('c4').desbloqueoEn), AHORA + 24 * DIA);
  assert.equal(C.reanudarEntradas(entradas, hace(1), hace(5)).cambio, false, 'sin vencimiento previo no cambia nada');
  assert.equal(C.primerCursoCerrado(entradas, AHORA), 'c4');
  assert.equal(C.primerCursoCerrado([], AHORA), null);
});

/* ───────────── 15 retos ───────────── */

const hechos = (q, d, o) => R.normalizarEstado({ caminoHechos: { quiz: Array.from({ length: q }, (_, i) => i), detective: Array.from({ length: d }, (_, i) => i), orden: Array.from({ length: o }, (_, i) => i) } });

test('15 retos: mínimo 4 de cada tipo (quiz, detective, ordena) y 3 libres; cada reto cuenta una vez', () => {
  assert.deepEqual(R.PRIMER_CURSO_RETOS, { total: 15, porTipo: 4 });
  const cero = R.progresoPrimerCurso(null);
  assert.deepEqual([cero.hechos, cero.meta, cero.completo], [0, 15, false]);
  assert.deepEqual(cero.libres, { hechos: 0, meta: 3 });
  // 15 quizzes solos no bastan: faltan 4 de detective y 4 de ordena
  const soloQuiz = R.progresoPrimerCurso(hechos(15, 0, 0));
  assert.deepEqual([soloQuiz.hechos, soloQuiz.completo, soloQuiz.tipos.quiz.hechos, soloQuiz.libres.hechos], [7, false, 4, 3]);
  // 4 + 4 + 4 = 12: faltan los 3 libres
  assert.deepEqual([R.progresoPrimerCurso(hechos(4, 4, 4)).hechos, R.progresoPrimerCurso(hechos(4, 4, 4)).completo], [12, false]);
  // 4 + 4 + 4 y 3 más de cualquier tipo = 15
  for (const [q, d, o] of [[7, 4, 4], [4, 7, 4], [4, 4, 7], [5, 5, 5], [6, 5, 4]]) {
    const p = R.progresoPrimerCurso(hechos(q, d, o));
    assert.deepEqual([p.hechos, p.completo], [15, true], `${q}-${d}-${o}`);
  }
  // más de 15 no se pasa de la meta
  assert.equal(R.progresoPrimerCurso(hechos(30, 20, 20)).hechos, 15);
  // repetir el mismo reto no suma: la lista guarda índices únicos
  const repetido = R.normalizarEstado({ caminoHechos: { quiz: [1, 1, 1, 1], detective: [], orden: [] } });
  assert.equal(R.progresoPrimerCurso(repetido).tipos.quiz.hechos, 1);
});

test('el camino tiene suficientes retos de cada tipo para superar ampliamente los 15', () => {
  for (const m of R.CAMINO_MODOS) assert.ok(R.TOTALES_CAMINO[m] >= 15, m);
  const total = R.CAMINO_MODOS.reduce((t, m) => t + R.TOTALES_CAMINO[m], 0);
  assert.ok(total >= 45);
});

/* ───────────── Paridad con el sitio (regla de siempre) ───────────── */

// Compara el calendario del servidor con club-acceso.js del sitio (sin prueba elegida) para que no se separen.
// Si la carpeta del sitio no está al lado, la prueba se omite.
const candidatos = [process.env.ZOO_SITIO, path.join(__dirname, '..', '..', 'ZOORIGEN-calendario'), path.join(__dirname, '..', '..', 'ZOORIGEN')]
  .filter(Boolean).map(r => path.join(r, 'assets', 'js', 'club-acceso.js'));
const rutaAcceso = candidatos.find(p => fs.existsSync(p));
test('paridad con club-acceso.js: sin prueba, el servidor y el sitio abren los mismos cursos el mismo día', { skip: rutaAcceso ? false : 'no hay carpeta del sitio al lado' }, () => {
  const A = require(rutaAcceso);
  const docs = [
    ['v1', { ordenVip: undefined }], ['v2', {}], ['n2', { ordenVip: 2 }], ['n1', { ordenVip: 1 }], ['s', { disponibleSiempre: true }],
    ['fijo', { lecciones: [{ videoId: C.VIDEO_GRATIS_FIJO }] }], ['n3', { ordenVip: 3 }]
  ];
  let k = 0;
  const firestore = docs.map(([id, extra]) => ({ id, ...doc(++k, extra), title: id }));
  const sitio = A.ordenParaDesbloqueo(firestore.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  const lista = C.ordenParaDesbloqueo(C.ordenPorCreacion(docs.map(([id, extra], i) => C.resumirCursoCalendario(id, doc(i + 1, extra)))));
  assert.deepEqual(lista.map(c => c.id), sitio.map(c => c.id), 'mismo orden de la fila');
  for (const diasMiembro of [0, 1, 7, 8, 9, 16, 23, 24, 100]) {
    const inicioMs = AHORA - diasMiembro * DIA - 3600000;     // la hora exacta no cuenta: solo días completos
    const entradas = C.construirEntradas({ lista, eleccion: null, inicioMs });
    const estados = C.estadoDeCursos({ lista, entradas, ahoraMs: AHORA });
    sitio.forEach((curso, i) => {
      const r = A.desbloqueoCurso({ lista: sitio, i, dias: Math.floor((AHORA - inicioMs) / DIA) });
      const s = estados.find(e => e.cursoId === curso.id);
      assert.equal(s.abierto, r.desbloqueado, `${curso.id} a los ${diasMiembro} días`);
      if (!r.desbloqueado) assert.equal(s.diasFalta, r.diasFalta, `${curso.id} faltan días a los ${diasMiembro}`);
    });
  }
});
