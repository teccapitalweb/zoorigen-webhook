'use strict';

// RECORDATORIOS DE PAGO · rutas (baja, cupón de la persona, preferencia, panel de administración), cobro con cupón automático y webhook.
// Ejecutar: node --test test/recordatorios-rutas.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, ts } = require('./helpers/club');
const { suscripcion } = require('./helpers/cargar-servidor');
const R = require('../services/recordatorios-pago');

const CLAVE_MAESTRA = 'llave-maestra-de-prueba';
const clave = R.claveDeBaja(CLAVE_MAESTRA);
const tokens = {
  'token-ana': { uid: 'ana', email: 'ana@example.com', email_verified: true },
  'token-beto': { uid: 'beto', email: 'beto@example.com', email_verified: true },
  'token-miembro': { uid: 'miembro', email: 'miembro@example.com', email_verified: true },
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true }
};
const ENV = { CERTIFICATE_SIGNING_KEY: CLAVE_MAESTRA, RESEND_API_KEY: 're_prueba', MAIL_FROM: 'Zoorigen <no-reply@zoorigen.com>' };

// El correo sale por fetch hacia api.resend.com: aquí se captura en lugar de enviarlo
async function conResend(fn, { status = 200 } = {}) {
  const anterior = global.fetch; const enviados = []; const env = { RESEND_API_KEY: process.env.RESEND_API_KEY, MAIL_FROM: process.env.MAIL_FROM };
  process.env.RESEND_API_KEY = ENV.RESEND_API_KEY; process.env.MAIL_FROM = ENV.MAIL_FROM;  global.fetch = async (url, opc) => { enviados.push({ url, cuerpo: JSON.parse(opc.body), cabeceras: opc.headers }); return { ok: status === 200, status, text: async () => 'x', headers: { get: () => null } }; };
  try { return await fn(enviados); } finally { global.fetch = anterior; for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

function servidor(seed = {}, env = ENV) {
  const silenciar = [console.warn, console.log, console.error]; console.warn = console.log = console.error = () => {};
  try {
    return cargarServidor({
      env, tokens, precios: true,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, beto: { emailVerified: true, email: 'beto@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroSinPlan({ name: 'Ana Pérez', email: 'ana@example.com', createdAt: ts(Date.now() - 3 * 86400000) }),
        'miembros/beto': miembroSinPlan({ name: 'Beto', email: 'beto@example.com', createdAt: ts(Date.now() - 3 * 86400000) }),
        'miembros/miembro': miembroConPlan({ name: 'Miembro', email: 'miembro@example.com' }),
        'miembros/admin': miembroSinPlan({ name: 'Admin', email: 'admin@example.com', role: 'admin' }),
        ...seed
      }
    });
  } finally { [console.warn, console.log, console.error] = silenciar; }
}
const urlBaja = (uid, firma = R.firmarBaja(clave, uid)) => `/baja-recordatorios?u=${uid}&t=${firma}`;
const conCupon = (uid, { monto = 50, codigo = 'ZOO50-ABC234', promoId = 'promo_1', vence = Date.now() + 6 * 3600000 } = {}) => ({
  [`recordatoriosPago/${uid}`]: R.estadoTrasEnviar({ registroMs: Date.now() - 3 * 86400000, ciclo: 1, paso: 1, enviados: 1 }, { ciclo: 1, paso: monto === 50 ? 2 : 3, ahoraMs: vence - 24 * 3600000, codigo, promoId, venceMs: vence })
});
const post = (app, ruta, cuerpo, t = 'token-admin') => request(app).post(ruta).set(auth(t)).send(cuerpo || {});
const acciones = db => [...db._data.entries()].filter(([k]) => k.startsWith('adminAcciones/')).map(([, v]) => v);

// ───────────────────────────── Baja ─────────────────────────────

test('baja: el enlace GET solo muestra la página de confirmación (los lectores de correo lo abren) y NO da de baja', async () => {
  const { app, db } = servidor();
  const r = await request(app).get(urlBaja('ana'));
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /¿Ya no quieres recibir promociones\?/);
  assert.match(r.text, /Sí, darme de baja/);
  assert.match(r.text, /Zoorigen/); assert.match(r.text, /Tehuacán, Puebla, México/);
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['referrer-policy'], 'same-origin');
  assert.equal(db._data.has('recordatoriosPago/ana'), false, 'abrir el enlace no cambia nada');
});

