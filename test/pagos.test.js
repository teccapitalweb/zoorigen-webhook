'use strict';

// Registro de pagos de suscripción: el aviso de Stripe los guarda (primer pago, renovación, cobro rechazado) y el panel los lee.
// Ejecutar: node --test test/pagos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, suscripcion, PRICE_MENSUAL, PRICE_ANUAL } = require('./helpers/cargar-servidor');
const { request: pedir, auth, tokensDe, miembroConPlan } = require('./helpers/club');

const evento = (type, object) => ({ id: 'evt_' + Math.random().toString(36).slice(2), type, data: { object } });
const enviar = (app, ev) => request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', 'firma-valida').send(JSON.stringify(ev));
const unix = ms => Math.floor(ms / 1000);
const T0 = Date.UTC(2026, 9, 21, 20, 9);

const factura = (sub, extra = {}) => ({
  id: 'in_1', subscription: sub.id, customer: 'cus_1', customer_email: 'Ana@Example.com', currency: 'mxn',
  amount_paid: 19900, amount_due: 19900, billing_reason: 'subscription_create', created: unix(T0), status_transitions: { paid_at: unix(T0) },
  lines: { data: sub.items.data.map(i => ({ price: i.price })) }, ...extra
});
const seedMiembro = (sub = 'sub_1') => ({ 'miembros/u1': { name: 'Ana Pérez', email: 'ana@example.com', stripeSubscriptionId: sub, planActivo: true, planStatus: 'active', planTipo: 'mensual' } });

test('el primer pago (invoice.payment_succeeded con subscription_create) queda guardado con monto, fecha, quién y plan', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'u1' });
  const { app, db } = cargarServidor({ suscripciones: [sub], seed: seedMiembro() });
  const r = await enviar(app, evento('invoice.payment_succeeded', factura(sub)));
  assert.equal(r.status, 200);
  const p = db.value('pagos/in_1');
  assert.deepEqual([p.estado, p.tipo, p.monto, p.moneda, p.plan, p.uid, p.nombre, p.email, p.fechaMs],
    ['pagado', 'primer', 199, 'MXN', 'mensual', 'u1', 'Ana Pérez', 'ana@example.com', T0]);
  assert.equal(p.subscriptionId, 'sub_1');
});

test('una renovación queda como «renov»; el plan anual se reconoce por su precio', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'u1', precio: PRICE_ANUAL });
  const { app, db } = cargarServidor({ suscripciones: [sub], seed: seedMiembro() });
  await enviar(app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_ren', billing_reason: 'subscription_cycle', amount_paid: 189900 })));
  const p = db.value('pagos/in_ren');
  assert.deepEqual([p.tipo, p.plan, p.monto], ['renov', 'anual', 1899]);
});

test('un cobro rechazado se anota con el monto que no se pudo cobrar', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'u1' });
  const { app, db } = cargarServidor({ suscripciones: [sub], seed: seedMiembro() });
  const r = await enviar(app, evento('invoice.payment_failed', factura(sub, { id: 'in_mal', amount_paid: 0, amount_due: 19900, billing_reason: 'subscription_cycle', status_transitions: {} })));
  assert.equal(r.status, 200);
  const p = db.value('pagos/in_mal');
  assert.deepEqual([p.estado, p.monto, p.tipo], ['fallido', 199, 'renov']);
  assert.equal(db.value('miembros/u1').planStatus, 'past_due', 'el acceso se suspende como siempre');
});

