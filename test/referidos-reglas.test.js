'use strict';

// Reglas puras de referidos: código, dispositivos, hitos y alias (sin Firebase).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../services/referidos');

const ts = ms => ({ toMillis: () => ms });
const inv = (uid, extra = {}) => ({ uid, anfitrionUid: 'host', deviceId: `dispositivo-${uid}`, huella: `huella-${uid}`, ip: `10.0.0.${uid.length}${uid.charCodeAt(0)}`, creadoEn: ts(1000), estado: 'valido', ...extra });

test('código: ZOO- + 6 primeras letras del uid en mayúsculas, y el enlace de registro', () => {
  assert.equal(R.codigoDeUid('abcdef123xyz'), 'ZOO-ABCDEF');
  assert.equal(R.codigoDeUid('Ab12Cd3456'), 'ZOO-AB12CD');
  assert.equal(R.enlaceDeCodigo('ZOO-ABCDEF'), 'https://www.zoorigen.com/pages/club-registro.html?ref=ZOO-ABCDEF');
});

test('código: se normaliza (mayúsculas, espacios) y se rechaza lo que no tiene la forma', () => {
  assert.equal(R.normalizarCodigo(' zoo-abcdef '), 'ZOO-ABCDEF');
  assert.equal(R.normalizarCodigo('ZOO-AB12CD'), 'ZOO-AB12CD');
  for (const malo of ['', 'ZOO-ABC', 'ZOO-ABCDEFG', 'XXX-ABCDEF', 'ZOO-ABC DEF', 'ZOO-ABC<EF', null, undefined, 123, ['ZOO-ABCDEF'], { a: 1 }]) {
    assert.equal(R.normalizarCodigo(malo), null, String(malo));
  }
});

test('variantes del prefijo: todas las mayúsculas/minúsculas posibles de las 6 letras (máximo 64)', () => {
  assert.equal(R.variantesDePrefijo('ZOO-123456').length, 1);
  assert.deepEqual(R.variantesDePrefijo('ZOO-AB1234').sort(), ['AB1234', 'Ab1234', 'aB1234', 'ab1234']);
  const v = R.variantesDePrefijo('ZOO-ABCDEF');
  assert.equal(v.length, 64);
  assert.ok(v.includes('abCDeF') && v.includes('ABCDEF') && v.includes('abcdef'));
  assert.ok(v.every(x => R.codigoDeUid(x) === 'ZOO-ABCDEF'));
});

test('dispositivo: se valida forma y largo del identificador y de la huella (ambos obligatorios)', () => {
  const ok = { deviceId: '11111111-1111-4111-8111-111111111111', huella: 'a1B2c3D4e5' };
  assert.deepEqual(R.validarDispositivo(ok), ok);
  assert.deepEqual(R.validarDispositivo({ deviceId: ' abcdefgh ', huella: ' abcdef ' }), { deviceId: 'abcdefgh', huella: 'abcdef' });
  for (const malo of [{}, { deviceId: ok.deviceId }, { huella: ok.huella }, { ...ok, deviceId: 'corto' }, { ...ok, deviceId: 'x'.repeat(65) },
    { ...ok, deviceId: 'con espacios dentro' }, { ...ok, deviceId: '<script>alert(1)</script>' }, { ...ok, huella: 'ab' }, { ...ok, huella: 'x'.repeat(200) },
    { ...ok, deviceId: 12345678 }, { ...ok, huella: ['abcdef'] }, { ...ok, deviceId: { $ne: 1 } }]) {
    assert.equal(R.validarDispositivo(malo), null, JSON.stringify(malo));
  }
  assert.equal(R.validarDispositivo(), null);
});