test('baja: el POST (botón de la página y «un clic» de Gmail y Yahoo) da de baja para siempre', async () => {
  const { app, db } = servidor();
  const r = await request(app).post(urlBaja('ana')).type('form').send({ 'List-Unsubscribe': 'One-Click' });
  assert.equal(r.status, 200);
  assert.match(r.text, /Listo, ya no te enviaremos promociones/);
  const e = db.value('recordatoriosPago/ana');
  assert.equal(e.baja, true); assert.ok(e.bajaMs > 0);
  // Repetirlo no rompe nada; la otra cuenta no se afecta
  assert.equal((await request(app).post(urlBaja('ana'))).status, 200);
  assert.equal(db._data.has('recordatoriosPago/beto'), false);
  // Quien se dio de baja ya no es elegible ni ve cupón
  const mc = await request(app).get('/api/recordatorios/mi-cupon').set(auth('token-ana'));
  assert.equal(mc.body.cupon, null);
});

test('baja: una firma falsa, de otra cuenta o incompleta se rechaza y no cambia nada', async () => {
  const { app, db } = servidor();
  const falsa = R.firmarBaja(clave, 'ana');
  for (const ruta of [urlBaja('ana', 'a'.repeat(40)), urlBaja('beto', falsa), urlBaja('ana', falsa.slice(0, 20)), '/baja-recordatorios', '/baja-recordatorios?u=ana', urlBaja('..%2Fana', falsa), urlBaja('ana', falsa.toUpperCase())]) {
    const g = await request(app).get(ruta);
    assert.equal(g.status, 400, ruta); assert.match(g.text, /Enlace no válido/);
    const p = await request(app).post(ruta);
    assert.equal(p.status, 400, ruta);
  }
  assert.equal([...db._data.keys()].some(k => k.startsWith('recordatoriosPago/')), false);
});

test('baja: una cuenta que no existe responde «listo» sin crear nada y sin revelar si existe', async () => {
  const { app, db } = servidor();
  const r = await request(app).post(urlBaja('fantasma'));
  assert.equal(r.status, 200); assert.match(r.text, /Listo/);
  assert.equal(db._data.has('recordatoriosPago/fantasma'), false);
});

test('baja: sin la llave de firmas del servidor, ningún enlace sirve', async () => {
  const { app, db } = servidor({}, {});
  const r = await request(app).post(urlBaja('ana'));
  assert.equal(r.status, 400);
  assert.equal(db._data.has('recordatoriosPago/ana'), false);
});

// ───────────────────────────── Cupón de la persona ─────────────────────────────

test('mi-cupon: pide sesión, devuelve solo el cupón de ESTA cuenta y nada a miembros ni administradores', async () => {
  const { app } = servidor({ ...conCupon('ana'), ...conCupon('miembro'), ...conCupon('admin') });
  assert.equal((await request(app).get('/api/recordatorios/mi-cupon')).status, 401);
  const ana = await request(app).get('/api/recordatorios/mi-cupon').set(auth('token-ana'));
  assert.equal(ana.status, 200);
  assert.deepEqual(Object.keys(ana.body.cupon).sort(), ['codigo', 'monto', 'precioFinal', 'precioMes', 'restanteMs', 'venceMs']);
  assert.equal(ana.body.cupon.codigo, 'ZOO50-ABC234'); assert.equal(ana.body.cupon.precioFinal, 149);
  assert.ok(ana.body.cupon.restanteMs > 0 && ana.body.cupon.restanteMs <= 6 * 3600000);
  assert.ok(!JSON.stringify(ana.body).includes('promo_1'), 'no expone el identificador interno de Stripe');
  assert.ok(!JSON.stringify(ana.body).includes('ana@'), 'ni datos personales');
  assert.equal((await request(app).get('/api/recordatorios/mi-cupon').set(auth('token-beto'))).body.cupon, null, 'Beto no tiene cupón y no ve el de Ana');
  assert.equal((await request(app).get('/api/recordatorios/mi-cupon').set(auth('token-miembro'))).body.cupon, null, 'un miembro no ve cupón');
  assert.equal((await request(app).get('/api/recordatorios/mi-cupon').set(auth('token-admin'))).body.cupon, null, 'el administrador no ve cupón');
});

test('mi-cupon: un cupón vencido ya no aparece', async () => {
  const { app } = servidor(conCupon('ana', { vence: Date.now() - 1000 }));
  assert.equal((await request(app).get('/api/recordatorios/mi-cupon').set(auth('token-ana'))).body.cupon, null);
});

// ───────────────────────────── Preferencia ─────────────────────────────

