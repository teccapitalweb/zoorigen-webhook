'use strict';

// Referidos completos: registro del invitado (idempotente), control de dispositivos, correo
// confirmado, hitos con XP y premios por invitados válidos. Todo con Firestore/Auth simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');

// El anfitrión tiene un uid con mayúsculas y minúsculas: su código sale en mayúsculas (ZOO-AB12CD)
const HOST = 'Ab12Cd3456xyz';
const CODIGO = 'ZOO-AB12CD';
const INVITADOS = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'];
const tokens = tokensDe(HOST, 'otrapersona', ...INVITADOS);
const usuariosAuth = () => Object.fromEntries(INVITADOS.map(u => [u, { emailVerified: true }]));
const NOMBRES = { i1: 'Luis Gómez Ruiz', i2: 'María García', i3: 'Pedro Sánchez', i4: 'Ana López', i5: 'Jorge Díaz', i6: 'Carla Mora', i7: 'Raúl Peña', i8: 'Sofía Luna' };
const baseSeed = (extra = {}) => ({
  ...cursosSeed(15),
  [`miembros/${HOST}`]: miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com', phone: '2361110000' }),
  'miembros/otrapersona': miembroSinPlan({ name: 'Otro Sin Plan' }),
  ...Object.fromEntries(INVITADOS.map(u => [`miembros/${u}`, miembroSinPlan({ name: NOMBRES[u], email: `${u}@example.com`, phone: `236000000${u.slice(1)}` })])),
  ...extra
});
const DEV = n => `dispositivo-0000-0000-000${n}`;
const HUE = n => `huella-numero-${n}`;
const cuerpo = (n, extra = {}) => ({ codigo: CODIGO, deviceId: DEV(n), huella: HUE(n), ...extra });
const registrar = (app, uid, body, ip = '203.0.113.50') =>
  request(app).post('/api/referidos/registrar').set(auth(`token-${uid}`)).set('X-Forwarded-For', ip).send(body);
const estado = (app, uid = HOST, cabeceras = {}) => {
  let r = request(app).get('/api/referidos/estado').set(auth(`token-${uid}`));
  for (const [k, v] of Object.entries(cabeceras)) r = r.set(k, v);
  return r;
};
const premios = (app, uid = HOST) => request(app).get('/api/premios').set(auth(`token-${uid}`));
const montar = (opciones = {}) => cargarServidor({ tokens, seed: baseSeed(opciones.seed), usuariosAuth: opciones.usuariosAuth || usuariosAuth() });
// Registra n invitados válidos, cada uno con su dispositivo e IP
async function registrarValidos(app, n) {
  for (let k = 1; k <= n; k++) assert.equal((await registrar(app, `i${k}`, cuerpo(k), `198.51.100.${k}`)).body.estado, 'valido');
}

// ── registrar ──
test('registrar: 401 sin sesión', async () => {
  const { app } = montar();
  assert.equal((await request(app).post('/api/referidos/registrar').send(cuerpo(1))).status, 401);
  assert.equal((await request(app).post('/api/referidos/registrar').set(auth('falso')).send(cuerpo(1))).status, 401);
});

test('registrar: 400 con código o datos del dispositivo inválidos (nada se guarda)', async () => {
  const { app, db } = montar();
  const malos = [
    {}, { ...cuerpo(1), codigo: undefined }, { ...cuerpo(1), codigo: 'ZOO-AB' }, { ...cuerpo(1), codigo: 'otra-cosa' }, { ...cuerpo(1), codigo: 123 }, { ...cuerpo(1), codigo: ['ZOO-AB12CD'] },
    { ...cuerpo(1), deviceId: undefined }, { ...cuerpo(1), deviceId: 'x' }, { ...cuerpo(1), deviceId: '<img src=x>' }, { ...cuerpo(1), deviceId: 55555555 },
    { ...cuerpo(1), huella: undefined }, { ...cuerpo(1), huella: 'a' }, { ...cuerpo(1), huella: { a: 1 } }
  ];
  for (const [n, b] of malos.entries()) {
    const r = await registrar(app, n < 8 ? 'i1' : 'i2', b);   // el límite es de 10 intentos por minuto por persona
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.ok(r.body.error);
  }
  assert.equal(db.value('referidos/i1'), undefined);
});

