'use strict';

// LIBROS y créditos: cada cuenta puede canjear con créditos A LO MÁS UN libro en toda su vida (lo escoge entre todos los del catálogo real).
// Los libros que abre por retos (5/15/30) o por membresía no cuentan; los demás materiales (PDF, Excel, PowerPoint) no tienen límite.
// Ejecutar: node --test test/creditos-un-libro.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias } = require('./helpers/club');
const creditos = require('../services/creditos');

const tokens = tokensDe('ana', 'sinplan', 'otra', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const conSaldo = (uid, saldo) => ({ [`creditosCuentas/${uid}`]: { uid, saldo, regalados: saldo, canjeados: 0, avisoPendiente: 0 } });
const LIBROS = ['libro:ley-fauna-mx', 'libro:bienestar-cautiverio', 'libro:conservacion-mx'];

function servidor(seed = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: {}, tokens,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, sinplan: { emailVerified: true, email: 'sinplan@example.com' }, otra: { emailVerified: true, email: 'otra@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com' }),
        'miembros/sinplan': miembroSinPlan({ name: 'Sin Plan', email: 'sinplan@example.com' }),
        'miembros/otra': miembroSinPlan({ name: 'Otra Persona', email: 'otra@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const estado = (app, t = 'token-sinplan') => request(app).get('/api/creditos/estado').set(auth(t));
const canjear = (app, materialId, t = 'token-sinplan') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const libro = (app, id, t = 'token-sinplan') => request(app).get(`/api/libros/${id}`).set(auth(t));
const bajar = (app, id, t = 'token-sinplan') => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t)).buffer(true).parse((res, cb) => { const x = []; res.on('data', c => x.push(c)); res.on('end', () => cb(null, Buffer.concat(x))); });
const movimientos = db => [...db._data.keys()].filter(k => k.startsWith('creditosMovimientos/')).map(k => db.value(k));
const desbloqueos = db => [...db._data.keys()].filter(k => k.startsWith('creditosDesbloqueos/')).map(k => db.value(k));

test('constante: un libro por cuenta con créditos', () => {
  assert.equal(creditos.MAX_LIBROS_POR_CREDITOS, 1);
  assert.equal(creditos.libroCanjeadoDe({ libroCanjeado: 'libro:a' }, new Set()), 'libro:a');
  assert.equal(creditos.libroCanjeadoDe({}, new Set(['pdf:x', 'libro:b'])), 'libro:b', 'cuentas anteriores: sale de los desbloqueos');
  assert.equal(creditos.libroCanjeadoDe({}, new Set(['pdf:x'])), '');
  assert.equal(creditos.libroCanjeadoDe(null, null), '');
});

test('canjear un libro: cuesta 100, se abre ese libro y SOLO ese; el segundo libro se rechaza (409 ya-canjeo-libro) sin cobrar', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 300));
  for (const l of LIBROS) assert.equal((await libro(app, l.slice(6))).status, 403, l + ' cerrado al inicio');
  const a = await canjear(app, 'libro:bienestar-cautiverio');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.saldo, 200);
  assert.equal((await libro(app, 'bienestar-cautiverio')).status, 200);
  for (const otro of ['libro:ley-fauna-mx', 'libro:conservacion-mx']) {
    const r = await canjear(app, otro);
    assert.equal(r.status, 409, otro);
    assert.equal(r.body.codigo, 'ya-canjeo-libro');
    assert.match(r.body.error, /UN libro/);
  }
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 200, 'no se cobró');
  assert.equal((await libro(app, 'ley-fauna-mx')).status, 403, 'el otro libro sigue cerrado');
  assert.equal(movimientos(db).filter(m => m.tipo === 'canje').length, 1);
  assert.equal(desbloqueos(db).filter(d => d.tipo === 'libro').length, 1);
});

test('el mismo libro dos veces: 409 ya-desbloqueado y no se cobra dos veces', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 300));
  assert.equal((await canjear(app, 'libro:ley-fauna-mx')).status, 200);
  const r = await canjear(app, 'libro:ley-fauna-mx');
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'ya-desbloqueado');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 200);
});