test('preferencia: la casilla del registro y el interruptor del perfil guardan «no quiero promociones»; la baja no se deshace', async () => {
  const { app, db } = servidor();
  assert.equal((await request(app).post('/api/recordatorios/preferencia').send({ recibe: false })).status, 401);
  assert.deepEqual((await request(app).get('/api/recordatorios/preferencia').set(auth('token-ana'))).body, { ok: true, recibe: true, baja: false });
  const r = await post(app, '/api/recordatorios/preferencia', { recibe: false, origen: 'registro' }, 'token-ana');
  assert.equal(r.status, 200); assert.equal(r.body.recibe, false);
  assert.equal(db.value('recordatoriosPago/ana').optOutOrigen, 'registro');
  assert.equal(db._data.has('recordatoriosPago/beto'), false, 'solo cambia la cuenta de quien pide');
  assert.equal((await post(app, '/api/recordatorios/preferencia', { recibe: true }, 'token-ana')).body.recibe, true);
  assert.equal(db.value('recordatoriosPago/ana').optOut, false);
  assert.equal((await post(app, '/api/recordatorios/preferencia', { recibe: 'si' }, 'token-ana')).status, 400);
  await request(app).post(urlBaja('beto'));
  assert.deepEqual((await post(app, '/api/recordatorios/preferencia', { recibe: true }, 'token-beto')).body, { ok: true, recibe: false, baja: true });
});

// ───────────────────────────── Administración ─────────────────────────────

test('administración: visitante 401, miembro 403; nada se guarda ni se envía', async () => {
  const { app, db } = servidor();
  const rutas = [['get', '/api/admin/recordatorios'], ['get', '/api/admin/recordatorios/lista'], ['post', '/api/admin/recordatorios/modo'], ['post', '/api/admin/recordatorios/limites'], ['post', '/api/admin/recordatorios/ensayo'], ['post', '/api/admin/recordatorios/prueba']];
  await conResend(async enviados => {
    for (const [metodo, ruta] of rutas) {
      assert.equal((await request(app)[metodo](ruta)).status, 401, ruta);
      assert.equal((await request(app)[metodo](ruta).set(auth('token-ana')).send({ modo: 'activo', confirmo: true, paso: 1 })).status, 403, ruta);
    }
    assert.equal(enviados.length, 0);
  });
  assert.equal(db._data.has('config/recordatorios'), false);
  assert.equal(acciones(db).length, 0);
});

test('administración: el interruptor ARRANCA APAGADO; activar pide confirmación y deja huella en la bitácora', async () => {
  const { app, db } = servidor();
  const estado = await conResend(() => request(app).get('/api/admin/recordatorios').set(auth('token-admin')));
  assert.equal(estado.status, 200);
  assert.equal(estado.body.modo, 'apagado'); assert.equal(estado.body.configurado, true); assert.equal(estado.body.correoAdmin, 'admin@example.com');
  assert.equal(estado.body.calificarian, 2, 'Ana y Beto');
  assert.equal(estado.body.serie.length, 7); assert.equal(estado.body.maxCiclos, 3);
  assert.ok(estado.body.primerEnvioMs > 0);
  assert.equal((await post(app, '/api/admin/recordatorios/modo', { modo: 'activo' })).status, 400, 'sin confirmación no se activa');
  assert.equal((await post(app, '/api/admin/recordatorios/modo', { modo: 'encendido', confirmo: true })).status, 400);
  assert.equal(db._data.has('config/recordatorios'), false);
  const ok = await conResend(() => post(app, '/api/admin/recordatorios/modo', { modo: 'activo', confirmo: true }));
  assert.equal(ok.status, 200); assert.equal(ok.body.modo, 'activo');
  assert.equal(db.value('config/recordatorios').modo, 'activo');
  assert.equal(db.value('config/recordatorios').actualizadoPor, 'admin@example.com');
  assert.equal((await post(app, '/api/admin/recordatorios/modo', { modo: 'apagado' })).body.modo, 'apagado', 'apagar no pide confirmación');
  assert.deepEqual(acciones(db).map(a => a.accion || a.tipo), acciones(db).map(a => a.accion || a.tipo));
  assert.equal(acciones(db).length, 2);
  assert.ok(acciones(db).every(a => JSON.stringify(a).includes('recordatorios-modo')));
});

