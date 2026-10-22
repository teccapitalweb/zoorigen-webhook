'use strict';

// Bitácora persistente del servidor (services/bitacora-servidor.js): arranques normales e inesperados, errores agrupados,
// limpieza a los 90 días y lectura para el panel. Con Firestore simulado y reloj propio.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore, FakeTimestamp } = require('./helpers/fake-firestore');
const { crearBitacoraServidor, patronDe, claveDe } = require('../services/bitacora-servidor');

const MIN = 60000; const HORA = 3600000; const DIA = 86400000;
const admin = { firestore: { FieldValue: {}, Timestamp: FakeTimestamp } };

function mundo(inicio = Date.parse('2026-10-20T12:00:00Z')) {
  const db = new FakeFirestore({});
  let reloj = inicio;
  const consola = { warn() {}, error() {}, log() {} };
  const nueva = (pid, opciones = {}) => {
    const proceso = { pid, on() {}, uptime: () => (reloj - opciones.arranque) / 1000 };
    const b = crearBitacoraServidor({ db, admin, ahora: () => new Date(reloj), proceso, consola, version: opciones.version || '2.0.0', commit: 'abc1234', intervaloLatidoMs: 1e9, intervaloVaciadoMs: 1e9 });
    return { ...b, proceso };
  };
  return { db, nueva, avanza: ms => { reloj += ms; }, ahoraMs: () => reloj };
}
const eventos = db => [...db._data.entries()].filter(([k]) => k.startsWith('servidorEventos/')).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
const cierre = async b => { clearInterval(); await b.cerrar(); };

test('primer arranque: queda como normal y se guarda la instancia', async () => {
  const m = mundo();
  const b = m.nueva(1);
  await b.iniciar(); await b.cerrar();
  const ev = eventos(m.db).filter(e => e.tipo === 'arranque');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].normal, true);
  assert.equal(ev[0].motivo, 'primer-arranque');
  assert.equal(ev[0].version, '2.0.0');
  assert.equal([...m.db._data.keys()].filter(k => k.startsWith('servidorInstancias/')).length, 1);
});

test('un arranque tras un cierre limpio (publicación) es normal; sin cierre limpio es inesperado, con su duración y caída', async () => {
  const m = mundo();
  const a = m.nueva(1); await a.iniciar();
  m.avanza(2 * HORA); await a.cerrar();          // cierre limpio: Railway publicó
  m.avanza(30000);
  const b = m.nueva(2); await b.iniciar();
  m.avanza(5 * HORA);                              // la instancia b se cae SIN cerrar (último latido en el arranque)
  m.avanza(40 * MIN);
  const c = m.nueva(3); await c.iniciar();
  const ev = eventos(m.db).filter(e => e.tipo === 'arranque').sort((x, y) => x.en - y.en);
  assert.deepEqual(ev.map(e => [e.motivo, e.normal]), [['primer-arranque', true], ['publicacion', true], ['inesperado', false]]);
  const inesperado = ev[2];
  assert.equal(inesperado.caida, true, 'más de 10 minutos sin servidor = caída');
  assert.ok(inesperado.duracionSeg >= 5 * 3600 + 39 * 60);
  // una instancia ya evaluada no se vuelve a contar
  await c.cerrar(); // c se apaga bien: d es una publicación normal
  m.avanza(MIN);
  const d = m.nueva(4); await d.iniciar();
  assert.equal(eventos(m.db).filter(e => e.tipo === 'arranque' && e.normal === false).length, 1);
});

test('reinicio inesperado corto (menos de 10 minutos): cuenta como reinicio inesperado pero no como caída', async () => {
  const m = mundo();
  const a = m.nueva(1); await a.iniciar();
  m.avanza(3 * MIN);
  const b = m.nueva(2); await b.iniciar();
  const e = eventos(m.db).filter(x => x.tipo === 'arranque' && x.normal === false)[0];
  assert.ok(e);
  assert.equal(e.caida, false);
  const h = await b.leerHistorial({ dias: 30 });
  assert.equal(h.resumen.reiniciosInesperados, 1);
  assert.equal(h.resumen.caidas, 0);
  assert.equal(h.resumen.reinicios, 2);
});

test('errores agrupados: el mismo problema con otros ids se cuenta junto y se acumula entre vaciados', async () => {
  const m = mundo();
  const b = m.nueva(1); await b.iniciar();
  b.registrarError('No se encontró miembro para la suscripción sub_1AAAAAAAAAAAAAAA1111');
  b.registrarError('No se encontró miembro para la suscripción sub_1BBBBBBBBBBBBBBB2222');
  b.registrarError('Falló el correo de ana@example.com');
  await b.vaciar();
  m.avanza(HORA);
  b.registrarError('No se encontró miembro para la suscripción sub_1CCCCCCCCCCCCCCC3333');
  await b.vaciar();
  const errores = [...m.db._data.entries()].filter(([k]) => k.startsWith('servidorErrores/')).map(([, v]) => v);
  assert.equal(errores.length, 2);
  const miembro = errores.find(e => /miembro/.test(e.patron));
  assert.equal(miembro.cuenta, 3);
  assert.ok(miembro.ultimaVez.getTime() > miembro.primeraVez.getTime());
  const texto = JSON.stringify(errores);
  assert.equal(/sub_1AAAA|sub_1BBBB|sub_1CCCC|ana@example/.test(texto), false, 'sin ids completos ni correos');
  assert.match(miembro.ejemplo, /sub_…\d{4}/);
  assert.equal(claveDe(patronDe('x sub_1Abcdefghij1')), claveDe(patronDe('x sub_1Zzzzzzzzzz9')));
});