test('los demás materiales no tienen límite: tras el libro se canjean un Excel, un PowerPoint y varios PDF mientras alcancen los créditos', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 600));
  assert.equal((await canjear(app, 'libro:conservacion-mx')).status, 200);
  for (const id of ['inventario-botiquin-caducidad', 'ppt-bioseguridad-recintos', 'intro-nom-059', 'checklist-bioseguridad', 'glosario-vida-silvestre']) {
    const r = await canjear(app, 'pdf:' + id);
    assert.equal(r.status, 200, id);
  }
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  assert.equal((await bajar(app, 'inventario-botiquin-caducidad')).status, 200);
  assert.equal((await bajar(app, 'ppt-bioseguridad-recintos')).status, 200);
  assert.equal(movimientos(db).filter(m => m.tipo === 'canje').length, 6);
});

test('concurrencia: dos canjes de libros DISTINTOS a la vez: solo uno gana, el otro recibe 409 y el saldo baja solo 100', async () => {
  for (let ronda = 0; ronda < 6; ronda++) {
    const { app, db } = servidor(conSaldo('sinplan', 200));
    const orden = ronda % 2 ? ['libro:ley-fauna-mx', 'libro:conservacion-mx'] : ['libro:conservacion-mx', 'libro:ley-fauna-mx'];
    const [a, b] = await Promise.all(orden.map(c => canjear(app, c)));
    const estados = [a.status, b.status].sort();
    assert.deepEqual(estados, [200, 409], 'ronda ' + ronda + ': ' + JSON.stringify([a.body, b.body]));
    const perdedor = a.status === 409 ? a : b;
    assert.equal(perdedor.body.codigo, 'ya-canjeo-libro');
    assert.equal(db.value('creditosCuentas/sinplan').saldo, 100, 'el saldo solo bajó 100');
    assert.equal(desbloqueos(db).filter(d => d.tipo === 'libro').length, 1);
    assert.equal(movimientos(db).filter(m => m.tipo === 'canje').length, 1);
  }
});

test('concurrencia: tres libros a la vez con saldo de sobra: solo uno se canjea', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 500));
  const r = await Promise.all(LIBROS.map(c => canjear(app, c)));
  assert.equal(r.filter(x => x.status === 200).length, 1, JSON.stringify(r.map(x => x.body)));
  assert.equal(r.filter(x => x.status === 409 && x.body.codigo === 'ya-canjeo-libro').length, 2);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 400);
});

test('concurrencia: un libro y un Excel a la vez (con saldo para ambos): los dos se canjean', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 200));
  const [a, b] = await Promise.all([canjear(app, 'libro:ley-fauna-mx'), canjear(app, 'pdf:peso-curva-crecimiento')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
});

test('un libro que ya abre por retos NO cuenta: sigue pudiendo canjear otro con créditos, y el que ya abre no se ofrece ni se cobra', async () => {
  const { app, db } = servidor({ ...retosDe('ana', 20), ...conSaldo('ana', 300) });   // 20 retos abren los de 5 y 15
  const e = await estado(app, 'token-ana');
  assert.equal(e.body.librosCanjeadosConCreditos, 0);
  const por = Object.fromEntries(e.body.libros.map(l => [l.id, l]));
  assert.deepEqual([por['ley-fauna-mx'].canjeable, por['ley-fauna-mx'].motivo], [false, 'ya-accesible']);
  assert.deepEqual([por['bienestar-cautiverio'].canjeable, por['bienestar-cautiverio'].motivo], [false, 'ya-accesible']);
  assert.deepEqual([por['conservacion-mx'].canjeable, por['conservacion-mx'].motivo], [true, null]);
  const claves = e.body.materiales.map(m => m.clave);
  assert.ok(!claves.includes('libro:ley-fauna-mx') && !claves.includes('libro:bienestar-cautiverio'), 'los que ya abre no se ofrecen en la lista de canjeables');
  const yaAbre = await canjear(app, 'libro:ley-fauna-mx', 'token-ana');
  assert.equal(yaAbre.status, 409); assert.equal(yaAbre.body.codigo, 'ya-accesible');
  assert.equal(db.value('creditosCuentas/ana').saldo, 300);
  const ok = await canjear(app, 'libro:conservacion-mx', 'token-ana');
  assert.equal(ok.status, 200); assert.equal(ok.body.saldo, 200);
  // ya canjeó su libro: no puede otro con créditos, pero los de retos siguen abiertos
  assert.equal((await libro(app, 'ley-fauna-mx', 'token-ana')).status, 200);
  assert.equal((await libro(app, 'bienestar-cautiverio', 'token-ana')).status, 200);
  assert.equal((await libro(app, 'conservacion-mx', 'token-ana')).status, 200);
});

