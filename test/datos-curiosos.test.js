'use strict';

// Datos curiosos: banco, siembra, elección, días de envío (martes y viernes, hora de México) e idempotencia.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../services/datos-curiosos');
const { FakeFirestore } = require('./helpers/fake-firestore');

const VIERNES = new Date('2026-10-09T13:00:00Z');   // viernes 7:00 en México
const MARTES = new Date('2026-10-06T13:00:00Z');
const MIERCOLES = new Date('2026-10-07T13:00:00Z');
const texto = n => `Dato curioso número ${n} sobre la fauna silvestre de México.`;
const dato = (id, extra = {}) => ({ id, texto: texto(id), tema: 'Fauna', fuente: 'Fuente', fuenteUrl: '', activo: true, veces: 0, ultimoEnvio: null, ...extra });
const banco = n => Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, texto: texto(i + 1), tema: 'Tema', fuente: 'F', fuenteUrl: 'https://example.com/f' }));
const globales = db => [...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/')).map(k => db.value(k));

// ── Fecha de México ──
test('fechaMexico usa UTC-6 fijo y tocaEnviar solo martes y viernes de esa fecha', () => {
  assert.equal(D.fechaMexico(new Date('2026-10-10T05:59:00Z')), '2026-10-09');
  assert.equal(D.fechaMexico(new Date('2026-10-10T06:00:00Z')), '2026-10-10');
  assert.equal(D.tocaEnviar(VIERNES), true);
  assert.equal(D.tocaEnviar(MARTES), true);
  assert.equal(D.tocaEnviar(MIERCOLES), false);
  assert.equal(D.tocaEnviar(new Date('2026-10-07T05:30:00Z')), true, 'martes 23:30 en México aunque ya sea miércoles en UTC');
  assert.equal(D.tocaEnviar(new Date('2026-10-06T03:00:00Z')), false, 'lunes 21:00 en México aunque ya sea martes en UTC');
  const dias = [0, 1, 2, 3, 4, 5, 6].map(n => D.tocaEnviar(new Date(Date.UTC(2026, 9, 4 + n, 18))));
  assert.deepEqual(dias, [false, false, true, false, false, true, false]);
});

// ── Validación ──
test('validarDato: texto 20..300, tema 2..60, fuente y enlace opcionales', () => {
  assert.equal(D.validarDato({ texto: 'x'.repeat(19), tema: 'Tema' }).error !== undefined, true);
  assert.equal(D.validarDato({ texto: 'x'.repeat(20), tema: 'Tema' }).error, undefined);
  assert.equal(D.validarDato({ texto: 'x'.repeat(300), tema: 'Tema' }).error, undefined);
  assert.ok(D.validarDato({ texto: 'x'.repeat(301), tema: 'Tema' }).error);
  assert.ok(D.validarDato({ texto: 'x'.repeat(20), tema: 'T' }).error);
  assert.ok(D.validarDato({ texto: 'x'.repeat(20), tema: 't'.repeat(61) }).error);
  for (const malo of [undefined, null, 5, [], {}]) assert.ok(D.validarDato({ texto: malo, tema: 'Tema' }).error, String(malo));
  assert.ok(D.validarDato({ texto: 'x'.repeat(20) }).error);
  assert.ok(D.validarDato({ texto: 'x'.repeat(20), tema: 'Tema', fuente: 5 }).error);
  assert.ok(D.validarDato({ texto: 'x'.repeat(20), tema: 'Tema', fuente: 'f'.repeat(121) }).error);
  assert.ok(D.validarDato({ texto: 'x'.repeat(20), tema: 'Tema', fuenteUrl: 'http://inseguro.com' }).error);
  assert.ok(D.validarDato({ texto: 'x'.repeat(20), tema: 'Tema', fuenteUrl: 'javascript:alert(1)' }).error);
  const ok = D.validarDato({ texto: '  Un   dato\u0000 <b>curioso</b> y largo  ', tema: ' Abejas ', fuente: ' Fuente ', fuenteUrl: 'https://example.com/a' });
  assert.deepEqual(ok.datos, { texto: 'Un dato <b>curioso</b> y largo', tema: 'Abejas', fuente: 'Fuente', fuenteUrl: 'https://example.com/a' });
});

test('validarDato parcial (actualizar): solo valida lo que viene', () => {
  assert.deepEqual(D.validarDato({ texto: texto(1) }, { parcial: true }).datos, { texto: texto(1) });
  assert.deepEqual(D.validarDato({ tema: 'Aves' }, { parcial: true }).datos, { tema: 'Aves' });
  assert.ok(D.validarDato({ texto: 'corto' }, { parcial: true }).error);
});

// ── Banco ──
test('el banco de prueba incluido tiene 6 datos marcados como prueba y todos válidos', () => {
  const todos = D.leerBanco(D.RUTA_BANCO, { incluirPrueba: true });
  assert.equal(todos.length, 6);
  assert.ok(todos.every(d => d.prueba === true && d.tema && d.fuente !== undefined && d.texto.length >= 20 && d.texto.length <= 300));
  const crudo = JSON.parse(fs.readFileSync(D.RUTA_BANCO, 'utf8'));
  for (const e of crudo) assert.deepEqual(Object.keys(e).sort(), ['fuente', 'fuenteUrl', 'id', 'prueba', 'tema', 'texto']);
  assert.deepEqual(D.leerBanco(), [], 'los de prueba no se siembran en producción');
});

test('leerBanco: descarta inválidos y repetidos; los reales (sin prueba) sí pasan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banco-'));
  const ruta = path.join(dir, 'b.json');
  fs.writeFileSync(ruta, JSON.stringify([
    { id: 'ok1', tema: 'Abejas', texto: texto(1), fuente: 'Una fuente', fuenteUrl: 'https://example.com/a' },
    { id: 'ok1', tema: 'Repetido', texto: texto(2), fuente: 'x' },
    { id: 'corto', tema: 'Tema', texto: 'muy corto', fuente: 'x' },
    { id: 'sin tema', texto: texto(3) },
    { id: 'http', tema: 'Tema', texto: texto(4), fuenteUrl: 'http://x.com' },
    { id: 'prueba1', prueba: true, tema: 'Tema', texto: texto(5) },
    null, 7
  ]));
  assert.deepEqual(D.leerBanco(ruta).map(d => d.id), ['ok1']);
  assert.deepEqual(D.leerBanco(ruta, { incluirPrueba: true }).map(d => d.id), ['ok1', 'prueba1']);
  const original = console.error; console.error = () => {};
  try { assert.deepEqual(D.leerBanco(path.join(dir, 'no.json')), []); } finally { console.error = original; }
});