test('registrar: un invitado con correo confirmado (Google) queda VÁLIDO y se guarda con su dispositivo e IP', async () => {
  const { app, db } = montar();
  const r = await registrar(app, 'i1', cuerpo(1), '198.51.100.7, 10.0.0.1');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body, { ok: true, estado: 'valido' });
  const doc = db.value('referidos/i1');
  assert.equal(doc.anfitrionUid, HOST);
  assert.equal(doc.codigo, CODIGO);
  assert.equal(doc.deviceId, DEV(1));
  assert.equal(doc.huella, HUE(1));
  assert.equal(doc.ip, '198.51.100.7', 'primer valor de x-forwarded-for');
  assert.equal(doc.estado, 'valido');
  assert.equal(doc.motivo, null);
  assert.ok(doc.creadoEn);
  assert.equal(typeof doc.ua, 'string');
});

test('registrar: el código puede venir en minúsculas y se busca al anfitrión aunque su uid mezcle mayúsculas y minúsculas', async () => {
  const { app, db } = montar();
  const r = await registrar(app, 'i1', cuerpo(1, { codigo: ' zoo-ab12cd ' }));
  assert.equal(r.body.estado, 'valido');
  assert.equal(db.value('referidos/i1').anfitrionUid, HOST);
  assert.deepEqual(db.value(`codigosReferido/${CODIGO}`).uid, HOST, 'queda registrado para la próxima');
});

test('registrar: si el código está en el registro de códigos no hace falta buscar al anfitrión', async () => {
  const { app, db } = montar({ seed: { [`codigosReferido/${CODIGO}`]: { uid: HOST, codigo: CODIGO } } });
  const antes = db.collection.bind(db);
  let consultasAMiembros = 0;
  db.collection = n => { const c = antes(n); if (n === 'miembros') { const where = c.where.bind(c); c.where = (...a) => { consultasAMiembros++; return where(...a); }; } return c; };
  assert.equal((await registrar(app, 'i1', cuerpo(1))).body.estado, 'valido');
  assert.equal(consultasAMiembros, 0);
});

test('registrar: código que no existe -> rechazado con motivo, y no consume el registro (puede usar otro código)', async () => {
  const { app, db } = montar();
  const r = await registrar(app, 'i1', cuerpo(1, { codigo: 'ZOO-QQQQQQ' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.estado, 'rechazado');
  assert.match(r.body.motivo, /no existe/i);
  assert.equal(db.value('referidos/i1'), undefined);
  assert.equal((await registrar(app, 'i1', cuerpo(1))).body.estado, 'valido');
});

test('registrar: el anfitrión no puede registrarse con su propio código', async () => {
  const { app, db } = montar();
  const r = await registrar(app, HOST, cuerpo(1));
  assert.equal(r.body.estado, 'rechazado');
  assert.match(r.body.motivo, /propio/i);
  assert.equal(db.value(`referidos/${HOST}`), undefined);
  assert.equal((await estado(app)).body.validos, 0);
});

test('registrar: IDEMPOTENTE — repetir la llamada no crea otro invitado ni cambia nada', async () => {
  const { app, db } = montar();
  const a = await registrar(app, 'i1', cuerpo(1));
  const guardado = db.value('referidos/i1');
  const b = await registrar(app, 'i1', cuerpo(1));
  const c = await registrar(app, 'i1', cuerpo(5, { codigo: 'ZOO-QQQQQQ' }), '203.0.113.99');
  assert.deepEqual(b.body, a.body);
  assert.deepEqual(c.body, a.body, 'tampoco se puede cambiar de anfitrión ni de dispositivo');
  assert.deepEqual(db.value('referidos/i1'), guardado);
  assert.equal((await estado(app)).body.validos, 1);
});

test('registrar: IDEMPOTENTE también en simultáneo — dos llamadas a la vez dejan un solo registro', async () => {
  const { app, db } = montar();
  const [a, b] = await Promise.all([registrar(app, 'i1', cuerpo(1)), registrar(app, 'i1', cuerpo(1))]);
  assert.deepEqual(a.body, b.body);
  const docs = [...db._data.keys()].filter(k => k.startsWith('referidos/'));
  assert.deepEqual(docs, ['referidos/i1']);
  assert.equal((await estado(app)).body.validos, 1);
});

test('correo SIN confirmar: queda pendiente-correo y NO cuenta para premios ni XP', async () => {
  const au = usuariosAuth(); au.i1.emailVerified = false;
  const { app } = montar({ usuariosAuth: au });
  const r = await registrar(app, 'i1', cuerpo(1));
  assert.deepEqual(r.body, { ok: true, estado: 'pendiente-correo' });
  const e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.pendientes, e.rechazados], [0, 1, 0]);
  assert.equal(e.invitados[0].estado, 'pendiente-correo');
  assert.equal(e.puntosTotales, 0);
  const p = (await premios(app)).body;
  assert.equal(p.xp.referidos, 0);
  assert.ok(!p.logros.find(l => l.id === 'l21').ganado);
});

