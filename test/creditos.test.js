'use strict';

// Créditos: regalo manual del administrador (100, 200, 300, 400 u otra cantidad entera de 1 a 1,000), canje por UN material sin curso (100 cada uno) y acceso a lo canjeado.
// Ejecutar: node --test test/creditos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias } = require('./helpers/club');
const { carpetaLibros, carpetaMateriales, libroValido, materialValido } = require('./helpers/materiales');
const creditos = require('../services/creditos');

const tokens = tokensDe('ana', 'sinplan', 'noverif', 'otra', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const DRIVE_ID = 'abcdefghij1234567890';

const catalogo = () => [
  materialValido('guia-miembros', 'miembros'),
  materialValido('plantilla-5', 'retos', 5, { tipo: 'plantilla' }),
  materialValido('presentacion-30', 'retos', 30, { tipo: 'presentacion' }),
  materialValido('guia-del-curso', 'curso', undefined, { cursoId: 'curso-uno', clase: 1 })
];

function servidor({ seed = {}, usuarios = {} } = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: { LIBROS_DIR: carpetaLibros([libroValido('libro-a', 5), libroValido('libro-b', 10)]), MATERIALES_DIR: carpetaMateriales(catalogo()) }, tokens,
      usuariosAuth: {
        ana: { emailVerified: true, email: 'ana@example.com' }, sinplan: { emailVerified: true, email: 'sinplan@example.com' },
        noverif: { emailVerified: false, email: 'noverif@example.com' }, otra: { emailVerified: true, email: 'otra@example.com' },
        admin: { emailVerified: true, email: 'admin@example.com' }, ...usuarios
      },
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com', createdAt: new Date(Date.now() - 5 * 86400000).toISOString() }),
        'miembros/sinplan': miembroSinPlan({ name: 'Sin Plan', email: 'sinplan@example.com', createdAt: new Date(Date.now() - 2 * 86400000).toISOString() }),
        'miembros/noverif': miembroSinPlan({ name: 'No Verificada', email: 'noverif@example.com', createdAt: new Date(Date.now() - 1 * 86400000).toISOString() }),
        'miembros/otra': miembroSinPlan({ name: 'Otra Persona', email: 'otra@example.com', createdAt: new Date(Date.now() - 9 * 86400000).toISOString() }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin' }),
        'cursos/curso-uno': { title: 'Curso Uno', lecciones: [{ title: 'A' }, { title: 'B' }] },
        'pdfs/drive-libre': { title: 'PDF de Drive sin curso', driveId: DRIVE_ID, pages: 4, createdAt: new Date().toISOString() },
        'pdfs/drive-de-curso': { title: 'PDF de Drive de un curso', driveId: DRIVE_ID, cursoId: 'curso-uno', clase: 1, createdAt: new Date().toISOString() },
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}

let n = 0;
const op = () => 'operacion-' + String(++n).padStart(6, '0');
const regalar = (app, uid, clave = op(), t = 'token-admin', cantidad = 100) => request(app).post('/api/admin/creditos/regalar').set(auth(t)).send({ uid, clave, cantidad });
const estado = (app, t = 'token-ana') => request(app).get('/api/creditos/estado').set(auth(t));
const canjear = (app, materialId, t = 'token-ana') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const archivo = (app, id, t) => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t));
const movimientos = db => [...db._data.keys()].filter(k => k.startsWith('creditosMovimientos/')).map(k => db.value(k));

/* ───────────────────────── Reglas puras ───────────────────────── */

test('constantes: se propone regalar 100 (máximo 1,000), cada material cuesta 100, sin caducidad y con tope diario de créditos', () => {
  assert.equal(creditos.REGALO, 100);
  assert.equal(creditos.MAX_REGALO, 1000);
  assert.equal(creditos.COSTO_MATERIAL, 100);
  assert.equal(creditos.CADUCIDAD_DIAS, null);
  assert.equal(creditos.TOPE_CREDITOS_POR_DIA, 1000);
  assert.equal(creditos.TOPE_REGALOS_POR_DIA, undefined, 'el tope ya no cuenta regalos: cuenta créditos');
});

test('cantidadValida: solo enteros de 1 a 1,000 y en forma de número', () => {
  for (const ok of [1, 50, 100, 200, 250, 300, 400, 999, 1000]) assert.equal(creditos.cantidadValida(ok), true, String(ok));
  for (const mal of [0, -1, -100, 1.5, 99.99, 1001, 5000, NaN, Infinity, '100', '300', ' 300', '3e2', null, undefined, true, [], {}, [300]]) assert.equal(creditos.cantidadValida(mal), false, JSON.stringify(mal));
});

test('catalogoCanjeable: libros y materiales sin curso; fuera lo ligado a un curso y lo de Drive con la liga mal escrita', () => {
  const lista = creditos.catalogoCanjeable({
    libros: [{ id: 'l1', titulo: 'Libro 1', categoria: 'Ley', paginas: [1, 2, 3] }],
    materiales: [{ id: 'm1', titulo: 'M1', area: 'A', acceso: 'miembros', tipo: 'guia', paginas: 2 }, { id: 'm2', titulo: 'M2', area: 'A', acceso: 'curso', cursoId: 'c1', clase: 2 }],
    drive: [{ id: 'd1', titulo: 'D1', area: 'G', paginas: 1 }, { id: 'd2', titulo: 'D2', cursoId: 'c1' }, { id: 'd3', titulo: 'D3', configuracionInvalida: true }]
  });
  assert.deepEqual(lista.map(x => x.clave), ['libro:l1', 'pdf:m1', 'drive:d1']);
});