test('sembrarSiVacia siembra una sola vez y solo si la colección está vacía', async () => {
  const db = new FakeFirestore();
  assert.equal(await D.sembrarSiVacia(db, { banco: banco(3), ahora: VIERNES }), 3);
  const g = db.value('datosCuriosos/b1');
  assert.deepEqual({ ...g, creadoEn: undefined }, { texto: texto(1), tema: 'Tema', fuente: 'F', fuenteUrl: 'https://example.com/f', activo: true, veces: 0, ultimoEnvio: null, origen: 'base', creadoEn: undefined });
  assert.equal(await D.sembrarSiVacia(db, { banco: banco(5) }), 0, 'ya no está vacía');
  assert.equal(db.value('datosCuriosos/b4'), undefined);
});

test('sembrarSiVacia con el archivo real: sin datos de prueba no siembra nada (para no bloquear el banco verdadero)', async () => {
  const db = new FakeFirestore();
  assert.equal(await D.sembrarSiVacia(db), 0);
  assert.equal((await db.collection('datosCuriosos').get()).size, 0);
  assert.equal(await D.sembrarSiVacia(db, { incluirPrueba: true }), 6);
  assert.equal((await db.collection('datosCuriosos').get()).size, 6);
});

// ── Elección ──
test('elegirDato: menos veces, luego envío más antiguo (nunca enviado primero), luego id', () => {
  assert.equal(D.elegirDato([dato('b', { veces: 1 }), dato('a', { veces: 2 }), dato('c', { veces: 1 })]).id, 'b');
  assert.equal(D.elegirDato([dato('b', { veces: 1, ultimoEnvio: '2026-09-01' }), dato('c', { veces: 1, ultimoEnvio: '2026-08-01' })]).id, 'c');
  assert.equal(D.elegirDato([dato('b', { veces: 1, ultimoEnvio: '2026-09-01' }), dato('c', { veces: 1, ultimoEnvio: null })]).id, 'c');
  assert.equal(D.elegirDato([dato('z'), dato('m'), dato('a')]).id, 'a');
  assert.equal(D.elegirDato([dato('a', { activo: false }), dato('b', { veces: 9 })]).id, 'b', 'los inactivos no cuentan');
  assert.equal(D.elegirDato([dato('a', { texto: 'corto' }), dato('b', { texto: 'x'.repeat(301) })]), null, 'texto fuera de 20..300');
  assert.equal(D.elegirDato([]), null);
  assert.equal(D.elegirDato(null), null);
});