test('administración: sin correo configurado no se puede activar y lo dice claro', async () => {
  const { app, db } = servidor({}, { CERTIFICATE_SIGNING_KEY: CLAVE_MAESTRA });
  const r = await post(app, '/api/admin/recordatorios/modo', { modo: 'activo', confirmo: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /RESEND_API_KEY y MAIL_FROM/);
  assert.equal(db._data.has('config/recordatorios'), false);
  assert.equal((await request(app).get('/api/admin/recordatorios').set(auth('token-admin'))).body.configurado, false);
});

test('administración: límites con validación y máximos', async () => {
  const { app, db } = servidor();
  for (const mal of [{}, { topeDiario: 0, maxPorCorrida: 5 }, { topeDiario: 10.5, maxPorCorrida: 5 }, { topeDiario: '10', maxPorCorrida: 5 }, { topeDiario: 100000, maxPorCorrida: 5 }, { topeDiario: 10, maxPorCorrida: 5000 }]) {
    assert.equal((await post(app, '/api/admin/recordatorios/limites', mal)).status, 400, JSON.stringify(mal));
  }
  const ok = await post(app, '/api/admin/recordatorios/limites', { topeDiario: 80, maxPorCorrida: 12 });
  assert.deepEqual([ok.status, ok.body.topeDiario, ok.body.maxPorCorrida], [200, 80, 12]);
  assert.equal(db.value('config/recordatorios').topeDiario, 80);
});

test('administración: el ensayo muestra quién recibiría qué correo y no envía, no crea cupones y no cambia estados', async () => {
  const { app, db, registro } = servidor();
  await conResend(async enviados => {
    const r = await post(app, '/api/admin/recordatorios/ensayo');
    assert.equal(r.status, 200); assert.equal(r.body.ensayo, true);
    assert.equal(enviados.length, 0);
    assert.ok(Array.isArray(r.body.recibirian));
  });
  assert.equal(registro.codigos.size, 0);
  assert.equal([...db._data.keys()].some(k => k.startsWith('recordatoriosPago/')), false);
  assert.equal(acciones(db).length, 1);
});

test('administración: la tabla con búsqueda y filtro por etapa', async () => {
  const { app } = servidor({ ...conCupon('ana'), 'recordatoriosPago/beto': { baja: true } });
  const lista = await request(app).get('/api/admin/recordatorios/lista').set(auth('token-admin'));
  assert.equal(lista.status, 200);
  const porCorreo = Object.fromEntries(lista.body.items.map(i => [i.correo, i]));
  assert.equal(porCorreo['ana@example.com'].etapa, 'cupon-vigente'); assert.equal(porCorreo['beto@example.com'].etapa, 'baja');
  assert.ok(!porCorreo['admin@example.com'], 'el administrador no aparece');
  assert.equal((await request(app).get('/api/admin/recordatorios/lista?etapa=baja').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/recordatorios/lista?q=ana').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/recordatorios/lista?etapa=nada').set(auth('token-admin'))).body.etapa, 'todas');
});

