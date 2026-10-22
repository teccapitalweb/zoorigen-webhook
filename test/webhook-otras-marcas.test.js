'use strict';

// La cuenta de Stripe es COMPARTIDA con otras marcas del mismo dueño: Stripe manda a este servidor avisos que no son de Zoorigen.
// Estos avisos se ignoran (200) y se cuentan; los de Zoorigen sin miembro siguen siendo error real (ALTA PRIORIDAD);
// los que no traen precio se conservan como siempre (500) pero se anotan "por revisar", no como error.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, suscripcion, PRICE_MENSUAL, PRICE_ANUAL } = require('./helpers/cargar-servidor');

const evento = (type, object) => ({ id: 'evt_1', type, data: { object } });
const enviar = (app, ev) => request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', 'firma-valida').send(JSON.stringify(ev));

const OTRA = 'price_OtraMarcaAgroClub000001';
const subAjena = (id = 'sub_ajena0001ABCD') => suscripcion({ id, uid: 'nadie', precio: OTRA, sinMetadata: true });
const subZoo = (id = 'sub_zoorigen001WXYZ', precio = PRICE_MENSUAL) => suscripcion({ id, uid: 'nadie', precio, sinMetadata: true });
const subSinPrecios = id => ({ ...suscripcion({ id, uid: 'nadie', sinMetadata: true }), items: { data: [] } });
const factura = (sub, extra = {}) => ({ id: 'in_1', subscription: sub.id, lines: { data: sub.items.data.map(i => ({ price: i.price })) }, ...extra });

// Captura lo que el servidor escribe en la consola durante una prueba
async function conConsola(fn) {
  const errores = []; const avisos = [];
  const e = console.error; const w = console.warn; const escribir = process.stderr.write;
  // Se sigue llamando al console.error original (que lleva la bitácora en memoria) pero sin ensuciar la salida de la prueba
  console.error = (...a) => { errores.push(a.map(String).join(' ')); process.stderr.write = () => true; try { e.apply(console, a); } finally { process.stderr.write = escribir; } };
  console.warn = (...a) => { avisos.push(a.map(String).join(' ')); };
  try { return { ...(await fn()), errores, avisos }; } finally { console.error = e; console.warn = w; process.stderr.write = escribir; }
}

const TIPOS = [
  ['invoice.payment_failed', s => factura(s)],
  ['invoice.payment_succeeded', s => factura(s)],
  ['customer.subscription.updated', s => s],
  ['customer.subscription.deleted', s => s]
];

for (const [tipo, objeto] of TIPOS) {
  test(`${tipo} de OTRA marca: responde 200, no toca miembros y se cuenta como ignorado (no como error)`, async () => {
    const sub = subAjena();
    const { app, db } = cargarServidor({ suscripciones: [sub], seed: { 'miembros/ana': { name: 'Ana', planActivo: true } } });
    const r = await conConsola(async () => ({ res: await enviar(app, evento(tipo, objeto(sub))) }));
    assert.equal(r.res.status, 200);
    assert.deepEqual(r.res.body, { received: true });
    assert.equal(r.errores.length, 0, 'sin console.error: ' + r.errores.join(' | '));
    assert.equal(db.value('miembros/ana').planActivo, true);
    await app.bitacoraServidor.vaciar();
    const doc = [...db._data.entries()].find(([k]) => k.startsWith('servidorEventos/ignorado-'));
    assert.ok(doc, 'queda un contador diario de ignorados');
    assert.equal(doc[1].cuenta, 1);
    assert.equal(doc[1].tipos[tipo], 1);
    // el último aviso recibido no cuenta como de Zoorigen
    const stripe = db.value('servidorEstado/stripe');
    assert.equal(stripe.ultimoTipo, tipo);
    assert.ok(!stripe.ultimoZoorigenEn, 'no cuenta como último aviso de Zoorigen');
  });

  test(`${tipo} de ZOORIGEN sin miembro: sigue siendo error real (500, mismo mensaje) y de ALTA PRIORIDAD`, async () => {
    const sub = subZoo();
    const { app } = cargarServidor({ suscripciones: [sub] });
    const r = await conConsola(async () => ({ res: await enviar(app, evento(tipo, objeto(sub))) }));
    assert.equal(r.res.status, 500);
    assert.equal(r.errores.length >= 1, true);
    assert.match(r.errores.join('\n'), /ALTA PRIORIDAD/);
    assert.match(r.errores.join('\n'), /No se encontró miembro para/);
  });

  test(`${tipo} sin precios que lo identifiquen: se conserva el 500 de siempre pero se anota POR REVISAR, no como error`, async () => {
    const sub = subSinPrecios('sub_sinprecios0001');
    const { app, db } = cargarServidor({ suscripciones: [sub] });
    const obj = tipo.startsWith('invoice') ? { id: 'in_2', subscription: sub.id, lines: { data: [] } } : sub;
    const r = await conConsola(async () => ({ res: await enviar(app, evento(tipo, obj)) }));
    assert.equal(r.res.status, 500);
    assert.equal(r.errores.filter(x => /Error procesando evento/.test(x)).length, 0, 'no se escribe como error');
    assert.match(r.avisos.join('\n'), /por revisar/);
    await app.bitacoraServidor.vaciar();
    const e = [...db._data.entries()].find(([k]) => k.startsWith('servidorErrores/'));
    assert.equal(e[1].nivel, 'revisar');
  });
}

