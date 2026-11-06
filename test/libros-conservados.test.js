'use strict';

// LIBROS CONSERVADOS: la subida de dificultad de los libros (ley-fauna-mx 5→25, bienestar-cautiverio 15→35, conservacion-mx 30→45) no le quita un libro
// a quien YA lo había desbloqueado con los umbrales de antes. services/libros-conservados.js + services/libros.js + rutas de libros, créditos y retos.
// Es independiente de materiales-conservados (otra colección, otra tabla, otra bandera).
// Ejecutar: node --test test/libros-conservados.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias } = require('./helpers/club');
const { FakeFirestore, FakeTimestamp } = require('./helpers/fake-firestore');
const C = require('../services/libros-conservados');
const L = require('../services/libros');
const { UMBRALES_PREVIOS_LIBROS } = require('../services/libros-umbrales-previos');

const LEY = 'ley-fauna-mx';
const BIEN = 'bienestar-cautiverio';
const CONS = 'conservacion-mx';
const NUEVOS = { [LEY]: 25, [BIEN]: 35, [CONS]: 45 };
const tokens = tokensDe('ana', 'beto', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const conservadosDe = (uid, ids) => ({ [`librosConservados/${uid}`]: { ids, version: 1, creadoEn: new FakeTimestamp(Date.now() - 86400000) } });
const SIN_MIGRAR = { 'config/migraciones': { materialesConservadosV1: true } };                     // la de libros todavía no terminó
const MIGRADO = { 'config/migraciones': { materialesConservadosV1: true, librosConservadosV1: true } };

function servidor(seed = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: {}, tokens,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, beto: { emailVerified: true, email: 'beto@example.com' }, vencida: { emailVerified: true, email: 'v@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }), 'miembros/beto': miembroConPlan({ name: 'Beto Ruiz' }),
        'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
        'miembros/admin': miembroSinPlan({ role: 'admin' }),
        ...MIGRADO, ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const libros = (app, t = 'token-ana') => request(app).get('/api/libros').set(auth(t));
const abiertos = async (app, t) => new Set((await libros(app, t)).body.libros.filter(l => l.desbloqueado).map(l => l.id));
const libro = (app, id, t = 'token-ana') => request(app).get(`/api/libros/${id}`).set(auth(t));
const estadoCreditos = (app, t = 'token-ana') => request(app).get('/api/creditos/estado').set(auth(t));
const canjear = (app, materialId, t = 'token-ana') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const camino = (app, c, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(c);
const avisosDe = (db, uid) => [...db._data.keys()].filter(k => k.startsWith(`avisos/${uid}/items/`)).map(k => k.split('/').pop());
const avisosLibro = (db, uid) => avisosDe(db, uid).filter(i => i.startsWith('libro_')).sort();
const miembrosDe = db => JSON.stringify([...db._data.entries()].filter(([k]) => /^miembros\/[^/]+$/.test(k)).sort());
const conSaldo = (uid, saldo) => ({ [`creditosCuentas/${uid}`]: { uid, saldo, regalados: saldo, canjeados: 0, avisoPendiente: 0 } });

/* ───────── tabla y datos ───────── */

test('los libros reales piden 25 / 35 / 45 y la tabla de umbrales anteriores guarda lo publicado (5 / 15 / 30): los nuevos nunca bajan', () => {
  assert.deepEqual({ ...UMBRALES_PREVIOS_LIBROS }, { [LEY]: 5, [BIEN]: 15, [CONS]: 30 });
  for (const id of Object.keys(NUEVOS)) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'libros', id + '.json'), 'utf8'));
    assert.equal(j.requiereRetos, NUEVOS[id], id);
    assert.ok(j.requiereRetos >= UMBRALES_PREVIOS_LIBROS[id]);
  }
  assert.throws(() => { UMBRALES_PREVIOS_LIBROS.otro = 1; }, /read only|not extensible|Cannot add/i);
  assert.deepEqual(C.previosCumplidos(6), [LEY]);
  assert.deepEqual(C.previosCumplidos(15), [BIEN, LEY]);
  assert.deepEqual(C.previosCumplidos(30), [BIEN, CONS, LEY]);
  assert.deepEqual(C.previosCumplidos(4), []);
  assert.equal(C.COLECCION, 'librosConservados');
  assert.equal(C.CLAVE_MIGRACION, 'librosConservadosV1');
});