test('después de canjear un libro, los demás siguen abriéndose por retos como siempre (a los 15 retos, el de 15)', async () => {
  const { app } = servidor({ ...retosDe('sinplan', 99), ...conSaldo('sinplan', 100) });   // sin membresía: los retos no abren nada
  assert.equal((await canjear(app, 'libro:ley-fauna-mx')).status, 200);
  assert.equal((await libro(app, 'bienestar-cautiverio')).status, 403, 'sin membresía los retos no abren');
  const { app: a2 } = servidor({ ...retosDe('ana', 14), ...conSaldo('ana', 100) });
  assert.equal((await canjear(a2, 'libro:conservacion-mx', 'token-ana')).status, 200);
  assert.equal((await libro(a2, 'bienestar-cautiverio', 'token-ana')).status, 403, 'con 14 retos aún no abre el de 15');
  const r = await request(a2).post('/api/retos/camino').set(auth('token-ana')).send({ modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(r.body.aceptado, true);
  assert.equal((await libro(a2, 'bienestar-cautiverio', 'token-ana')).status, 200, 'con 15 retos se abre por retos');
});

test('sin saldo no canjea un libro (402) y no queda marcado como canjeado', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 50));
  const r = await canjear(app, 'libro:ley-fauna-mx');
  assert.equal(r.status, 402); assert.equal(r.body.codigo, 'saldo-insuficiente');
  const e = await estado(app);
  assert.equal(e.body.librosCanjeadosConCreditos, 0);
  assert.ok(e.body.libros.every(l => !l.canjeable && l.motivo === 'saldo-insuficiente'));
  assert.equal(db.value('creditosCuentas/sinplan').libroCanjeado, undefined);
  const { app: sin } = servidor();
  assert.equal((await canjear(sin, 'libro:ley-fauna-mx')).status, 402, 'sin cuenta de créditos');
});

test('estado: por libro canjeable y motivo; de la cuenta, librosCanjeadosConCreditos (0 o 1) y el id del libro', async () => {
  const { app } = servidor(conSaldo('sinplan', 200));
  let e = await estado(app);
  assert.equal(e.body.librosCanjeadosConCreditos, 0); assert.equal(e.body.libroCanjeadoId, null); assert.equal(e.body.maxLibrosPorCreditos, 1);
  assert.equal(e.body.libros.length, 3);
  assert.ok(e.body.libros.every(l => l.canjeable === true && l.motivo === null && l.desbloqueado === false));
  assert.ok(e.body.materiales.filter(m => m.tipo === 'libro').every(m => m.canjeable === true && m.motivo === null));
  await canjear(app, 'libro:bienestar-cautiverio');
  e = await estado(app);
  assert.equal(e.body.librosCanjeadosConCreditos, 1); assert.equal(e.body.libroCanjeadoId, 'bienestar-cautiverio');
  const por = Object.fromEntries(e.body.libros.map(l => [l.id, l]));
  assert.deepEqual([por['bienestar-cautiverio'].canjeable, por['bienestar-cautiverio'].desbloqueado, por['bienestar-cautiverio'].motivo], [false, true, 'ya-canjeado']);
  assert.deepEqual([por['ley-fauna-mx'].canjeable, por['ley-fauna-mx'].motivo], [false, 'ya-canjeo-libro']);
  assert.deepEqual([por['conservacion-mx'].canjeable, por['conservacion-mx'].motivo], [false, 'ya-canjeo-libro']);
  // los demás materiales conservan su estado: siguen canjeables (el límite es solo de libros)
  const pdf = e.body.materiales.find(m => m.clave === 'pdf:peso-curva-crecimiento');
  assert.equal(pdf.desbloqueado, false); assert.equal(pdf.canjeable, undefined);
  assert.equal((await request(app).get('/api/creditos/estado')).status, 401);
});