test('analizarClave: solo libro:, pdf: y drive: con ids seguros', () => {
  assert.deepEqual(creditos.analizarClave('pdf:guia-1'), { tipo: 'pdf', id: 'guia-1', clave: 'pdf:guia-1' });
  for (const malo of ['guia-1', 'curso:abc', 'pdf:', 'pdf:../x', 'pdf:a b', 'pdf:' + 'a'.repeat(90), null, 5, {}]) assert.equal(creditos.analizarClave(malo), null, String(malo));
});

test('historialDeRegalos: los canjes se emparejan por créditos, del regalo más antiguo al más nuevo; salen del más reciente al más antiguo', () => {
  const mov = [
    { id: 'r1', tipo: 'regalo', uid: 'a', cantidad: 100, enMs: 1000, en: new Date(1000), adminCorreo: 'x@y.z' },
    { id: 'r2', tipo: 'regalo', uid: 'a', cantidad: 100, enMs: 3000, en: new Date(3000) },
    { id: 'c1', tipo: 'canje', uid: 'a', cantidad: 100, enMs: 2000, en: new Date(2000), materialId: 'pdf:m1', materialTitulo: 'M1' },
    { id: 'r3', tipo: 'regalo', uid: 'b', cantidad: 100, enMs: 2500, en: new Date(2500) }
  ];
  const h = creditos.historialDeRegalos(mov);
  assert.deepEqual(h.map(x => [x.id, x.estado]), [['r2', 'pendiente'], ['r3', 'pendiente'], ['r1', 'canjeado']]);
  assert.equal(h[2].canje.titulo, 'M1');
});

test('historialDeRegalos: un regalo de 300 pasa de Pendiente a "Canjeados 1 de 3", "2 de 3" y Canjeado con sus materiales', () => {
  const regalo = { id: 'r', tipo: 'regalo', uid: 'a', cantidad: 300, enMs: 1000, en: new Date(1000) };
  const canje = (n, titulo) => ({ id: 'c' + n, tipo: 'canje', uid: 'a', cantidad: 100, enMs: 1000 + n * 10, en: new Date(1000 + n * 10), materialId: 'pdf:m' + n, materialTitulo: titulo });
  const de = movs => creditos.historialDeRegalos(movs)[0];
  let h = de([regalo]);
  assert.deepEqual([h.estado, h.materialesCanjeados, h.materialesTotal, h.cantidad, h.canjes.length], ['pendiente', 0, 3, 300, 0]);
  h = de([regalo, canje(1, 'Uno')]);
  assert.deepEqual([h.estado, h.materialesCanjeados, h.materialesTotal, h.usados], ['parcial', 1, 3, 100]);
  h = de([regalo, canje(1, 'Uno'), canje(2, 'Dos')]);
  assert.deepEqual([h.estado, h.materialesCanjeados], ['parcial', 2]);
  h = de([regalo, canje(1, 'Uno'), canje(2, 'Dos'), canje(3, 'Tres')]);
  assert.deepEqual([h.estado, h.materialesCanjeados, h.materialesTotal], ['canjeado', 3, 3]);
  assert.deepEqual(h.canjes.map(c => c.titulo), ['Uno', 'Dos', 'Tres']);
  assert.equal(h.canje.titulo, 'Tres', 'canje = el último');
});

test('historialDeRegalos: primero en entrar, primero en salir entre varios regalos de la misma persona; un canje puede repartirse entre dos', () => {
  const g = (id, cantidad, ms) => ({ id, tipo: 'regalo', uid: 'a', cantidad, enMs: ms, en: new Date(ms) });
  const c = (id, ms, titulo) => ({ id, tipo: 'canje', uid: 'a', cantidad: 100, enMs: ms, en: new Date(ms), materialId: 'pdf:' + id, materialTitulo: titulo });
  const h = creditos.historialDeRegalos([g('g1', 200, 100), g('g2', 300, 200), c('c1', 300, 'A'), c('c2', 310, 'B'), c('c3', 320, 'C')]);
  const por = Object.fromEntries(h.map(x => [x.id, x]));
  assert.equal(por.g1.estado, 'canjeado'); assert.deepEqual(por.g1.canjes.map(x => x.titulo), ['A', 'B']);
  assert.equal(por.g2.estado, 'parcial'); assert.deepEqual(por.g2.canjes.map(x => x.titulo), ['C']);
  assert.deepEqual([por.g2.materialesCanjeados, por.g2.materialesTotal], [1, 3]);
  // 250 + 50: el sobrante de un regalo se completa con el siguiente
  const h2 = creditos.historialDeRegalos([g('a1', 250, 100), g('a2', 50, 200), c('d1', 300, 'X'), c('d2', 310, 'Y'), c('d3', 320, 'Z')]);
  const p2 = Object.fromEntries(h2.map(x => [x.id, x]));
  assert.equal(p2.a1.estado, 'canjeado'); assert.deepEqual([p2.a1.materialesCanjeados, p2.a1.materialesTotal, p2.a1.sobrante], [2, 2, 50]);
  assert.deepEqual(p2.a1.canjes.map(x => x.titulo), ['X', 'Y', 'Z'], 'el tercer canje usa 50 de este regalo y 50 del siguiente');
  assert.equal(p2.a2.estado, 'canjeado'); assert.deepEqual(p2.a2.canjes.map(x => x.titulo), ['Z']);
  // un regalo de menos de 100 solo se gasta junto con otro: mientras tanto queda Pendiente
  const h3 = creditos.historialDeRegalos([g('p1', 40, 100)]);
  assert.deepEqual([h3[0].estado, h3[0].materialesTotal, h3[0].sobrante], ['pendiente', 0, 40]);
  // regalos viejos sin cantidad cuentan como 100
  assert.equal(creditos.historialDeRegalos([{ id: 'v', tipo: 'regalo', uid: 'a', enMs: 1, en: new Date(1) }])[0].cantidad, 100);
});

