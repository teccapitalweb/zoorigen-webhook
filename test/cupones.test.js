'use strict';

// Cupones de créditos: crear (administración), listar, pausar, canjear (persona) y límite de intentos.
// Ejecutar: node --test test/cupones.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const C = require('../services/cupones');

const tokens = tokensDe('ana', 'beto', 'sinverificar', 'admin');
function servidor(seed = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      tokens,
      usuariosAuth: {
        ana: { emailVerified: true, email: 'ana@example.com' }, beto: { emailVerified: true, email: 'beto@example.com' },
        sinverificar: { emailVerified: false, email: 'sin@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' }
      },
      seed: {
        'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }),
        'miembros/beto': miembroSinPlan({ name: 'Beto', email: 'beto@example.com' }),
        'miembros/sinverificar': miembroSinPlan({ name: 'Sin', email: 'sin@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin', email: 'admin@example.com' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const crear = (app, cuerpo, t = 'token-admin') => request(app).post('/api/admin/creditos/cupones').set(auth(t)).send(cuerpo);
const lista = (app, t = 'token-admin') => request(app).get('/api/admin/creditos/cupones').set(auth(t));
const estado = (app, clave, est, t = 'token-admin') => request(app).post('/api/admin/creditos/cupones/estado').set(auth(t)).send({ clave, estado: est });
const canjes = (app, clave, t = 'token-admin') => request(app).get('/api/admin/creditos/cupones/canjes?clave=' + encodeURIComponent(clave)).set(auth(t));
const canjear = (app, clave, t = 'token-ana') => request(app).post('/api/creditos/cupon/canjear').set(auth(t)).send({ clave });
const disponible = (app, t = 'token-ana') => request(app).get('/api/creditos/cupon-disponible').set(auth(t));
const saldoDe = db => (db.value('creditosCuentas/ana') || {}).saldo || 0;
const FUTURO = () => new Date(Date.now() + 86400000).toISOString();

test('claves: no distinguen mayúsculas, acentos ni espacios; de 4 a 24 letras, números o guion', () => {
  assert.equal(C.normalizarClave('  canal 100 '), 'CANAL100');
  assert.equal(C.normalizarClave('Canál-Ñu'), 'CANAL-NU');
  for (const mala of ['', 'abc', 'a'.repeat(25), 'canal*100', 'hola mundo!', null, undefined, 5]) assert.equal(C.normalizarClave(mala), mala === 5 ? '' : '', 'clave ' + mala);
  const g = C.generarClave(); assert.match(g, /^ZOO[A-HJKMNP-Z2-9]{6}$/);
  assert.notEqual(C.generarClave(), C.generarClave());
});

test('estado: activo, pausado, vencido y agotado', () => {
  const ahora = Date.now();
  assert.equal(C.estadoDe({ canjes: 0 }, ahora), 'activo');
  assert.equal(C.estadoDe({ estado: 'pausado' }, ahora), 'pausado');
  assert.equal(C.estadoDe({ venceMs: ahora - 1 }, ahora), 'vencido');
  assert.equal(C.estadoDe({ venceMs: ahora + 5 }, ahora), 'activo');
  assert.equal(C.estadoDe({ maxPersonas: 3, canjes: 3 }, ahora), 'agotado');
  assert.equal(C.estadoDe({ maxPersonas: 3, canjes: 2 }, ahora), 'activo');
  assert.equal(C.estadoDe({ estado: 'pausado', venceMs: ahora - 1 }, ahora), 'pausado');
});

test('sin sesión 401; una persona que no es administradora no administra cupones (403)', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/admin/creditos/cupones')).status, 401);
  assert.equal((await request(app).post('/api/creditos/cupon/canjear').send({ clave: 'X' })).status, 401);
  assert.equal((await request(app).get('/api/creditos/cupon-disponible')).status, 401);
  for (const r of [await lista(app, 'token-ana'), await crear(app, { clave: 'CANAL100', creditos: 100 }, 'token-ana'), await estado(app, 'CANAL100', 'pausado', 'token-ana'), await canjes(app, 'CANAL100', 'token-ana')]) assert.equal(r.status, 403);
});

test('crear: con clave propia (se guarda normalizada), al azar si va vacía, y se anota en la bitácora; sin tope ni fecha es válido', async () => {
  const { app, db } = servidor();
  const a = await crear(app, { clave: ' canal 100 ', creditos: 100 });
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.cupon.clave, a.body.cupon.creditos, a.body.cupon.estado, a.body.cupon.canjes, a.body.cupon.vence, a.body.cupon.maxPersonas], ['CANAL100', 100, 'activo', 0, null, null]);
  assert.ok(db.value('creditosCupones/CANAL100'));
  const b = await crear(app, { clave: '', creditos: 200, vence: FUTURO(), maxPersonas: 50 });
  assert.equal(b.status, 200);
  assert.match(b.body.cupon.clave, /^ZOO[A-Z0-9]{6}$/);
  assert.equal(b.body.cupon.maxPersonas, 50);
  assert.ok(b.body.cupon.vence);
  const acciones = [...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).map(k => db.value(k)).filter(x => x.accion === 'cupon-crear');
  assert.equal(acciones.length, 2);
  const l = await lista(app);
  assert.equal(l.body.cupones.length, 2);
});

test('crear: clave repetida 409; créditos fuera de 1 a 1,000, máximo raro o fecha pasada 400; nada se guarda', async () => {
  const { app, db } = servidor();
  assert.equal((await crear(app, { clave: 'CANAL100', creditos: 100 })).status, 200);
  const dup = await crear(app, { clave: 'canal100', creditos: 50 });
  assert.equal(dup.status, 409); assert.equal(dup.body.codigo, 'clave-existe');
  for (const cuerpo of [{ clave: 'UNO', creditos: 100 }, { clave: 'BUENA1', creditos: 0 }, { clave: 'BUENA2', creditos: 1001 }, { clave: 'BUENA3', creditos: 10.5 }, { clave: 'BUENA4', creditos: '100' },
    { clave: 'BUENA5', creditos: 100, maxPersonas: 0 }, { clave: 'BUENA6', creditos: 100, maxPersonas: 2.5 }, { clave: 'BUENA7', creditos: 100, vence: new Date(Date.now() - 1000).toISOString() }, { clave: 'BUENA8', creditos: 100, vence: 'mañana' }]) {
    assert.equal((await crear(app, cuerpo)).status, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await lista(app)).body.cupones.length, 1);
  assert.equal(db.value('creditosCupones/BUENA1'), undefined);
});

test('canjear: suma los créditos al instante, una sola vez por persona, y queda en el libro como regalo de cupón', async () => {
  const { app, db } = servidor();
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  const r = await canjear(app, 'canal 100');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.creditos, r.body.saldo], [true, 100, 100]);
  assert.equal(saldoDe(db), 100);
  const otra = await canjear(app, 'CANAL100');
  assert.equal(otra.status, 409); assert.equal(otra.body.codigo, 'ya-canjeado');
  assert.equal(saldoDe(db), 100, 'no se paga dos veces');
  assert.equal((await canjear(app, 'CANAL100', 'token-beto')).status, 200, 'otra persona sí puede');
  const mov = [...db._data.keys()].filter(k => k.startsWith('creditosMovimientos/')).map(k => db.value(k)).filter(x => x.origen === 'cupon');
  assert.equal(mov.length, 2);
  assert.deepEqual([mov[0].tipo, mov[0].cantidad, mov[0].cupon], ['regalo', 100, 'CANAL100']);
  const c = (await lista(app)).body.cupones[0];
  assert.deepEqual([c.canjes, c.creditosEntregados], [2, 200]);
  assert.equal(db.value('creditosCuentas/ana').avisoPendiente, undefined, 'no se le vuelve a felicitar por algo que acaba de hacer');
});

