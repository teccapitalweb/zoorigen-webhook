'use strict';

// MATERIALES CONSERVADOS: lo que una persona ya había desbloqueado con retos (umbrales de ANTES de la escalera nueva) sigue desbloqueado;
// la escalera nueva solo cuenta para quien todavía no lo había desbloqueado. services/materiales-conservados.js + rutas de materiales, créditos y retos.
// Ejecutar: node --test test/materiales-conservados.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias } = require('./helpers/club');
const { FakeFirestore, FakeTimestamp } = require('./helpers/fake-firestore');
const C = require('../services/materiales-conservados');
const { UMBRALES_PREVIOS } = require('../services/materiales-umbrales-previos');
const retosServicio = require('../services/retos');

const CATALOGO = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'materiales', 'catalogo.json'), 'utf8'));
const NUEVO = Object.fromEntries(CATALOGO.map(m => [m.id, m.requiereRetos]));
const M12 = 'libro-entradas-salidas-insumos';      // antes 12 → ahora 13
const M18 = 'control-alimentacion-recintos';       // antes 18 → ahora 22
const M60 = 'ppt-uma-pimvs-zoologicos';            // antes 60 → ahora 120
const tokens = tokensDe('ana', 'beto', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const conservadosDe = (uid, ids) => ({ [`materialesConservados/${uid}`]: { ids, version: 1, creadoEn: new FakeTimestamp(Date.now() - 86400000) } });
const SIN_MIGRAR = { 'config/migraciones': {} };                       // la migración todavía no terminó (respaldo perezoso activo)
const MIGRADO = { 'config/migraciones': { materialesConservadosV1: true } };   // ya terminó (el mundo después del lanzamiento)

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
const lista = (app, t = 'token-ana') => request(app).get('/api/materiales').set(auth(t));
const abiertos = async (app, t) => new Set((await lista(app, t)).body.materiales.filter(m => m.desbloqueado).map(m => m.id));
const bajar = (app, id, t = 'token-ana') => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t)).buffer(true).parse((res, cb) => { const x = []; res.on('data', c => x.push(c)); res.on('end', () => cb(null, Buffer.concat(x))); });
const estadoCreditos = (app, t = 'token-ana') => request(app).get('/api/creditos/estado').set(auth(t));
const canjear = (app, materialId, t = 'token-ana') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const camino = (app, c, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(c);
const miembrosDe = db => JSON.stringify([...db._data.entries()].filter(([k]) => /^miembros\/[^/]+$/.test(k)).sort());

/* ───────── La tabla de umbrales anteriores ───────── */

test('tabla de umbrales anteriores: es lo publicado en origin/main, cubre los materiales de retos y los nuevos umbrales nunca bajan', () => {
  assert.equal(UMBRALES_PREVIOS[M12], 12);
  assert.equal(UMBRALES_PREVIOS[M18], 18);
  assert.equal(UMBRALES_PREVIOS[M60], 60);
  assert.equal(Object.keys(UMBRALES_PREVIOS).length, 23);
  for (const [id, previo] of Object.entries(UMBRALES_PREVIOS)) {
    assert.ok(id in NUEVO, id + ' sigue en el catálogo');
    assert.ok(NUEVO[id] >= previo, `${id}: el umbral nuevo (${NUEVO[id]}) nunca es menor que el anterior (${previo})`);
  }
  assert.throws(() => { UMBRALES_PREVIOS.otro = 1; }, /read only|not extensible|Cannot add/i, 'la tabla está congelada');
  assert.deepEqual(C.previosCumplidos(12).includes(M12), true);
  assert.deepEqual(C.previosCumplidos(11).includes(M12), false);
  assert.deepEqual(C.previosCumplidos(0), []);
  assert.deepEqual(C.previosCumplidos(-5), []);
  assert.deepEqual(C.previosCumplidos(2.5), []);
});

/* ───────── Reglas de acceso con lo conservado ───────── */

test('12 retos antes del lanzamiento: conserva «libro-entradas-salidas-insumos» (aunque ahora pide 13), se lista abierto y el archivo se puede bajar', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 12) });
  const r = await lista(app);
  const m = r.body.materiales.find(x => x.id === M12);
  assert.equal(NUEVO[M12], 13);
  assert.equal(m.desbloqueado, true);
  assert.equal(m.conservado, true);
  assert.equal(m.faltan, 0);
  assert.equal((await bajar(app, M12)).status, 200, 'la autorización real del archivo respeta lo conservado');
  assert.deepEqual(db.value('materialesConservados/ana').ids.includes(M12), true);
  assert.equal(db.value('materialesConservados/ana').version, 1);
  // y lo que no cumplía con los umbrales de antes sigue cerrado
  assert.equal(r.body.materiales.find(x => x.id === 'peso-curva-crecimiento').desbloqueado, false);
});