test('correo: pasa a VÁLIDO solo cuando Firebase dice que ya confirmó (al consultar el anfitrión o al repetir el registro)', async () => {
  const au = usuariosAuth(); au.i1.emailVerified = false; au.i2.emailVerified = false;
  const { app, db } = montar({ usuariosAuth: au });
  await registrar(app, 'i1', cuerpo(1), '198.51.100.1');
  await registrar(app, 'i2', cuerpo(2), '198.51.100.2');
  assert.equal((await estado(app)).body.validos, 0);
  au.i1.emailVerified = true; au.i2.emailVerified = true;
  const e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.pendientes], [2, 0]);
  assert.equal(db.value('referidos/i1').estado, 'valido');
  // Y repetir registrar de un invitado pendiente también lo pone al día
  au.i3.emailVerified = false;
  await registrar(app, 'i3', cuerpo(3), '198.51.100.3');
  au.i3.emailVerified = true;
  assert.equal((await registrar(app, 'i3', cuerpo(3), '198.51.100.3')).body.estado, 'valido');
});

test('correo: si Firebase Auth falla, el invitado sigue pendiente (no se cuela como válido)', async () => {
  const au = usuariosAuth(); au.i1.emailVerified = false;
  const { app } = montar({ usuariosAuth: au });
  await registrar(app, 'i1', cuerpo(1));
  au.i1.emailVerified = true;
  const original = console.error; console.error = () => {};
  try {
    delete au.i1; // Auth ya no lo encuentra (notFound)
    assert.equal((await estado(app)).body.validos, 0);
  } finally { console.error = original; }
});

test('lo que el navegador escriba en miembros.referredBy YA NO cuenta', async () => {
  const seed = {};
  for (const u of INVITADOS) seed[`miembros/${u}`] = miembroConPlan({ name: NOMBRES[u], referredBy: CODIGO });
  const { app } = montar({ seed });
  const e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.pendientes, e.rechazados, e.invitados.length], [0, 0, 0, 0]);
  assert.equal(e.puntosTotales, 0);
  assert.equal((await premios(app)).body.xp.referidos, 0);
});

test('el viejo POST /api/referidos se quitó', async () => {
  const { app } = montar();
  const r = await request(app).post('/api/referidos').set(auth(`token-${HOST}`)).send({});
  assert.equal(r.status, 404);
});

// ── Control de dispositivos ──
test('dispositivos: mismo deviceId que el anfitrión -> rechazado con motivo', async () => {
  const { app, db } = montar();
  await estado(app, HOST, { 'X-Device-Id': DEV(9) });                  // el anfitrión abre su pantalla desde DEV(9)
  const r = await registrar(app, 'i1', cuerpo(9, { huella: HUE(1) }), '198.51.100.1');
  assert.equal(r.body.estado, 'rechazado');
  assert.match(r.body.motivo, /mismo dispositivo/i);
  assert.equal(db.value('referidos/i1').estado, 'rechazado');
  const e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.rechazados], [0, 1]);
  assert.match(e.invitados[0].motivo, /mismo dispositivo/i);
});