test('el mismo cobro que llega dos veces se guarda una sola vez y conserva su fecha; un pago reemplaza a un rechazo de la misma factura, nunca al revés', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'u1' });
  const { app, db } = cargarServidor({ suscripciones: [sub], seed: seedMiembro() });
  await enviar(app, evento('invoice.payment_failed', factura(sub, { id: 'in_x', amount_paid: 0, billing_reason: 'subscription_cycle' })));
  assert.equal(db.value('pagos/in_x').estado, 'fallido');
  await enviar(app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_x', billing_reason: 'subscription_cycle', status_transitions: { paid_at: unix(T0 + 3600000) } })));
  assert.deepEqual([db.value('pagos/in_x').estado, db.value('pagos/in_x').fechaMs], ['pagado', T0 + 3600000]);
  await enviar(app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_x', billing_reason: 'subscription_cycle', status_transitions: { paid_at: unix(T0 + 9999999) } })));
  assert.equal(db.value('pagos/in_x').fechaMs, T0 + 3600000, 'no se pisa un pago ya guardado');
  await enviar(app, evento('invoice.payment_failed', factura(sub, { id: 'in_x', amount_paid: 0, billing_reason: 'subscription_cycle' })));
  assert.equal(db.value('pagos/in_x').estado, 'pagado', 'un rechazo tardío no borra el pago');
  assert.equal([...db._data.keys()].filter(k => k.startsWith('pagos/')).length, 1);
});

test('el primer cobro que llega ANTES del alta del miembro también se guarda (se reconoce por el precio de Zoorigen)', async () => {
  const sub = suscripcion({ id: 'sub_nueva', uid: 'u9' });
  const { app, db } = cargarServidor({ suscripciones: [sub] });
  await enviar(app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_nuevo' })));
  const p = db.value('pagos/in_nuevo');
  assert.ok(p, 'guardado');
  assert.deepEqual([p.uid, p.email, p.plan], ['', 'ana@example.com', 'mensual']);
});

test('los cobros de OTRA marca de la cuenta compartida no se guardan, y las facturas en ceros (cupón del 100 %) tampoco', async () => {
  const ajena = suscripcion({ id: 'sub_ajena', uid: 'nadie', precio: 'price_OtraMarcaAgroClub000001', sinMetadata: true });
  const { app, db } = cargarServidor({ suscripciones: [ajena] });
  const r = await enviar(app, evento('invoice.payment_succeeded', factura(ajena, { id: 'in_ajeno' })));
  assert.equal(r.status, 200);
  assert.equal(db.value('pagos/in_ajeno'), undefined);
  const sub = suscripcion({ id: 'sub_1', uid: 'u1' });
  const b = cargarServidor({ suscripciones: [sub], seed: seedMiembro() });
  await enviar(b.app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_cero', amount_paid: 0 })));
  assert.equal(b.db.value('pagos/in_cero'), undefined);
});

test('registrar un pago nunca rompe el aviso de Stripe: si Firestore falla al guardar, el aviso se atiende igual', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'u1' });
  const { app, db } = cargarServidor({ suscripciones: [sub], seed: seedMiembro() });
  const original = db.collection.bind(db);
  db.collection = nombre => (nombre === 'pagos' ? { doc: () => ({ get: async () => { throw new Error('Firestore caído'); }, set: async () => { throw new Error('Firestore caído'); } }) } : original(nombre));
  const silenciar = console.warn; console.warn = () => {};
  try {
    const r = await enviar(app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_r', billing_reason: 'subscription_cycle' })));
    assert.equal(r.status, 200);
    assert.equal(db.value('miembros/u1').planActivo, true, 'la renovación se aplicó');
  } finally { console.warn = silenciar; }
});

// ── Lo que ve el panel ──
const tokens = tokensDe('ana', 'admin');
function servidorPanel(extra = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      tokens, usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: { 'miembros/ana': miembroConPlan({ name: 'Ana', email: 'ana@example.com', stripeSubscriptionId: 'sub_1' }), 'miembros/admin': { role: 'admin', name: 'Admin', email: 'admin@example.com' }, ...extra }
    });
  } finally { console.warn = silenciar; }
}
const pago = (id, ms, extra = {}) => ({ invoiceId: id, subscriptionId: 'sub_1', uid: 'ana', nombre: 'Ana', email: 'ana@example.com', plan: 'mensual', tipo: 'primer', estado: 'pagado', monto: 199, moneda: 'MXN', fechaMs: ms, creadoMs: ms, ...extra });