test('20 retos antes del lanzamiento: conserva «control-alimentacion-recintos» (antes 18, ahora 22) y lo que pedía 15 y 12', async () => {
  const { app } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 20) });
  const abre = await abiertos(app);
  assert.ok(abre.has(M18) && abre.has(M12) && abre.has('peso-curva-crecimiento'));
  assert.equal((await bajar(app, M18)).status, 200);
  assert.equal(abre.has('bitacora-enriquecimiento-semanal'), false, 'pedía 21: no lo tenía');
});

test('con 6, 8 o 9 retos no cambia nada: lo abierto es exactamente lo mismo con o sin lo conservado', async () => {
  for (const n of [6, 8, 9]) {
    const con = servidor({ ...SIN_MIGRAR, ...retosDe('ana', n) });
    const sin = servidor({ ...MIGRADO, ...retosDe('ana', n) });
    assert.deepEqual([...await abiertos(con.app)].sort(), [...await abiertos(sin.app)].sort(), `${n} retos`);
  }
});

test('quien llega a 13 DESPUÉS del lanzamiento (0 retos, sin documento) usa el umbral NUEVO: a 16 no se le regala lo que pedía 15', async () => {
  const { app, db } = servidor({ ...MIGRADO, ...retosDe('ana', 12) });
  let abre = await abiertos(app);
  assert.equal(abre.has(M12), false, '12 retos con el umbral nuevo (13) no abre');
  const { app: a16, db: db16 } = servidor({ ...MIGRADO, ...retosDe('ana', 16) });
  abre = await abiertos(a16);
  assert.equal(abre.has(M12), true, 'a 13 o más abre por su umbral nuevo');
  assert.equal(abre.has('peso-curva-crecimiento'), false, 'pedía 15 antes y 17 ahora: con 16 sigue cerrado');
  assert.equal(db16.value('materialesConservados/ana'), undefined, 'no se guarda nada para quien no tenía derecho previo');
  assert.equal(db.value('materialesConservados/ana'), undefined);
  // y subiendo un reto tras otro desde 0 tampoco se le regala nada
  const { app: a0, db: db0 } = servidor({ ...MIGRADO });
  assert.equal((await camino(a0, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 })).status, 200);
  assert.equal(db0.value('materialesConservados/ana'), undefined);
});

test('quien ya conservaba sigue viendo abierto aunque el umbral nuevo sea 120 (con 70 retos y membresía)', async () => {
  const { app } = servidor({ ...MIGRADO, ...retosDe('ana', 70), ...conservadosDe('ana', [M60]) });
  assert.equal(NUEVO[M60], 120);
  const abre = await abiertos(app);
  assert.ok(abre.has(M60));
  assert.equal((await bajar(app, M60)).status, 200);
  assert.equal(abre.has('ppt-bioseguridad-recintos'), false, 'solo lo conservado se abre');
});

