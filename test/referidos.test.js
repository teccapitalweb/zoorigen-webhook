'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, ts, dias } = require('./helpers/cargar-servidor');

// uid 'abcdef123' → código ZOO-ABCDEF (igual que club-referidos.html)
const tokens = {
  'token-ana': { uid: 'abcdef123', email: 'ana@example.com' },
  'token-otro': { uid: 'zzzzzz999', email: 'otro@example.com' }
};
const auth = t => ({ Authorization: `Bearer ${t}` });
const pedir = (app, t = 'token-ana', body = {}) => request(app).post('/api/referidos').set(auth(t)).send(body);

const seed = {
  'miembros/abcdef123': { name: 'Ana Pérez', email: 'ana@example.com' },
  'miembros/inv1': { name: 'Luis Gómez Ruiz', email: 'luis@example.com', phone: '2361110000', referredBy: 'ZOO-ABCDEF', createdAt: '2026-09-01T00:00:00.000Z', planActivo: true, planVence: ts(dias(10)) },
  'miembros/inv2': { name: 'María', email: 'maria@example.com', referredBy: 'ZOO-ABCDEF', createdAt: '2026-09-02T00:00:00.000Z', planActivo: false },
  'miembros/inv3': { nombreCompleto: 'Pedro Sánchez', email: 'pedro@example.com', referredBy: 'ZOO-ABCDEF', planActivo: true, planVence: ts(dias(5)) },
  'miembros/inv4': { name: 'Sin Pago', referredBy: 'ZOO-ABCDEF', planActivo: true, planVence: ts(dias(-5)) },
  'miembros/ajeno': { name: 'Invitado Ajeno', email: 'ajeno@example.com', referredBy: 'ZOO-ZZZZZZ', planActivo: true, planVence: ts(dias(10)) }
};

test('referidos exige sesión de Firebase', async () => {
  const { app } = cargarServidor({ tokens, seed });
  assert.equal((await request(app).post('/api/referidos').send({})).status, 401);
  assert.equal((await pedir(app, 'falso')).status, 401);
});

test('devuelve solo los invitados con el código del miembro autenticado', async () => {
  const { app } = cargarServidor({ tokens, seed });
  const res = await pedir(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.refCode, 'ZOO-ABCDEF');
  assert.equal(res.body.totalInvitados, 4);
  assert.ok(!JSON.stringify(res.body).includes('Ajeno'));
});

test('cuenta como pagados solo a los que tienen acceso vigente', async () => {
  const { app } = cargarServidor({ tokens, seed });
  const res = await pedir(app);
  assert.equal(res.body.totalPagados, 2);
  assert.equal(res.body.mesesGanados, 0);
});

test('3 invitados pagados = 1 mes ganado', async () => {
  const extra = { ...seed, 'miembros/inv5': { name: 'Otro', referredBy: 'ZOO-ABCDEF', planActivo: true, planVence: ts(dias(9)) } };
  const { app } = cargarServidor({ tokens, seed: extra });
  const res = await pedir(app);
  assert.equal(res.body.totalPagados, 3);
  assert.equal(res.body.mesesGanados, 1);
});

test('NUNCA expone correo ni teléfono de los invitados', async () => {
  const { app } = cargarServidor({ tokens, seed });
  const texto = JSON.stringify((await pedir(app)).body);
  for (const secreto of ['@example.com', '2361110000', 'email', 'phone']) {
    assert.ok(!texto.includes(secreto), `no debe aparecer ${secreto}`);
  }
});

test('solo entrega el nombre de pila', async () => {
  const { app } = cargarServidor({ tokens, seed });
  const nombres = (await pedir(app)).body.invitados.map(i => i.nombre).sort();
  assert.deepEqual(nombres, ['Luis', 'María', 'Pedro', 'Sin'].sort());
});

test('no se puede espiar el código de otra persona enviándolo en el cuerpo', async () => {
  const { app } = cargarServidor({ tokens, seed });
  const res = await pedir(app, 'token-ana', { refCode: 'ZOO-ZZZZZZ', referredBy: 'ZOO-ZZZZZZ' });
  assert.equal(res.body.refCode, 'ZOO-ABCDEF');
  assert.ok(!JSON.stringify(res.body).includes('Ajeno'));
});

test('un miembro sin invitados recibe ceros', async () => {
  const { app } = cargarServidor({ tokens, seed });
  const res = await pedir(app, 'token-otro');
  assert.equal(res.body.totalInvitados, 1); // su invitado 'ajeno'
  const { app: app2 } = cargarServidor({ tokens, seed: { 'miembros/zzzzzz999': { name: 'Solo' } } });
  const vacio = await pedir(app2, 'token-otro');
  assert.deepEqual([vacio.body.totalInvitados, vacio.body.totalPagados, vacio.body.mesesGanados], [0, 0, 0]);
});

test('el propio miembro no cuenta como su invitado', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'miembros/abcdef123': { name: 'Ana', referredBy: 'ZOO-ABCDEF' } } });
  assert.equal((await pedir(app)).body.totalInvitados, 0);
});

test('la respuesta no se guarda en caché', async () => {
  const { app } = cargarServidor({ tokens, seed });
  assert.equal((await pedir(app)).headers['cache-control'], 'no-store');
});
