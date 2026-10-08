'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, suscripcion, PRICE_MENSUAL, PRICE_ANUAL } = require('./helpers/cargar-servidor');

const tokens = {
  'token-ana': { uid: 'u1', email: 'ana@example.com' },
  'token-sin-correo': { uid: 'u2' },
  'token-otro': { uid: 'u3', email: 'otro@example.com' }
};
const auth = t => ({ Authorization: `Bearer ${t}` });

// ── Crear sesión de pago ───────────────────────────────────
test('checkout exige sesión de Firebase', async () => {
  const { app } = cargarServidor({ tokens });
  assert.equal((await request(app).post('/create-checkout-session').send({})).status, 401);
  assert.equal((await request(app).post('/create-checkout-session').set(auth('falso')).send({})).status, 401);
});

test('checkout mensual usa el precio mensual y ata la compra al uid', async () => {
  const { app, registro } = cargarServidor({ tokens });
  const res = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'mensual' });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.test/pay');
  const cfg = registro.sesionesCreadas[0];
  assert.equal(cfg.mode, 'subscription');
  assert.equal(cfg.line_items[0].price, PRICE_MENSUAL);
  assert.equal(cfg.customer_email, 'ana@example.com');
  assert.equal(cfg.metadata.firebaseUID, 'u1');
  assert.equal(cfg.subscription_data.metadata.firebaseUID, 'u1');
  assert.ok(cfg.success_url.includes('club-gracias.html'));
});

test('checkout anual usa el precio anual', async () => {
  const { app, registro } = cargarServidor({ tokens });
  await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'anual' });
  assert.equal(registro.sesionesCreadas[0].line_items[0].price, PRICE_ANUAL);
});

test('un plan desconocido cae al mensual (no se puede forzar otro precio)', async () => {
  const { app, registro } = cargarServidor({ tokens });
  await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'gratis', priceId: 'price_barato' });
  assert.equal(registro.sesionesCreadas[0].line_items[0].price, PRICE_MENSUAL);
});

test('checkout embebido devuelve clientSecret', async () => {
  const { app, registro } = cargarServidor({ tokens });
  const res = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ embedded: true });
  assert.equal(res.body.clientSecret, 'cs_secret_test');
  assert.equal(registro.sesionesCreadas[0].ui_mode, 'embedded');
});

test('checkout rechaza cuentas sin correo', async () => {
  const { app } = cargarServidor({ tokens });
  const res = await request(app).post('/create-checkout-session').set(auth('token-sin-correo')).send({});
  assert.equal(res.status, 400);
});

test('NO cobra dos veces a quien ya tiene membresía vigente', async () => {
  const { app, registro } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })]
  });
  const res = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({});
  assert.equal(res.status, 409);
  assert.equal(registro.sesionesCreadas.length, 0);
});

test('permite volver a pagar si la suscripción anterior ya terminó', async () => {
  const { app, registro } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', status: 'canceled' })]
  });
  const res = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({});
  assert.equal(res.status, 200);
  assert.equal(registro.sesionesCreadas.length, 1);
});

test('permite pagar si la suscripción guardada es de la cuenta Stripe anterior', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { stripeSubscriptionId: 'sub_historica' } } });
  const res = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({});
  assert.equal(res.status, 200);
});

test('bloquea si la suscripción guardada pertenece a otro uid', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'otro-uid' })]
  });
  const res = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({});
  assert.equal(res.status, 403);
});

// ── Cancelar / reactivar ───────────────────────────────────
test('cancelar programa el fin de periodo y conserva el acceso', async () => {
  const { app, db, registro } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: true, stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })]
  });
  const res = await request(app).post('/cancel-subscription').set(auth('token-ana')).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.accesoHasta);
  assert.deepEqual(registro.actualizaciones[0].cambios, { cancel_at_period_end: true });
  const miembro = db.value('miembros/u1');
  assert.equal(miembro.planStatus, 'cancelled_active');
  assert.equal(miembro.planActivo, true);
  assert.ok(miembro.canceladoEn);
});

test('cancelar sin suscripción responde 404', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: false } } });
  const res = await request(app).post('/cancel-subscription').set(auth('token-ana')).send({});
  assert.equal(res.status, 404);
});

test('nadie puede cancelar la suscripción de otra persona', async () => {
  const { app, registro } = cargarServidor({
    tokens,
    seed: { 'miembros/u3': { stripeSubscriptionId: 'sub_ajena' } },
    suscripciones: [suscripcion({ id: 'sub_ajena', uid: 'u1' })]
  });
  const res = await request(app).post('/cancel-subscription').set(auth('token-otro')).send({});
  assert.equal(res.status, 403);
  assert.equal(registro.actualizaciones.length, 0);
});

test('reactivar quita la cancelación programada', async () => {
  const { app, db } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: true, stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', cancelAlFinal: true })]
  });
  const res = await request(app).post('/reactivate-subscription').set(auth('token-ana')).send({});
  assert.equal(res.status, 200);
  assert.equal(db.value('miembros/u1').planStatus, 'active');
  assert.ok(db.value('miembros/u1').reanudadoEn);
});

test('no se puede reactivar una suscripción ya terminada', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', status: 'canceled' })]
  });
  const res = await request(app).post('/reactivate-subscription').set(auth('token-ana')).send({});
  assert.equal(res.status, 409);
});