test('regla pura: abierto si membresía Y (umbral nuevo O conservado); el administrador abre todo; sin membresía nada', () => {
  const libroPuro = { id: LEY, requiereRetos: 25 };
  const con = new Set([LEY]);
  assert.equal(L.acceso(libroPuro, { superados: 6, membresia: true, conservadosLibros: con }).desbloqueado, true);
  assert.equal(L.acceso(libroPuro, { superados: 6, membresia: true, conservadosLibros: con }).conservado, true);
  assert.equal(L.acceso(libroPuro, { superados: 6, membresia: true }).desbloqueado, false);
  assert.equal(L.acceso(libroPuro, { superados: 6, membresia: true }).faltan, 19);
  assert.equal(L.acceso(libroPuro, { superados: 30, membresia: true, conservadosLibros: con }).conservado, undefined, 'ya cumple el umbral nuevo: no es «conservado»');
  assert.equal(L.acceso(libroPuro, { superados: 6, membresia: false, conservadosLibros: con }).desbloqueado, false, 'el acceso sigue exigiendo membresía');
  assert.equal(L.acceso(libroPuro, { superados: 0, membresia: false, esAdmin: true }).desbloqueado, true);
  assert.equal(L.acceso(libroPuro, { superados: 6, membresia: true, conservadosLibros: new Set(['otro']) }).desbloqueado, false);
});

/* ───────── acceso: listado y lectura del libro ───────── */

test('miembro con 6, 9, 15 y 30 retos al momento del lanzamiento conserva EXACTAMENTE los libros que ya cumplía con los umbrales viejos', async () => {
  const casos = [[6, [LEY]], [9, [LEY]], [15, [BIEN, LEY]], [30, [BIEN, CONS, LEY]]];
  for (const [n, esperados] of casos) {
    const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', n) });
    const abre = await abiertos(app);
    assert.deepEqual([...abre].sort(), esperados, `${n} retos`);
    const r = await libros(app);
    for (const l of r.body.libros.filter(x => abre.has(x.id))) { assert.equal(l.faltan, 0); assert.equal(l.conservado, n < NUEVOS[l.id] ? true : undefined, `${n} retos: ${l.id} se marca como conservado solo si el umbral nuevo aún no se alcanza`); }
    for (const id of esperados) assert.equal((await libro(app, id)).status, 200, `${n} retos: se puede leer ${id}`);
    for (const id of Object.keys(NUEVOS).filter(x => !esperados.includes(x))) assert.equal((await libro(app, id)).status, 403, `${n} retos: ${id} sigue cerrado`);
    assert.deepEqual(db.value('librosConservados/ana').ids, esperados);
    assert.equal(db.value('librosConservados/ana').version, 1);
  }
});

test('con 0 retos que llega a 24 NO ve el libro de 25 («faltan 1»); a 25 sí; el de 35 y el de 45 igual (usan el umbral NUEVO)', async () => {
  for (const [id, umbral] of Object.entries(NUEVOS)) {
    const { app, db } = servidor({ ...retosDe('ana', umbral - 1) });
    const r = (await libros(app)).body.libros.find(l => l.id === id);
    assert.equal(r.desbloqueado, false, `${id} con ${umbral - 1}`);
    assert.equal(r.faltan, 1);
    assert.equal((await libro(app, id)).status, 403);
    const { app: a2 } = servidor({ ...retosDe('ana', umbral) });
    assert.equal((await libro(a2, id)).status, 200, `${id} con ${umbral}`);
    assert.equal(db.value('librosConservados/ana'), undefined, 'no se guarda nada a quien no tenía derecho previo');
  }
  const { app: a0 } = servidor({});
  const faltan = (await libros(a0)).body.libros.map(l => [l.id, l.faltan]);
  assert.deepEqual(faltan, [[LEY, 25], [BIEN, 35], [CONS, 45]]);
});

test('quien ya conservaba sigue viendo abierto el libro aunque el umbral nuevo sea 45 (con 31 retos y membresía), y solo ese', async () => {
  const { app } = servidor({ ...retosDe('ana', 31), ...conservadosDe('ana', [CONS]) });
  const abre = await abiertos(app);
  assert.ok(abre.has(CONS) && abre.has(LEY), 'conserva el de 45 y alcanza el de 25 por umbral nuevo');
  assert.equal(abre.has(BIEN), false, 'el de 35 pide 35: no lo conserva ni lo alcanza');
  assert.equal((await libro(app, CONS)).status, 200);
});