test('correos de prueba: SOLO al correo del administrador que los pide, con cupón real marcado prueba; no cuentan en las estadísticas', async () => {
  const { app, db, registro } = servidor();
  await conResend(async enviados => {
    const r = await post(app, '/api/admin/recordatorios/prueba', { paso: 3, ciclo: 2, para: 'otro@example.com', correo: 'otro@example.com' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.para, 'admin@example.com');
    assert.equal(enviados.length, 1);
    assert.deepEqual(enviados[0].cuerpo.to, ['admin@example.com'], 'nunca a otra persona');
    assert.match(enviados[0].cuerpo.subject, /^\[PRUEBA\]/);
    assert.equal(enviados[0].url, 'https://api.resend.com/emails');
    assert.equal(enviados[0].cuerpo.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const promo = [...registro.codigos.values()][0];
    assert.equal(promo.metadata.prueba, 'si'); assert.equal(promo.coupon, 'ZOORIGEN_RECORDATORIO_100');
    // Todos los pasos
    const todos = await post(app, '/api/admin/recordatorios/prueba', { paso: 'todos' });
    assert.equal(todos.status, 200); assert.equal(todos.body.enviados.length, 7);
    assert.equal(enviados.length, 8);
    assert.ok(enviados.every(e => e.cuerpo.to.length === 1 && e.cuerpo.to[0] === 'admin@example.com'));
    assert.equal((await post(app, '/api/admin/recordatorios/prueba', { paso: 8 })).status, 400);
    assert.equal((await post(app, '/api/admin/recordatorios/prueba', {})).status, 400);
  });
  assert.equal([...db._data.keys()].some(k => k.startsWith('recordatoriosPago/') || k.startsWith('recordatoriosEstadisticas/')), false, 'las pruebas no tocan estados ni estadísticas');
});

test('correos de prueba: si Resend falla, el panel recibe un error claro', async () => {
  const { app } = servidor();
  await conResend(async () => {
    const r = await post(app, '/api/admin/recordatorios/prueba', { paso: 2 });
    assert.equal(r.status, 502);
  }, { status: 500 });
  const sin = servidor({}, { CERTIFICATE_SIGNING_KEY: CLAVE_MAESTRA });
  assert.equal((await post(sin.app, '/api/admin/recordatorios/prueba', { paso: 2 })).status, 409);
});

// ───────────────────────────── Cobro con cupón automático ─────────────────────────────

test('cobro: con un cupón vigente, el plan mensual lo aplica solo (discounts) y ya no ofrece escribir códigos', async () => {
  const { app, registro } = servidor(conCupon('ana'));
  registro.codigos.set('promo_1', { id: 'promo_1', active: true, times_redeemed: 0, max_redemptions: 1, expires_at: Math.floor((Date.now() + 6 * 3600000) / 1000), metadata: { marca: 'zoorigen' }, code: 'ZOO50-ABC234' });
  const r = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'mensual', embedded: true });
  assert.equal(r.status, 200);
  const s = registro.sesionesCreadas[0];
  assert.deepEqual(s.discounts, [{ promotion_code: 'promo_1' }]);
  assert.equal('allow_promotion_codes' in s, false, 'Stripe no admite discounts junto con allow_promotion_codes');
  assert.equal(s.metadata.recordatorioPromoId, 'promo_1'); assert.equal(s.metadata.recordatorioCodigo, 'ZOO50-ABC234'); assert.equal(s.metadata.recordatorioPaso, '2');
  assert.equal(s.metadata.firebaseUID, 'ana');
});

test('cobro: el plan anual y quien no tiene cupón se cobran exactamente como siempre', async () => {
  const { app, registro } = servidor(conCupon('ana'));
  registro.codigos.set('promo_1', { id: 'promo_1', active: true, times_redeemed: 0, max_redemptions: 1, metadata: { marca: 'zoorigen' } });
  await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'anual' });
  const anual = registro.sesionesCreadas[0];
  assert.equal(anual.allow_promotion_codes, true); assert.equal('discounts' in anual, false); assert.equal('recordatorioPromoId' in anual.metadata, false);
  await request(app).post('/create-checkout-session').set(auth('token-beto')).send({ planType: 'mensual' });
  const beto = registro.sesionesCreadas[1];
  assert.equal(beto.allow_promotion_codes, true); assert.equal('discounts' in beto, false);
});

test('cobro: un cupón vencido, ya usado o de otra marca NO se aplica; el pago sigue normal', async () => {
  for (const cambio of [{ times_redeemed: 1 }, { active: false }, { expires_at: Math.floor((Date.now() - 1000) / 1000) }, { metadata: { marca: 'alintec' } }]) {
    const { app, registro } = servidor(conCupon('ana'));
    registro.codigos.set('promo_1', { id: 'promo_1', active: true, times_redeemed: 0, max_redemptions: 1, metadata: { marca: 'zoorigen' }, ...cambio });
    const r = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'mensual' });
    assert.equal(r.status, 200, JSON.stringify(cambio));
    assert.equal('discounts' in registro.sesionesCreadas[0], false, JSON.stringify(cambio));
    assert.equal(registro.sesionesCreadas[0].allow_promotion_codes, true);
  }
});

test('cobro: si Stripe rechaza el cupón justo al crear el pago, la persona paga sin él (nunca se bloquea el pago)', async () => {
  const { app, registro } = servidor(conCupon('ana'));
  registro.codigos.set('promo_1', { id: 'promo_1', active: true, times_redeemed: 0, max_redemptions: 1, metadata: { marca: 'zoorigen' } });
  registro.rechazarCupones = true;
  const r = await request(app).post('/create-checkout-session').set(auth('token-ana')).send({ planType: 'mensual' });
  assert.equal(r.status, 200);
  assert.equal(registro.sesionesCreadas.length, 1);
  const s = registro.sesionesCreadas[0];
  assert.equal('discounts' in s, false); assert.equal(s.allow_promotion_codes, true);
  assert.equal('recordatorioPromoId' in s.metadata, false);
});

// ───────────────────────────── Webhook ─────────────────────────────