test('lo canjeado con créditos sigue abierto y lo conservado ya no se ofrece ni se cobra (no se canjea dos veces)', async () => {
  const saldo = { 'creditosCuentas/ana': { uid: 'ana', saldo: 300, regalados: 300, canjeados: 0, avisoPendiente: 0 } };
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 20), ...saldo });
  const est = await estadoCreditos(app);
  const ofrecidos = est.body.materiales.map(m => m.id);
  assert.equal(ofrecidos.includes(M12) || ofrecidos.includes(M18), false, 'lo conservado no se ofrece para canjear');
  const rep = await canjear(app, 'pdf:' + M18);
  assert.equal(rep.status, 409);
  assert.equal(rep.body.codigo, 'ya-accesible');
  assert.equal(db.value('creditosCuentas/ana').saldo, 300, 'no se cobró');
  // lo que sí canjea con créditos (82 retos no los tiene) se abre y se conserva abierto junto con lo conservado
  const ok = await canjear(app, 'pdf:ppt-bioseguridad-recintos');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const abre = await abiertos(app);
  assert.ok(abre.has('ppt-bioseguridad-recintos') && abre.has(M18));
  assert.equal(db.value('creditosCuentas/ana').saldo, 200);
});

test('un miembro vencido mantiene la regla actual: sin membresía no abre nada por retos, ni lo conservado (el acceso exige membresía vigente)', async () => {
  const { app } = servidor({ ...MIGRADO, ...retosDe('vencida', 20), ...conservadosDe('vencida', [M12, M18]) });
  const r = await lista(app, 'token-vencida');
  assert.equal(r.body.materiales.find(m => m.id === M12).desbloqueado, false);
  const b = await bajar(app, M12, 'token-vencida');
  assert.equal(b.status, 403);
  // al renovar vuelve a verlo (lo guardado según retos no se perdió)
  const { app: a2 } = servidor({ ...MIGRADO, ...retosDe('ana', 5), ...conservadosDe('ana', [M12]) });
  assert.equal((await abiertos(a2)).has(M12), true);
});

test('el administrador abre todo y no se le guarda nada; quien no tiene membresía nunca recibe respaldo', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('admin', 50) });
  assert.equal((await abiertos(app, 'token-admin')).size, CATALOGO.length);
  assert.equal(db.value('materialesConservados/admin'), undefined);
  const v = servidor({ ...SIN_MIGRAR, ...retosDe('vencida', 20) });
  await lista(v.app, 'token-vencida');
  assert.equal(v.db.value('materialesConservados/vencida'), undefined);
});

/* ───────── Respaldo perezoso en el POST de retos ───────── */

test('POST de retos: el respaldo se calcula ANTES de sumar el reto (12 → 13 conserva lo de 12, no lo de 13) y en la misma transacción', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 12) });
  const r = await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.value('retosUsuario/ana').superados, 13);
  const cons = db.value('materialesConservados/ana');
  assert.ok(cons.ids.includes(M12));
  assert.equal(cons.ids.includes('peso-curva-crecimiento'), false);
  assert.equal(cons.origen, 'respaldo-reto');
  // un segundo reto no vuelve a tocar el documento (solo se agrega, y aquí no hay nada que agregar)
  const antes = JSON.stringify(cons);
  await camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 });
  assert.equal(JSON.stringify(db.value('materialesConservados/ana')), antes);
  assert.equal(db.value('retosUsuario/ana').superados, 14);
});

test('dos retos a la vez sin documento: queda UN solo respaldo con lo de antes (sin carreras)', async () => {
  const { app, db } = servidor({ ...SIN_MIGRAR, ...retosDe('ana', 17) });
  const rs = await Promise.all([camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 }), camino(app, { modo: 'quiz', indice: 1, puntaje: 5, total: 5 })]);
  assert.ok(rs.every(r => r.status === 200));
  const cons = db.value('materialesConservados/ana');
  assert.ok(cons.ids.includes('peso-curva-crecimiento'), 'a 17 ya cumplía lo de 15');
  assert.equal(cons.ids.includes('control-alimentacion-recintos'), false, 'lo de 18 no lo tenía antes de los retos nuevos');
});