test('GET /api/admin/pagos: solo administración; del más reciente al más antiguo; sin ids de Stripe', async () => {
  const { app } = servidorPanel({ 'pagos/in_a': pago('in_a', 1000), 'pagos/in_b': pago('in_b', 3000, { tipo: 'renov' }), 'pagos/in_c': pago('in_c', 2000, { estado: 'fallido' }) });
  assert.equal((await pedir(app).get('/api/admin/pagos')).status, 401);
  assert.equal((await pedir(app).get('/api/admin/pagos').set(auth('token-ana'))).status, 403);
  const r = await pedir(app).get('/api/admin/pagos').set(auth('token-admin'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pagos.map(p => p.id), ['in_b', 'in_c', 'in_a']);
  assert.deepEqual(Object.keys(r.body.pagos[0]).sort(), ['correo', 'estado', 'fecha', 'id', 'intentos', 'moneda', 'monto', 'motivo', 'nombre', 'plan', 'proximoIntento', 'tipo', 'uid', 'ultimoIntento']);
  assert.ok(!JSON.stringify(r.body).includes('sub_1') && !JSON.stringify(r.body).includes('cus_'));
});

test('POST /api/admin/pagos/sincronizar: trae de Stripe los cobros pagados que faltan, sin duplicar los que ya están ni tocar otras marcas', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'ana' });
  const { app, db, stripe } = servidorPanel({ 'pagos/in_1': pago('in_1', T0) });
  stripe.subscriptions.retrieve = async id => { if (id !== 'sub_1') throw new Error('no existe'); return sub; };
  const consultas = [];
  stripe.invoices = { list: async q => { consultas.push(q); return { data: [
    factura(sub, { id: 'in_1' }),
    factura(sub, { id: 'in_2', billing_reason: 'subscription_cycle', created: unix(T0 + 86400000 * 30), status_transitions: { paid_at: unix(T0 + 86400000 * 30) } }),
    factura(sub, { id: 'in_cero', amount_paid: 0 })
  ] }; } };
  assert.equal((await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-ana')).send({})).status, 403);
  const r = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.suscripciones, r.body.revisados, r.body.nuevos, r.body.errores], [1, 3, 1, 0]);
  assert.deepEqual(consultas, [{ subscription: 'sub_1', status: 'paid', limit: 100 }, { status: 'open', limit: 100 }], 'una consulta por suscripción de pagados y UNA general de facturas abiertas');
  assert.deepEqual([r.body.fallidosNuevos, r.body.motivosCompletados, r.body.motivosPendientes, r.body.motivosErrores], [0, 0, 0, 0]);
  assert.equal(db.value('pagos/in_2').tipo, 'renov');
  assert.equal(db.value('pagos/in_cero'), undefined);
  assert.equal(db.value('pagos/in_1').fechaMs, T0, 'el que ya estaba no se toca');
  const otra = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
  assert.equal(otra.body.nuevos, 0, 'una segunda vez no agrega nada');
  const acciones = [...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).map(k => db.value(k)).filter(a => a.accion === 'pagos-sincronizar');
  assert.equal(acciones.length, 2);
});

test('si Stripe falla con una suscripción, la sincronización sigue con las demás y cuenta el error', async () => {
  const sub = suscripcion({ id: 'sub_2', uid: 'beto' });
  const { app, stripe } = servidorPanel({ 'miembros/beto': miembroConPlan({ name: 'Beto', email: 'beto@example.com', stripeSubscriptionId: 'sub_2' }) });
  stripe.subscriptions.retrieve = async () => sub;
  stripe.invoices = { list: async q => { if (q.subscription === 'sub_1') throw new Error('Stripe no responde'); return { data: [factura(sub, { id: 'in_ok', subscription: 'sub_2' })] }; } };
  const silenciar = console.warn; console.warn = () => {};
  try {
    const r = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
    assert.deepEqual([r.status, r.body.errores, r.body.nuevos], [200, 1, 1]);
  } finally { console.warn = silenciar; }
});

// ═══════════ Motivo del rechazo ═══════════
const pagosSvc = require('../services/pagos');
const { FakeFirestore } = require('./helpers/fake-firestore');