test('metricas: regalados, canjeados, pendientes y canjes por material (de más a menos)', () => {
  const m = creditos.metricas([
    { tipo: 'regalo', cantidad: 100 }, { tipo: 'regalo', cantidad: 100 }, { tipo: 'regalo', cantidad: 100 },
    { tipo: 'canje', cantidad: 100, materialId: 'pdf:a', materialTitulo: 'A' }, { tipo: 'canje', cantidad: 100, materialId: 'pdf:b', materialTitulo: 'B' }, { tipo: 'canje', cantidad: 100, materialId: 'pdf:b', materialTitulo: 'B' }
  ]);
  assert.equal(m.regalados, 300); assert.equal(m.canjeados, 300); assert.equal(m.pendientes, 0);
  assert.deepEqual(m.materiales.map(x => [x.titulo, x.canjes]), [['B', 2], ['A', 1]]);
  assert.deepEqual(creditos.metricas([]), { regalados: 0, canjeados: 0, pendientes: 0, regalos: 0, canjes: 0, materiales: [] });
});

/* ───────────────────────── Regalar ───────────────────────── */

test('regalar: solo administración (401 sin sesión, 403 a una persona) y siempre con una cantidad entera de 1 a 1,000', async () => {
  const { app, db } = servidor();
  assert.equal((await request(app).post('/api/admin/creditos/regalar').send({ uid: 'ana', clave: op(), cantidad: 100 })).status, 401);
  assert.equal((await regalar(app, 'ana', op(), 'token-ana')).status, 403);
  assert.equal((await regalar(app, 'ana', op(), 'token-ana', 1000)).status, 403, 'una persona no se regala créditos a sí misma');
  assert.equal(db.value('creditosCuentas/ana'), undefined);
  const mal = async cantidad => request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'ana', clave: op(), cantidad });
  for (const c of [0, -100, 1.5, 1001, 5000, '300', '1e2', null, true, [100], {}]) {
    const r = await mal(c);
    assert.equal(r.status, 400, JSON.stringify(c));
    assert.equal(r.body.codigo, 'cantidad-invalida', JSON.stringify(c));
  }
  assert.equal((await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'ana', clave: op() })).status, 400, 'sin cantidad no se regala nada');
  assert.equal(db.value('creditosCuentas/ana'), undefined, 'ninguna cantidad mala deja rastro');
  assert.equal(movimientos(db).length, 0);
});

test('regalar: acepta 100, 200, 300, 400, 250 y 1000 y suma exactamente esa cantidad', async () => {
  const { app, db } = servidor();
  let esperado = 0;
  for (const c of [100, 200, 300, 250]) {
    const r = await regalar(app, 'otra', op(), 'token-admin', c);
    esperado += c;
    assert.equal(r.status, 200, String(c));
    assert.equal(r.body.cantidad, c); assert.equal(r.body.saldo, esperado);
    assert.equal(r.body.materiales, Math.floor(c / 100));
  }
  assert.equal(db.value('creditosCuentas/otra').saldo, 850);
  assert.equal((await regalar(app, 'sinplan', op(), 'token-admin', 400)).body.saldo, 400);
  const mil = await regalar(app, 'ana', op(), 'token-admin', 1000);
  assert.equal(mil.status, 200); assert.equal(db.value('creditosCuentas/ana').saldo, 1000);
  const movs = movimientos(db).filter(m => m.uid === 'otra').map(m => m.cantidad).sort((a, b) => a - b);
  assert.deepEqual(movs, [100, 200, 250, 300]);
});

test('regalar: suma 100 a una cuenta con o sin membresía, anota el movimiento, la bitácora y deja el aviso pendiente', async () => {
  const { app, db } = servidor();
  assert.equal((await regalar(app, 'ana')).body.saldo, 100);
  assert.equal((await regalar(app, 'sinplan')).body.saldo, 100);
  const cuenta = db.value('creditosCuentas/sinplan');
  assert.equal(cuenta.saldo, 100); assert.equal(cuenta.avisoPendiente, 100); assert.equal(cuenta.regalados, 100);
  const movs = movimientos(db).filter(m => m.uid === 'sinplan');
  assert.equal(movs.length, 1);
  assert.equal(movs[0].tipo, 'regalo'); assert.equal(movs[0].cantidad, 100); assert.equal(movs[0].adminUid, 'admin'); assert.ok(movs[0].en);
  const acciones = [...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).map(k => db.value(k)).filter(a => a.accion === 'creditos-regalar');
  assert.equal(acciones.length, 2);
  assert.match(acciones[0].resumen, /Regaló 100 créditos a/);
});

