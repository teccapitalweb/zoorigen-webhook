'use strict';

// El formulario de pago de Stripe debe ofrecer «Agregar código» (promoción) tanto embebido como con redirección.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroSinPlan, auth, tokensDe } = require('./helpers/club');

const servidor = () => cargarServidor({ tokens: tokensDe('ana'), seed: { 'miembros/ana': miembroSinPlan() } });

test('create-checkout-session embebido permite códigos de promoción y devuelve el clientSecret', async () => {
  const { app, registro } = servidor();
  const r = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'anual', embedded: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.clientSecret, 'cs_secret_test');
  const sesion = registro.sesionesCreadas[0];
  assert.equal(sesion.ui_mode, 'embedded');
  assert.equal(sesion.allow_promotion_codes, true);
  assert.equal(sesion.mode, 'subscription');
});

test('create-checkout-session con redirección también permite códigos', async () => {
  const { app, registro } = servidor();
  const r = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'mensual' });
  assert.equal(r.status, 200);
  assert.ok(r.body.url);
  assert.equal(registro.sesionesCreadas[0].allow_promotion_codes, true);
});