// Lo que Stripe devuelve cuando la factura trae el intento de pago y su último cargo (con datos de tarjeta de sobra, que NO deben guardarse)
const intentoRechazado = (extra = {}) => ({
  id: 'pi_1', status: 'requires_payment_method', customer: 'cus_1', amount: 19900, created: unix(T0),
  last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', type: 'card_error', message: 'Your card has insufficient funds.',
    payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, issuer: 'BANCO DEMO SA' }, billing_details: { name: 'Ana Pérez' } } },
  latest_charge: { id: 'ch_1', created: unix(T0 + 60000), failure_code: 'card_declined', failure_message: 'Your card has insufficient funds.',
    payment_method_details: { card: { brand: 'visa', last4: '4242', fingerprint: 'fp_secreto' } }, billing_details: { name: 'Ana Pérez', email: 'ana@example.com' },
    outcome: { reason: 'generic_decline', network_status: 'declined_by_network', seller_message: 'The bank returned the decline code insufficient_funds.' } },
  ...extra
});
const facturaRechazada = (sub, extra = {}) => factura(sub, { id: 'in_mal', amount_paid: 0, amount_due: 19900, billing_reason: 'subscription_cycle', status_transitions: {}, attempt_count: 1, next_payment_attempt: unix(T0 + 3 * 86400000), status: 'open', ...extra });
const doc = (db, id) => db.value('pagos/' + id);
// Lo que se guarda del rechazo: solo estas claves del documento, y en el motivo nada de la tarjeta (ni número, ni últimos 4, ni vencimiento, ni banco, ni titular)
const CLAVES_DOC = ['invoiceId', 'subscriptionId', 'customerId', 'uid', 'nombre', 'email', 'plan', 'tipo', 'estado', 'monto', 'moneda', 'fechaMs', 'creadoMs', 'intentos', 'ultimoIntentoMs', 'motivo', 'motivoEn'];
const sinTarjeta = d => { const t = JSON.stringify(d.motivo || {}).toLowerCase(); return Object.keys(d).every(k => CLAVES_DOC.includes(k)) && !['4242', 'visa', 'banco demo', 'fp_secreto', 'ana pérez', 'pm_1', 'last4', 'exp_month', 'fingerprint', 'ana@example'].some(x => t.includes(x)); };
function conStripe(extra = {}) {
  const sub = suscripcion({ id: 'sub_1', uid: 'u1' });
  const c = cargarServidor({ suscripciones: [sub], seed: seedMiembro(), ...extra });
  return { sub, ...c };
}

test('un cobro rechazado guarda POR QUÉ falló (código, código del banco, tipo, mensaje) y cuántos intentos van, sin datos de la tarjeta', async () => {
  const { sub, app, db, stripe } = conStripe();
  const pedidas = [];
  stripe.invoices = { retrieve: async (id, opciones) => { pedidas.push([id, opciones]); return { ...facturaRechazada(sub), payment_intent: intentoRechazado() }; } };
  const r = await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub)));
  assert.equal(r.status, 200);
  assert.deepEqual(pedidas[0], ['in_mal', { expand: ['payment_intent', 'payment_intent.latest_charge'] }]);
  const p = doc(db, 'in_mal');
  assert.equal(p.estado, 'fallido');
  assert.deepEqual(p.motivo, { codigo: 'card_declined', declineCodigo: 'insufficient_funds', tipo: 'card_error', razonStripe: 'generic_decline', redEstado: 'declined_by_network',
    mensajeStripe: 'Your card has insufficient funds.', reintentoMs: unix(T0 + 3 * 86400000) * 1000 });
  assert.equal(p.intentos, 1);
  assert.equal(p.ultimoIntentoMs, T0 + 60000, 'la fecha del último cargo');
  assert.ok(sinTarjeta(p), 'ni número, ni últimos 4, ni vencimiento, ni banco, ni titular: ' + JSON.stringify(p));
  assert.equal(db.value('miembros/u1').planStatus, 'past_due', 'el acceso se suspende como siempre');
});