test('regalar: la misma operación repetida (doble clic) no regala dos veces; otra operación sí suma', async () => {
  const { app, db } = servidor();
  const clave = op();
  const [a, b] = await Promise.all([regalar(app, 'ana', clave), regalar(app, 'ana', clave)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(db.value('creditosCuentas/ana').saldo, 100, 'solo un regalo');
  assert.equal(movimientos(db).filter(m => m.tipo === 'regalo').length, 1);
  assert.ok([a.body.repetido, b.body.repetido].includes(true));
  assert.equal((await regalar(app, 'ana', op())).body.saldo, 200, 'otro regalo, otra operación');
});

test('regalar: la misma operación repetida con otra cantidad tampoco regala dos veces (gana la primera)', async () => {
  const { app, db } = servidor();
  const clave = op();
  assert.equal((await regalar(app, 'ana', clave, 'token-admin', 300)).body.saldo, 300);
  const otra = await regalar(app, 'ana', clave, 'token-admin', 1000);
  assert.equal(otra.status, 200); assert.equal(otra.body.repetido, true); assert.equal(otra.body.cantidad, 300);
  assert.equal(db.value('creditosCuentas/ana').saldo, 300);
});

test('regalar: tope de 1,000 créditos por cuenta y por día (no de regalos): 600 + 400 pasan y uno más no', async () => {
  const { app, db } = servidor();
  assert.equal((await regalar(app, 'ana', op(), 'token-admin', 600)).status, 200);
  assert.equal((await regalar(app, 'ana', op(), 'token-admin', 400)).status, 200);
  const r = await regalar(app, 'ana', op(), 'token-admin', 1);
  assert.equal(r.status, 429);
  assert.equal(r.body.codigo, 'tope-diario');
  assert.match(r.body.error, /1000 créditos|1,000 créditos|tope/);
  assert.equal(db.value('creditosCuentas/ana').saldo, 1000);
  assert.equal(movimientos(db).filter(m => m.uid === 'ana').length, 2, 'lo rechazado no deja movimiento');
  assert.equal((await regalar(app, 'otra', op(), 'token-admin', 1000)).status, 200, 'el tope es por cuenta');
  // muchos regalos chicos también suman hacia el tope
  for (let i = 0; i < 10; i++) assert.equal((await regalar(app, 'sinplan', op(), 'token-admin', 100)).status, 200);
  assert.equal((await regalar(app, 'sinplan', op(), 'token-admin', 100)).status, 429);
});

test('regalar: un regalo que pasaría el tope se rechaza completo y el mensaje dice cuánto queda por regalar hoy', async () => {
  const { app, db } = servidor();
  assert.equal((await regalar(app, 'ana', op(), 'token-admin', 800)).status, 200);
  const r = await regalar(app, 'ana', op(), 'token-admin', 300);
  assert.equal(r.status, 429);
  assert.match(r.body.error, /hasta 200/);
  assert.equal(db.value('creditosCuentas/ana').saldo, 800);
  assert.equal((await regalar(app, 'ana', op(), 'token-admin', 200)).status, 200);
});

test('regalar: cuentas anteriores (solo guardaban cuántos regalos) siguen contando hacia el tope', async () => {
  const hoy = creditos.diaMexico(Date.now());
  const { app } = servidor({ seed: { 'creditosCuentas/ana': { uid: 'ana', saldo: 300, regalados: 300, canjeados: 0, avisoPendiente: 0, regalosHoy: { dia: hoy, n: 3 } } } });
  assert.equal((await regalar(app, 'ana', op(), 'token-admin', 700)).status, 200, '3 regalos de 100 + 700 = 1,000');
  assert.equal((await regalar(app, 'ana', op(), 'token-admin', 1)).status, 429);
});

test('regalar: rechaza cuenta sin correo confirmado, cuenta inexistente, administradores, id raro y clave faltante', async () => {
  const { app, db } = servidor();
  const nv = await regalar(app, 'noverif');
  assert.equal(nv.status, 409); assert.equal(nv.body.codigo, 'correo-no-verificado');
  assert.equal(db.value('creditosCuentas/noverif'), undefined);
  assert.equal((await regalar(app, 'fantasma')).status, 404);
  assert.equal((await regalar(app, 'admin')).status, 409);
  assert.equal((await regalar(app, '../x')).status, 400);
  assert.equal((await regalar(app, 'ana', 'corta')).status, 400);
  assert.equal((await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'ana', cantidad: 100 })).status, 400);
  assert.equal(movimientos(db).length, 0);
});

/* ───────────────────────── Estado de la persona ───────────────────────── */