test('cuentas anteriores a la regla (su libro solo consta en los desbloqueos) tampoco pueden canjear otro', async () => {
  const { app, db } = servidor({ ...conSaldo('sinplan', 300),
    'creditosDesbloqueos/sinplan__libro__ley-fauna-mx': { uid: 'sinplan', clave: 'libro:ley-fauna-mx', tipo: 'libro', materialId: 'ley-fauna-mx', titulo: 'Fauna silvestre y ley' } });
  const e = await estado(app);
  assert.equal(e.body.librosCanjeadosConCreditos, 1); assert.equal(e.body.libroCanjeadoId, 'ley-fauna-mx');
  const r = await canjear(app, 'libro:conservacion-mx');
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'ya-canjeo-libro');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 300);
  assert.equal((await canjear(app, 'pdf:peso-curva-crecimiento')).status, 200);
});

test('un regalo posterior no borra el libro canjeado (el límite sigue)', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 100));
  assert.equal((await canjear(app, 'libro:ley-fauna-mx')).status, 200);
  const g = await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'sinplan', clave: 'operacion-libro-01', cantidad: 300 });
  assert.equal(g.status, 200);
  assert.equal(db.value('creditosCuentas/sinplan').libroCanjeado, 'libro:ley-fauna-mx');
  const r = await canjear(app, 'libro:conservacion-mx');
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'ya-canjeo-libro');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 300);
});

test('el límite es por cuenta: otra cuenta canjea su propio libro', async () => {
  const { app } = servidor({ ...conSaldo('sinplan', 100), ...conSaldo('otra', 100) });
  assert.equal((await canjear(app, 'libro:ley-fauna-mx', 'token-sinplan')).status, 200);
  assert.equal((await canjear(app, 'libro:conservacion-mx', 'token-otra')).status, 200);
  assert.equal((await canjear(app, 'libro:ley-fauna-mx', 'token-otra')).status, 409, 'otra ya canjeó el suyo');
});

test('historial del administrador: el canje de un libro queda marcado como libro', async () => {
  const { app } = servidor();
  await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'sinplan', clave: 'operacion-libro-02', cantidad: 200 });
  await canjear(app, 'libro:ley-fauna-mx'); await canjear(app, 'pdf:peso-curva-crecimiento');
  const h = await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'));
  const canjes = h.body.regalos.flatMap(r => r.canjes);
  assert.ok(canjes.find(c => c.materialId === 'libro:ley-fauna-mx').esLibro === true);
  assert.ok(canjes.find(c => c.materialId === 'pdf:peso-curva-crecimiento').esLibro === false);
});

test('la lógica del límite vive en la transacción del servidor (no en el navegador)', () => {
  const fs = require('fs'); const path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'services', 'creditos.js'), 'utf8');
  const i = js.indexOf('async function canjear');
  const bloque = js.slice(i, js.indexOf('async function marcarAvisoVisto'));
  assert.match(bloque, /db\.runTransaction/);
  assert.ok(bloque.indexOf("'ya-canjeo-libro'") > bloque.indexOf('db.runTransaction'), 'el rechazo está DENTRO de la transacción');
  assert.ok(bloque.indexOf("'ya-canjeo-libro'") < bloque.indexOf("'saldo-insuficiente'"), 'se rechaza antes de pedir saldo y sin cobrar');
});