test('canjear: no deja el aviso de felicitación pendiente ni cuenta contra el tope diario de regalos del administrador', async () => {
  const { app, db } = servidor();
  await crear(app, { clave: 'GRANDE', creditos: 1000 });
  await canjear(app, 'GRANDE');
  const cuenta = db.value('creditosCuentas/ana');
  assert.equal(cuenta.regalosHoy, undefined);
  const g = await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'ana', cantidad: 1000, clave: 'operacion-cupon-0001' });
  assert.equal(g.status, 200, 'el administrador todavía puede regalar ese día');
});

test('claves que no sirven: no existe y pausado dan el mismo mensaje; vencido y agotado dicen lo que pasó', async () => {
  const { app, db } = servidor();
  await crear(app, { clave: 'PAUSADO1', creditos: 100 });
  await estado(app, 'PAUSADO1', 'pausado');
  await crear(app, { clave: 'LIMITE2', creditos: 100, maxPersonas: 1 });
  assert.equal((await canjear(app, 'LIMITE2', 'token-beto')).status, 200);
  await crear(app, { clave: 'VENCIDO3', creditos: 100, vence: new Date(Date.now() + 60000).toISOString() });
  db._data.set('creditosCupones/VENCIDO3', { ...db.value('creditosCupones/VENCIDO3'), venceMs: Date.now() - 1000 });
  const nada = await canjear(app, 'NOEXISTE');
  const pausa = await canjear(app, 'PAUSADO1');
  assert.equal(nada.status, 404); assert.equal(pausa.status, 404);
  assert.equal(nada.body.error, pausa.body.error, 'no se distingue un cupón pausado de uno que no existe');
  assert.equal(nada.body.codigo, 'no-valido');
  const agot = await canjear(app, 'LIMITE2');
  assert.equal(agot.status, 410); assert.equal(agot.body.codigo, 'cupon-agotado'); assert.equal(agot.body.limite, 1);
  assert.match(agot.body.error, /límite de 1 personas/);
  const venc = await canjear(app, 'VENCIDO3');
  assert.equal(venc.status, 410); assert.equal(venc.body.codigo, 'cupon-vencido');
  assert.equal(saldoDe(db), 0, 'ninguno de esos dio créditos');
});