test('estado: sin sesión 401; sin regalos saldo 0; con regalo, saldo, aviso pendiente y materiales canjeables sin los de curso', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/creditos/estado')).status, 401);
  const e0 = await estado(app, 'token-sinplan');
  assert.equal(e0.body.saldo, 0); assert.equal(e0.body.avisoPendiente, 0); assert.equal(e0.body.costo, 100);
  await regalar(app, 'sinplan');
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.saldo, 100); assert.equal(e.body.avisoPendiente, 100);
  assert.match(e.headers['cache-control'], /no-store/);
  assert.deepEqual(e.body.materiales.map(m => m.clave).sort(), ['drive:drive-libre', 'libro:libro-a', 'libro:libro-b', 'pdf:guia-miembros', 'pdf:plantilla-5', 'pdf:presentacion-30']);
  assert.ok(e.body.materiales.every(m => m.costo === 100 && m.desbloqueado === false));
  assert.ok(!JSON.stringify(e.body).includes('guia-del-curso') && !JSON.stringify(e.body).includes('drive-de-curso'), 'lo de un curso nunca se ofrece');
  assert.doesNotMatch(JSON.stringify(e.body), new RegExp(DRIVE_ID), 'sin ids ni enlaces de Drive');
});

test('estado: lo que la persona ya abre por membresía o retos NO se ofrece para canjear', async () => {
  const { app } = servidor({ seed: retosDe('ana', 6) });
  const e = await estado(app, 'token-ana');
  const claves = e.body.materiales.map(m => m.clave);
  assert.ok(!claves.includes('pdf:guia-miembros'), 'con membresía ya abre los de miembros');
  assert.ok(!claves.includes('pdf:plantilla-5') && !claves.includes('libro:libro-a'), 'con 6 retos ya abre lo de 5');
  assert.ok(claves.includes('pdf:presentacion-30') && claves.includes('libro:libro-b'), 'lo que todavía le pide más retos sí se puede canjear');
});

/* ───────────────────────── Canjear ───────────────────────── */

test('canjear: sin saldo 402 (te faltan créditos) y no se crea nada', async () => {
  const { app, db } = servidor();
  const r = await canjear(app, 'pdf:plantilla-5', 'token-sinplan');
  assert.equal(r.status, 402);
  assert.equal(r.body.codigo, 'saldo-insuficiente');
  assert.match(r.body.error, /faltan créditos/);
  assert.equal(db.value('creditosDesbloqueos/sinplan__pdf__plantilla-5'), undefined);
});

test('canjear: descuenta 100, desbloquea SOLO ese material para esa cuenta y anota el movimiento', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan');
  // antes: sin membresía no abre nada
  assert.equal((await archivo(app, 'plantilla-5', 'token-sinplan')).status, 403);
  const r = await canjear(app, 'pdf:plantilla-5', 'token-sinplan');
  assert.equal(r.status, 200);
  assert.equal(r.body.saldo, 0); assert.equal(r.body.titulo, 'Material plantilla-5');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  assert.equal(db.value('creditosCuentas/sinplan').canjeados, 100);
  assert.ok(db.value('creditosDesbloqueos/sinplan__pdf__plantilla-5'));
  const canje = movimientos(db).find(m => m.tipo === 'canje');
  assert.equal(canje.uid, 'sinplan'); assert.equal(canje.cantidad, 100); assert.equal(canje.materialId, 'pdf:plantilla-5');
  // después: ESE material abre (aunque no tenga membresía ni retos); los demás siguen cerrados
  const abre = await archivo(app, 'plantilla-5', 'token-sinplan');
  assert.equal(abre.status, 200);
  assert.match(abre.headers['content-type'], /pdf/);
  assert.equal((await archivo(app, 'presentacion-30', 'token-sinplan')).status, 403);
  assert.equal((await archivo(app, 'guia-miembros', 'token-sinplan')).status, 403);
  // otra persona sin ese canje sigue sin abrirlo
  assert.equal((await archivo(app, 'plantilla-5', 'token-otra')).status, 403);
  // la lista lo marca desbloqueado, sin candado de «solo miembros», y no lo ofrece otra vez
  const lista = await request(app).get('/api/materiales').set(auth('token-sinplan'));
  const m = lista.body.materiales.find(x => x.id === 'plantilla-5');
  assert.equal(m.desbloqueado, true); assert.equal(m.soloMiembros, false); assert.equal(m.porCreditos, true);
  assert.equal(lista.body.materiales.find(x => x.id === 'presentacion-30').desbloqueado, false);
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.materiales.find(x => x.clave === 'pdf:plantilla-5').desbloqueado, true);
});

test('canjear: un libro y un PDF de Drive también se abren con lo canjeado, y solo ellos', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan');
  assert.equal((await request(app).get('/api/libros/libro-a').set(auth('token-sinplan'))).status, 403);
  assert.equal((await canjear(app, 'libro:libro-a', 'token-sinplan')).status, 200);
  const libro = await request(app).get('/api/libros/libro-a').set(auth('token-sinplan'));
  assert.equal(libro.status, 200);
  assert.match(JSON.stringify(libro.body), /Texto secreto 1 de libro-a/);
  assert.equal((await request(app).get('/api/libros/libro-b').set(auth('token-sinplan'))).status, 403);
  assert.equal((await request(app).get('/api/materiales/drive/drive-libre/enlace').set(auth('token-sinplan'))).status, 403);
  assert.equal((await canjear(app, 'drive:drive-libre', 'token-sinplan')).status, 200);
  const enlace = await request(app).get('/api/materiales/drive/drive-libre/enlace').set(auth('token-sinplan'));
  assert.equal(enlace.status, 200);
  assert.match(enlace.body.url, /drive\.google\.com/);
  assert.equal((await request(app).get('/api/materiales/drive/drive-de-curso/enlace').set(auth('token-sinplan'))).status, 403, 'el de un curso sigue por la clase');
});

