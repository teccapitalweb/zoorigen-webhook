'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { cargarServidor, suscripcion, ts, dias, VIDEO_GRATIS, VIDEO_PREMIUM } = require('./helpers/cargar-servidor');

const tokens = {
  'token-ana': { uid: 'u1', email: 'ana@example.com' },
  'token-admin': { uid: 'adm', email: 'admin@example.com' }
};
const auth = t => ({ Authorization: `Bearer ${t}` });
const verificar = (app, t = 'token-ana') => request(app).post('/verify-membership').set(auth(t)).send({});
const embed = (app, videoId, t = 'token-ana') => request(app).post('/api/bunny/embed-token').set(auth(t)).send({ videoId });

// ── /verify-membership: miembros sin Stripe (históricos) ───
test('verify-membership exige sesión', async () => {
  const { app } = cargarServidor({ tokens });
  assert.equal((await request(app).post('/verify-membership').send({})).status, 401);
});

test('un usuario sin documento no tiene acceso', async () => {
  const { app } = cargarServidor({ tokens });
  const res = await verificar(app);
  assert.equal(res.body.active, false);
  assert.equal(res.body.status, 'expired');
});

test('miembro vigente con fecha Timestamp tiene acceso', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, planVence: ts(dias(10)) } } });
  const res = await verificar(app);
  assert.equal(res.body.active, true);
  assert.equal(res.body.verifiedWithStripe, false);
});

test('miembro heredado de Shopify con fecha en TEXTO ISO sigue teniendo acceso', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: true, planVence: new Date(dias(10)).toISOString(), shopifyOrderId: 123 } }
  });
  const res = await verificar(app);
  assert.equal(res.body.active, true);
  assert.equal(res.body.source, 'shopify');
});

test('activación manual se reconoce como origen manual', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: true, planVence: ts(dias(10)), activadoManualmente: true } }
  });
  const res = await verificar(app);
  assert.equal(res.body.active, true);
  assert.equal(res.body.source, 'manual');
});

test('planActivo=true pero vencido NO da acceso (caso "activo falso")', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, planVence: ts(dias(-3)) } } });
  const res = await verificar(app);
  assert.equal(res.body.active, false);
});

test('planActivo=true sin fecha de vencimiento NO da acceso', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true } } });
  assert.equal((await verificar(app)).body.active, false);
});

// El servidor anterior (Shopify) guardaba las cancelaciones como planStatus:'cancelled'
// sin tocar planActivo. El miembro conserva el acceso hasta planVence (igual que el frontend).
const cancelacionHeredada = (extra = {}) => ({
  planActivo: true, planStatus: 'cancelled', planCancelado: true,
  planVence: ts(dias(15)), accesoHasta: ts(dias(15)), ...extra
});

test('cancelación heredada de Shopify conserva el acceso hasta planVence', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': cancelacionHeredada() } });
  const res = await verificar(app);
  assert.equal(res.body.active, true);
  assert.equal(res.body.status, 'cancelled_active');
});

test('cancelación heredada con fecha en texto ISO también conserva el acceso', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': cancelacionHeredada({ planVence: new Date(dias(15)).toISOString() }) } });
  assert.equal((await verificar(app)).body.active, true);
});

test('cancelación heredada YA VENCIDA no da acceso', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': cancelacionHeredada({ planVence: ts(dias(-2)) }) } });
  assert.equal((await verificar(app)).body.active, false);
});

test('cancelación heredada con planActivo=false (desactivado a mano) no da acceso', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': cancelacionHeredada({ planActivo: false }) } });
  assert.equal((await verificar(app)).body.active, false);
});

test('cancelación heredada vigente puede ver videos (antes se le negaba)', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': cancelacionHeredada() } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 200);
});

test('cancelación heredada vencida NO puede ver videos', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': cancelacionHeredada({ planVence: ts(dias(-2)) }) } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 403);
});

