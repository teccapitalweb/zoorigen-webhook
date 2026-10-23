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
  assert.deepEqual(Object.keys(r.body.pagos[0]).sort(), ['correo', 'estado', 'fecha', 'id', 'moneda', 'monto', 'nombre', 'plan', 'tipo', 'uid']);
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
  assert.deepEqual(consultas, [{ subscription: 'sub_1', status: 'paid', limit: 100 }]);
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
