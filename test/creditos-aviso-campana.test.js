'use strict';

// Aviso en la CAMPANA del Club por cada regalo de créditos: GET /api/creditos/regalos (ligera, solo de la cuenta que pregunta).
// Ejecutar: node --test test/creditos-aviso-campana.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroSinPlan, auth, tokensDe, ts } = require('./helpers/club');
const creditos = require('../services/creditos');

const tokens = tokensDe('ana', 'otra', 'admin');
function servidor(seed = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      tokens,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, otra: { emailVerified: true, email: 'otra@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }),
        'miembros/otra': miembroSinPlan({ name: 'Otra', email: 'otra@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin', email: 'admin@example.com' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
let n = 0;
const op = () => 'operacion-aviso-' + String(++n).padStart(6, '0');
const regalar = (app, uid, cantidad = 100, clave = op()) => request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid, clave, cantidad });
const regalos = (app, t = 'token-ana') => request(app).get('/api/creditos/regalos').set(auth(t));
const DIA = 86400000;
const mov = (uid, cantidad, hace, extra = {}) => ({ tipo: 'regalo', uid, cantidad, adminUid: 'admin', adminCorreo: 'admin@example.com', en: ts(Date.now() - hace), operacion: 'x', ...extra });

test('sin sesión 401; con sesión y sin regalos, lista vacía', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/creditos/regalos')).status, 401);
  const r = await regalos(app);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.regalos, r.body.dias], [true, [], 30]);
});

test('un regalo del administrador aparece con id estable, cantidad y fecha; sin datos del administrador', async () => {
  const { app, db } = servidor();
  const g = await regalar(app, 'ana', 300);
  assert.equal(g.status, 200);
  const r = await regalos(app);
  assert.equal(r.body.regalos.length, 1);
  const x = r.body.regalos[0];
  assert.deepEqual(Object.keys(x).sort(), ['cantidad', 'en', 'id']);
  assert.equal(x.cantidad, 300);
  assert.ok(Math.abs(Date.parse(x.en) - Date.now()) < 60000);
  assert.ok(db.value('creditosMovimientos/' + x.id), 'el id es el del movimiento del libro');
  assert.ok(!JSON.stringify(r.body).includes('admin@'), 'no filtra el correo del administrador');
  // Estable: preguntar otra vez da el mismo id
  assert.equal((await regalos(app)).body.regalos[0].id, x.id);
});

test('un doble clic del administrador (misma clave) no duplica el aviso; dos regalos distintos son dos avisos, el más nuevo primero', async () => {
  const { app } = servidor();
  const clave = op();
  await regalar(app, 'ana', 100, clave); await regalar(app, 'ana', 100, clave);
  assert.equal((await regalos(app)).body.regalos.length, 1);
  await regalar(app, 'ana', 250);
  const lista = (await regalos(app)).body.regalos;
  assert.deepEqual(lista.map(r => r.cantidad).sort((a, b) => a - b), [100, 250]);
  assert.equal(new Set(lista.map(r => r.id)).size, 2);
  assert.ok(Date.parse(lista[0].en) >= Date.parse(lista[1].en));
});

test('solo ve sus regalos: otra cuenta y el administrador reciben lista vacía', async () => {
  const { app } = servidor();
  await regalar(app, 'ana', 200);
  assert.deepEqual((await regalos(app, 'token-otra')).body.regalos, []);
  assert.deepEqual((await regalos(app, 'token-admin')).body.regalos, []);
  assert.equal((await regalos(app, 'token-ana')).body.regalos.length, 1);
});

test('siguen apareciendo aunque ya se haya visto la tarjeta de felicitación (no dependen del aviso pendiente)', async () => {
  const { app } = servidor();
  await regalar(app, 'ana', 100);
  assert.equal((await request(app).post('/api/creditos/aviso-visto').set(auth('token-ana')).send({})).status, 200);
  const e = await request(app).get('/api/creditos/estado').set(auth('token-ana'));
  assert.equal(e.body.avisoPendiente, 0);
  assert.equal((await regalos(app)).body.regalos.length, 1);
});

test('solo los últimos 30 días, solo regalos (no canjes ni movimientos raros) y máximo 10', async () => {
  const seed = {
    'creditosMovimientos/viejo': mov('ana', 100, 31 * DIA),
    'creditosMovimientos/limite': mov('ana', 100, 29 * DIA),
    'creditosMovimientos/canje': { tipo: 'canje', uid: 'ana', clave: 'pdf:x', costo: 100, en: ts(Date.now() - 1000) },
    'creditosMovimientos/rara': mov('ana', 'mucho', 1000),
    'creditosMovimientos/negativa': mov('ana', -50, 1000),
    'creditosMovimientos/ajena': mov('otra', 500, 1000)
  };
  for (let i = 0; i < 12; i++) seed['creditosMovimientos/n' + i] = mov('ana', 10 + i, (i + 1) * 3600000);
  const { app } = servidor(seed);
  const lista = (await regalos(app)).body.regalos;
  assert.equal(lista.length, 10, 'máximo 10');
  assert.ok(lista.every(r => /^n\d+$/.test(r.id)), 'solo los más recientes');
  const { app: app2 } = servidor({ 'creditosMovimientos/viejo': mov('ana', 100, 31 * DIA), 'creditosMovimientos/limite': mov('ana', 120, 29 * DIA), 'creditosMovimientos/canje': { tipo: 'canje', uid: 'ana', en: ts(Date.now()) } });
  assert.deepEqual((await regalos(app2)).body.regalos.map(r => r.id), ['limite']);
});

test('servicio: leerRegalosRecientes valida el uid y respeta la ventana', async () => {
  const { db } = servidor({ 'creditosMovimientos/a': mov('ana', 100, 5 * DIA) });
  assert.deepEqual(await creditos.leerRegalosRecientes(db, '../x'), []);
  assert.equal((await creditos.leerRegalosRecientes(db, 'ana')).length, 1);
  assert.equal((await creditos.leerRegalosRecientes(db, 'ana', { dias: 2 })).length, 0);
  assert.equal(creditos.DIAS_AVISO_REGALO, 30);
});

test('compatibilidad: GET /api/creditos/estado no cambia (la campana usa su propia ruta)', async () => {
  const { app } = servidor();
  await regalar(app, 'ana', 100);
  const e = await request(app).get('/api/creditos/estado').set(auth('token-ana'));
  assert.equal(e.status, 200); assert.equal(e.body.saldo, 100); assert.equal(e.body.avisoPendiente, 100);
  assert.equal('regalos' in e.body, false);
});