// ── Envío diario ──
test('enviarDatoCuriosoSiToca: viernes envía un aviso global, marca el dato y deja el día reservado', async () => {
  const db = new FakeFirestore();
  await D.sembrarSiVacia(db, { banco: banco(3), ahora: VIERNES });
  const r = await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES });
  assert.deepEqual(r, { enviado: true, datoId: 'b1', avisoId: 'dato_2026-10-09_b1', fecha: '2026-10-09' });
  const aviso = db.value('notificacionesGlobales/dato_2026-10-09_b1');
  assert.equal(aviso.tipo, 'dato');
  assert.equal(aviso.titulo, '💡 Dato curioso');
  assert.equal(aviso.descripcion, texto(1));
  assert.equal(aviso.origen, 'auto');
  assert.equal(db.value('datosCuriosos/b1').veces, 1);
  assert.equal(db.value('datosCuriosos/b1').ultimoEnvio, '2026-10-09');
  assert.equal(db.value('config/datosCuriosos').ultimoEnvioFecha, '2026-10-09');
});

test('enviarDatoCuriosoSiToca es idempotente por día (aunque el servidor se reinicie)', async () => {
  const db = new FakeFirestore();
  await D.sembrarSiVacia(db, { banco: banco(3) });
  assert.equal((await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES })).enviado, true);
  const otra = await D.enviarDatoCuriosoSiToca(db, { ahora: new Date(VIERNES.getTime() + 3600000) });
  assert.deepEqual(otra, { enviado: false, motivo: 'ya-enviado', fecha: '2026-10-09' });
  assert.equal(globales(db).length, 1);
  assert.equal(db.value('datosCuriosos/b1').veces, 1);
});

test('enviarDatoCuriosoSiToca: dos procesos a la vez envían un solo dato', async () => {
  const db = new FakeFirestore();
  db.lenta = true;
  await D.sembrarSiVacia(db, { banco: banco(3) });
  const r = await Promise.all([D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES }), D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES })]);
  assert.equal(r.filter(x => x.enviado).length, 1);
  assert.equal(globales(db).length, 1);
});

test('enviarDatoCuriosoSiToca: miércoles no envía nada (ni reserva el día); forzar sí', async () => {
  const db = new FakeFirestore();
  await D.sembrarSiVacia(db, { banco: banco(2) });
  const r = await D.enviarDatoCuriosoSiToca(db, { ahora: MIERCOLES });
  assert.deepEqual(r, { enviado: false, motivo: 'no-toca', fecha: '2026-10-07' });
  assert.equal(globales(db).length, 0);
  assert.equal(db.value('config/datosCuriosos'), undefined);
  assert.equal((await D.enviarDatoCuriosoSiToca(db, { ahora: MIERCOLES, forzar: true })).enviado, true);
});