test('canjear: un material ligado a un curso, uno que no existe o una clave rara no se pueden canjear', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan');
  for (const [clave, status] of [['pdf:guia-del-curso', 404], ['drive:drive-de-curso', 404], ['pdf:no-existe', 404], ['oficial:nom-059', 400], ['pdf:../x', 400], ['', 400]]) {
    const r = await canjear(app, clave, 'token-sinplan');
    assert.equal(r.status, status, clave);
  }
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 100, 'no se gastó nada');
  assert.equal((await request(app).post('/api/creditos/canjear').set(auth('token-sinplan')).send({})).status, 400);
});

test('canjear: si ya lo abre por membresía o retos, no gasta créditos (409 ya-accesible)', async () => {
  const { app, db } = servidor({ seed: retosDe('ana', 6) });
  await regalar(app, 'ana');
  const r = await canjear(app, 'pdf:plantilla-5', 'token-ana');
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'ya-accesible');
  assert.equal(db.value('creditosCuentas/ana').saldo, 100);
  assert.equal((await canjear(app, 'pdf:presentacion-30', 'token-ana')).status, 200, 'lo que aún le pide más retos sí');
});

test('canjear: el mismo material dos veces no cobra dos veces; un segundo regalo permite canjear otro material', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan');
  assert.equal((await canjear(app, 'pdf:guia-miembros', 'token-sinplan')).status, 200);
  const otra = await canjear(app, 'pdf:guia-miembros', 'token-sinplan');
  assert.equal(otra.status, 409); assert.equal(otra.body.codigo, 'ya-desbloqueado');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 100, 'solo se descontó una vez');
  assert.equal((await canjear(app, 'pdf:plantilla-5', 'token-sinplan')).status, 200);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  assert.equal((await canjear(app, 'pdf:presentacion-30', 'token-sinplan')).status, 402);
});

test('canjear: concurrencia — dos canjes del mismo material a la vez cobran una sola vez; con 100 de saldo, solo uno de dos materiales distintos', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan');
  const [a, b] = await Promise.all([canjear(app, 'pdf:guia-miembros', 'token-sinplan'), canjear(app, 'pdf:guia-miembros', 'token-sinplan')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 100);
  const { app: app2, db: db2 } = servidor();
  await regalar(app2, 'otra');
  const [c, d] = await Promise.all([canjear(app2, 'pdf:plantilla-5', 'token-otra'), canjear(app2, 'pdf:presentacion-30', 'token-otra')]);
  assert.deepEqual([c.status, d.status].sort(), [200, 402]);
  assert.equal(db2.value('creditosCuentas/otra').saldo, 0);
  assert.equal(movimientos(db2).filter(m => m.tipo === 'canje').length, 1);
});

test('canjear: no se puede canjear en nombre de otra cuenta ni con la cuenta de otro (el uid sale de la sesión)', async () => {
  const { app, db } = servidor();
  await regalar(app, 'ana');
  const r = await request(app).post('/api/creditos/canjear').set(auth('token-sinplan')).send({ materialId: 'pdf:plantilla-5', uid: 'ana' });
  assert.equal(r.status, 402, 'sinplan no tiene saldo; el uid del cuerpo se ignora');
  assert.equal(db.value('creditosCuentas/ana').saldo, 100);
});

/* ───────────────────────── Aviso de felicitación ───────────────────────── */

test('aviso-visto: marca la felicitación como vista en el servidor; un regalo nuevo vuelve a avisar', async () => {
  const { app } = servidor();
  assert.equal((await request(app).post('/api/creditos/aviso-visto')).status, 401);
  await regalar(app, 'sinplan');
  assert.equal((await estado(app, 'token-sinplan')).body.avisoPendiente, 100);
  assert.equal((await request(app).post('/api/creditos/aviso-visto').set(auth('token-sinplan')).send({})).status, 200);
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.avisoPendiente, 0); assert.equal(e.body.saldo, 100, 'ver el aviso no cambia el saldo');
  await regalar(app, 'sinplan');
  assert.equal((await estado(app, 'token-sinplan')).body.avisoPendiente, 100);
  // sin cuenta de créditos no falla
  assert.equal((await request(app).post('/api/creditos/aviso-visto').set(auth('token-otra')).send({})).status, 200);
});

/* ───────────────────────── Panel ───────────────────────── */

