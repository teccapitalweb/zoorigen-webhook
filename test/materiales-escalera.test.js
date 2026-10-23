'use strict';

// ESCALERA DE RETOS con el catálogo REAL (data/materiales y data/libros): los 20 materiales nuevos se abren con 3, 6, 9... 60 retos
// (solo miembros con membresía vigente) o canjeándolos con 100 créditos; los antiguos conservan sus reglas y además se canjean.
// Retos y créditos son vías independientes: cualquiera que se cumpla abre el material, y si ya abre por una no se ofrece ni se cobra la otra.
// Ejecutar: node --test test/materiales-escalera.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias } = require('./helpers/club');
const { ESCALERA, ORDEN, PASO, TOTAL_RETOS_ALCANZABLES } = require('../tools/materiales/generador-office/escalera');
const creditos = require('../services/creditos');
const retosServicio = require('../services/retos');

const CATALOGO = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'materiales', 'catalogo.json'), 'utf8'));
const NUEVOS = CATALOGO.filter(m => ESCALERA[m.id]);
const ANTIGUOS = CATALOGO.filter(m => !ESCALERA[m.id]);
const tokens = tokensDe('ana', 'sinplan', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const conSaldo = (uid, saldo) => ({ [`creditosCuentas/${uid}`]: { uid, saldo, regalados: saldo, canjeados: 0, avisoPendiente: 0 } });

function servidor(seed = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: {}, tokens,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, sinplan: { emailVerified: true, email: 'sinplan@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
        'miembros/sinplan': miembroSinPlan({ name: 'Sin Plan' }),
        'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
        'miembros/admin': miembroSinPlan({ role: 'admin' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const bajar = (app, id, t = 'token-ana') => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t))
  .buffer(true).parse((res, cb) => { const trozos = []; res.on('data', c => trozos.push(c)); res.on('end', () => cb(null, Buffer.concat(trozos))); });
const cuerpo = r => JSON.parse(r.body.toString('utf8'));
const lista = (app, t = 'token-ana') => request(app).get('/api/materiales').set(auth(t));
const estado = (app, t = 'token-ana') => request(app).get('/api/creditos/estado').set(auth(t));
const canjear = (app, materialId, t = 'token-ana') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const camino = (app, cuerpoReto, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(cuerpoReto);

/* ───────────────────────── La escalera en el catálogo ───────────────────────── */

test('escalera: los 20 materiales nuevos piden 3, 6, 9 ... 60 retos, todos por retos y sin repetir umbral', () => {
  assert.equal(NUEVOS.length, 20);
  assert.equal(ORDEN.length, 20);
  assert.equal(PASO, 3);
  const umbrales = NUEVOS.map(m => m.requiereRetos).sort((a, b) => a - b);
  assert.deepEqual(umbrales, Array.from({ length: 20 }, (_, i) => (i + 1) * 3));
  for (const m of NUEVOS) {
    assert.equal(m.acceso, 'retos', m.id);
    assert.equal(m.requiereRetos, ESCALERA[m.id], m.id);
    assert.notEqual(m.acceso, 'curso', m.id + ' no va ligado a un curso');
  }
  assert.deepEqual(ORDEN.map(id => CATALOGO.find(m => m.id === id).requiereRetos), umbrales, 'el orden pensado coincide con el catálogo');
});

test('escalera: lo más básico abre primero y lo legal y más completo al final', () => {
  const por = Object.fromEntries(NUEVOS.map(m => [m.id, m.requiereRetos]));
  assert.equal(por['carteles-visitantes-senales'], 3);
  assert.equal(por['etograma-hoja-observacion'], 6);
  assert.equal(por['plantilla-plan-manejo-uma'], 57);
  assert.equal(por['ppt-uma-pimvs-zoologicos'], 60);
  assert.ok(por['inventario-botiquin-caducidad'] < por['cuarentena-recepcion-ejemplares'], 'los registros sencillos antes que la cuarentena');
  assert.ok(por['cuarentena-recepcion-ejemplares'] < por['ppt-bioseguridad-recintos'], 'los formatos antes que las presentaciones');
  for (const id of ['plantilla-plan-manejo-uma', 'ppt-uma-pimvs-zoologicos']) assert.ok(por[id] > por['ppt-observacion-conductual-etogramas'] - 1, id + ' al final');
});

test('escalera: TODOS son alcanzables con holgura (el último pide menos del 90 % de los retos que se pueden superar)', () => {
  // 116 = 32 quiz + 60 detective + 24 ordena (retos distintos del camino); la práctica diaria suma más
  const camino = retosServicio.TOTALES_CAMINO;
  assert.equal(camino.quiz + camino.detective + camino.orden, TOTAL_RETOS_ALCANZABLES);
  assert.ok(Math.max(...NUEVOS.map(m => m.requiereRetos)) <= Math.floor(TOTAL_RETOS_ALCANZABLES * 0.9), 'último umbral <= 90 % del total');
  assert.ok(Math.max(...NUEVOS.map(m => m.requiereRetos)) < TOTAL_RETOS_ALCANZABLES);
});

test('los antiguos conservan EXACTAMENTE sus reglas: 6 por membresía y presentaciones con 3, 10 y 20 retos; libros con 5, 15 y 30', () => {
  assert.equal(ANTIGUOS.length, 9);
  const por = Object.fromEntries(ANTIGUOS.map(m => [m.id, [m.acceso, m.requiereRetos || 0]]));
  assert.deepEqual(por, {
    'checklist-bioseguridad': ['miembros', 0], 'ficha-registro-ejemplar': ['miembros', 0], 'fauna-herida': ['miembros', 0], 'calendario-colmenas': ['miembros', 0],
    'glosario-vida-silvestre': ['miembros', 0], 'marco-normativo-uno': ['miembros', 0],
    'intro-nom-059': ['retos', 3], 'bienestar-cinco-dominios': ['retos', 10], 'polinizadores-abejas': ['retos', 20]
  });
  const libros = ['ley-fauna-mx', 'bienestar-cautiverio', 'conservacion-mx'].map(id => [id, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'libros', id + '.json'), 'utf8')).requiereRetos]);
  assert.deepEqual(libros, [['ley-fauna-mx', 5], ['bienestar-cautiverio', 15], ['conservacion-mx', 30]]);
});

/* ───────────────────────── Acceso por retos (servidor) ───────────────────────── */

test('límites: con n - 1 retos NO abre (403, faltan 1) y con n SÍ abre, para cada uno de los 20 materiales', async () => {
  for (const m of NUEVOS) {
    const n = m.requiereRetos;
    const { app: justo } = servidor(retosDe('ana', n));
    const ok = await bajar(justo, m.id);
    assert.equal(ok.status, 200, `${m.id} con ${n}`);
    const { app: falta } = servidor(retosDe('ana', n - 1));
    const no = await bajar(falta, m.id);
    assert.equal(no.status, 403, `${m.id} con ${n - 1}`);
    const c = cuerpo(no);
    assert.equal(c.codigo, 'retos-insuficientes');
    assert.deepEqual([c.requiere, c.superados, c.faltan], [n, n - 1, 1], m.id);
    assert.equal(String(no.headers['content-type']).includes('openxml') || String(no.headers['content-type']).includes('pdf'), false, 'el rechazo no entrega ni el tipo del archivo');
  }
});

test('la lista dice cuántos retos faltan por material y cuáles ya están desbloqueados (10 retos)', async () => {
  const { app } = servidor(retosDe('ana', 10));
  const r = await lista(app);
  const por = Object.fromEntries(r.body.materiales.map(m => [m.id, m]));
  for (const m of NUEVOS) {
    const x = por[m.id];
    assert.equal(x.desbloqueado, m.requiereRetos <= 10, m.id);
    assert.equal(x.faltan, Math.max(0, m.requiereRetos - 10), m.id);
    assert.equal(x.requiereRetos, m.requiereRetos);
    assert.equal(x.soloMiembros, false);
  }
  assert.equal(por['carteles-visitantes-senales'].desbloqueado, true);
  assert.equal(por['plantilla-plan-manejo-uma'].faltan, 47);
  assert.equal(por['ppt-uma-pimvs-zoologicos'].faltan, 50);
});

test('un miembro con muchos retos (60) abre los 20; el administrador abre todo con 0 retos', async () => {
  const { app } = servidor(retosDe('ana', 60));
  const r = await lista(app);
  assert.equal(r.body.materiales.filter(m => ESCALERA[m.id]).every(m => m.desbloqueado && m.faltan === 0), true);
  for (const id of ['ppt-uma-pimvs-zoologicos', 'plantilla-plan-manejo-uma']) assert.equal((await bajar(app, id)).status, 200, id);
  const { app: a2 } = servidor();
  assert.equal((await bajar(a2, 'ppt-uma-pimvs-zoologicos', 'token-admin')).status, 200);
});

test('sin membresía los retos NO abren nada, ni con 99 retos (membresía vencida o nunca tuvo); solo los créditos', async () => {
  const { app } = servidor({ ...retosDe('sinplan', 99), ...retosDe('vencida', 99) });
  for (const m of NUEVOS) {
    for (const t of ['token-sinplan', 'token-vencida']) {
      const r = await bajar(app, m.id, t);
      assert.equal(r.status, 403, `${m.id} ${t}`);
      assert.equal(cuerpo(r).codigo, 'membresia-requerida');
    }
  }
  const l = await lista(app, 'token-sinplan');
  assert.ok(l.body.materiales.every(m => !m.desbloqueado && m.soloMiembros === true));
  assert.equal(l.body.superados, 0, 'sin membresía no se cuentan retos');
});

test('concurrencia: 8 descargas a la vez justo en el límite abren todas; a un reto del límite, ninguna', async () => {
  const id = 'cuarentena-recepcion-ejemplares';
  const n = ESCALERA[id];
  const { app: justo } = servidor(retosDe('ana', n));
  const a = await Promise.all(Array.from({ length: 8 }, () => bajar(justo, id)));
  assert.deepEqual(a.map(r => r.status), Array(8).fill(200));
  const { app: falta } = servidor(retosDe('ana', n - 1));
  const b = await Promise.all(Array.from({ length: 8 }, () => bajar(falta, id)));
  assert.deepEqual(b.map(r => r.status), Array(8).fill(403));
});

test('al superar el reto que cruza el umbral, el material se abre sin más pasos; dos retos a la vez suman dos', async () => {
  const id = 'inventario-botiquin-caducidad';   // 9 retos
  const { app, db } = servidor(retosDe('ana', 7));
  assert.equal((await bajar(app, id)).status, 403);
  const [r1, r2] = await Promise.all([
    camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 }),
    camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 })
  ]);
  assert.equal(r1.body.aceptado, true); assert.equal(r2.body.aceptado, true);
  assert.equal(db.value('retosUsuario/ana').superados, 9, 'la transacción suma los dos');
  assert.equal((await bajar(app, id)).status, 200);
  const l = await lista(app);
  assert.equal(l.body.materiales.find(m => m.id === id).faltan, 0);
});