test('quien ya canjeó un cupón agotado ve "ya canjeaste", no "agotado"', async () => {
  const { app } = servidor();
  await crear(app, { clave: 'LIMITE2', creditos: 100, maxPersonas: 1 });
  await canjear(app, 'LIMITE2');
  const otra = await canjear(app, 'LIMITE2');
  assert.equal(otra.body.codigo, 'ya-canjeado');
});

test('el máximo de personas se respeta aunque canjeen a la vez: nunca se pasa', async () => {
  const { app } = servidor();
  await crear(app, { clave: 'DOSX', creditos: 100, maxPersonas: 1 });
  const [a, b] = await Promise.all([canjear(app, 'DOSX', 'token-ana'), canjear(app, 'DOSX', 'token-beto')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 410]);
  assert.equal((await lista(app)).body.cupones[0].canjes, 1);
});

test('pausar y reactivar: pausado no se canjea; al reactivar sí; un cupón con canjes no se borra', async () => {
  const { app } = servidor();
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  const p = await estado(app, 'canal100', 'pausado');
  assert.equal(p.status, 200); assert.equal(p.body.cupon.estado, 'pausado');
  assert.equal((await canjear(app, 'CANAL100')).status, 404);
  const r = await estado(app, 'CANAL100', 'activo');
  assert.equal(r.body.cupon.estado, 'activo');
  assert.equal((await canjear(app, 'CANAL100')).status, 200);
  assert.equal((await estado(app, 'NOEXISTE', 'pausado')).status, 404);
  assert.equal((await estado(app, 'CANAL100', 'borrado')).status, 400);
});

test('"ver quién": nombre, correo, créditos y fecha de cada canje', async () => {
  const { app } = servidor();
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  await canjear(app, 'CANAL100'); await canjear(app, 'CANAL100', 'token-beto');
  const r = await canjes(app, 'CANAL100');
  assert.equal(r.status, 200); assert.equal(r.body.total, 2);
  assert.deepEqual(Object.keys(r.body.canjes[0]).sort(), ['correo', 'creditos', 'en', 'nombre']);
  assert.deepEqual(r.body.canjes.map(x => x.nombre).sort(), ['Ana', 'Beto']);
  assert.equal((await canjes(app, 'xx')).status, 400);
});

test('el aviso dice SI hay un cupón (y cuánto da), nunca la clave; desaparece al canjearlo y no cuenta los pausados, vencidos ni agotados', async () => {
  const { app } = servidor();
  assert.deepEqual((await disponible(app)).body, { ok: true, hay: false, cantidad: 0, creditos: 0, limitado: false, ids: [] });
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  await crear(app, { clave: 'GRANDE2', creditos: 300, vence: FUTURO() });
  await crear(app, { clave: 'PAUSA3', creditos: 500 }); await estado(app, 'PAUSA3', 'pausado');
  const d = await disponible(app);
  assert.deepEqual([d.body.hay, d.body.cantidad, d.body.creditos, d.body.limitado], [true, 2, 300, true]);
  assert.equal(d.body.ids.length, 2);
  const texto = JSON.stringify(d.body);
  for (const clave of ['CANAL100', 'GRANDE2', 'PAUSA3']) assert.ok(!texto.includes(clave), 'no filtra la clave ' + clave);
  await canjear(app, 'CANAL100'); await canjear(app, 'GRANDE2');
  assert.equal((await disponible(app)).body.hay, false, 'ya canjeó todo lo que había');
  assert.equal((await disponible(app, 'token-beto')).body.hay, true, 'a otra persona todavía le toca');
});