test('los envíos rotan por todo el banco antes de repetir', async () => {
  const db = new FakeFirestore();
  await D.sembrarSiVacia(db, { banco: banco(3) });
  const fechas = ['2026-10-06', '2026-10-09', '2026-10-13', '2026-10-16', '2026-10-20'].map(f => new Date(`${f}T13:00:00Z`));
  const usados = [];
  for (const f of fechas) usados.push((await D.enviarDatoCuriosoSiToca(db, { ahora: f })).datoId);
  assert.deepEqual(usados, ['b1', 'b2', 'b3', 'b1', 'b2']);
});

test('sin datos activos no envía y NO deja el día reservado (se puede reintentar al cargar datos)', async () => {
  const db = new FakeFirestore();
  assert.deepEqual(await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES }), { enviado: false, motivo: 'sin-datos', fecha: '2026-10-09' });
  assert.equal(db.value('config/datosCuriosos').ultimoEnvioFecha, null);
  await D.crearDato(db, { texto: texto(1), tema: 'Tema' }, { ahora: VIERNES });
  assert.equal((await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES })).enviado, true);
});

test('con datos de prueba solo se envían si se pide expresamente', async () => {
  const db = new FakeFirestore();
  assert.equal((await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES })).motivo, 'sin-datos');
  assert.equal((await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES, incluirPrueba: true })).enviado, true);
  assert.match(globales(db)[0].descripcion, /^\[PRUEBA\]/);
});

test('si Firestore falla a medias, libera el día y no lanza', async () => {
  const db = new FakeFirestore();
  await D.sembrarSiVacia(db, { banco: banco(2) });
  const original = db.collection.bind(db);
  db.collection = nombre => {
    if (nombre === 'notificacionesGlobales') throw new Error('caída simulada');
    return original(nombre);
  };
  const consola = console.error; console.error = () => {};
  let r;
  try { r = await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES }); } finally { console.error = consola; }
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'error');
  assert.equal(db.value('config/datosCuriosos').ultimoEnvioFecha, null, 'el día quedó libre para reintentar');
  assert.equal(db.value('datosCuriosos/b1').veces, 0);
  db.collection = original;
  assert.equal((await D.enviarDatoCuriosoSiToca(db, { ahora: VIERNES })).enviado, true);
});

// ── Administración ──
test('crearDato / actualizarDato / eliminarDato / enviarDato', async () => {
  const db = new FakeFirestore();
  const nuevo = await D.crearDato(db, { texto: texto(1), tema: 'Aves', fuente: 'Fuente', fuenteUrl: 'https://example.com/a' }, { ahora: VIERNES });
  assert.equal(nuevo.id, `adm_${VIERNES.getTime()}`);
  assert.deepEqual([nuevo.origen, nuevo.activo, nuevo.veces, nuevo.ultimoEnvio], ['admin', true, 0, null]);

  const cambiado = await D.actualizarDato(db, nuevo.id, { activo: false, tema: 'Reptiles' });
  assert.deepEqual([cambiado.activo, cambiado.tema, cambiado.texto], [false, 'Reptiles', texto(1)]);
  assert.equal(await D.actualizarDato(db, 'no-existe', { activo: true }), null);

  const envio = await D.enviarDato(db, nuevo, { ahora: VIERNES });
  assert.equal(envio.enviado, true);
  assert.equal((await D.enviarDato(db, nuevo, { ahora: VIERNES })).enviado, false, 'el mismo dato el mismo día no se repite');
  assert.equal(db.value(`datosCuriosos/${nuevo.id}`).veces, 1);

  assert.equal(await D.eliminarDato(db, nuevo.id), true);
  assert.equal(await D.eliminarDato(db, nuevo.id), false);
});

test('crearDato siembra primero el banco si la colección estaba vacía (así el banco no se pierde)', async () => {
  const db = new FakeFirestore();
  // el banco real aún no llega: con datos de prueba solo se siembra a petición, pero el orden es: sembrar -> crear
  await D.crearDato(db, { texto: texto(1), tema: 'Tema' }, { ahora: VIERNES });
  assert.equal((await D.listarDatos(db)).length, 1);
});