test('el navegador no puede abrir un material con otra cifra: lo que cuenta es lo guardado en el servidor', async () => {
  const { app } = servidor(retosDe('ana', 8));
  const r = await request(app).get('/api/materiales/inventario-botiquin-caducidad/archivo?superados=99&retos=99').set(auth('token-ana'))
    .set('X-Retos', '99').set('X-Superados', '99');
  assert.equal(r.status, 403);
});

/* ───────────────────────── Créditos: vía independiente ───────────────────────── */

test('créditos: una cuenta SIN membresía y con 300 créditos canjea 3 de los nuevos (aunque pidan 60 retos) y solo se abren esos', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 300));
  const e = await estado(app, 'token-sinplan');
  const claves = e.body.materiales.map(m => m.clave);
  for (const m of NUEVOS) assert.ok(claves.includes('pdf:' + m.id), m.id + ' se ofrece para canjear');
  for (const id of ['ppt-uma-pimvs-zoologicos', 'plantilla-plan-manejo-uma', 'carteles-visitantes-senales']) {
    const r = await canjear(app, 'pdf:' + id, 'token-sinplan');
    assert.equal(r.status, 200, id);
  }
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  for (const id of ['ppt-uma-pimvs-zoologicos', 'plantilla-plan-manejo-uma', 'carteles-visitantes-senales']) assert.equal((await bajar(app, id, 'token-sinplan')).status, 200, id);
  assert.equal((await bajar(app, 'ppt-bioseguridad-recintos', 'token-sinplan')).status, 403, 'lo no canjeado sigue cerrado');
});