test('IP: primer valor de x-forwarded-for; si no hay, la del socket; solo caracteres de IP', () => {
  assert.equal(R.ipDeSolicitud({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, '::1'), '203.0.113.9');
  assert.equal(R.ipDeSolicitud({ 'x-forwarded-for': ' 203.0.113.9 ' }, '::1'), '203.0.113.9');
  assert.equal(R.ipDeSolicitud({}, '::ffff:127.0.0.1'), '::ffff:127.0.0.1');
  assert.equal(R.ipDeSolicitud({ 'x-forwarded-for': '<script>' }, ''), '');
  assert.equal(R.ipDeSolicitud({}, ''), '');
});

test('dispositivos del anfitrión: se agregan sin repetir y solo los últimos 20', () => {
  let d = R.agregarDispositivo(null, { deviceId: 'dispositivo-1', huella: 'huella-1', ip: '1.1.1.1' });
  assert.deepEqual(d, { ids: ['dispositivo-1'], huellas: ['huella-1'], combos: ['huella-1|1.1.1.1'] });
  d = R.agregarDispositivo(d, { deviceId: 'dispositivo-1', huella: 'huella-1', ip: '1.1.1.1' });
  assert.equal(d.ids.length, 1);
  d = R.agregarDispositivo(d, { deviceId: 'dispositivo-2', huella: null, ip: '' });
  assert.deepEqual(d, { ids: ['dispositivo-1', 'dispositivo-2'], huellas: ['huella-1'], combos: ['huella-1|1.1.1.1'] });
  for (let i = 0; i < 30; i++) d = R.agregarDispositivo(d, { deviceId: `dispositivo-n${i}`, huella: `h${i}h${i}h`, ip: '2.2.2.2' });
  assert.equal(d.ids.length, 20);
  assert.equal(d.ids.at(-1), 'dispositivo-n29');
  assert.deepEqual(R.normalizarDispositivosAnfitrion('basura'), { ids: [], huellas: [], combos: [] });
});

test('mismo dispositivo: mismo identificador, o misma huella Y misma IP (la IP sola o la huella sola no bastan)', () => {
  const a = { deviceId: 'dispositivo-aaaa', huella: 'huella-1', ip: '1.1.1.1' };
  assert.equal(R.mismoDispositivo(a, { deviceId: 'dispositivo-aaaa', huella: 'otra-huella', ip: '9.9.9.9' }), true);
  assert.equal(R.mismoDispositivo(a, { deviceId: 'dispositivo-bbbb', huella: 'huella-1', ip: '1.1.1.1' }), true);
  assert.equal(R.mismoDispositivo(a, { deviceId: 'dispositivo-bbbb', huella: 'huella-1', ip: '2.2.2.2' }), false, 'misma huella, otra IP');
  assert.equal(R.mismoDispositivo(a, { deviceId: 'dispositivo-bbbb', huella: 'huella-2', ip: '1.1.1.1' }), false, 'misma IP, otra huella');
  assert.equal(R.mismoDispositivo({ deviceId: 'dispositivo-bbbb', huella: 'huella-1', ip: '' }, { deviceId: 'dispositivo-cccc', huella: 'huella-1', ip: '' }), false, 'sin IP no se compara la huella');
});

test('control: se rechaza al invitado que es el propio anfitrión o que usa su mismo dispositivo', () => {
  const host = { ids: ['dispositivo-host'], huellas: ['huella-host'], combos: ['huella-host|7.7.7.7'] };
  assert.equal(R.evaluarDispositivo(inv('host'), host), 'mismo-usuario');
  assert.equal(R.evaluarDispositivo(inv('a', { deviceId: 'dispositivo-host' }), host), 'dispositivo-anfitrion');
  assert.equal(R.evaluarDispositivo(inv('a', { huella: 'huella-host', ip: '7.7.7.7' }), host), 'dispositivo-anfitrion');
  assert.equal(R.evaluarDispositivo(inv('a', { huella: 'huella-host', ip: '8.8.8.8' }), host), null);
  assert.equal(R.evaluarDispositivo(inv('a', { huella: 'otra-huella', ip: '7.7.7.7' }), host), null);
  assert.equal(R.evaluarDispositivo(inv('a'), host), null);
  assert.equal(R.evaluarDispositivo(inv('a'), null), null);
});

test('control: contra otros invitados solo choca con los ya válidos que comparten dispositivo', () => {
  const host = { ids: [], huellas: [], combos: [] };
  const primero = inv('p', { deviceId: 'dispositivo-comun', estado: 'valido' });
  assert.equal(R.evaluarDispositivo(inv('s', { deviceId: 'dispositivo-comun' }), host, [primero]), 'dispositivo-invitado');
  assert.equal(R.evaluarDispositivo(inv('s', { huella: primero.huella, ip: primero.ip }), host, [primero]), 'dispositivo-invitado');
  assert.equal(R.evaluarDispositivo(inv('s'), host, [primero]), null, 'dispositivo distinto');
  for (const estado of ['rechazado', 'pendiente-correo']) {
    assert.equal(R.evaluarDispositivo(inv('s', { deviceId: 'dispositivo-comun' }), host, [{ ...primero, estado }]), null, `un ${estado} no bloquea`);
  }
  assert.equal(R.evaluarDispositivo(inv('p'), host, [primero]), null, 'no choca consigo mismo');
});

test('control: con soloAnteriores el que se registró primero se queda y el segundo pierde (empate por uid)', () => {
  const host = { ids: [], huellas: [], combos: [] };
  const a = inv('a', { deviceId: 'dispositivo-comun', creadoEn: ts(1000) });
  const b = inv('b', { deviceId: 'dispositivo-comun', creadoEn: ts(2000) });
  assert.equal(R.evaluarDispositivo(b, host, [a, b], { soloAnteriores: true }), 'dispositivo-invitado');
  assert.equal(R.evaluarDispositivo(a, host, [a, b], { soloAnteriores: true }), null);
  const c = inv('c', { deviceId: 'dispositivo-comun', creadoEn: ts(1000) });
  assert.equal(R.evaluarDispositivo(c, host, [a, c], { soloAnteriores: true }), 'dispositivo-invitado', 'mismo instante: gana el uid menor');
  assert.equal(R.evaluarDispositivo(a, host, [a, c], { soloAnteriores: true }), null);
});

test('cuenta nueva: hasta 14 días de antigüedad; sin dato se acepta', () => {
  const ahora = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(R.cuentaNueva('Fri, 09 Oct 2026 11:00:00 GMT', ahora), true);
  assert.equal(R.cuentaNueva('Thu, 01 Oct 2026 11:00:00 GMT', ahora), true);
  assert.equal(R.cuentaNueva('Mon, 31 Aug 2026 11:00:00 GMT', ahora), false);
  assert.equal(R.cuentaNueva(undefined, ahora), true);
  assert.equal(R.cuentaNueva('no es fecha', ahora), true);
});

test('hitos: pago 120, 5 retos 40, 15 retos 80; cada uno UNA sola vez y no se pierde', () => {
  assert.deepEqual(R.HITOS.map(h => [h.clave, h.puntos]), [['pago', 120], ['retos5', 40], ['retos15', 80]]);
  let r = R.actualizarHitos(null, { pago: false, retosSuperados: 4 });
  assert.deepEqual(r, { hitos: { pago: false, retos5: false, retos15: false }, nuevos: [] });
  r = R.actualizarHitos(r.hitos, { pago: true, retosSuperados: 5 });
  assert.deepEqual(r.nuevos, ['pago', 'retos5']);
  r = R.actualizarHitos(r.hitos, { pago: true, retosSuperados: 5 });
  assert.deepEqual(r.nuevos, [], 'no se repite');
  r = R.actualizarHitos(r.hitos, { pago: false, retosSuperados: 0 });
  assert.deepEqual(r.hitos, { pago: true, retos5: true, retos15: false }, 'lo logrado no se pierde');
  r = R.actualizarHitos(r.hitos, { retosSuperados: 20 });
  assert.deepEqual(r.nuevos, ['retos15']);
  assert.equal(R.puntosDeHitos(r.hitos), 240);
  assert.equal(R.XP_POR_INVITADO, 240);
  assert.equal(R.XP_MAXIMO_REFERIDOS, 6 * 240);
});

test('hitos: solo un invitado válido muestra hitos logrados', () => {
  const guardados = { pago: true, retos5: true, retos15: false };
  assert.deepEqual(R.listaDeHitos(guardados, true).map(h => h.logrado), [true, true, false]);
  assert.deepEqual(R.listaDeHitos(guardados, false).map(h => h.logrado), [false, false, false]);
  assert.deepEqual(Object.keys(R.listaDeHitos(null, true)[0]).sort(), ['clave', 'logrado', 'puntos', 'texto']);
});

test('pago: se acepta un cobro confirmado o plan vigente de Stripe; un alta manual del administrador no', () => {
  assert.equal(R.invitadoPago({ ultimoPago: { toMillis() {} } }, null, false), true);
  assert.equal(R.invitadoPago({ ultimoPago: null }, { ultimoPago: 'x' }, false), true);
  assert.equal(R.invitadoPago({ stripeSubscriptionId: 'sub_1' }, null, true), true);
  assert.equal(R.invitadoPago({ stripeSubscriptionId: 'sub_1' }, null, false), false, 'sin plan vigente no');
  assert.equal(R.invitadoPago({ stripeSubscriptionId: 'sub_1', activadoManualmente: true }, null, true), false);
  assert.equal(R.invitadoPago({ planActivo: true }, null, true), false, 'solo plan sin pago ni suscripción no basta');
  assert.equal(R.invitadoPago(null, null, false), false);
});

test('resumen: cuenta estados y solo los primeros 6 válidos suman XP', () => {
  const todos = Array.from({ length: 8 }, (_, n) => ({ uid: `v${n}`, estado: 'valido', hitos: { pago: true, retos5: false, retos15: false } }));
  const r = R.resumirInvitados([...todos, { uid: 'p', estado: 'pendiente-correo', hitos: { pago: true } }, { uid: 'x', estado: 'rechazado', hitos: { pago: true } }]);
  assert.deepEqual([r.validos, r.pendientes, r.rechazados], [8, 1, 1]);
  assert.equal(r.xp, 6 * 120, 'pendientes, rechazados y del 7.º en adelante no suman');
  assert.equal(r.detalle.filter(d => d.conPuntos).length, 6);
  assert.equal(r.detalle[6].puntos, 0);
});

test('alias: primer nombre + inicial; nunca correos ni números', () => {
  const casos = [['María García', 'María G.'], ['Luis Gómez Ruiz', 'Luis G.'], ['Juan Carlos Pérez Gómez', 'Juan P.'], ['Pedro', 'Pedro'],
    ['ana@correo.com', 'Miembro'], ['5512345678', 'Miembro'], ['', 'Miembro'], [null, 'Miembro'], [undefined, 'Miembro'], ['Óscar Núñez', 'Óscar N.'],
    ['  luisa   mora  ', 'luisa M.'], ['Ana ana@x.com Pérez', 'Ana P.']];
  for (const [entrada, esperado] of casos) assert.equal(R.aliasDeNombre(entrada), esperado, String(entrada));
  assert.ok(R.aliasDeNombre('X'.repeat(80) + ' Lopez').length <= 24);
});