test('GET /api/admin/pagos muestra el motivo YA TRADUCIDO (nunca el mensaje en inglés de Stripe), los intentos y el resumen por categoría', async () => {
  const { app } = servidorPanel({
    'pagos/in_a': pago('in_a', 3000, { estado: 'fallido', tipo: 'renov', intentos: 2, ultimoIntentoMs: 3500, motivo: { codigo: 'card_declined', declineCodigo: 'insufficient_funds', mensajeStripe: 'Your card has insufficient funds.', reintentoMs: 9000 } }),
    'pagos/in_b': pago('in_b', 2000, { estado: 'fallido', motivo: { codigo: 'expired_card', mensajeStripe: 'Your card has expired.' } }),
    'pagos/in_c': pago('in_c', 1500, { estado: 'fallido' }),
    'pagos/in_d': pago('in_d', 1000, { estado: 'pagado', motivo: { codigo: 'expired_card' } })
  });
  const r = await pedir(app).get('/api/admin/pagos').set(auth('token-admin'));
  const por = Object.fromEntries(r.body.pagos.map(p => [p.id, p]));
  assert.deepEqual(por.in_a.motivo, { texto: 'Fondos insuficientes', significa: por.in_a.motivo.significa, queHacer: por.in_a.motivo.queHacer, categoria: 'fondos', codigo: 'insufficient_funds' });
  assert.ok(por.in_a.motivo.significa.length > 10 && por.in_a.motivo.queHacer.length > 10);
  assert.deepEqual([por.in_a.intentos, por.in_a.ultimoIntento, por.in_a.proximoIntento], [2, new Date(3500).toISOString(), new Date(9000).toISOString()]);
  assert.equal(por.in_b.motivo.texto, 'Tarjeta vencida');
  assert.equal(por.in_c.motivo, null, 'un rechazo viejo sin motivo guardado: aún no se conoce');
  assert.deepEqual([por.in_d.motivo, por.in_d.intentos], [null, 0], 'un pagado nunca muestra motivo');
  assert.ok(!/Your card|insufficient funds|has expired/i.test(JSON.stringify(r.body)), 'el inglés de Stripe no sale del servidor');
  assert.deepEqual([r.body.rechazos.total, r.body.rechazos.conMotivo, r.body.rechazos.sinMotivo], [3, 2, 1]);
  assert.deepEqual(r.body.rechazos.categorias.map(c => [c.clave, c.n]), [['fondos', 1], ['tarjeta', 1]]);
});

test('si la factura no trae payment_intent (API nueva), el motivo sale de los intentos de pago de la persona (el de esa factura)', async () => {
  const { sub, app, db, stripe } = conStripe();
  stripe.invoices = { retrieve: async (id, opciones) => { if (opciones && opciones.expand) throw new Error('This property cannot be expanded (payment_intent)'); return facturaRechazada(sub); } };
  const consultas = [];
  stripe.paymentIntents = { list: async q => { consultas.push(q); return { data: [
    intentoRechazado({ id: 'pi_otro', invoice: 'in_otra', last_payment_error: { code: 'expired_card', type: 'card_error' } }),
    intentoRechazado({ id: 'pi_este', invoice: 'in_mal' })
  ] }; } };
  await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub)));
  assert.deepEqual(consultas, [{ customer: 'cus_1', limit: 10, expand: ['data.latest_charge'] }]);
  assert.equal(doc(db, 'in_mal').motivo.declineCodigo, 'insufficient_funds');
  assert.ok(sinTarjeta(doc(db, 'in_mal')));
});

test('sin vínculo con la factura, se elige el intento rechazado más cercano en fecha y monto; si no hay, el cobro queda sin motivo', async () => {
  const { sub, app, db, stripe } = conStripe();
  stripe.invoices = { retrieve: async () => facturaRechazada(sub) };
  stripe.paymentIntents = { list: async () => ({ data: [
    intentoRechazado({ id: 'pi_lejos', created: unix(T0 - 20 * 86400000), last_payment_error: { code: 'expired_card' } }),
    intentoRechazado({ id: 'pi_monto', amount: 5000, last_payment_error: { code: 'lost_card' } }),
    intentoRechazado({ id: 'pi_ok', created: unix(T0 + 1000) })
  ] }) };
  await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub)));
  assert.equal(doc(db, 'in_mal').motivo.declineCodigo, 'insufficient_funds');
  const b = conStripe();
  b.stripe.invoices = { retrieve: async () => facturaRechazada(b.sub) };
  b.stripe.paymentIntents = { list: async () => ({ data: [intentoRechazado({ amount: 1, created: 1 })] }) };
  await enviar(b.app, evento('invoice.payment_failed', facturaRechazada(b.sub)));
  assert.equal(doc(b.db, 'in_mal').estado, 'fallido');
  assert.equal(doc(b.db, 'in_mal').motivo, undefined);
});