test('créditos: el desbloqueo es permanente (aunque la persona nunca tenga membresía ni retos) y no depende del saldo', async () => {
  const { app } = servidor(conSaldo('sinplan', 100));
  assert.equal((await canjear(app, 'pdf:peso-curva-crecimiento', 'token-sinplan')).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await bajar(app, 'peso-curva-crecimiento', 'token-sinplan')).status, 200);
  const l = await lista(app, 'token-sinplan');
  const m = l.body.materiales.find(x => x.id === 'peso-curva-crecimiento');
  assert.equal(m.desbloqueado, true); assert.equal(m.porCreditos, true);
  assert.equal((await canjear(app, 'pdf:peso-curva-crecimiento', 'token-sinplan')).status, 409, 'no se cobra dos veces');
});

test('créditos: un miembro con pocos retos puede canjear lo que todavía no abre por retos; si ya lo abre por retos, no se le ofrece ni se le cobra', async () => {
  const { app, db } = servidor({ ...retosDe('ana', 20), ...conSaldo('ana', 200) });
  const e = await estado(app);
  const claves = e.body.materiales.map(m => m.clave);
  assert.ok(!claves.includes('pdf:carteles-visitantes-senales'), 'abre con 3 retos: no se ofrece');
  assert.ok(!claves.includes('pdf:control-alimentacion-recintos'), 'abre con 18: no se ofrece');
  assert.ok(claves.includes('pdf:bitacora-enriquecimiento-semanal'), 'pide 21 (tiene 20): sí se ofrece');
  assert.ok(claves.includes('pdf:ppt-uma-pimvs-zoologicos'));
  const yaAbre = await canjear(app, 'pdf:control-alimentacion-recintos');
  assert.equal(yaAbre.status, 409); assert.equal(yaAbre.body.codigo, 'ya-accesible');
  assert.equal(db.value('creditosCuentas/ana').saldo, 200, 'no se cobró');
  const falta = await canjear(app, 'pdf:bitacora-enriquecimiento-semanal');
  assert.equal(falta.status, 200); assert.equal(falta.body.saldo, 100);
  assert.equal((await bajar(app, 'bitacora-enriquecimiento-semanal')).status, 200);
});