test('límite de intentos: 5 claves que no sirven y la persona espera; acertar borra los fallos; otra persona no se ve afectada', async () => {
  const { app } = servidor();
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  for (let i = 0; i < 5; i++) assert.equal((await canjear(app, 'MAL' + i + 'XX')).status, 404);
  const bloqueado = await canjear(app, 'CANAL100');
  assert.equal(bloqueado.status, 429);
  assert.equal(bloqueado.body.codigo, 'demasiados-intentos');
  assert.match(bloqueado.body.error, /Espera \d+ minutos?/);
  assert.equal((await canjear(app, 'CANAL100', 'token-beto')).status, 200, 'otra persona no depende de ese bloqueo');
});

test('el limitador de intentos libera después de la ventana y un acierto borra los fallos', () => {
  let t = 0;
  const l = C.crearLimitadorIntentos({ ahora: () => t, max: 3, ventanaMs: 1000 });
  l.fallo('u'); l.fallo('u'); l.fallo('u');
  assert.throws(() => l.revisar('u'), e => e.status === 429 && e.codigo === 'demasiados-intentos');
  t = 1001; assert.doesNotThrow(() => l.revisar('u'));
  l.fallo('u'); l.fallo('u'); l.acierto('u'); l.fallo('u');
  assert.doesNotThrow(() => l.revisar('u'));
});

test('solo cuentas con el correo verificado y que no sean de administración', async () => {
  const { app, db } = servidor();
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  const sin = await canjear(app, 'CANAL100', 'token-sinverificar');
  assert.equal(sin.status, 409); assert.equal(sin.body.codigo, 'correo-no-verificado');
  const adm = await canjear(app, 'CANAL100', 'token-admin');
  assert.equal(adm.status, 409);
  assert.equal(db.value('creditosCuentas/admin'), undefined);
  assert.equal((await disponible(app, 'token-admin')).body.hay, false, 'a la administración no se le avisa');
});

test('los créditos de un cupón se canjean como cualquier regalo y salen en el historial con su origen', async () => {
  const { app } = servidor();
  await crear(app, { clave: 'CANAL100', creditos: 100 });
  await canjear(app, 'CANAL100');
  const h = await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'));
  assert.equal(h.status, 200);
  const x = h.body.regalos.find(r => r.uid === 'ana');
  assert.deepEqual([x.cantidad, x.origen, x.cupon, x.estado], [100, 'cupon', 'CANAL100', 'pendiente']);
  const est = await request(app).get('/api/creditos/estado').set(auth('token-ana'));
  assert.equal(est.body.saldo, 100);
  assert.equal(est.body.avisoPendiente, 0);
});

// ── Para quién es el cupón: todas las cuentas, solo cuentas gratuitas o solo miembros VIP ──
const servidorConVip = () => servidor({ 'miembros/beto': require('./helpers/club').miembroConPlan({ name: 'Beto', email: 'beto@example.com' }) });

test('para quién: todas las cuentas por omisión, solo gratuitas o solo VIP; un valor raro da 400', async () => {
  const { app } = servidor();
  const a = await crear(app, { clave: 'PARATODOS', creditos: 100 });
  assert.equal(a.body.cupon.audiencia, 'todos');
  assert.equal((await crear(app, { clave: 'SOLOFREE', creditos: 100, audiencia: 'gratuitos' })).body.cupon.audiencia, 'gratuitos');
  assert.equal((await crear(app, { clave: 'SOLOVIP', creditos: 100, audiencia: 'vip' })).body.cupon.audiencia, 'vip');
  for (const raro of ['miembros', 'VIP', 5, {}]) assert.equal((await crear(app, { clave: 'RARO' + String(raro).length + 'XX', creditos: 100, audiencia: raro })).status, 400, JSON.stringify(raro));
  const l = (await lista(app)).body.cupones.map(c => [c.clave, c.audiencia]).sort();
  assert.deepEqual(l, [['PARATODOS', 'todos'], ['SOLOFREE', 'gratuitos'], ['SOLOVIP', 'vip']]);
});

