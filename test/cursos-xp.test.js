'use strict';

// XP por cursos terminados: fórmula fija, cursos distintos que existan, orden por fecha del certificado.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../services/logros');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, certificado
} = require('./helpers/club');

// ── Fórmula ──
test('fórmula del XP por curso: n=1..9 -> 20..100, el décimo 180, y el ciclo se repite', () => {
  const esperado = {
    1: 20, 2: 30, 3: 40, 4: 50, 5: 60, 6: 70, 7: 80, 8: 90, 9: 100, 10: 180,
    11: 20, 12: 30, 13: 40, 14: 50, 15: 60, 16: 70, 17: 80, 18: 90, 19: 100, 20: 180, 21: 20, 25: 60, 30: 180
  };
  for (const [n, xp] of Object.entries(esperado)) assert.equal(L.xpDeCurso(Number(n)), xp, `curso ${n}`);
  for (let n = 1; n <= 25; n++) assert.equal(L.xpDeCurso(n), n % 10 === 0 ? 180 : 10 + 10 * (n % 10));
  assert.equal(L.xpDeCurso(0), 0);
  assert.equal(L.xpDeCurso(-3), 0);
  assert.equal(L.xpDeCurso(NaN), 0);
});

test('los 15 cursos del club pagan 920 XP en total', () => {
  let t = 0; for (let n = 1; n <= 15; n++) t += L.xpDeCurso(n);
  assert.equal(t, 920);
  assert.equal(L.xpMaximo().cursos, 920);
});

// ── Armado de la lista (reglas puras) ──
const todos = () => true;
const cert = (courseId, fecha, folio = `F-${courseId}-${fecha}`) => ({ courseId, folio, fecha });

test('cursosTerminados: se ordenan por fecha del certificado y el n-ésimo paga la fórmula', () => {
  const lista = L.cursosTerminados([
    cert('c3', '2026-09-03T10:00:00.000Z'), cert('c1', '2026-09-01T10:00:00.000Z'), cert('c2', '2026-09-02T10:00:00.000Z')
  ], todos);
  assert.deepEqual(lista, [
    { courseId: 'c1', n: 1, xp: 20, fecha: '2026-09-01T10:00:00.000Z' },
    { courseId: 'c2', n: 2, xp: 30, fecha: '2026-09-02T10:00:00.000Z' },
    { courseId: 'c3', n: 3, xp: 40, fecha: '2026-09-03T10:00:00.000Z' }
  ]);
});

test('cursosTerminados: un curso paga una sola vez aunque haya certificados repetidos (cuenta el más antiguo)', () => {
  const lista = L.cursosTerminados([
    cert('c1', '2026-09-05T00:00:00.000Z', 'B'), cert('c1', '2026-09-01T00:00:00.000Z', 'A'), cert('c1', '2026-09-09T00:00:00.000Z', 'C'),
    cert('c2', '2026-09-03T00:00:00.000Z')
  ], todos);
  assert.deepEqual(lista.map(c => [c.courseId, c.n, c.xp, c.fecha]), [
    ['c1', 1, 20, '2026-09-01T00:00:00.000Z'], ['c2', 2, 30, '2026-09-03T00:00:00.000Z']
  ]);
});

test('cursosTerminados: certificados de cursos que no existen no cuentan ni ocupan un lugar en la fórmula', () => {
  const existe = id => id !== 'fantasma';
  const lista = L.cursosTerminados([
    cert('fantasma', '2026-09-01T00:00:00.000Z'), cert('c1', '2026-09-02T00:00:00.000Z'),
    { courseId: '', folio: 'x', fecha: '2026-09-01T00:00:00.000Z' }, { folio: 'y' }, null, cert('c2', '2026-09-03T00:00:00.000Z')
  ], existe);
  assert.deepEqual(lista.map(c => [c.courseId, c.n, c.xp]), [['c1', 1, 20], ['c2', 2, 30]]);
  assert.deepEqual(L.cursosTerminados([cert('c1', '2026-09-01T00:00:00.000Z')], () => false), []);
  assert.deepEqual(L.cursosTerminados(undefined, todos), []);
});

test('cursosTerminados: con la misma fecha se desempata por folio; sin fecha válida van al final', () => {
  const f = '2026-09-01T00:00:00.000Z';
  const lista = L.cursosTerminados([cert('c9', f, 'Z-9'), cert('c8', f, 'A-8'), cert('c7', 'no-es-fecha', 'A-0'), cert('c6', undefined, 'A-1')], todos);
  assert.deepEqual(lista.map(c => c.courseId), ['c8', 'c9', 'c7', 'c6']);
  assert.equal(lista[2].fecha, null);
  assert.deepEqual(lista.map(c => c.n), [1, 2, 3, 4]);
});

test('cursosTerminados: 11 cursos -> el décimo paga 180 y el undécimo vuelve a 20', () => {
  const certs = Array.from({ length: 11 }, (_, i) => cert(`c${i + 1}`, new Date(Date.UTC(2026, 8, i + 1)).toISOString()));
  const lista = L.cursosTerminados(certs, todos);
  assert.equal(lista[9].xp, 180);
  assert.equal(lista[10].xp, 20);
  assert.equal(lista.reduce((t, c) => t + c.xp, 0), 540 + 180 + 20);
});