test('admin: miembros con saldo, de la cuenta más reciente a la más antigua, sin administradores; las personas no entran', async () => {
  const { app } = servidor();
  await regalar(app, 'otra');
  assert.equal((await request(app).get('/api/admin/creditos/miembros')).status, 401);
  assert.equal((await request(app).get('/api/admin/creditos/miembros').set(auth('token-ana'))).status, 403);
  const r = await request(app).get('/api/admin/creditos/miembros').set(auth('token-admin'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.miembros.map(m => m.uid), ['noverif', 'sinplan', 'ana', 'otra']);
  const otra = r.body.miembros.find(m => m.uid === 'otra');
  assert.equal(otra.saldo, 100); assert.ok(otra.ultimoRegalo); assert.equal(otra.correo, 'otra@example.com');
  assert.equal(r.body.miembros.find(m => m.uid === 'ana').saldo, 0);
  assert.equal(r.body.regalo, 100);
  assert.equal(r.body.maxRegalo, 1000);
  assert.equal(r.body.topeDia, 1000);
  assert.equal(r.body.costo, 100);
});

test('admin: historial de regalos con Pendiente / Canjeado, el material y la fecha de canje; filtros, búsqueda y paginación', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan'); await regalar(app, 'otra');
  await canjear(app, 'pdf:plantilla-5', 'token-sinplan');
  const h = await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'));
  assert.equal(h.status, 200);
  assert.equal(h.body.total, 3);
  assert.deepEqual(h.body.totales, { todos: 3, pendientes: 2, canjeados: 1 });
  const canjeado = h.body.regalos.find(r => r.estado === 'canjeado');
  assert.equal(canjeado.uid, 'sinplan'); assert.equal(canjeado.canje.titulo, 'Material plantilla-5'); assert.ok(canjeado.canje.en);
  assert.equal(canjeado.regaladoPor, 'admin@example.com');
  assert.equal(canjeado.nombre, 'Sin Plan');
  assert.deepEqual(h.body.regalos.map(r => r.en), [...h.body.regalos.map(r => r.en)].sort().reverse(), 'más reciente primero');
  assert.equal((await request(app).get('/api/admin/creditos/historial?estado=pendientes').set(auth('token-admin'))).body.total, 2);
  assert.equal((await request(app).get('/api/admin/creditos/historial?estado=canjeados').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/creditos/historial?q=PLANTILLA').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/creditos/historial?q=otra%20persona').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/creditos/historial?pagina=2').set(auth('token-admin'))).body.regalos.length, 0);
  assert.equal((await request(app).get('/api/admin/creditos/historial').set(auth('token-ana'))).status, 403);
});

test('admin: métricas con totales y canjes por material para la gráfica; sin datos todo en cero', async () => {
  const { app } = servidor();
  const vacio = await request(app).get('/api/admin/creditos/metricas').set(auth('token-admin'));
  assert.equal(vacio.body.regalados, 0); assert.deepEqual(vacio.body.materiales, []);
  await regalar(app, 'sinplan'); await regalar(app, 'otra'); await regalar(app, 'ana');
  await canjear(app, 'pdf:plantilla-5', 'token-sinplan'); await canjear(app, 'pdf:plantilla-5', 'token-otra');
  const m = await request(app).get('/api/admin/creditos/metricas').set(auth('token-admin'));
  assert.equal(m.body.regalados, 300); assert.equal(m.body.canjeados, 200); assert.equal(m.body.pendientes, 100);
  assert.deepEqual(m.body.materiales, [{ clave: 'pdf:plantilla-5', titulo: 'Material plantilla-5', canjes: 2 }]);
  assert.equal((await request(app).get('/api/admin/creditos/metricas').set(auth('token-ana'))).status, 403);
});

test('el libro de movimientos es append-only: ningún camino del servidor edita o borra un movimiento', () => {
  const t = ['services/creditos.js', 'services/rutas-creditos.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  const usos = [...t.matchAll(/COL_MOVIMIENTOS[^;\n]*/g)].map(m => m[0]);
  assert.ok(usos.length >= 3);
  assert.doesNotMatch(t, /movRef\.(update|delete)|tx\.(update|delete)\(/);
  assert.doesNotMatch(t, /creditosMovimientos[^\n]*\.(delete|update)\(/);
});

/* ───────────────────────── Cantidades distintas de 100 ───────────────────────── */

test('regalar 300 y canjear tres materiales, uno por uno: saldo 300, 200, 100, 0; el cuarto da 402 y nada cambia', async () => {
  const { app, db } = servidor();
  assert.equal((await regalar(app, 'sinplan', op(), 'token-admin', 300)).body.saldo, 300);
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.saldo, 300); assert.equal(e.body.avisoPendiente, 300); assert.equal(e.body.costo, 100);
  const r1 = await canjear(app, 'pdf:plantilla-5', 'token-sinplan'); assert.equal(r1.status, 200); assert.equal(r1.body.saldo, 200);
  const r2 = await canjear(app, 'pdf:presentacion-30', 'token-sinplan'); assert.equal(r2.status, 200); assert.equal(r2.body.saldo, 100);
  const r3 = await canjear(app, 'pdf:guia-miembros', 'token-sinplan'); assert.equal(r3.status, 200); assert.equal(r3.body.saldo, 0);
  assert.equal((await archivo(app, 'plantilla-5', 'token-sinplan')).status, 200);
  assert.equal((await archivo(app, 'presentacion-30', 'token-sinplan')).status, 200);
  assert.equal((await archivo(app, 'guia-miembros', 'token-sinplan')).status, 200);
  const sin = await canjear(app, 'libro:libro-a', 'token-sinplan');
  assert.equal(sin.status, 402);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  assert.equal(movimientos(db).filter(m => m.tipo === 'canje').length, 3);
  // el historial lo cuenta: un regalo de 300 con sus 3 materiales
  const h = await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'));
  const fila = h.body.regalos.find(x => x.uid === 'sinplan');
  assert.deepEqual([fila.cantidad, fila.estado, fila.materialesCanjeados, fila.materialesTotal], [300, 'canjeado', 3, 3]);
  assert.equal(fila.canjes.length, 3);
});

test('canjear: el costo lo fija el servidor; el navegador no puede mandar otro costo, otra cantidad ni otro saldo', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan', op(), 'token-admin', 300);
  const r = await request(app).post('/api/creditos/canjear').set(auth('token-sinplan')).send({ materialId: 'pdf:plantilla-5', costo: 1, cantidad: 1, precio: 0, saldo: 99999, uid: 'ana' });
  assert.equal(r.status, 200);
  assert.equal(r.body.saldo, 200, 'se descontaron exactamente 100');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 200);
  assert.equal(db.value('creditosCuentas/ana'), undefined);
  const canje = movimientos(db).find(m => m.tipo === 'canje');
  assert.equal(canje.cantidad, 100);
});

test('canjear: con menos de 100 créditos no se puede (402), aunque se haya regalado 1, 50 o 99', async () => {
  const { app, db } = servidor();
  for (const c of [1, 50, 99]) {
    const { app: a2, db: d2 } = servidor();
    assert.equal((await regalar(a2, 'sinplan', op(), 'token-admin', c)).status, 200);
    const r = await canjear(a2, 'pdf:plantilla-5', 'token-sinplan');
    assert.equal(r.status, 402, String(c));
    assert.equal(d2.value('creditosCuentas/sinplan').saldo, c);
  }
  // 50 + 50 sí alcanzan juntos
  await regalar(app, 'sinplan', op(), 'token-admin', 50); await regalar(app, 'sinplan', op(), 'token-admin', 50);
  assert.equal((await canjear(app, 'pdf:plantilla-5', 'token-sinplan')).status, 200);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
});

test('regalar 250: alcanza para 2 materiales y sobran 50 de saldo', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan', op(), 'token-admin', 250);
  assert.equal((await canjear(app, 'pdf:plantilla-5', 'token-sinplan')).body.saldo, 150);
  assert.equal((await canjear(app, 'pdf:guia-miembros', 'token-sinplan')).body.saldo, 50);
  assert.equal((await canjear(app, 'pdf:presentacion-30', 'token-sinplan')).status, 402);
  assert.equal((await estado(app, 'token-sinplan')).body.saldo, 50);
  const h = (await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'))).body.regalos[0];
  assert.deepEqual([h.estado, h.materialesCanjeados, h.materialesTotal, h.sobrante], ['canjeado', 2, 2, 50]);
});

test('aviso: varios regalos antes de verlo suman en una sola felicitación; se ve una vez y no cambia el saldo', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan', op(), 'token-admin', 200); await regalar(app, 'sinplan', op(), 'token-admin', 100);
  assert.equal((await estado(app, 'token-sinplan')).body.avisoPendiente, 300);
  await request(app).post('/api/creditos/aviso-visto').set(auth('token-sinplan')).send({});
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.avisoPendiente, 0); assert.equal(e.body.saldo, 300);
});