test('dispositivos: misma huella + misma IP que el anfitrión -> rechazado; solo la huella o solo la IP -> válido', async () => {
  const { app } = montar();
  await estado(app, HOST, { 'X-Device-Id': DEV(9), 'X-Huella': HUE(9), 'X-Forwarded-For': '192.0.2.10' });
  const igual = await registrar(app, 'i1', cuerpo(1, { huella: HUE(9) }), '192.0.2.10');
  assert.equal(igual.body.estado, 'rechazado');
  const soloHuella = await registrar(app, 'i2', cuerpo(2, { huella: HUE(9) }), '192.0.2.11');
  assert.equal(soloHuella.body.estado, 'valido', 'misma huella pero otra IP (otro teléfono igual)');
  const soloIp = await registrar(app, 'i3', cuerpo(3), '192.0.2.10');
  assert.equal(soloIp.body.estado, 'valido', 'misma IP pero otro aparato (misma casa)');
});

test('dispositivos: el dispositivo con que el propio anfitrión se registró también cuenta como suyo', async () => {
  // "Qr98St7654" invita al anfitrión; el anfitrión se registra desde DEV(9) y luego invita a i1 desde ese mismo aparato
  const ANTERIOR = 'Qr98St7654';
  const { app, db } = cargarServidor({
    tokens: { ...tokens, 'token-anterior': { uid: ANTERIOR, email: 'a@example.com' } },
    usuariosAuth: { ...usuariosAuth(), [HOST]: { emailVerified: true } },
    seed: { ...baseSeed(), [`miembros/${ANTERIOR}`]: miembroConPlan({ name: 'Persona Anterior' }) }
  });
  const registroDelAnfitrion = await registrar(app, HOST, { codigo: 'ZOO-QR98ST', deviceId: DEV(9), huella: HUE(9) }, '198.51.100.9');
  assert.equal(registroDelAnfitrion.body.estado, 'valido');
  assert.deepEqual(db.value(`dispositivosAnfitrion/${HOST}`).ids, [DEV(9)], 'se guarda como dispositivo suyo');
  const r = await registrar(app, 'i1', cuerpo(1, { deviceId: DEV(9) }), '198.51.100.1');
  assert.equal(r.body.estado, 'rechazado');
  assert.match(r.body.motivo, /mismo dispositivo/i);
});

test('dispositivos: el segundo invitado con el mismo dispositivo que uno ya válido se rechaza', async () => {
  const { app } = montar();
  assert.equal((await registrar(app, 'i1', cuerpo(1), '198.51.100.1')).body.estado, 'valido');
  const mismoId = await registrar(app, 'i2', cuerpo(2, { deviceId: DEV(1) }), '198.51.100.2');
  assert.equal(mismoId.body.estado, 'rechazado');
  assert.match(mismoId.body.motivo, /otra persona invitada/i);
  const mismaHuellaIp = await registrar(app, 'i3', cuerpo(3, { huella: HUE(1) }), '198.51.100.1');
  assert.equal(mismaHuellaIp.body.estado, 'rechazado');
  const distinto = await registrar(app, 'i4', cuerpo(4), '198.51.100.4');
  assert.equal(distinto.body.estado, 'valido');
  assert.equal((await estado(app)).body.validos, 2);
});

test('dispositivos: dos pendientes con el mismo dispositivo — el primero que confirma se queda, el otro se rechaza', async () => {
  const au = usuariosAuth(); au.i1.emailVerified = false; au.i2.emailVerified = false;
  const { app } = montar({ usuariosAuth: au });
  await registrar(app, 'i1', cuerpo(1, { deviceId: DEV(7) }), '198.51.100.1');
  await registrar(app, 'i2', cuerpo(2, { deviceId: DEV(7) }), '198.51.100.2');
  au.i2.emailVerified = true;                                          // confirma primero el segundo
  let e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.pendientes], [1, 1]);
  au.i1.emailVerified = true;
  e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.pendientes, e.rechazados], [1, 0, 1]);
  assert.deepEqual(e.invitados.map(i => i.estado), ['rechazado', 'valido'], 'i1 llegó antes pero confirmó después');
});