test('con la migración terminada, el POST de retos no escribe documento de conservados', async () => {
  const { app, db } = servidor({ ...MIGRADO, ...retosDe('ana', 12) });
  await camino(app, { modo: 'quiz', indice: 0, puntaje: 5, total: 5 });
  assert.equal(db.value('materialesConservados/ana'), undefined);
});

/* ───────── Migración única ───────── */

function dbMigracion() {
  return new FakeFirestore({
    ...retosDe('a1', 12), ...retosDe('a2', 20), ...retosDe('a3', 60), ...retosDe('a4', 9), ...retosDe('a5', 2), ...retosDe('a6', 0), ...retosDe('a7', 8),
    ...retosDe('ya', 40), ...conservadosDe('ya', ['intro-nom-059']),
    'miembros/a1': miembroConPlan({ name: 'A1' }), 'miembros/a5': miembroSinPlan({ name: 'A5' })
  });
}
const admin = { firestore: { FieldValue: { serverTimestamp: () => new FakeTimestamp(Date.now()) }, FieldPath: { documentId: () => '__name__' } } };
const anotados = [];
const historialFalso = { anotar: async (...a) => { anotados.push(a); return 'x'; } };
const consola = { log() {}, error() {} };

test('migración: guarda por persona lo que cumplía con los umbrales de antes, solo si no está vacío, sin tocar a quien ya tenía documento ni escribir en miembros', async () => {
  const db = dbMigracion();
  const miembrosAntes = miembrosDe(db);
  const c = C.crearConservacion({ db, admin, historial: historialFalso, log: consola });
  const r = await c.migrar({ pagina: 2 });
  assert.deepEqual([r.revisados, r.conservados], [8, 5]);
  assert.ok(r.paginas >= 4, 'paginada de 2 en 2: ' + r.paginas);
  assert.ok(db.value('materialesConservados/a1').ids.includes(M12));
  assert.ok(db.value('materialesConservados/a2').ids.includes(M18));
  assert.ok(db.value('materialesConservados/a3').ids.includes(M60));
  assert.deepEqual(db.value('materialesConservados/a4').ids.sort(), ['carteles-visitantes-senales', 'etograma-hoja-observacion', 'intro-nom-059', 'inventario-botiquin-caducidad'].sort());
  assert.equal(db.value('materialesConservados/a5'), undefined, 'con 2 retos no cumplía ninguno');
  assert.equal(db.value('materialesConservados/a6'), undefined, '0 retos: nada');
  assert.deepEqual(db.value('materialesConservados/ya').ids, ['intro-nom-059'], 'un documento existente no se toca');
  assert.equal(miembrosDe(db), miembrosAntes, 'no se escribió nada en los documentos de miembros');
  assert.equal(db.value('config/migraciones').materialesConservadosV1, true);
  assert.equal(db.value('config/migraciones').materialesConservadosV1Miembros, 5);
  // el resumen queda en el historial de administración como acción del sistema
  assert.equal(anotados.length, 1);
  assert.equal(anotados[0][0].uid, 'sistema');
  assert.equal(anotados[0][1], 'sistema-conservar-materiales');
  assert.equal(anotados[0][3], 'Conservó los desbloqueos de materiales de 5 miembros');
});

test('migración: es idempotente (dos corridas = mismo resultado) y la segunda ni siquiera recorre nada', async () => {
  const db = dbMigracion();
  const c = C.crearConservacion({ db, admin, log: consola });
  await c.migrar();
  const primera = JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('materialesConservados/')).sort());
  const segunda = await c.migrar();
  assert.equal(segunda.omitida, true);
  // y aun sin la bandera (por ejemplo, otra instancia) volver a correrla no cambia nada
  const bandera = db.value('config/migraciones');
  db._data.delete('config/migraciones');
  const otra = C.crearConservacion({ db, admin, log: consola });
  const r3 = await otra.migrar();
  assert.equal(r3.conservados, 0, 'todo ya estaba guardado');
  assert.equal(JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('materialesConservados/')).sort()), primera);
  assert.ok(bandera.materialesConservadosV1);
});