test('checkout.session.completed sin firebaseUID: de otra marca se ignora (200); de Zoorigen sigue siendo error; sin datos, por revisar', async () => {
  const ajena = subAjena('sub_ajena0002ABCD');
  const zoo = subZoo('sub_zoorigen002WXYZ', PRICE_ANUAL);
  const { app, db } = cargarServidor({ suscripciones: [ajena, zoo] });
  const sesion = (sub, extra = {}) => ({ id: 'cs_9', payment_status: 'paid', subscription: sub && sub.id, customer_email: 'x@example.com', metadata: {}, ...extra });
  const a = await conConsola(async () => ({ res: await enviar(app, evento('checkout.session.completed', sesion(ajena))) }));
  assert.equal(a.res.status, 200);
  assert.equal(a.errores.length, 0);
  const b = await conConsola(async () => ({ res: await enviar(app, evento('checkout.session.completed', sesion(zoo))) }));
  assert.equal(b.res.status, 500);
  assert.match(b.errores.join('\n'), /ALTA PRIORIDAD/);
  assert.match(b.errores.join('\n'), /Checkout sin firebaseUID o subscriptionId/);
  const c = await conConsola(async () => ({ res: await enviar(app, evento('checkout.session.completed', sesion(null, { subscription: null }))) }));
  assert.equal(c.res.status, 500);
  assert.match(c.avisos.join('\n'), /por revisar/);
  assert.equal(db.value('miembros/nadie'), undefined);
});

test('un aviso de Zoorigen con miembro sigue procesándose igual y queda como último aviso de Zoorigen', async () => {
  const sub = suscripcion({ id: 'sub_ok0001ZZZZ', uid: 'u1' });
  const { app, db } = cargarServidor({ suscripciones: [sub] });
  const res = await enviar(app, evento('customer.subscription.updated', sub));
  assert.equal(res.status, 200);
  assert.equal(db.value('miembros/u1').planActivo, true);
  await app.bitacoraServidor.vaciar();
  const stripe = db.value('servidorEstado/stripe');
  assert.equal(stripe.ultimoZoorigenTipo, 'customer.subscription.updated');
  assert.ok(stripe.ultimoZoorigenEn);
});

test('los precios históricos de STRIPE_PRICES_HISTORICOS también cuentan como de Zoorigen', async () => {
  const sub = suscripcion({ id: 'sub_viejo001ABCD', uid: 'nadie', precio: 'price_ViejoDeZoorigen9', sinMetadata: true });
  const { app } = cargarServidor({ suscripciones: [sub], env: { STRIPE_PRICES_HISTORICOS: 'price_ViejoDeZoorigen9, price_OtroViejo' } });
  const r = await conConsola(async () => ({ res: await enviar(app, evento('customer.subscription.updated', sub)) }));
  assert.equal(r.res.status, 500, 'es de Zoorigen y no hay miembro');
  assert.match(r.errores.join('\n'), /ALTA PRIORIDAD/);
});

test('el servidor nunca deja ids de Stripe completos en lo que guarda de los errores', async () => {
  const sub = subZoo('sub_1SabcDEF123456xyz9');
  const { app, db } = cargarServidor({ suscripciones: [sub] });
  await conConsola(async () => ({ res: await enviar(app, evento('customer.subscription.deleted', sub)) }));
  await app.bitacoraServidor.vaciar();
  const textos = JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('servidorErrores/')));
  assert.ok(textos.includes('sub_…xyz9'), 'se conservan solo los últimos 4');
  assert.equal(textos.includes('sub_1SabcDEF123456xyz9'), false);
});