test('dispositivos: dos registros SIMULTÁNEOS desde el mismo dispositivo dejan un solo válido', async () => {
  const { app } = montar();
  const [a, b] = await Promise.all([
    registrar(app, 'i1', cuerpo(1, { deviceId: DEV(7) }), '198.51.100.1'),
    registrar(app, 'i2', cuerpo(2, { deviceId: DEV(7) }), '198.51.100.2')
  ]);
  const estados = [a.body.estado, b.body.estado].sort();
  assert.deepEqual(estados, ['rechazado', 'valido']);
  const e = (await estado(app)).body;
  assert.deepEqual([e.validos, e.rechazados], [1, 1]);
});

test('dispositivos: una cuenta que ya existía hace mucho no puede ser "invitado nuevo"', async () => {
  const au = usuariosAuth(); au.i1.creationTime = new Date(Date.now() - 90 * 86400000).toUTCString();
  const { app, db } = montar({ usuariosAuth: au });
  const r = await registrar(app, 'i1', cuerpo(1));
  assert.equal(r.body.estado, 'rechazado');
  assert.match(r.body.motivo, /ya existía/i);
  assert.equal(db.value('referidos/i1').estado, 'rechazado');
  assert.equal((await registrar(app, 'i2', cuerpo(2), '198.51.100.2')).body.estado, 'valido', 'una cuenta recién creada sí');
});

test('dispositivos: el registro de dispositivos del anfitrión guarda solo datos válidos y no más de 20', async () => {
  const { app, db } = montar();
  await estado(app, HOST, { 'X-Device-Id': '<mal>' });
  assert.equal(db.value(`dispositivosAnfitrion/${HOST}`), undefined, 'un identificador inválido se ignora');
  await estado(app, HOST, { 'X-Device-Id': DEV(1), 'X-Huella': 'x' });
  assert.deepEqual(db.value(`dispositivosAnfitrion/${HOST}`).ids, [DEV(1)]);
  assert.deepEqual(db.value(`dispositivosAnfitrion/${HOST}`).huellas, [], 'huella inválida ignorada');
  for (let i = 0; i < 30; i++) {
    const r = await estado(app, HOST, { 'X-Device-Id': `dispositivo-extra-${String(i).padStart(3, '0')}` });
    assert.equal(r.status, 200);
  }
  assert.equal(db.value(`dispositivosAnfitrion/${HOST}`).ids.length, 20);
});

test('registrar: máximo 10 intentos por minuto', async () => {
  const { app } = montar();
  for (let i = 0; i < 10; i++) assert.equal((await registrar(app, 'i1', { codigo: 'mal' })).status, 400);
  assert.equal((await registrar(app, 'i1', cuerpo(1))).status, 429);
});