test('migración: solo se AGREGA, nunca se quita (la unión conserva lo que ya estaba)', async () => {
  const db = new FakeFirestore({ ...conservadosDe('ana', ['x-material-viejo', M12]) });
  const c = C.crearConservacion({ db, admin, log: consola });
  await c.guardarUnion('ana', [M18]);
  assert.deepEqual(db.value('materialesConservados/ana').ids, [M12, M18, 'x-material-viejo'].sort());
  const creado = db.value('materialesConservados/ana').creadoEn;
  await c.guardarUnion('ana', [M12]);
  assert.deepEqual(db.value('materialesConservados/ana').creadoEn, creado, 'creadoEn no cambia');
  assert.equal(db.value('materialesConservados/ana').ids.length, 3);
});

test('arranque: la migración corre en segundo plano, no lanza ni retrasa; si falla no marca la bandera y se reintenta en el siguiente arranque', async () => {
  const db = dbMigracion();
  const original = db.collection.bind(db);
  let rompe = true;
  db.collection = n => {
    if (n === 'retosUsuario' && rompe) return { orderBy: () => ({ limit: () => ({ get: async () => { throw new Error('Firestore caído'); } }) }) };
    return original(n);
  };
  const errores = [];
  const c = C.crearConservacion({ db, admin, historial: historialFalso, log: { log() {}, error: (...a) => errores.push(a.join(' ')) } });
  const t0 = Date.now();
  const h = c.iniciar({ retrasoMs: 0 });                 // vuelve de inmediato: nada se espera
  assert.ok(Date.now() - t0 < 50);
  await new Promise(r => setTimeout(r, 40));
  assert.match(errores.join('\n'), /migración falló y se reintentará en el siguiente arranque/);
  assert.equal(db.value('config/migraciones'), undefined, 'la bandera NO se marcó');
  // siguiente arranque, ya sin el fallo
  rompe = false;
  const c2 = C.crearConservacion({ db, admin, log: consola });
  const r = await c2.migrar();
  assert.equal(r.revisados, 8);
  assert.equal(db.value('config/migraciones').materialesConservadosV1, true);
  h.detener();
});

test('arranque: un corte a la mitad se recupera (lo ya guardado no se repite y la segunda corrida termina el trabajo)', async () => {
  const db = dbMigracion();
  const c1 = C.crearConservacion({ db, admin, log: consola });
  await c1.guardarUnion('a1', C.previosCumplidos(12), { soloSiNoExiste: true });   // se alcanzó a guardar a1 antes del corte
  const antes = JSON.stringify(db.value('materialesConservados/a1'));
  const c2 = C.crearConservacion({ db, admin, historial: historialFalso, log: consola });
  const r = await c2.migrar({ pagina: 3 });
  assert.equal(r.conservados, 4, 'a1 ya estaba: se guardan los otros cuatro');
  assert.equal(JSON.stringify(db.value('materialesConservados/a1')), antes);
});

test('server.js solo programa la migración al ejecutarse directamente (las pruebas importan la app sin arrancar nada)', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = codigo.indexOf('conservacionMateriales.iniciar()');
  assert.ok(i > codigo.indexOf('require.main === module'), 'dentro del bloque que solo corre con node server.js');
  assert.match(codigo, /conservacion: conservacionMateriales/);
  const { app } = servidor({});
  assert.ok(app);
});

test('la tabla y el código no escriben campos nuevos en documentos existentes de miembros ni en retosUsuario', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'services', 'materiales-conservados.js'), 'utf8');
  assert.doesNotMatch(fuente, /collection\('miembros'\)|collection\('retosUsuario'\)\.doc\([^)]*\)\.(set|update)/);
  assert.match(fuente, /materialesConservados/);
});
