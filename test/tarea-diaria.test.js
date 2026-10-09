'use strict';
// Estas pruebas usan un banco de prueba de 6 datos, no el banco real de data/.
process.env.DATOS_CURIOSOS_BANCO_RUTA = require('node:path').join(__dirname, 'fixtures', 'datos-curiosos-banco-prueba.json');

// Tarea diaria: cálculo de la próxima 13:00 UTC, pasos aislados, aviso de noticias y programador sin timers abiertos.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../services/tarea-diaria');
const D = require('../services/datos-curiosos');
const { FakeFirestore } = require('./helpers/fake-firestore');

const VIERNES = new Date('2026-10-09T13:00:00Z');
const MIERCOLES = new Date('2026-10-07T13:00:00Z');
const HORA = 3600000;
const nuevas = n => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, titulo: `Noticia ${i + 1} del sector`, categoria: 'fauna' }));
const syncFalso = (guardadas, extra = {}) => async () => ({ guardadas, omitidas: 3, fuentes: [{ id: 'x', ok: true, items: 5 }], eliminadas: 1, nuevas: nuevas(guardadas), ...extra });
const globales = db => [...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/'));

test('msHastaProxima: la siguiente 13:00 UTC, hoy o mañana', () => {
  assert.equal(T.msHastaProxima(new Date('2026-10-09T12:00:00Z')), HORA);
  assert.equal(T.msHastaProxima(new Date('2026-10-09T13:00:00Z')), 24 * HORA, 'justo a las 13:00 la siguiente es mañana');
  assert.equal(T.msHastaProxima(new Date('2026-10-09T13:00:01Z')), 24 * HORA - 1000);
  assert.equal(T.msHastaProxima(new Date('2026-10-09T23:59:00Z')), 13 * HORA + 60000);
  assert.equal(T.msHastaProxima(new Date('2026-10-09T00:00:00Z')), 13 * HORA);
  assert.equal(T.HORA_UTC, 13);
});

test('ejecutarTareaDiaria: noticias nuevas crean el aviso global "Nuevas noticias del sector" (uno por día)', async () => {
  const db = new FakeFirestore();
  const r = await T.ejecutarTareaDiaria(db, { ahora: MIERCOLES, sync: syncFalso(3) });
  assert.deepEqual(r.noticias, { guardadas: 3, omitidas: 3, eliminadas: 1, fuentes: [{ id: 'x', ok: true, items: 5 }] });
  assert.equal(r.aviso.creado, true);
  assert.equal(r.aviso.id, 'noticias_2026-10-07');
  const a = db.value('notificacionesGlobales/noticias_2026-10-07');
  assert.equal(a.titulo, '📰 Nuevas noticias del sector');
  assert.equal(a.tipo, 'noticia');
  assert.equal(a.descripcion, 'Noticia 1 del sector y 2 más');
  assert.equal(a.enlace, 'club-noticias.html');
  assert.deepEqual(r.dato, { enviado: false, motivo: 'no-toca', fecha: '2026-10-07' });

  const segunda = await T.ejecutarTareaDiaria(db, { ahora: new Date(MIERCOLES.getTime() + 2 * HORA), sync: syncFalso(2) });
  assert.equal(segunda.aviso.creado, false, 'un solo aviso de noticias por día');
  assert.equal(globales(db).length, 1);
});

test('ejecutarTareaDiaria: sin noticias nuevas no hay aviso', async () => {
  const db = new FakeFirestore();
  const r = await T.ejecutarTareaDiaria(db, { ahora: MIERCOLES, sync: syncFalso(0) });
  assert.equal(r.aviso, null);
  assert.equal(globales(db).length, 0);
});

test('ejecutarTareaDiaria: martes y viernes también envía el dato curioso', async () => {
  const db = new FakeFirestore();
  await D.crearDato(db, { texto: 'Un dato curioso de prueba bien largo.', tema: 'Tema' }, { ahora: VIERNES });
  const r = await T.ejecutarTareaDiaria(db, { ahora: VIERNES, sync: syncFalso(1) });
  assert.equal(r.dato.enviado, true);
  assert.deepEqual(globales(db).sort(), [`notificacionesGlobales/dato_2026-10-09_adm_${VIERNES.getTime()}`, 'notificacionesGlobales/noticias_2026-10-09']);
});

test('ejecutarTareaDiaria: si falla la sincronización, el dato curioso corre igual (y al revés)', async () => {
  const db = new FakeFirestore();
  await D.crearDato(db, { texto: 'Un dato curioso de prueba bien largo.', tema: 'Tema' }, { ahora: VIERNES });
  const consola = console.error; console.error = () => {};
  let r;
  try { r = await T.ejecutarTareaDiaria(db, { ahora: VIERNES, sync: async () => { throw new Error('todo se cayó'); } }); } finally { console.error = consola; }
  assert.deepEqual(r.noticias, { error: true });
  assert.equal(r.dato.enviado, true);

  const roto = new FakeFirestore();
  const original = roto.collection.bind(roto);
  roto.collection = n => { if (n === 'config') throw new Error('sin config'); return original(n); };
  console.error = () => {};
  try { r = await T.ejecutarTareaDiaria(roto, { ahora: VIERNES, sync: syncFalso(2) }); } finally { console.error = consola; }
  assert.equal(r.noticias.guardadas, 2);
  assert.equal(r.dato.motivo, 'error');
});

test('ejecutarTareaDiaria con minHoras: se salta las noticias si la última sincronización es reciente', async () => {
  const db = new FakeFirestore({ 'config/noticiasSector': { ultimaSync: new Date(MIERCOLES.getTime() - 2 * HORA).toISOString() } });
  let llamadas = 0;
  const sync = async () => { llamadas++; return syncFalso(1)(); };
  const reciente = await T.ejecutarTareaDiaria(db, { ahora: MIERCOLES, minHoras: 6, sync });
  assert.deepEqual(reciente.noticias, { omitida: true, motivo: 'reciente' });
  assert.equal(llamadas, 0);
  const antigua = await T.ejecutarTareaDiaria(new FakeFirestore({ 'config/noticiasSector': { ultimaSync: new Date(MIERCOLES.getTime() - 7 * HORA).toISOString() } }), { ahora: MIERCOLES, minHoras: 6, sync });
  assert.equal(antigua.noticias.guardadas, 1);
  const sinHistorial = await T.ejecutarTareaDiaria(new FakeFirestore(), { ahora: MIERCOLES, minHoras: 6, sync });
  assert.equal(sinHistorial.noticias.guardadas, 1);
  assert.equal(llamadas, 2);
});

// ── Programador ──
test('iniciarProgramador desactivado (activa:false) no crea temporizadores', () => {
  const p = T.iniciarProgramador(new FakeFirestore(), { activa: false, ejecutar: () => { throw new Error('no debe correr'); } });
  assert.equal(p.activo, false);
  p.detener();
});

test('NOTICIAS_TAREA=off apaga la tarea', () => {
  const antes = process.env.NOTICIAS_TAREA;
  process.env.NOTICIAS_TAREA = 'off';
  try { assert.equal(T.iniciarProgramador(new FakeFirestore(), { ejecutar: () => { throw new Error('no'); } }).activo, false); } finally {
    if (antes === undefined) delete process.env.NOTICIAS_TAREA; else process.env.NOTICIAS_TAREA = antes;
  }
});

test('iniciarProgramador: corre una vez al arrancar (con el mínimo de 6 horas) y se puede detener sin dejar temporizadores', async () => {
  const llamadas = [];
  const p = T.iniciarProgramador(new FakeFirestore(), { retrasoArranqueMs: 5, ejecutar: async (db, o) => { llamadas.push(o); } });
  assert.equal(p.activo, true);
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(llamadas, [{ minHoras: 6 }]);
  p.detener();
});

test('detener antes del arranque cancela la corrida y un error de la tarea no tumba el proceso', async () => {
  let corrio = false;
  const p = T.iniciarProgramador(new FakeFirestore(), { retrasoArranqueMs: 5, ejecutar: async () => { corrio = true; } });
  p.detener();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(corrio, false);

  const consola = console.error; console.error = () => {};
  try {
    const q = T.iniciarProgramador(new FakeFirestore(), { retrasoArranqueMs: 5, ejecutar: async () => { throw new Error('boom'); } });
    await new Promise(r => setTimeout(r, 40));
    q.detener();
  } finally { console.error = consola; }
});