// ── /verify-membership: miembros con Stripe (fuente de verdad) ──
test('con Stripe activo, verify confirma y sincroniza Firestore', async () => {
  const { app, db } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: false, stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1' })]
  });
  const res = await verificar(app);
  assert.equal(res.body.active, true);
  assert.equal(res.body.source, 'stripe');
  assert.equal(res.body.verifiedWithStripe, true);
  assert.equal(db.value('miembros/u1').planActivo, true);
});

test('Stripe manda sobre Firestore: si Stripe canceló, se revoca el acceso', async () => {
  const { app, db } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: true, planVence: ts(dias(10)), stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'u1', status: 'canceled' })]
  });
  const res = await verificar(app);
  assert.equal(res.body.active, false);
  assert.equal(db.value('miembros/u1').planActivo, false);
});

test('suscripción de la cuenta Stripe anterior → 409 historical_subscription', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, stripeSubscriptionId: 'sub_vieja' } } });
  const res = await verificar(app);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'historical_subscription');
});

test('suscripción que pertenece a otro uid → 403', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { stripeSubscriptionId: 'sub_1' } },
    suscripciones: [suscripcion({ id: 'sub_1', uid: 'otro' })]
  });
  assert.equal((await verificar(app)).status, 403);
});

// ── Videos protegidos (Bunny) ──────────────────────────────
test('embed-token exige sesión', async () => {
  const { app } = cargarServidor({ tokens });
  const res = await request(app).post('/api/bunny/embed-token').send({ videoId: VIDEO_GRATIS });
  assert.equal(res.status, 401);
});

test('embed-token rechaza videos que no están en el catálogo', async () => {
  const { app } = cargarServidor({ tokens });
  assert.equal((await embed(app, 'no-existe')).status, 404);
});

test('la clase gratuita se entrega sin membresía', async () => {
  const { app } = cargarServidor({ tokens });
  const res = await embed(app, VIDEO_GRATIS);
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, true);
});

test('una clase de pago se niega a quien no es miembro', async () => {
  const { app } = cargarServidor({ tokens });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 403);
});

test('una clase de pago se niega con membresía vencida', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, planStatus: 'active', planVence: ts(dias(-1)) } } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 403);
});

test('una clase de pago se niega con pago fallido (past_due)', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, planStatus: 'past_due', planVence: ts(dias(10)) } } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 403);
});

test('miembro activo recibe un enlace firmado que caduca en 5 minutos', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, planStatus: 'active', planVence: ts(dias(10)) } } });
  const res = await embed(app, VIDEO_PREMIUM);
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, false);
  const url = new URL(res.body.embedUrl);
  const expires = Number(url.searchParams.get('expires'));
  assert.ok(expires - Math.floor(Date.now() / 1000) <= 300);
  const esperado = crypto.createHash('sha256').update('clave-bunny-de-prueba' + VIDEO_PREMIUM + expires).digest('hex');
  assert.equal(url.searchParams.get('token'), esperado);
  assert.ok(!res.body.embedUrl.includes('clave-bunny-de-prueba'), 'la clave secreta nunca debe viajar al navegador');
});

test('cancelled_active (cancelada pero pagada) todavía puede ver videos', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/u1': { planActivo: true, planStatus: 'cancelled_active', planVence: ts(dias(10)) } } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 200);
});

test('el acceso también se reconoce desde la colección espejo usuarios', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'usuarios/u1': { planActivo: true, planStatus: 'active', fechaExpiracion: ts(dias(10)) } } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 200);
});

test('un administrador ve todo sin membresía', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'admins/adm': { activo: true } } });
  assert.equal((await embed(app, VIDEO_PREMIUM, 'token-admin')).status, 200);
});

test('sin clave de Bunny configurada responde 503', async () => {
  const { app } = cargarServidor({ tokens, env: { BUNNY_TOKEN_AUTH_KEY: '' } });
  assert.equal((await embed(app, VIDEO_GRATIS)).status, 503);
});