test('un miembro vencido mantiene la regla de acceso (sin membresía no se abre ni lo conservado) y al renovar lo recupera', async () => {
  const { app } = servidor({ ...retosDe('vencida', 15), ...conservadosDe('vencida', [LEY, BIEN]) });
  const r = await libros(app, 'token-vencida');
  assert.ok(r.body.libros.every(l => l.desbloqueado === false && l.soloMiembros === true));
  assert.equal((await libro(app, LEY, 'token-vencida')).status, 403);
  const { app: a2 } = servidor({ ...retosDe('ana', 15), ...conservadosDe('ana', [LEY, BIEN]) });
  assert.equal((await abiertos(a2)).has(BIEN), true);
});

test('el administrador abre todo sin documento; quien no tiene membresía nunca recibe respaldo', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('admin', 50), ...retosDe('vencida', 20) });
  assert.equal((await abiertos(app, 'token-admin')).size, 3);
  await libros(app, 'token-vencida');
  assert.equal(db.value('librosConservados/admin'), undefined);
  assert.equal(db.value('librosConservados/vencida'), undefined);
});

/* ───────── créditos ───────── */

test('canje con créditos intacto: lo conservado no se ofrece ni se cobra; lo canjeado sigue abierto; el límite de un libro por créditos se mantiene', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 15), ...conSaldo('ana', 300) });
  const e = await estadoCreditos(app);
  const por = Object.fromEntries(e.body.libros.map(l => [l.id, l]));
  assert.deepEqual([por[LEY].canjeable, por[LEY].motivo], [false, 'ya-accesible']);
  assert.deepEqual([por[BIEN].canjeable, por[BIEN].motivo], [false, 'ya-accesible']);
  assert.deepEqual([por[CONS].canjeable, por[CONS].motivo], [true, null]);
  assert.ok(!e.body.materiales.some(m => m.clave === 'libro:' + LEY || m.clave === 'libro:' + BIEN), 'no se ofrecen para canjear');
  const repetido = await canjear(app, 'libro:' + LEY);
  assert.equal(repetido.status, 409); assert.equal(repetido.body.codigo, 'ya-accesible');
  assert.equal(db.value('creditosCuentas/ana').saldo, 300, 'no se cobró');
  const ok = await canjear(app, 'libro:' + CONS);
  assert.equal(ok.status, 200); assert.equal(ok.body.saldo, 200);
  // el canjeado y los conservados siguen abiertos
  for (const id of [LEY, BIEN, CONS]) assert.equal((await libro(app, id)).status, 200, id);
  const otra = await estadoCreditos(app);
  assert.equal(otra.body.librosCanjeadosConCreditos, 1);
});

test('un libro canjeado con créditos sigue abierto aunque no tenga retos ni membresía; y no cuenta como «conservado»', async () => {
  const { app, db } = servidor({ ...retosDe('vencida', 3), ...conSaldo('vencida', 100) });
  const ok = await canjear(app, 'libro:' + BIEN, 'token-vencida');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await libro(app, BIEN, 'token-vencida')).status, 200);
  assert.equal(db.value('librosConservados/vencida'), undefined);
});

/* ───────── avisos de «libro desbloqueado» ───────── */

test('avisos: quien conserva el libro no recibe un aviso falso al cruzar el umbral nuevo; el aviso que ya tenía no se repite', async () => {
  const aviso = (id, texto) => ({ tipo: 'libro', titulo: '¡Desbloqueaste un libro!', texto, enlace: 'club-pdfs.html', creadoEn: ts(dias(-5)), leido: false });
  // lo que ya había recibido antes del lanzamiento, cuando cruzó 5 y 15 retos
  const previo = { 'avisos/ana/items/libro_ley-fauna-mx': aviso(), 'avisos/ana/items/libro_bienestar-cautiverio': aviso() };
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 24), ...previo });
  assert.deepEqual(avisosLibro(db, 'ana'), ['libro_bienestar-cautiverio', 'libro_ley-fauna-mx']);
  // sube de 24 a 25: cruza el umbral NUEVO del libro, pero ya lo tenía abierto
  const r = await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.librosNuevos, [], 'no es un libro nuevo');
  assert.deepEqual(avisosLibro(db, 'ana'), ['libro_bienestar-cautiverio', 'libro_ley-fauna-mx'], 'ni un aviso más');
  // y abrir la lista de libros tampoco crea avisos de lo que no desbloqueó
  await libros(app);
  assert.deepEqual(avisosLibro(db, 'ana'), ['libro_bienestar-cautiverio', 'libro_ley-fauna-mx']);
});