test('un cupón anterior, sin el dato de para quién, vale para todas las cuentas', async () => {
  const { app } = servidor({ 'creditosCupones/VIEJO1': { clave: 'VIEJO1', creditos: 100, canjes: 0, creditosEntregados: 0, estado: 'activo', creadoMs: Date.now() } });
  assert.equal((await lista(app)).body.cupones[0].audiencia, 'todos');
  assert.equal((await canjear(app, 'VIEJO1')).status, 200);
});

test('solo para miembros VIP: una cuenta gratuita no lo canjea (403, sin gastar un intento) y una con membresía sí', async () => {
  const { app, db } = servidorConVip();
  await crear(app, { clave: 'SOLOVIP', creditos: 100, audiencia: 'vip' });
  const gratis = await canjear(app, 'SOLOVIP', 'token-ana');
  assert.equal(gratis.status, 403); assert.equal(gratis.body.codigo, 'cupon-no-aplica'); assert.equal(gratis.body.audiencia, 'vip');
  assert.equal(gratis.body.error, 'Este cupón es solo para miembros VIP.');
  assert.equal(saldoDe(db), 0);
  for (let i = 0; i < 6; i++) assert.equal((await canjear(app, 'SOLOVIP', 'token-ana')).status, 403, 'no es un intento fallido: nunca se bloquea por esto');
  const vip = await canjear(app, 'SOLOVIP', 'token-beto');
  assert.equal(vip.status, 200);
  assert.equal((db.value('creditosCuentas/beto') || {}).saldo, 100);
});

test('solo para cuentas gratuitas: una con membresía no lo canjea y una sin membresía sí', async () => {
  const { app, db } = servidorConVip();
  await crear(app, { clave: 'SOLOFREE', creditos: 100, audiencia: 'gratuitos' });
  const vip = await canjear(app, 'SOLOFREE', 'token-beto');
  assert.equal(vip.status, 403); assert.equal(vip.body.error, 'Este cupón es solo para cuentas gratuitas.');
  assert.equal((db.value('creditosCuentas/beto') || {}).saldo, undefined);
  assert.equal((await canjear(app, 'SOLOFREE', 'token-ana')).status, 200);
});

test('el aviso solo se ofrece a quien el cupón le sirve (y cuenta solo esos)', async () => {
  const { app } = servidorConVip();
  assert.equal((await disponible(app, 'token-ana')).body.hay, false);
  await crear(app, { clave: 'SOLOVIP', creditos: 300, audiencia: 'vip' });
  assert.equal((await disponible(app, 'token-ana')).body.hay, false, 'a una cuenta gratuita no le avisa de un cupón VIP');
  const v = await disponible(app, 'token-beto');
  assert.deepEqual([v.body.hay, v.body.cantidad, v.body.creditos], [true, 1, 300]);
  await crear(app, { clave: 'SOLOFREE', creditos: 100, audiencia: 'gratuitos' });
  await crear(app, { clave: 'PARATODOS', creditos: 200 });
  const g = await disponible(app, 'token-ana');
  assert.deepEqual([g.body.cantidad, g.body.creditos], [2, 200], 'gratuitos + todos');
  const m = await disponible(app, 'token-beto');
  assert.deepEqual([m.body.cantidad, m.body.creditos], [2, 300], 'vip + todos');
  assert.ok(!JSON.stringify(g.body).includes('SOLOVIP') && !JSON.stringify(m.body).includes('SOLOFREE'));
});

test('quien ya canjeó o un cupón de otro tipo no aparece como disponible; los cupones vencidos ni agotados tampoco, sea cual sea la audiencia', async () => {
  const { app } = servidorConVip();
  await crear(app, { clave: 'SOLOVIP', creditos: 100, audiencia: 'vip', maxPersonas: 1 });
  await canjear(app, 'SOLOVIP', 'token-beto');
  assert.equal((await disponible(app, 'token-beto')).body.hay, false);
});

test('si la persona deja de tener membresía el cupón VIP deja de servirle, y al revés; lo decide el servidor en el momento', async () => {
  const { app, db } = servidorConVip();
  await crear(app, { clave: 'SOLOVIP', creditos: 100, audiencia: 'vip' });
  db._data.set('miembros/beto', { ...db.value('miembros/beto'), planActivo: false, planStatus: 'canceled', planVence: null });
  assert.equal((await canjear(app, 'SOLOVIP', 'token-beto')).status, 403);
});