test('«alta prioridad» y «por revisar» se distinguen y por revisar no cuenta como error interno', async () => {
  const m = mundo();
  const b = m.nueva(1); await b.iniciar();
  b.registrarError('[ALTA PRIORIDAD] Error procesando evento de Zoorigen: No se encontró miembro para cancelar sub_1XXXXXXXXXXXXXXXXXXX');
  b.registrarError('Aviso de Stripe por revisar: No se encontró miembro para la suscripción sub_1YYYYYYYYYYYYYYYYYY', { nivel: 'revisar' });
  b.registrarError('Error normal cualquiera');
  const h = await b.leerHistorial({ dias: 30 });
  const nivel = Object.fromEntries(h.errores.map(e => [e.nivel, e.cuenta]));
  assert.deepEqual(nivel, { alta: 1, revisar: 1, error: 1 });
  assert.equal(h.resumen.erroresInternos, 2);
  assert.equal(h.resumen.porRevisar, 1);
});

test('avisos de Stripe de otras marcas: un contador por día y el último aviso recibido', async () => {
  const m = mundo();
  const b = m.nueva(1); await b.iniciar();
  for (let i = 0; i < 5; i++) b.registrarIgnorado('invoice.payment_failed');
  b.registrarIgnorado('customer.subscription.updated');
  b.registrarAvisoStripe('invoice.payment_failed', false);
  await b.vaciar();
  m.avanza(HORA);
  b.registrarAvisoStripe('customer.subscription.updated', true);
  const h = await b.leerHistorial({ dias: 30 });
  assert.equal(h.resumen.stripeIgnorados, 6);
  assert.equal(h.stripeIgnorados.length, 1);
  assert.equal(h.stripeIgnorados[0].tipos['invoice.payment_failed'], 5);
  assert.equal(h.stripe.ultimoTipo, 'customer.subscription.updated');
  assert.equal(h.stripe.ultimoZoorigenTipo, 'customer.subscription.updated');
});

test('los registros de más de 90 días se limpian al arrancar y los recientes se quedan', async () => {
  const m = mundo();
  const viejo = new Date(m.ahoraMs() - 100 * DIA); const reciente = new Date(m.ahoraMs() - 10 * DIA);
  await m.db.collection('servidorEventos').doc('v1').set({ tipo: 'arranque', en: viejo, normal: true });
  await m.db.collection('servidorEventos').doc('r1').set({ tipo: 'arranque', en: reciente, normal: true });
  await m.db.collection('servidorErrores').doc('v2').set({ patron: 'viejo', cuenta: 4, ultimaVez: viejo });
  await m.db.collection('servidorErrores').doc('r2').set({ patron: 'reciente', cuenta: 2, ultimaVez: reciente });
  const b = m.nueva(1); await b.iniciar();
  await new Promise(r => setTimeout(r, 50));
  const ids = eventos(m.db).map(e => e.id);
  assert.equal(ids.includes('v1'), false);
  assert.equal(ids.includes('r1'), true);
  assert.equal(m.db.value('servidorErrores/v2'), undefined);
  assert.ok(m.db.value('servidorErrores/r2'));
});

test('«Marcarlos como publicaciones normales»: los inesperados dejan de contar y los normales no se tocan', async () => {
  const m = mundo();
  const a = m.nueva(1); await a.iniciar();
  m.avanza(2 * MIN); const b = m.nueva(2); await b.iniciar();
  m.avanza(2 * MIN); const c = m.nueva(3); await c.iniciar();
  assert.equal((await c.leerHistorial({ dias: 30 })).resumen.reiniciosInesperados, 2);
  assert.equal(await c.reconocerReinicios(), 2);
  const h = await c.leerHistorial({ dias: 30 });
  assert.equal(h.resumen.reiniciosInesperados, 0);
  assert.equal(h.resumen.reinicios, 3);
  assert.equal(await c.reconocerReinicios(), 0);
});

test('si Firestore falla, la bitácora no lanza nada', async () => {
  const roto = { collection() { throw new Error('sin base de datos'); }, runTransaction() { throw new Error('sin base de datos'); } };
  const b = crearBitacoraServidor({ db: roto, admin, consola: { warn() {}, error() {}, log() {} }, proceso: { pid: 1, on() {}, uptime: () => 1 }, intervaloLatidoMs: 1e9, intervaloVaciadoMs: 1e9 });
  b.registrarError('algo'); b.registrarIgnorado('x'); b.registrarAvisoStripe('x', true);
  await assert.doesNotReject(b.iniciar());
  await assert.doesNotReject(b.vaciar());
  await assert.doesNotReject(b.cerrar());
});
