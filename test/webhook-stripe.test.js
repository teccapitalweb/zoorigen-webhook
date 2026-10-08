'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, suscripcion, ts, dias, PRICE_ANUAL } = require('./helpers/cargar-servidor');

const evento = (type, object) => ({ id: 'evt_1', type, data: { object } });
const enviar = (app, ev, firma = 'firma-valida') =>
  request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', firma).send(JSON.stringify(ev));

const sesion = (extra = {}) => ({
  id: 'cs_1', payment_status: 'paid', subscription: 'sub_1',
  customer_email: 'ana@example.com', metadata: { firebaseUID: 'u1', planType: 'mensual' }, ...extra
});

test('GET / responde el health check', async () => {
  const { app } = cargarServidor();
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'OK');
});

test('webhook rechaza una firma inválida', async () => {
  const { app, db } = cargarServidor();
  const res = await enviar(app, evento('checkout.session.completed', sesion()), 'firma-falsa');
  assert.equal(res.status, 400);
  assert.equal(db.value('miembros/u1'), undefined);
});

test('checkout.session.completed activa el plan en miembros y usuarios', async () => {
  const { app, db } = cargarServidor({ suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })] });
  const res = await enviar(app, evento('checkout.session.completed', sesion()));
  assert.equal(res.status, 200);

  const miembro = db.value('miembros/u1');
  assert.equal(miembro.planActivo, true);
  assert.equal(miembro.planStatus, 'active');
  assert.equal(miembro.planTipo, 'mensual');
  assert.equal(miembro.stripeSubscriptionId, 'sub_1');
  assert.ok(miembro.planVence.toMillis() > Date.now());
  assert.ok(miembro.ultimoPago && miembro.planInicio);

  const usuario = db.value('usuarios/u1');
  assert.equal(usuario.planActivo, true);
  assert.equal(usuario.tipoPlan, 'mensual');
  assert.ok(usuario.fechaExpiracion.toMillis() > Date.now());
});

test('el precio anual se guarda como plan anual', async () => {
  const { app, db } = cargarServidor({ suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', precio: PRICE_ANUAL, terminaEn: dias(360) })] });
  await enviar(app, evento('checkout.session.completed', sesion({ metadata: { firebaseUID: 'u1', planType: 'anual' } })));
  assert.equal(db.value('miembros/u1').planTipo, 'anual');
});

test('checkout sin pago confirmado NO activa nada', async () => {
  const { app, db } = cargarServidor({ suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })] });
  const res = await enviar(app, evento('checkout.session.completed', sesion({ payment_status: 'unpaid' })));
  assert.equal(res.status, 200);
  assert.equal(db.value('miembros/u1'), undefined);
});

test('checkout sin firebaseUID responde 500 para que Stripe reintente', async () => {
  const { app } = cargarServidor({ suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })] });
  const res = await enviar(app, evento('checkout.session.completed', sesion({ metadata: {} })));
  assert.equal(res.status, 500);
});

test('renovación (invoice.payment_succeeded) extiende el acceso', async () => {
  const { app, db } = cargarServidor({
    seed: { 'miembros/u1': { planActivo: true, planVence: ts(dias(1)), stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', terminaEn: dias(31) })]
  });
  const res = await enviar(app, evento('invoice.payment_succeeded', { subscription: 'sub_1', billing_reason: 'subscription_cycle' }));
  assert.equal(res.status, 200);
  const miembro = db.value('miembros/u1');
  assert.ok(miembro.planVence.toMillis() > dias(30));
  assert.ok(miembro.ultimoPago);
});

test('la primera factura (subscription_create) se ignora para no duplicar', async () => {
  const { app, db } = cargarServidor({ suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })] });
  await enviar(app, evento('invoice.payment_succeeded', { subscription: 'sub_1', billing_reason: 'subscription_create' }));
  assert.equal(db.value('miembros/u1'), undefined);
});

test('pago fallido suspende la membresía (past_due)', async () => {
  const { app, db } = cargarServidor({
    seed: { 'miembros/u1': { planActivo: true, stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })]
  });
  const res = await enviar(app, evento('invoice.payment_failed', { subscription: 'sub_1' }));
  assert.equal(res.status, 200);
  const miembro = db.value('miembros/u1');
  assert.equal(miembro.planStatus, 'past_due');
  assert.equal(miembro.planActivo, false);
});

test('cancelar al final del periodo conserva el acceso (cancelled_active)', async () => {
  const { app, db } = cargarServidor({ suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', cancelAlFinal: true })] });
  const res = await enviar(app, evento('customer.subscription.updated', suscripcion({ id: 'sub_1', uid: 'u1', cancelAlFinal: true })));
  assert.equal(res.status, 200);
  const miembro = db.value('miembros/u1');
  assert.equal(miembro.planStatus, 'cancelled_active');
  assert.equal(miembro.planActivo, true);
  assert.equal(miembro.planCancelado, true);
});

test('suscripción eliminada deja la membresía vencida', async () => {
  const eliminada = suscripcion({ id: 'sub_1', uid: 'u1', status: 'canceled' });
  const { app, db } = cargarServidor({ seed: { 'miembros/u1': { planActivo: true } } });
  const res = await enviar(app, evento('customer.subscription.deleted', eliminada));
  assert.equal(res.status, 200);
  const miembro = db.value('miembros/u1');
  assert.equal(miembro.planActivo, false);
  assert.equal(miembro.planStatus, 'expired');
  assert.ok(miembro.canceladoEn);
  assert.ok(db.value('usuarios/u1').fechaCancelacion);
});

test('eventos desconocidos se confirman sin error', async () => {
  const { app } = cargarServidor();
  const res = await enviar(app, evento('charge.refunded', {}));
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
});

test('suscripción sin miembro localizable responde 500 (reintento de Stripe)', async () => {
  const { app } = cargarServidor();
  const res = await enviar(app, evento('customer.subscription.updated', suscripcion({ id: 'sub_x', uid: 'u1', sinMetadata: true })));
  assert.equal(res.status, 500);
});