// ── estado ──
test('estado: 401 sin sesión y no se guarda en caché', async () => {
  const { app } = montar();
  assert.equal((await request(app).get('/api/referidos/estado')).status, 401);
  const r = await estado(app);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('estado: sin invitados trae el código, el enlace y los dos premios con lo que falta', async () => {
  const { app, db } = montar();
  const b = (await estado(app)).body;
  assert.equal(b.ok, true);
  assert.equal(b.codigo, CODIGO);
  assert.equal(b.enlace, `https://www.zoorigen.com/pages/club-registro.html?ref=${CODIGO}`);
  assert.deepEqual([b.validos, b.pendientes, b.rechazados, b.puntosTotales], [0, 0, 0, 0]);
  assert.deepEqual(b.invitados, []);
  assert.deepEqual(b.premios, [
    { clave: 'referidos-1', requisito: '3 invitados válidos', faltan: 3, ganado: false, usado: null },
    { clave: 'referidos-2', requisito: '6 invitados válidos', faltan: 6, ganado: false, usado: null }
  ]);
  assert.deepEqual(db.value(`codigosReferido/${CODIGO}`).uid, HOST);
});

test('estado: cualquier miembro tiene su código, incluso sin plan', async () => {
  const { app } = montar();
  const b = (await estado(app, 'otrapersona')).body;
  assert.equal(b.codigo, 'ZOO-OTRAPE');
  assert.equal(b.enlace, 'https://www.zoorigen.com/pages/club-registro.html?ref=ZOO-OTRAPE');
});

test('estado: cada invitado trae alias, fecha, estado, hitos y puntos', async () => {
  const { app } = montar();
  await registrarValidos(app, 2);
  const b = (await estado(app)).body;
  assert.equal(b.invitados.length, 2);
  const i = b.invitados[0];
  assert.deepEqual(Object.keys(i).sort(), ['alias', 'estado', 'fecha', 'hitos', 'puntos']);
  assert.equal(i.alias, 'Luis G.');
  assert.equal(i.estado, 'valido');
  assert.ok(!Number.isNaN(Date.parse(i.fecha)));
  assert.deepEqual(i.hitos.map(h => [h.clave, h.puntos, h.logrado]), [['pago', 120, false], ['retos5', 40, false], ['retos15', 80, false]]);
  assert.deepEqual(i.hitos.map(h => h.texto), ['Tu invitado pagó una suscripción', 'Tu invitado superó 5 retos', 'Tu invitado superó 15 retos']);
  assert.equal(i.puntos, 0);
  assert.equal(b.invitados[1].alias, 'María G.');
});

test('PRIVACIDAD: ni el estado ni la respuesta de registrar ni los premios exponen correo, teléfono ni uid de los invitados', async () => {
  const { app } = montar();
  const respuestas = [];
  for (let k = 1; k <= 3; k++) respuestas.push((await registrar(app, `i${k}`, cuerpo(k), `198.51.100.${k}`)).body);
  respuestas.push((await estado(app)).body, (await premios(app)).body);
  const texto = JSON.stringify(respuestas);
  for (const secreto of ['@example.com', 'luis@', 'i1@', '2360000001', '2360000002', 'email', 'phone', 'telefono', '"uid"', 'i1', 'i2', 'i3', 'anfitrionUid', 'deviceId', 'huella', '198.51.100']) {
    assert.ok(!texto.includes(secreto), `no debe aparecer ${secreto}`);
  }
  assert.ok(texto.includes('Luis G.'));
});

test('PRIVACIDAD: si el nombre guardado de un invitado es un correo o un teléfono, solo sale "Miembro"', async () => {
  const seed = {
    'miembros/i1': miembroSinPlan({ name: 'secreto@example.com' }),
    'miembros/i2': miembroSinPlan({ name: '2361234567' }),
    'miembros/i3': miembroSinPlan({ name: '', nombreCompleto: 'Pedro 2361234567 Gómez' })
  };
  const { app } = montar({ seed });
  await registrarValidos(app, 3);
  const b = (await estado(app)).body;
  assert.deepEqual(b.invitados.map(i => i.alias), ['Miembro', 'Miembro', 'Pedro G.']);
  assert.ok(!JSON.stringify(b).includes('secreto'));
  assert.ok(!JSON.stringify(b).includes('2361234567'));
});

test('estado: un anfitrión solo ve a SUS invitados', async () => {
  const { app } = montar();
  await registrarValidos(app, 2);
  const b = (await estado(app, 'otrapersona')).body;
  assert.equal(b.invitados.length, 0);
  assert.equal(b.validos, 0);
});

// ── hitos y XP ──
test('hito "pagó": +120 puntos, una sola vez, y no se pierde si el invitado después cancela', async () => {
  const { app, db } = montar();
  await registrarValidos(app, 1);
  let b = (await estado(app)).body;
  assert.equal(b.puntosTotales, 0);
  db._data.set('miembros/i1', miembroConPlan({ name: NOMBRES.i1 }));
  b = (await estado(app)).body;
  assert.equal(b.invitados[0].hitos[0].logrado, true);
  assert.equal(b.invitados[0].puntos, 120);
  assert.equal(b.puntosTotales, 120);
  assert.equal((await premios(app)).body.xp.referidos, 120);
  assert.equal((await estado(app)).body.puntosTotales, 120, 'consultar de nuevo no suma otra vez');
  db._data.set('miembros/i1', miembroSinPlan({ name: NOMBRES.i1, planStatus: 'expired', planVence: ts(dias(-5)) }));
  assert.equal((await estado(app)).body.puntosTotales, 120, 'lo logrado no se pierde');
  assert.equal(db.value('referidos/i1').hitos.pago, true);
});

test('hito "pagó": un alta manual del administrador o solo planActivo=true no cuenta', async () => {
  const { app, db } = montar();
  await registrarValidos(app, 2);
  db._data.set('miembros/i1', miembroConPlan({ name: NOMBRES.i1, activadoManualmente: true, ultimoPago: null }));
  db._data.set('miembros/i2', { name: NOMBRES.i2, planActivo: true, planVence: ts(dias(10)), role: 'member' });
  assert.equal((await estado(app)).body.puntosTotales, 0);
});

test('hitos de retos: 5 retos superados = +40, 15 = +80 (cada uno una vez)', async () => {
  const { app, db } = montar();
  await registrarValidos(app, 1);
  db._data.set('retosUsuario/i1', { uid: 'i1', superados: 4 });
  assert.equal((await estado(app)).body.puntosTotales, 0);
  db._data.set('retosUsuario/i1', { uid: 'i1', superados: 5 });
  let b = (await estado(app)).body;
  assert.equal(b.puntosTotales, 40);
  assert.deepEqual(b.invitados[0].hitos.map(h => h.logrado), [false, true, false]);
  db._data.set('retosUsuario/i1', { uid: 'i1', superados: 60 });
  b = (await estado(app)).body;
  assert.equal(b.puntosTotales, 120);
  assert.deepEqual(b.invitados[0].hitos.map(h => h.logrado), [false, true, true]);
});

test('los hitos de un invitado pendiente o rechazado no dan puntos', async () => {
  const au = usuariosAuth(); au.i1.emailVerified = false;
  const { app, db } = montar({ usuariosAuth: au });
  await registrar(app, 'i1', cuerpo(1), '198.51.100.1');                                  // pendiente
  await estado(app, HOST, { 'X-Device-Id': DEV(9) });
  await registrar(app, 'i2', cuerpo(9), '198.51.100.2');                                  // rechazado (mismo dispositivo)
  for (const u of ['i1', 'i2']) { db._data.set(`miembros/${u}`, miembroConPlan({ name: NOMBRES[u] })); db._data.set(`retosUsuario/${u}`, { uid: u, superados: 30 }); }
  const b = (await estado(app)).body;
  assert.equal(b.puntosTotales, 0);
  assert.ok(b.invitados.every(i => i.hitos.every(h => !h.logrado)));
});

test('el XP de referidos entra al total, al nivel y a la tabla de logros (Embajador / La manada crece)', async () => {
  const { app, db } = montar();
  await registrarValidos(app, 3);
  for (const u of ['i1', 'i2', 'i3']) db._data.set(`miembros/${u}`, miembroConPlan({ name: NOMBRES[u] }));
  const p = (await premios(app)).body;
  assert.equal(p.xp.referidos, 360);
  assert.ok(p.logros.find(l => l.id === 'l21').ganado && p.logros.find(l => l.id === 'l22').ganado);
  assert.equal(p.xp.total, 20 + 60 + 150 + 360, 'bienvenida + Embajador + La manada crece + referidos');
  assert.equal(db.value(`premiosUsuario/${HOST}`).xpTotal, p.xp.total);
});

test('techo: solo los primeros 6 invitados válidos suman XP (máximo 1440) aunque haya más', async () => {
  const { app, db } = montar();
  await registrarValidos(app, 8);
  for (const u of INVITADOS) { db._data.set(`miembros/${u}`, miembroConPlan({ name: NOMBRES[u] })); db._data.set(`retosUsuario/${u}`, { uid: u, superados: 99 }); }
  const b = (await estado(app)).body;
  assert.equal(b.validos, 8);
  assert.equal(b.puntosTotales, 1440);
  assert.equal(b.invitados.filter(i => i.sinPuntos).length, 2);
  assert.equal((await premios(app)).body.xp.referidos, 1440);
});

// ── premios por invitados ──
test('3 invitados válidos ganan "referidos-1"; 6 ganan "referidos-2"; los pendientes no cuentan', async () => {
  const au = usuariosAuth(); au.i3.emailVerified = false;
  const { app, db } = montar({ usuariosAuth: au });
  await registrar(app, 'i1', cuerpo(1), '198.51.100.1');
  await registrar(app, 'i2', cuerpo(2), '198.51.100.2');
  await registrar(app, 'i3', cuerpo(3), '198.51.100.3');                                  // pendiente
  let b = (await estado(app)).body;
  assert.deepEqual(b.premios.map(p => [p.clave, p.faltan, p.ganado]), [['referidos-1', 1, false], ['referidos-2', 4, false]]);
  assert.ok(!(await premios(app)).body.premios.find(p => p.clave === 'referidos-1').ganado);
  au.i3.emailVerified = true;
  b = (await estado(app)).body;
  assert.deepEqual(b.premios.map(p => [p.faltan, p.ganado]), [[0, true], [3, false]]);
  assert.deepEqual(db.value(`premiosUsuario/${HOST}`).ganados, ['referidos-1']);
  for (let k = 4; k <= 6; k++) await registrar(app, `i${k}`, cuerpo(k), `198.51.100.${k}`);
  b = (await estado(app)).body;
  assert.deepEqual(b.premios.map(p => [p.faltan, p.ganado]), [[0, true], [0, true]]);
  assert.deepEqual(db.value(`premiosUsuario/${HOST}`).ganados, ['referidos-1', 'referidos-2']);
});

test('los premios por invitados se canjean con /api/premios/usar y aparecen como usados en el estado', async () => {
  const { app } = montar();
  await registrarValidos(app, 3);
  const g = (await premios(app)).body;
  const p = g.premios.find(x => x.clave === 'referidos-1');
  assert.deepEqual([p.ganado, p.disponible], [true, true]);
  assert.equal(g.disponibles, 1);
  const usar = await request(app).post('/api/premios/usar').set(auth(`token-${HOST}`)).send({ cursoId: 'c4' });
  assert.deepEqual(usar.body, { ok: true, cursoId: 'c4', clave: 'referidos-1' });
  const b = (await estado(app)).body;
  assert.equal(b.premios[0].usado.cursoId, 'c4');
  assert.equal(b.premios[1].usado, null);
  const otra = await request(app).post('/api/premios/usar').set(auth(`token-${HOST}`)).send({ cursoId: 'c5' });
  assert.equal(otra.status, 403, 'solo había un premio');
});

test('un premio de referidos ya ganado no se pierde aunque después el invitado se rechace o salga', async () => {
  const { app, db } = montar();
  await registrarValidos(app, 3);
  assert.ok((await estado(app)).body.premios[0].ganado);
  db._data.set('referidos/i3', { ...db.value('referidos/i3'), estado: 'rechazado', motivo: 'x' });
  const b = (await estado(app)).body;
  assert.equal(b.validos, 2);
  assert.equal(b.premios[0].ganado, true);
});

test('los invitados no cambian el acceso de nadie a los videos (embed-token intacto)', async () => {
  const { VIDEO_PREMIUM } = require('./helpers/cargar-servidor');
  const { app } = montar();
  await registrarValidos(app, 3);
  const inv = await request(app).post('/api/bunny/embed-token').set(auth('token-i1')).send({ videoId: VIDEO_PREMIUM });
  assert.equal(inv.status, 403);
  const host = await request(app).post('/api/bunny/embed-token').set(auth(`token-${HOST}`)).send({ videoId: VIDEO_PREMIUM });
  assert.equal(host.status, 200);
});