test('avisos: a quien NO lo tenía antes, el aviso sale una sola vez al cruzar el umbral NUEVO (24 → 25), no antes', async () => {
  const { app, db } = servidor({ ...retosDe('ana', 24) });
  await libros(app);
  assert.deepEqual(avisosLibro(db, 'ana'), [], 'con 24 no hay libro: no hay aviso falso por el cambio de umbral');
  const r = await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.deepEqual(r.body.librosNuevos, [LEY]);
  assert.deepEqual(avisosLibro(db, 'ana'), ['libro_ley-fauna-mx']);
  await libros(app);
  await camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 });
  assert.deepEqual(avisosLibro(db, 'ana'), ['libro_ley-fauna-mx'], 'no se repite');
});

test('avisos: lo que se conserva por el lanzamiento (6 retos sin aviso previo) avisa UNA vez como libro ya ganado, no como libro nuevo', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 6) });
  await libros(app);
  await libros(app);
  assert.deepEqual(avisosLibro(db, 'ana'), ['libro_ley-fauna-mx']);
});

/* ───────── respaldo perezoso en el POST de retos ───────── */

test('POST de retos: el respaldo se calcula ANTES de sumar el reto (14 → 15 conserva solo lo de 14: el de 5, no el de 15) y en la misma transacción', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 14) });
  const r = await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.value('retosUsuario/ana').superados, 15);
  assert.deepEqual(db.value('librosConservados/ana').ids, [LEY]);
  assert.equal(db.value('librosConservados/ana').origen, 'respaldo-reto');
  const antes = JSON.stringify(db.value('librosConservados/ana'));
  await camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 });
  assert.equal(JSON.stringify(db.value('librosConservados/ana')), antes, 'un segundo reto no lo toca');
});

test('dos retos a la vez sin documento: queda UN solo respaldo con lo de antes (sin carreras)', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 29) });
  const rs = await Promise.all([camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 }), camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 })]);
  assert.ok(rs.every(r => r.status === 200));
  assert.deepEqual(db.value('librosConservados/ana').ids, [BIEN, LEY], 'a 29 no cumplía el de 30');
});