test('créditos y retos son independientes: con créditos canjeados y luego retos suficientes, sigue abierto por ambas vías', async () => {
  const { app } = servidor({ ...retosDe('ana', 20), ...conSaldo('ana', 100) });
  assert.equal((await canjear(app, 'pdf:bitacora-enriquecimiento-semanal')).status, 200);
  assert.equal((await bajar(app, 'bitacora-enriquecimiento-semanal')).status, 200);
  const r = await camino(app, { modo: 'quiz', indice: 5, puntaje: 5, total: 5 });
  assert.equal(r.body.aceptado, true);   // ya tiene 21 retos: también abre por retos
  assert.equal((await bajar(app, 'bitacora-enriquecimiento-semanal')).status, 200);
});

/* ───────────────────────── Los antiguos: retos y créditos como siempre ───────────────────────── */

test('antiguos: por retos funcionan como antes (3, 10 y 20) y por membresía los otros 6', async () => {
  const { app: con9 } = servidor(retosDe('ana', 9));
  assert.equal((await bajar(con9, 'intro-nom-059')).status, 200);
  assert.equal((await bajar(con9, 'bienestar-cinco-dominios')).status, 403);
  const { app: con10 } = servidor(retosDe('ana', 10));
  assert.equal((await bajar(con10, 'bienestar-cinco-dominios')).status, 200);
  assert.equal((await bajar(con10, 'polinizadores-abejas')).status, 403);
  const { app: con20 } = servidor(retosDe('ana', 20));
  assert.equal((await bajar(con20, 'polinizadores-abejas')).status, 200);
  const { app: cero } = servidor();
  for (const id of ['checklist-bioseguridad', 'ficha-registro-ejemplar', 'fauna-herida', 'calendario-colmenas', 'glosario-vida-silvestre', 'marco-normativo-uno']) {
    assert.equal((await bajar(cero, id)).status, 200, id + ' con membresía y 0 retos');
  }
  assert.equal((await bajar(cero, 'intro-nom-059')).status, 403);
});