test('cursosTerminados acepta fechas Date, número y Timestamp de Firestore', () => {
  const ts = ms => ({ toMillis: () => ms });
  const lista = L.cursosTerminados([cert('a', ts(3000)), cert('b', new Date(1000)), cert('c', 2000)], todos);
  assert.deepEqual(lista.map(c => c.courseId), ['b', 'c', 'a']);
});

test('evaluar suma el XP de cursos al total y lo desglosa en xp.cursos (sin mezclarlo con los logros)', () => {
  const cursosLista = L.cursosTerminados([cert('c1', '2026-09-01T00:00:00.000Z'), cert('c2', '2026-09-02T00:00:00.000Z')], todos);
  const base = { esVIP: true, completados: 2, areas: 0, dias: [], tarjetaDir: false, foroPosts: 0, foroRespuestas: 0, foroLikes: 0, invitadosValidos: 0 };
  const sin = L.evaluar({ ...base, cursosLista: [] }, null, 0, new Date('2026-09-30T18:00:00Z'));
  const con = L.evaluar({ ...base, cursosLista }, null, 0, new Date('2026-09-30T18:00:00Z'));
  assert.equal(con.xp.cursos, 50);
  assert.equal(con.xp.logros, sin.xp.logros);
  assert.equal(con.xp.total, sin.xp.total + 50);
  assert.deepEqual(con.cursos, { terminados: 2, lista: cursosLista });
  assert.equal(sin.xp.cursos, 0);
  assert.deepEqual(sin.cursos, { terminados: 0, lista: [] });
});

// ── Endpoint ──
const tokens = tokensDe('ana', 'sinplan');
const premiosDe = (app, t = 'token-ana') => request(app).get('/api/premios').set(auth(t));
const montar = extra => cargarServidor({
  tokens,
  seed: {
    ...cursosSeed(15),
    'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
    'miembros/sinplan': miembroSinPlan(),
    ...extra
  }
});
const cert2 = (uid, courseId, issuedAt, folio) => {
  const c = certificado(uid, courseId, { issuedAt, ...(folio ? { folio } : {}) });
  return [`certificados/${c.folio}`, c];
};

test('GET /api/premios: cursos:{terminados, lista:[{courseId,n,xp,fecha}]} en orden cronológico y xp.cursos en el total', async () => {
  const seed = Object.fromEntries([
    cert2('ana', 'c3', '2026-09-03T10:00:00.000Z'), cert2('ana', 'c1', '2026-09-01T10:00:00.000Z'), cert2('ana', 'c2', '2026-09-02T10:00:00.000Z'),
    cert2('ana', 'c1', '2026-09-08T10:00:00.000Z', 'REPETIDO'),
    cert2('ana', 'inexistente', '2026-08-01T10:00:00.000Z')
  ]);
  const { app } = montar(seed);
  const res = await premiosDe(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.cursos, {
    terminados: 3,
    lista: [
      { courseId: 'c1', n: 1, xp: 20, fecha: '2026-09-01T10:00:00.000Z' },
      { courseId: 'c2', n: 2, xp: 30, fecha: '2026-09-02T10:00:00.000Z' },
      { courseId: 'c3', n: 3, xp: 40, fecha: '2026-09-03T10:00:00.000Z' }
    ]
  });
  assert.equal(res.body.xp.cursos, 90);
  assert.equal(res.body.xp.total, res.body.xp.logros + res.body.xp.retos + res.body.xp.referidos + res.body.xp.cursos);
});

test('GET /api/premios: 11 cursos distintos pagan 540 + 180 + 20 y el curso 10 es el de 180', async () => {
  const seed = Object.fromEntries(Array.from({ length: 11 }, (_, i) => cert2('ana', `c${i + 1}`, new Date(Date.UTC(2026, 8, i + 1)).toISOString())));
  const { app } = montar(seed);
  const res = await premiosDe(app);
  assert.equal(res.body.cursos.terminados, 11);
  assert.equal(res.body.cursos.lista[9].xp, 180);
  assert.equal(res.body.cursos.lista[10].xp, 20);
  assert.equal(res.body.xp.cursos, 740);
});

test('GET /api/premios: sin certificados no hay XP de cursos', async () => {
  const res = await premiosDe(montar().app);
  assert.deepEqual(res.body.cursos, { terminados: 0, lista: [] });
  assert.equal(res.body.xp.cursos, 0);
});

test('GET /api/premios sin membresía no revela XP ni cursos (vista previa a cero)', async () => {
  const seed = Object.fromEntries([cert2('sinplan', 'c1', '2026-09-01T10:00:00.000Z'), cert2('sinplan', 'c2', '2026-09-02T10:00:00.000Z')]);
  const res = await premiosDe(montar(seed).app, 'token-sinplan');
  assert.equal(res.body.membresia, false);
  assert.equal(res.body.xp.total, 0);
  assert.equal(res.body.xp.cursos, 0);
  assert.deepEqual(res.body.cursos, { terminados: 0, lista: [] });
});

test('el XP de cursos entra al total guardado para la clasificación', async () => {
  const seed = Object.fromEntries(Array.from({ length: 9 }, (_, i) => cert2('ana', `c${i + 1}`, new Date(Date.UTC(2026, 8, i + 1)).toISOString())));
  const { app, db } = montar(seed);
  const res = await premiosDe(app);
  assert.equal(res.body.xp.cursos, 540);
  assert.equal(db.value('premiosUsuario/ana').xpTotal, res.body.xp.total);
});
