'use strict';

// Configuración del panel: precios vigentes (solo lectura), contacto, estado de servicios e historial del servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const { ts, dias, PRICE_MENSUAL, PRICE_ANUAL } = require('./helpers/cargar-servidor');
const contacto = require('../services/contacto');

const tokens = { ...tokensDe('ana', 'beto'), 'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true } };
const montar = (extra = {}, env = {}) => cargarServidor({
  tokens, env,
  seed: {
    'miembros/admin': miembroSinPlan({ name: 'Admin', role: 'admin' }),
    'miembros/ana': miembroConPlan({ name: 'Ana', stripeSubscriptionStatus: 'active' }),
    'miembros/beto': miembroSinPlan({ name: 'Beto' }),
    ...extra
  }
});
const get = (app, ruta, t = 'token-admin') => request(app).get(ruta).set(auth(t));
async function conEnv(vars, fn) {
  const previo = {};
  for (const k of ['STRIPE_SECRET_KEY', 'CERTIFICATE_SIGNING_KEY', 'RESEND_API_KEY', 'BUNNY_TOKEN_AUTH_KEY', 'BUNNY_API_KEY']) { previo[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const post = (app, ruta, cuerpo, t = 'token-admin') => request(app).post(ruta).set(auth(t)).send(cuerpo || {});

const ADMIN_GET = ['/api/admin/precios', '/api/admin/contacto', '/api/admin/servicios', '/api/admin/servidor/historial'];
const ADMIN_POST = ['/api/admin/contacto', '/api/admin/servidor/reconocer-reinicios'];

test('control de acceso: visitante 401, miembro 403, y nada se guarda', async () => {
  const { app, db } = montar();
  for (const r of ADMIN_GET) {
    assert.equal((await request(app).get(r)).status, 401, r);
    const m = await get(app, r, 'token-ana');
    assert.equal(m.status, 403, r);
    assert.deepEqual(Object.keys(m.body), ['error'], r);
  }
  for (const r of ADMIN_POST) {
    assert.equal((await request(app).post(r).send({})).status, 401, r);
    assert.equal((await post(app, r, { whatsapp: '+52 1 236 111 3237', instagram: '@a', correo: 'a@b.mx' }, 'token-ana')).status, 403, r);
  }
  assert.equal(db.value('config/contacto'), undefined);
  assert.equal([...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).length, 0);
});

/* ───────── precios ───────── */

test('GET /api/admin/precios: precios vigentes de solo lectura, sin ids completos ni claves', async () => {
  const { app } = montar();
  const r = await conEnv({ STRIPE_SECRET_KEY: 'sk_test_VALOR_SECRETO_PRECIOS' }, () => get(app, '/api/admin/precios'));
  assert.equal(r.status, 200);
  assert.equal(r.body.soloLectura, true);
  assert.deepEqual(r.body.planes.map(p => [p.plan, p.monto, p.moneda, p.cobro]), [['mensual', 199, 'mxn', 'cada mes'], ['anual', 1899, 'mxn', 'cada año']]);
  assert.equal(r.body.planes[0].origen, 'lista', 'sin Stripe real se muestra el precio de lista');
  assert.equal(r.body.modo, 'prueba');
  const t = JSON.stringify(r.body);
  assert.equal(t.includes(PRICE_MENSUAL) || t.includes(PRICE_ANUAL) || /VALOR_SECRETO|sk_test/.test(t), false);
  assert.equal(r.body.planes[0].idCorto, '…' + PRICE_MENSUAL.slice(-4));
  assert.match(r.body.nota, /cuenta compartida/);
});

test('no existe ninguna ruta para cambiar precios', async () => {
  const { app } = montar();
  for (const m of ['post', 'put', 'patch']) {
    const r = await request(app)[m]('/api/admin/precios').set(auth('token-admin')).send({ mensual: 1 });
    assert.equal(r.status, 404);
  }
});

/* ───────── contacto ───────── */

test('GET /api/config/contacto: público, con caché y con los valores de siempre si no hay nada guardado', async () => {
  const { app } = montar();
  const r = await request(app).get('/api/config/contacto');
  assert.equal(r.status, 200);
  assert.match(r.headers['cache-control'], /public, max-age=300/);
  assert.deepEqual(r.body, { ok: true, whatsapp: '+52 1 236 111 3237', whatsappNumero: '5212361113237', instagram: 'https://www.instagram.com/zoorigen.mexico1/', correo: 'zooorigen@gmail.com' });
});

test('POST /api/admin/contacto: valida, guarda en config/contacto, el Club lo lee y queda quién, cuándo y antes/después', async () => {
  const { app, db } = montar();
  const r = await post(app, '/api/admin/contacto', { whatsapp: '+52 1 55 1234 5678', instagram: '@zoorigen.nuevo', correo: 'Hola@Zoorigen.MX' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.contacto.whatsappNumero, r.body.contacto.instagram, r.body.contacto.correo], ['5215512345678', 'https://www.instagram.com/zoorigen.nuevo/', 'hola@zoorigen.mx']);
  const doc = db.value('config/contacto');
  assert.equal(doc.whatsappNumero, '5215512345678');
  assert.equal(doc.actualizadoPor, 'admin');
  const publico = await request(app).get('/api/config/contacto');
  assert.equal(publico.body.correo, 'hola@zoorigen.mx');
  assert.equal(publico.body.whatsappNumero, '5215512345678');
  const accion = [...db._data.values()].find(v => v && v.accion === 'contacto-guardar');
  assert.equal(accion.por, 'admin');
  assert.equal(accion.antes.correo, 'zooorigen@gmail.com');
  assert.equal(accion.despues.correo, 'hola@zoorigen.mx');
  assert.ok(accion.en);
  const admin = await get(app, '/api/admin/contacto');
  assert.equal(admin.body.contacto.personalizado, true);
  assert.equal(admin.body.porDefecto.correo, 'zooorigen@gmail.com');
});

test('contacto: entradas inválidas dan 400 con un mensaje claro y no guardan nada', async () => {
  const { app, db } = montar();
  const ok = { whatsapp: '+52 1 236 111 3237', instagram: 'https://www.instagram.com/zoorigen.mexico1/', correo: 'a@b.mx' };
  const malos = [
    [{ ...ok, whatsapp: 'abc' }, /WhatsApp/], [{ ...ok, whatsapp: '12345' }, /entre 10 y 15 dígitos/], [{ ...ok, whatsapp: '+52 1 236 111 3237 ext 5' }, /WhatsApp/],
    [{ ...ok, instagram: 'https://evil.example.com/zoorigen' }, /Instagram/], [{ ...ok, instagram: 'javascript:alert(1)' }, /Instagram/], [{ ...ok, instagram: '@a b' }, /Instagram/],
    [{ ...ok, correo: 'no-es-correo' }, /correo/], [{ ...ok, correo: 'a@b' }, /correo/], [{ ...ok, correo: 'x'.repeat(130) + '@b.mx' }, /correo/],
    [{ ...ok, correo: undefined }, /Faltan/], [{ ...ok, whatsapp: 3 }, /Faltan/], [null, /Faltan/]
  ];
  for (const [cuerpo, patron] of malos) {
    const r = await post(app, '/api/admin/contacto', cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
    assert.match(r.body.error, patron);
  }
  assert.equal(db.value('config/contacto'), undefined);
});

test('validaciones puras: WhatsApp, Instagram y correo', () => {
  assert.deepEqual(contacto.validarWhatsapp('(236) 111-3237'), { display: '(236) 111-3237', numero: '2361113237' });
  assert.equal(contacto.validarWhatsapp('00 52 1 236 111 3237').numero, '5212361113237');
  assert.equal(contacto.validarInstagram('zoorigen.mexico1').url, 'https://www.instagram.com/zoorigen.mexico1/');
  assert.equal(contacto.validarInstagram('http://instagram.com/abc/?hl=es').url, 'https://www.instagram.com/abc/');
  assert.ok(contacto.validarInstagram('https://instagram.com.malo.com/abc').error);
  assert.equal(contacto.validarCorreo('  ZOO@X.com ').correo, 'zoo@x.com');
  // un documento guardado a medias o dañado nunca deja al Club sin enlace
  assert.equal(contacto.contactoVigente({ whatsapp: 'mal', instagram: 'mal/mal', correo: 'mal' }).whatsappNumero, '5212361113237');
  assert.equal(contacto.contactoVigente(null).personalizado, false);
});

/* ───────── estado de servicios ───────── */

test('GET /api/admin/servicios: semáforo y comprobaciones reales, sin secretos', async () => {
  const { app } = montar();
  const r = await conEnv({ STRIPE_SECRET_KEY: 'sk_live_VALOR_SECRETO_X', CERTIFICATE_SIGNING_KEY: 'llave-larga-de-prueba-no-real-0123456789', RESEND_API_KEY: 're_VALOR_SECRETO', BUNNY_TOKEN_AUTH_KEY: 'clave-bunny-no-real' }, () => get(app, '/api/admin/servicios'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.comprobaciones.map(c => c.clave), ['servidor', 'base', 'stripe', 'avisos', 'pagos', 'correo', 'videos', 'certificados']);
  const por = Object.fromEntries(r.body.comprobaciones.map(c => [c.clave, c]));
  assert.equal(por.servidor.nivel, 'ok');
  assert.equal(por.base.nivel, 'ok');
  assert.equal(por.stripe.nivel, 'ok');
  assert.equal(por.correo.nivel, 'ok');
  assert.equal(por.certificados.nivel, 'ok');
  assert.equal(por.avisos.nivel, 'aviso', 'hay un miembro con Stripe y aún no se registra ningún aviso');
  assert.equal(r.body.nivel, 'aviso');
  assert.equal(r.body.resumen, 'Hay avisos por revisar');
  assert.equal(/VALOR_SECRETO|sk_live|sub_|llave-larga/.test(JSON.stringify(r.body)), false);
});

test('servicios: sin llave de certificados es un problema real (rojo); modo de prueba de Stripe y falta de correo son avisos', async () => {
  const { app } = montar();
  const r = await conEnv({ STRIPE_SECRET_KEY: 'sk_test_falsa', BUNNY_TOKEN_AUTH_KEY: 'x' }, () => get(app, '/api/admin/servicios'));
  const por = Object.fromEntries(r.body.comprobaciones.map(c => [c.clave, c]));
  assert.equal(por.certificados.nivel, 'error');
  assert.equal(por.stripe.nivel, 'aviso');
  assert.equal(por.correo.nivel, 'aviso');
  assert.equal(r.body.nivel, 'error');
  assert.equal(r.body.resumen, 'Hay algo que corregir');
});

test('servicios: pagos contra membresías compara lo guardado (sin llamar a Stripe) y nombra a quien no coincide', async () => {
  const { app } = montar({
    'miembros/c1': miembroConPlan({ name: 'Coincide', stripeSubscriptionId: 'sub_ok', stripeSubscriptionStatus: 'active' }),
    'miembros/c2': miembroSinPlan({ name: 'Cobrando sin acceso', stripeSubscriptionId: 'sub_x', stripeSubscriptionStatus: 'active', planVence: ts(dias(-5)) }),
    'miembros/c3': miembroConPlan({ name: 'Acceso sin suscripción', stripeSubscriptionId: 'sub_y', stripeSubscriptionStatus: 'canceled' })
  });
  const r = await get(app, '/api/admin/servicios');
  const pagos = r.body.comprobaciones.find(c => c.clave === 'pagos');
  assert.equal(pagos.nivel, 'aviso');
  assert.match(pagos.detalle, /2 de 4 no coinciden/);
  assert.deepEqual(pagos.casos.map(c => c.nombre).sort(), ['Acceso sin suscripción', 'Cobrando sin acceso']);
  assert.equal(JSON.stringify(r.body).includes('sub_'), false, 'ningún id de Stripe en la respuesta');
});

/* ───────── historial del servidor ───────── */

const evento = (id, extra) => [`servidorEventos/${id}`, { tipo: 'arranque', en: new Date(Date.now() - 3600000), normal: true, motivo: 'publicacion', ...extra }];

test('historial: los reinicios se cuentan solo en la ventana pedida y se puede marcar lo inesperado como normal', async () => {
  const seed = Object.fromEntries([
    evento('e1', {}), evento('e2', { en: new Date(Date.now() - 2 * 86400000), normal: false, motivo: 'inesperado', caida: true, duracionSeg: 1800 }),
    evento('e3', { en: new Date(Date.now() - 20 * 86400000), normal: false, motivo: 'inesperado' }),
    ['servidorErrores/k1', { patron: 'p', ejemplo: 'No se encontró miembro para la suscripción sub_…ABCD', nivel: 'error', cuenta: 14, primeraVez: new Date(Date.now() - 5 * 86400000), ultimaVez: new Date(Date.now() - 3600000) }],
    ['servidorErrores/k2', { patron: 'q', ejemplo: 'Algo viejo', nivel: 'error', cuenta: 2, primeraVez: new Date(Date.now() - 40 * 86400000), ultimaVez: new Date(Date.now() - 35 * 86400000) }]
  ]);
  const { app, db } = montar(seed);
  const sem = await get(app, '/api/admin/servidor/historial?dias=7');
  assert.deepEqual([sem.body.resumen.reinicios, sem.body.resumen.reiniciosInesperados, sem.body.resumen.caidas], [2, 1, 1]);
  const mes = await get(app, '/api/admin/servidor/historial?dias=30');
  assert.deepEqual([mes.body.resumen.reinicios, mes.body.resumen.reiniciosInesperados], [3, 2]);
  assert.equal(mes.body.resumen.erroresInternos, 14, 'el error de hace 35 días no entra en 30');
  assert.equal(mes.body.errores.length, 1);
  assert.equal(mes.body.errores[0].cuenta, 14);
  assert.equal(JSON.stringify(mes.body).includes('sub_1'), false);
  const raro = await get(app, '/api/admin/servidor/historial?dias=500');
  assert.equal(raro.body.dias, 30, 'una ventana inválida cae en 30 días');
  const m = await post(app, '/api/admin/servidor/reconocer-reinicios');
  assert.equal(m.status, 200);
  assert.equal(m.body.marcados, 2);
  assert.equal(db.value('servidorEventos/e2').normal, true);
  const despues = await get(app, '/api/admin/servidor/historial?dias=30');
  assert.equal(despues.body.resumen.reiniciosInesperados, 0);
  const accion = [...db._data.values()].find(v => v && v.accion === 'reinicios-normales');
  assert.equal(accion.cantidad, 2);
});