test('antiguos: sin membresía se canjean con créditos (los 9 y los 3 libros) y se abren solo esos', async () => {
  const { app, db } = servidor(conSaldo('sinplan', 1200));
  const e = await estado(app, 'token-sinplan');
  const claves = e.body.materiales.map(m => m.clave);
  for (const m of ANTIGUOS) assert.ok(claves.includes('pdf:' + m.id), m.id);
  for (const l of ['libro:ley-fauna-mx', 'libro:bienestar-cautiverio', 'libro:conservacion-mx']) assert.ok(claves.includes(l), l);
  for (const m of ANTIGUOS) {
    assert.equal((await bajar(app, m.id, 'token-sinplan')).status, 403, m.id + ' cerrado');
    assert.equal((await canjear(app, 'pdf:' + m.id, 'token-sinplan')).status, 200, m.id + ' canjeado');
    assert.equal((await bajar(app, m.id, 'token-sinplan')).status, 200, m.id + ' abierto');
  }
  assert.equal((await canjear(app, 'libro:conservacion-mx', 'token-sinplan')).status, 200);
  assert.equal((await request(app).get('/api/libros/conservacion-mx').set(auth('token-sinplan'))).status, 200);
  assert.equal((await request(app).get('/api/libros/ley-fauna-mx').set(auth('token-sinplan'))).status, 403, 'el libro no canjeado sigue cerrado');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 1200 - 100 * 10);
});

test('antiguos: si ya los abre por retos o por membresía, no se ofrecen para canjear ni se cobran; los que aún no abre, sí', async () => {
  const { app, db } = servidor({ ...retosDe('ana', 12), ...conSaldo('ana', 300) });
  const e = await estado(app);
  const claves = new Set(e.body.materiales.map(m => m.clave));
  for (const id of ['checklist-bioseguridad', 'fauna-herida', 'intro-nom-059', 'bienestar-cinco-dominios']) assert.ok(!claves.has('pdf:' + id), id + ' ya lo abre: no se ofrece');
  assert.ok(claves.has('pdf:polinizadores-abejas'), 'pide 20 (tiene 12): se ofrece');
  assert.ok(claves.has('libro:bienestar-cautiverio'), 'libro de 15 (tiene 12): se ofrece');
  assert.ok(!claves.has('libro:ley-fauna-mx'), 'libro de 5: ya lo abre');
  for (const id of ['checklist-bioseguridad', 'intro-nom-059']) {
    const r = await canjear(app, 'pdf:' + id);
    assert.equal(r.status, 409, id); assert.equal(r.body.codigo, 'ya-accesible');
  }
  assert.equal((await canjear(app, 'libro:ley-fauna-mx')).status, 409);
  assert.equal(db.value('creditosCuentas/ana').saldo, 300, 'nada se cobró');
  assert.equal((await canjear(app, 'pdf:polinizadores-abejas')).body.saldo, 200);
  assert.equal((await canjear(app, 'libro:bienestar-cautiverio')).body.saldo, 100);
});

test('constantes de créditos intactas: 100 por material, y un material de la escalera cuesta lo mismo que uno antiguo', () => {
  assert.equal(creditos.COSTO_MATERIAL, 100);
  const lista = creditos.catalogoCanjeable({ materiales: CATALOGO.map(m => ({ ...m })) });
  assert.equal(lista.length, 29);
  assert.ok(lista.every(x => x.tipo === 'pdf'));
});