const evento = (object) => ({ id: 'evt_1', type: 'checkout.session.completed', data: { object } });
const enviarWebhook = (app, ev) => request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', 'firma-valida').send(JSON.stringify(ev));
const sesionPagada = (extra = {}) => ({ id: 'cs_1', payment_status: 'paid', subscription: 'sub_1', customer_email: 'ana@example.com', metadata: { firebaseUID: 'ana', planType: 'mensual' }, total_details: { amount_discount: 0 }, ...extra });
const servidorWebhook = (seed = {}) => {
  const silenciar = [console.warn, console.log, console.error]; console.warn = console.log = console.error = () => {};
  try {
    return cargarServidor({ env: ENV, tokens, precios: true, suscripciones: [suscripcion({ id: 'sub_1', uid: 'ana' })], seed: { 'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }), ...seed } });
  } finally { [console.warn, console.log, console.error] = silenciar; }
};

test('webhook: pagar con el código del correo deja a la persona CONVERTIDA con su vuelta y paso, y suma las estadísticas', async () => {
  const { app, db } = servidorWebhook(conCupon('ana', { monto: 100, codigo: 'ZOO100-QWE234' }));
  const r = await enviarWebhook(app, evento(sesionPagada({ metadata: { firebaseUID: 'ana', planType: 'mensual', recordatorioPromoId: 'promo_1', recordatorioCodigo: 'ZOO100-QWE234', recordatorioPaso: '3' }, total_details: { amount_discount: 10000 } })));
  assert.equal(r.status, 200);
  assert.equal(db.value('miembros/ana').planActivo, true, 'la membresía se activa como siempre');
  const e = db.value('recordatoriosPago/ana');
  assert.equal(e.cerrada, 'convertida'); assert.deepEqual([e.conversion.ciclo, e.conversion.paso, e.conversion.codigo], [1, 3, 'ZOO100-QWE234']);
  const g = db.value('recordatoriosEstadisticas/global');
  assert.deepEqual([g.convertidas, g.pagosConCuponPaso.p3], [1, 1]);
});

test('webhook: pagar SIN cupón también cierra la serie (como pago), sin contar como conversión', async () => {
  const { app, db } = servidorWebhook(conCupon('ana'));
  await enviarWebhook(app, evento(sesionPagada()));
  assert.equal(db.value('recordatoriosPago/ana').cerrada, 'pago');
  const g = db.value('recordatoriosEstadisticas/global');
  assert.equal(g.convertidas || 0, 0); assert.equal(g.pagosSinCupon, 1);
});

test('webhook: un código escrito a mano se reconoce en Stripe; el de otra marca o el de prueba no cuentan como conversión', async () => {
  for (const [metadata, esperado] of [[{ marca: 'zoorigen', paso: '2', prueba: 'no' }, 'convertida'], [{ marca: 'alintec', paso: '2' }, 'pago'], [{ marca: 'zoorigen', paso: '2', prueba: 'si' }, 'pago']]) {
    const { app, db, registro } = servidorWebhook(conCupon('ana'));
    registro.codigos.set('promo_1', { id: 'promo_1', code: 'ZOO50-ABC234', active: true, times_redeemed: 1, metadata });
    registro.sesionesLeibles.set('cs_1', { id: 'cs_1', total_details: { amount_discount: 5000, breakdown: { discounts: [{ discount: { promotion_code: 'promo_1' } }] } } });
    await enviarWebhook(app, evento(sesionPagada({ total_details: { amount_discount: 5000 } })));
    assert.equal(db.value('recordatoriosPago/ana').cerrada, esperado, JSON.stringify(metadata));
  }
});

test('webhook: si el cierre de la serie falla, la membresía igual queda activa y el webhook responde bien', async () => {
  const { app, db, registro } = servidorWebhook();
  registro.sesionesLeibles = { get() { throw new Error('Stripe caído'); } };
  const r = await enviarWebhook(app, evento(sesionPagada({ total_details: { amount_discount: 5000 } })));
  assert.equal(r.status, 200);
  assert.equal(db.value('miembros/ana').planActivo, true);
});

test('el servicio queda expuesto para el demo y arranca apagado', async () => {
  const { app } = servidor();
  assert.ok(app.recordatoriosPago && typeof app.recordatoriosPago.procesar === 'function');
  assert.equal((await app.recordatoriosPago.leerConfig()).modo, 'apagado');
  assert.deepEqual(await app.recordatoriosPago.procesar(), { omitido: 'apagado' });
});