test('Stripe reintenta y vuelve a fallar: se ACTUALIZAN el motivo y los intentos del mismo cobro (no se duplica)', async () => {
  const { sub, app, db, stripe } = conStripe();
  let intento = 1;
  stripe.invoices = { retrieve: async () => ({ ...facturaRechazada(sub, { attempt_count: intento }), payment_intent: intento === 1 ? intentoRechazado() : intentoRechazado({ last_payment_error: { code: 'card_declined', decline_code: 'expired_card', type: 'card_error' }, latest_charge: { created: unix(T0 + 90000000), outcome: {} } }) }) };
  await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub)));
  assert.deepEqual([doc(db, 'in_mal').intentos, doc(db, 'in_mal').motivo.declineCodigo], [1, 'insufficient_funds']);
  const fechaOriginal = doc(db, 'in_mal').fechaMs;
  intento = 2;
  await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub, { attempt_count: 2 })));
  const p = doc(db, 'in_mal');
  assert.deepEqual([p.intentos, p.motivo.declineCodigo, p.ultimoIntentoMs], [2, 'expired_card', T0 + 90000000]);
  assert.equal(p.fechaMs, fechaOriginal, 'la fecha del cobro no cambia');
  assert.equal([...db._data.keys()].filter(k => k.startsWith('pagos/')).length, 1);
});

test('un cobro PAGADO jamás se toca: ni con un aviso de rechazo tardío, ni si se paga mientras se consulta el motivo', async () => {
  const { sub, app, db, stripe } = conStripe();
  await enviar(app, evento('invoice.payment_succeeded', factura(sub, { id: 'in_ok', billing_reason: 'subscription_cycle' })));
  stripe.invoices = { retrieve: async () => ({ ...facturaRechazada(sub, { id: 'in_ok' }), payment_intent: intentoRechazado() }) };
  await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub, { id: 'in_ok' })));
  assert.equal(doc(db, 'in_ok').estado, 'pagado');
  assert.equal(doc(db, 'in_ok').motivo, undefined);
  assert.equal(doc(db, 'in_ok').intentos, undefined);
  // carrera: el cobro se paga justo mientras se le pregunta a Stripe por el motivo
  const b = conStripe();
  b.stripe.invoices = { retrieve: async () => { await b.db.collection('pagos').doc('in_carrera').set({ ...doc(b.db, 'in_carrera'), estado: 'pagado', monto: 199 }); return { ...facturaRechazada(b.sub, { id: 'in_carrera' }), payment_intent: intentoRechazado() }; } };
  await enviar(b.app, evento('invoice.payment_failed', facturaRechazada(b.sub, { id: 'in_carrera' })));
  assert.equal(doc(b.db, 'in_carrera').estado, 'pagado');
  assert.equal(doc(b.db, 'in_carrera').motivo, undefined, 'no se le pega un motivo a un pago');
});

test('si Stripe falla o no responde al pedir el motivo, el aviso se atiende igual y el rechazo queda anotado sin motivo', async () => {
  const { sub, app, db, stripe } = conStripe();
  stripe.invoices = { retrieve: async () => { throw new Error('Stripe caído'); } };
  const silenciar = console.warn; console.warn = () => {};
  try {
    const r = await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub)));
    assert.equal(r.status, 200);
    assert.equal(doc(db, 'in_mal').estado, 'fallido');
    assert.equal(doc(db, 'in_mal').motivo, undefined);
    assert.equal(doc(db, 'in_mal').intentos, 1, 'los intentos salen del propio aviso');
    assert.equal(db.value('miembros/u1').planStatus, 'past_due');
    // una respuesta rara de Stripe (sin nada útil) tampoco rompe
    stripe.invoices = { retrieve: async () => null };
    assert.equal((await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub, { id: 'in_2' })))).status, 200);
    stripe.invoices = undefined;
    assert.equal((await enviar(app, evento('invoice.payment_failed', facturaRechazada(sub, { id: 'in_3' })))).status, 200);
    assert.equal(doc(db, 'in_3').estado, 'fallido');
  } finally { console.warn = silenciar; }
});