test('admin: la lista de miembros muestra el saldo exacto y el historial filtra Pendientes (incluye los parciales) y Canjeados', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan', op(), 'token-admin', 300); await regalar(app, 'otra', op(), 'token-admin', 100);
  await canjear(app, 'pdf:plantilla-5', 'token-sinplan'); await canjear(app, 'pdf:plantilla-5', 'token-otra');
  const m = await request(app).get('/api/admin/creditos/miembros').set(auth('token-admin'));
  assert.equal(m.body.miembros.find(x => x.uid === 'sinplan').saldo, 200);
  assert.equal(m.body.miembros.find(x => x.uid === 'otra').saldo, 0);
  const pend = await request(app).get('/api/admin/creditos/historial?estado=pendientes').set(auth('token-admin'));
  assert.equal(pend.body.total, 1); assert.equal(pend.body.regalos[0].estado, 'parcial');
  assert.equal((await request(app).get('/api/admin/creditos/historial?estado=canjeados').set(auth('token-admin'))).body.total, 1);
  assert.deepEqual((await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'))).body.totales, { todos: 2, pendientes: 1, canjeados: 1 });
  const met = await request(app).get('/api/admin/creditos/metricas').set(auth('token-admin'));
  assert.equal(met.body.regalados, 400); assert.equal(met.body.canjeados, 200); assert.equal(met.body.pendientes, 200);
});

test('la bitácora del administrador anota la cantidad real regalada', async () => {
  const { app, db } = servidor();
  await regalar(app, 'ana', op(), 'token-admin', 400);
  const acciones = [...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).map(k => db.value(k)).filter(a => a.accion === 'creditos-regalar');
  assert.equal(acciones.length, 1);
  assert.match(acciones[0].resumen, /Regaló 400 créditos a/);
});