test('con la migración de libros terminada, el POST de retos no escribe documento de libros conservados; la de materiales sigue su camino aparte', async () => {
  const { app, db } = servidor({ ...MIGRADO, ...retosDe('ana', 14) });
  await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(db.value('librosConservados/ana'), undefined);
  // con la bandera de materiales sin marcar y la de libros marcada, solo se respalda lo de materiales
  const { app: a2, db: db2 } = servidor({ 'config/migraciones': { librosConservadosV1: true }, ...retosDe('ana', 14) });
  await camino(a2, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(db2.value('librosConservados/ana'), undefined);
  assert.ok(db2.value('materialesConservados/ana'), 'son migraciones independientes');
});

/* ───────── migración única ───────── */

function dbMigracion() {
  return new FakeFirestore({
    ...retosDe('a1', 6), ...retosDe('a2', 9), ...retosDe('a3', 15), ...retosDe('a4', 30), ...retosDe('a5', 4), ...retosDe('a6', 0), ...retosDe('a7', 24),
    ...retosDe('ya', 40), ...conservadosDe('ya', [LEY]),
    'miembros/a1': miembroConPlan({ name: 'A1' }), 'miembros/a5': miembroSinPlan({ name: 'A5' })
  });
}
const admin = { firestore: { FieldValue: { serverTimestamp: () => new FakeTimestamp(Date.now()) }, FieldPath: { documentId: () => '__name__' } } };
const consola = { log() {}, error() {} };

test('migración: por persona lo que cumplía con los umbrales de antes, solo si no está vacío, paginada, sin tocar a quien ya tenía documento ni escribir en miembros; queda en el historial', async () => {
  const db = dbMigracion();
  const anotados = [];
  const miembrosAntes = miembrosDe(db);
  const c = C.crearConservacion({ db, admin, historial: { anotar: async (...a) => { anotados.push(a); } }, log: consola });
  const r = await c.migrar({ pagina: 2 });
  assert.deepEqual([r.revisados, r.conservados], [8, 5]);
  assert.ok(r.paginas >= 4);
  assert.deepEqual(db.value('librosConservados/a1').ids, [LEY]);
  assert.deepEqual(db.value('librosConservados/a2').ids, [LEY]);
  assert.deepEqual(db.value('librosConservados/a3').ids, [BIEN, LEY]);
  assert.deepEqual(db.value('librosConservados/a4').ids, [BIEN, CONS, LEY]);
  assert.equal(db.value('librosConservados/a5'), undefined, '4 retos: ninguno');
  assert.equal(db.value('librosConservados/a6'), undefined, '0 retos: nada');
  assert.deepEqual(db.value('librosConservados/a7').ids, [BIEN, LEY], '24 retos: los de 5 y 15 (con los umbrales de antes)');
  assert.deepEqual(db.value('librosConservados/ya').ids, [LEY], 'un documento existente no se toca');
  assert.equal(miembrosDe(db), miembrosAntes, 'no se escribió nada en documentos de miembros');
  assert.equal(db.value('config/migraciones').librosConservadosV1, true);
  assert.equal(db.value('config/migraciones').librosConservadosV1Miembros, 5);
  assert.equal(db.value('materialesConservados/a1'), undefined, 'no toca la colección de materiales');
  assert.equal(anotados.length, 1);
  assert.equal(anotados[0][1], 'sistema-conservar-libros');
  assert.equal(anotados[0][3], 'Conservó los desbloqueos de libros de 5 miembros');
});

test('migración: idempotente (dos corridas = mismo resultado; la segunda se omite y, aun sin bandera, no cambia nada) y solo agrega', async () => {
  const db = dbMigracion();
  const c = C.crearConservacion({ db, admin, log: consola });
  await c.migrar();
  const primera = JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('librosConservados/')).sort());
  assert.equal((await c.migrar()).omitida, true);
  db._data.delete('config/migraciones');
  const r3 = await C.crearConservacion({ db, admin, log: consola }).migrar();
  assert.equal(r3.conservados, 0);
  assert.equal(JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('librosConservados/')).sort()), primera);
  const c2 = C.crearConservacion({ db: new FakeFirestore({ ...conservadosDe('ana', [CONS]) }), admin, log: consola });
  await c2.guardarUnion('ana', [LEY]);
  assert.deepEqual(c2.refDe ? (await c2.leerDoc('ana')).ids : null, new Set([CONS, LEY]), 'la unión no quita nada');
});

test('arranque: en segundo plano, no lanza ni retrasa; si falla no marca la bandera y la segunda corrida termina; un corte a la mitad se recupera', async () => {
  const db = dbMigracion();
  const original = db.collection.bind(db);
  let rompe = true;
  db.collection = n => (n === 'retosUsuario' && rompe ? { orderBy: () => ({ limit: () => ({ get: async () => { throw new Error('Firestore caído'); } }) }) } : original(n));
  const errores = [];
  const c = C.crearConservacion({ db, admin, log: { log() {}, error: (...a) => errores.push(a.join(' ')) } });
  const t0 = Date.now();
  const h = c.iniciar({ retrasoMs: 0 });
  assert.ok(Date.now() - t0 < 50);
  await new Promise(r => setTimeout(r, 40));
  assert.match(errores.join('\n'), /\[Libros conservados\] La migración falló y se reintentará en el siguiente arranque/);
  assert.equal(db.value('config/migraciones'), undefined);
  rompe = false;
  // un corte a la mitad: a1 ya estaba guardado
  await C.crearConservacion({ db, admin, log: consola }).guardarUnion('a1', [LEY], { soloSiNoExiste: true });
  const antes = JSON.stringify(db.value('librosConservados/a1'));
  const r = await C.crearConservacion({ db, admin, log: consola }).migrar({ pagina: 3 });
  assert.equal(r.conservados, 4);
  assert.equal(JSON.stringify(db.value('librosConservados/a1')), antes);
  assert.equal(db.value('config/migraciones').librosConservadosV1, true);
  h.detener();
});

test('server.js programa las dos migraciones (materiales y libros) solo al ejecutarse directamente, cada una con su bandera', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(codigo.indexOf('conservacionLibros.iniciar(') > codigo.indexOf('require.main === module'));
  assert.ok(codigo.indexOf('conservacionMateriales.iniciar()') > codigo.indexOf('require.main === module'));
  assert.match(codigo, /conservacionLibros/);
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'services', 'libros-conservados.js'), 'utf8');
  assert.doesNotMatch(fuente, /collection\('miembros'\)|materialesConservados|materialesConservadosV1/);
  assert.match(fuente, /librosConservadosV1/);
});