test('tiempo límite: una consulta a Stripe que nunca responde se corta y no deja colgado el registro', async () => {
  const db = new FakeFirestore();
  const stripe = { invoices: { retrieve: () => new Promise(() => {}) } };
  const svc = pagosSvc.crearServicio({ db, stripe, esSuscripcionPropia: async () => true, planDeFactura: () => 'mensual', subscriptionIdDe: i => i.subscription, tiempoStripeMs: 30 });
  const t0 = Date.now();
  const q = await svc.registrarCobro({ id: 'in_lento', subscription: 'sub_1', customer: 'cus_1', customer_email: 'a@b.c', amount_due: 19900, attempt_count: 1, created: unix(T0) }, 'fallido');
  assert.equal(q, 'creado');
  assert.ok(Date.now() - t0 < 2000, 'no esperó a Stripe');
  assert.equal(db.value('pagos/in_lento').estado, 'fallido');
  assert.equal(db.value('pagos/in_lento').motivo, undefined);
  const l = await svc.leerMotivo({ id: 'in_lento' });
  assert.match(l.error, /demasiado/);
});

test('«Traer pagos desde Stripe» completa el motivo de los rechazados que aún no lo tienen y dice cuántos completó', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'ana' });
  const { app, db, stripe } = servidorPanel({
    'pagos/in_1': pago('in_1', 1000, { estado: 'fallido', tipo: 'renov', customerId: 'cus_1' }), 'pagos/in_2': pago('in_2', 2000, { estado: 'fallido', tipo: 'renov', customerId: 'cus_1' }),
    'pagos/in_3': pago('in_3', 3000, { estado: 'fallido', tipo: 'renov', customerId: 'cus_1' }), 'pagos/in_4': pago('in_4', 4000, { estado: 'fallido', motivo: { codigo: 'expired_card' } }),
    'pagos/in_ok': pago('in_ok', 5000)
  });
  stripe.subscriptions.retrieve = async () => sub;
  const codigos = { in_1: 'insufficient_funds', in_2: 'expired_card', in_3: 'authentication_required' };
  const pedidas = [];
  stripe.invoices = {
    list: async () => ({ data: [] }),
    retrieve: async id => { pedidas.push(id); if (id === 'in_3') throw new Error('Stripe no responde'); return { ...facturaRechazada(sub, { id, attempt_count: 2 }), payment_intent: intentoRechazado({ last_payment_error: { code: 'card_declined', decline_code: codigos[id], type: 'card_error' } }) }; }
  };
  const silenciar = console.warn; console.warn = () => {};
  try {
    const r = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.motivosCompletados, r.body.motivosPendientes, r.body.motivosErrores], [2, 1, 1]);
    assert.deepEqual([...pedidas].sort(), ['in_1', 'in_2', 'in_3'], 'solo los que no tenían motivo; el que ya lo tenía y el pagado no se consultan');
    assert.equal(db.value('pagos/in_1').motivo.declineCodigo, 'insufficient_funds');
    assert.equal(db.value('pagos/in_1').intentos, 2);
    assert.equal(db.value('pagos/in_2').motivo.declineCodigo, 'expired_card');
    assert.equal(db.value('pagos/in_3').motivo, undefined, 'el que falló se queda pendiente y no frena a los demás');
    assert.equal(db.value('pagos/in_4').motivo.codigo, 'expired_card');
    assert.equal(db.value('pagos/in_ok').motivo, undefined);
    const acc = [...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).map(k => db.value(k)).find(a => a.accion === 'pagos-sincronizar');
    assert.match(acc.resumen, /2 motivos completados/);
    // una segunda pasada completa el que faltaba cuando Stripe ya responde
    stripe.invoices.retrieve = async id => ({ ...facturaRechazada(sub, { id }), payment_intent: intentoRechazado({ last_payment_error: { code: 'card_declined', decline_code: 'authentication_required' } }) });
    const r2 = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
    assert.deepEqual([r2.body.motivosCompletados, r2.body.motivosPendientes], [1, 0]);
  } finally { console.warn = silenciar; }
});

test('el relleno tiene tope por pasada (100) y avisa cuántos quedan pendientes', async () => {
  const seed = {};
  for (let i = 0; i < 105; i++) seed['pagos/in_m' + i] = pago('in_m' + i, 1000 + i, { estado: 'fallido', customerId: 'cus_1' });
  const sub = suscripcion({ id: 'sub_1', uid: 'ana' });
  const { app, stripe } = servidorPanel(seed);
  stripe.subscriptions.retrieve = async () => sub;
  stripe.invoices = { list: async () => ({ data: [] }), retrieve: async id => ({ ...facturaRechazada(sub, { id }), payment_intent: intentoRechazado() }) };
  const r = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
  assert.deepEqual([r.body.motivosCompletados, r.body.motivosPendientes], [pagosSvc.TOPE_MOTIVOS_POR_PASADA, 5]);
  assert.equal(pagosSvc.TOPE_MOTIVOS_POR_PASADA, 100);
});

test('«Traer pagos desde Stripe» también registra rechazos que no estaban: facturas abiertas con intentos fallidos de Zoorigen (no las de otra marca, ni sin intentos, ni pagadas)', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'ana' });
  const ajena = suscripcion({ id: 'sub_ajena', uid: 'x', precio: 'price_OtraMarcaAgroClub000001', sinMetadata: true });
  const { app, db, stripe } = servidorPanel();
  stripe.subscriptions.retrieve = async id => (id === 'sub_1' ? sub : ajena);
  const listas = [];
  stripe.invoices = {
    list: async q => {
      listas.push(q);
      if (q.status === 'paid') return { data: [] };
      if (!q.starting_after) return { has_more: true, data: [facturaRechazada(sub, { id: 'in_n1' }), facturaRechazada(ajena, { id: 'in_ajena', subscription: 'sub_ajena', lines: { data: [{ price: { id: 'price_OtraMarcaAgroClub000001' } }] } })] };
      return { has_more: false, data: [facturaRechazada(sub, { id: 'in_n2', attempt_count: 3 }), facturaRechazada(sub, { id: 'in_sin', attempt_count: 0 }), { ...facturaRechazada(sub, { id: 'in_pagada' }), status: 'paid' }] };
    },
    retrieve: async id => ({ ...facturaRechazada(sub, { id }), payment_intent: intentoRechazado() })
  };
  const r = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.fallidosNuevos, 2);
  assert.deepEqual(listas.filter(q => q.status === 'open'), [{ status: 'open', limit: 100 }, { status: 'open', limit: 100, starting_after: 'in_ajena' }], 'pagina de 100 en 100');
  assert.deepEqual([db.value('pagos/in_n1').estado, db.value('pagos/in_n2').estado], ['fallido', 'fallido']);
  assert.equal(db.value('pagos/in_n2').intentos, 3);
  assert.equal(db.value('pagos/in_n1').motivo.declineCodigo, 'insufficient_funds', 'y de una vez trae su motivo');
  for (const id of ['in_ajena', 'in_sin', 'in_pagada']) assert.equal(db.value('pagos/' + id), undefined, id);
  assert.equal(r.body.motivosCompletados, 0, 'los recién traídos ya traen su motivo');
});

test('si Stripe falla al listar facturas abiertas, la sincronización de pagados sigue y cuenta el error', async () => {
  const sub = suscripcion({ id: 'sub_1', uid: 'ana' });
  const { app, stripe } = servidorPanel();
  stripe.subscriptions.retrieve = async () => sub;
  stripe.invoices = { list: async q => { if (q.status === 'open') throw new Error('límite de Stripe'); return { data: [factura(sub, { id: 'in_ok2' })] }; } };
  const silenciar = console.warn; console.warn = () => {};
  try {
    const r = await pedir(app).post('/api/admin/pagos/sincronizar').set(auth('token-admin')).send({});
    assert.deepEqual([r.status, r.body.nuevos, r.body.errores], [200, 1, 1]);
  } finally { console.warn = silenciar; }
});
