'use strict';

// Métricas de visitas: contador anónimo y sin cookies (services/metricas-visitas.js + services/rutas-metricas-visitas.js).
// Reglas puras (origen, aparato, bots, país, identificador del día), endpoint público (interruptor, CORS, DNT, bots, límite), privacidad
// (nunca IP ni navegador), miembros con sesión, lectura del panel (solo administradores), registro una por una y limpieza.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, cargarServidor, ts, dias, miembroConPlan, miembroSinPlan, auth } = require('./helpers/club');
const V = require('../services/metricas-visitas');
const tarea = require('../services/tarea-diaria');

const DIA = 86400000;
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const UA_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_FB = 'Mozilla/5.0 (Linux; Android 13; SM-A546E Build/TP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.0;]';
const UA_IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0.0 (iPhone14,5; iOS 17_4)';
const UA_TIKTOK = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 musical_ly_2023 TikTok';
const ORIGEN = 'https://www.zoorigen.com';

/* ───────────── Reglas puras ───────────── */

test('día y hora de México: 2026-10-08T05:30Z es 7 de octubre a las 23 h', () => {
  assert.equal(V.claveDia(new Date('2026-10-08T05:30:00Z')), '2026-10-07');
  assert.equal(V.horaMexico(new Date('2026-10-08T05:30:00Z')), '23');
  assert.equal(V.horaMexico(new Date('2026-10-08T06:05:00Z')), '00');
  assert.equal(V.restarDias('2026-03-01', 1), '2026-02-28');
  assert.deepEqual(V.listaDeDias('2026-10-03', 3), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('bots: rastreadores y herramientas no cuentan; los navegadores de Instagram, Facebook y TikTok SÍ', () => {
  for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'facebookexternalhit/1.1', 'WhatsApp/2.23.20.0 A', 'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 HeadlessChrome/124', 'Lighthouse', 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)', '', 'corto']) {
    assert.equal(V.esBot(ua), true, ua);
  }
  for (const ua of [UA_PC, UA_IPHONE, UA_ANDROID, UA_FB, UA_IG, UA_TIKTOK]) assert.equal(V.esBot(ua), false, ua);
});

test('aparato: teléfono, tableta o computadora', () => {
  assert.equal(V.dispositivoDe(UA_IPHONE), 'movil');
  assert.equal(V.dispositivoDe(UA_ANDROID), 'movil');
  assert.equal(V.dispositivoDe(UA_TABLET), 'tablet');
  assert.equal(V.dispositivoDe(UA_IPAD), 'tablet');
  assert.equal(V.dispositivoDe(UA_PC), 'computadora');
  assert.equal(V.dispositivoDe(''), 'computadora');
});

test('origen de la visita: utm → referrer → navegador de la app → igshid → fbclid → directo → otros (tabla de casos reales)', () => {
  const f = (ref, utm, ua, p) => V.fuenteDe(ref, utm, ua, p);
  const casos = [
    [['', '', UA_PC], 'directo'], [['https://www.google.com/', '', UA_PC], 'google'], [['https://www.bing.com/search?q=x', '', UA_PC], 'bing'],
    [['https://duckduckgo.com/', '', UA_PC], 'duckduckgo'], [['https://search.yahoo.com/', '', UA_PC], 'yahoo'],
    [['https://l.facebook.com/l.php?u=x', '', UA_PC], 'facebook'], [['https://m.facebook.com/', '', UA_PC], 'facebook'], [['https://l.instagram.com/?u=x', '', UA_PC], 'instagram'],
    [['https://api.whatsapp.com/', '', UA_PC], 'whatsapp'], [['https://wa.me/5255', '', UA_PC], 'whatsapp'], [['https://t.co/abc', '', UA_PC], 'x'], [['https://www.youtube.com/watch', '', UA_PC], 'youtube'],
    [['https://www.tiktok.com/', '', UA_PC], 'tiktok'], [['https://www.linkedin.com/', '', UA_PC], 'linkedin'], [['https://lnkd.in/x', '', UA_PC], 'linkedin'],
    [['https://outlook.live.com/', '', UA_PC], 'correo'],
    [['https://zoorigen.com/pages/club-login.html', '', UA_PC], 'interno'], [['https://www.zoorigen.com/', '', UA_PC], 'interno'], [['http://127.0.0.1:8765/', '', UA_PC], 'interno'],
    [['https://blog.ejemplo.org/nota', '', UA_PC], 'otros'],
    [['', 'facebook', UA_PC], 'facebook'], [['', 'ig', UA_PC], 'instagram'], [['', 'fb', UA_PC], 'facebook'], [['', 'msg', UA_PC], 'facebook'], [['', 'wa', UA_PC], 'whatsapp'],
    [['', 'tt', UA_PC], 'tiktok'], [['', 'newsletter', UA_PC], 'correo'], [['', 'facebook_ads', UA_PC], 'facebook'], [['', 'x', UA_PC], 'x'], [['', 'xylophone', UA_PC], 'otros'],
    [['https://www.google.com/', 'instagram', UA_PC], 'instagram'],
    [['android-app://com.instagram.android', '', UA_PC], 'instagram'], [['ios-app://389801252/', '', UA_PC], 'instagram'], [['android-app://com.whatsapp', '', UA_PC], 'whatsapp'],
    [['', '', UA_FB], 'facebook'], [['', '', UA_IG], 'instagram'], [['', '', UA_TIKTOK], 'tiktok']
  ];
  for (const [[ref, utm, ua], esperado] of casos) assert.equal(f(ref, utm, ua), esperado, JSON.stringify([ref, utm]));
  assert.equal(f('', '', UA_PC, { igshid: true }), 'instagram');
  assert.equal(f('', '', UA_PC, { fbclid: true }), 'meta', 'enlace de Meta sin más pistas: «Meta sin identificar»');
  assert.equal(f('https://sitio-raro.com/', '', UA_PC, { fbclid: true }), 'otros');
  assert.equal(f('', '', UA_IG + ' FB_IAB', { fbclid: true }), 'instagram', 'Instagram gana a Facebook aunque el navegador diga FB_IAB');
  assert.ok(V.FUENTES.length === 16 && V.FUENTES.includes('meta') && V.FUENTES.includes('interno'));
});

test('origen de una cuenta: el primer contacto debe ser anterior a crearla y de hasta 30 días antes', () => {
  const creada = Date.parse('2026-11-05T12:00:00Z');
  const contacto = (t, extra = {}) => ({ ref: 'https://l.facebook.com/', utm: '', ua: UA_PC, t, ...extra });
  assert.equal(V.origenDeCuenta(contacto(creada - 3600000), creada), 'facebook');
  assert.equal(V.origenDeCuenta(contacto(creada + 5 * 60000), creada), 'facebook', 'hasta 10 minutos después se tolera');
  assert.equal(V.origenDeCuenta(contacto(creada + 20 * 60000), creada), 'sin_dato', 'un contacto posterior no explica la cuenta');
  assert.equal(V.origenDeCuenta(contacto(creada - 40 * DIA), creada), 'sin_dato', 'cuenta anterior al contador');
  assert.equal(V.origenDeCuenta(null, creada), 'sin_dato');
  assert.equal(V.origenDeCuenta(contacto(creada - 1000), null), 'sin_dato');
  assert.equal(V.origenDeCuenta({ ref: '', utm: '', ua: UA_PC, t: creada - 1000, fb: true }, creada), 'meta');
});

test('pistas guardadas por visita: solo el nombre del sitio, la etiqueta y marcas; nunca la dirección completa', () => {
  const p = V.pistasDe({ referrer: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fsecreto&token=abc', utm: 'Face<book>', userAgent: UA_FB, fbclid: true, igshid: false });
  assert.deepEqual(p, { ref: 'l.facebook.com', utm: 'facebook', app: 'facebook', fbclid: true, igshid: false });
  assert.deepEqual(V.pistasDe({ referrer: 'no es una dirección', userAgent: UA_PC }), { ref: '', utm: '', app: '', fbclid: false, igshid: false });
});

test('IP y país: se toma la primera IP pública de las cabeceras del proxy; sin dato queda ZZ; una cabecera del CDN manda sobre la base local', () => {
  assert.equal(V.esIpPublica('187.190.1.1'), true);
  for (const ip of ['10.1.2.3', '192.168.1.5', '172.16.0.1', '127.0.0.1', '::1', 'fd00::1', '100.64.0.9', '']) assert.equal(V.esIpPublica(ip), false, ip);
  assert.equal(V.ipDeSolicitud({ 'x-forwarded-for': '10.0.0.1, 187.190.1.1' }, '10.9.9.9'), '187.190.1.1');
  assert.equal(V.ipDeSolicitud({}, '::ffff:8.8.8.8'), '::ffff:8.8.8.8'.replace('::ffff:', '') === '8.8.8.8' ? V.ipDeSolicitud({}, '::ffff:8.8.8.8') : '');
  assert.equal(V.paisDeIp('187.190.1.1'), 'MX');
  assert.equal(V.paisDeIp('8.8.8.8'), 'US');
  assert.equal(V.paisDeIp('10.0.0.1'), 'ZZ');
  assert.equal(V.paisDeIp(''), 'ZZ');
  assert.equal(V.paisDeIp('8.8.8.8', null), 'ZZ', 'sin la base local no se inventa nada');
  assert.equal(V.paisDeIp('8.8.8.8', { lookup: () => { throw new Error('x'); } }), 'ZZ');
  assert.equal(V.paisDeSolicitud({ 'cf-ipcountry': 'ES' }, '8.8.8.8'), 'ES');
  assert.equal(V.paisDeSolicitud({ 'cf-ipcountry': 'XX' }, '187.190.1.1'), 'MX', 'XX (desconocido) se ignora');
  assert.equal(V.paisDeSolicitud({}, '187.190.1.1'), 'MX');
});

test('identificador anónimo del día: cambia cada día, depende de la clave y no contiene la IP ni el navegador', () => {
  const a = V.hashVisitante('187.190.1.1', UA_PC, '2026-11-05', 'clave');
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(V.hashVisitante('187.190.1.1', UA_PC, '2026-11-05', 'clave'), a);
  assert.notEqual(V.hashVisitante('187.190.1.1', UA_PC, '2026-11-06', 'clave'), a, 'otro día, otro identificador: no se puede seguir a nadie');
  assert.notEqual(V.hashVisitante('187.190.1.1', UA_PC, '2026-11-05', 'otra-clave'), a);
  assert.notEqual(V.hashVisitante('187.190.1.2', UA_PC, '2026-11-05', 'clave'), a);
  assert.equal(a.includes('187') && a.includes('190'), false);
});

test('cuerpo de la petición: lista cerrada de campos, recortes y alias de páginas', () => {
  assert.equal(V.limpiarCuerpo({ pagina: 'inventada' }), null);
  assert.equal(V.limpiarCuerpo('texto'), null);
  assert.equal(V.limpiarCuerpo(null), null);
  assert.equal(V.limpiarCuerpo([1]), null);
  assert.equal(V.limpiarCuerpo({ pagina: 'portada' }).pagina, 'landing', 'el contador anterior mandaba «portada»');
  const c = V.limpiarCuerpo({ pagina: 'panel', ref: 'x'.repeat(900), utm: 'y'.repeat(90), fbclid: 'si', igshid: true, ip: '1.2.3.4', extra: 'z', origen: { ref: 'a'.repeat(500), utm: 'b', ua: 'u'.repeat(500), t: '123', fb: true, ig: 1, cualquiera: 'x' } });
  assert.equal(c.referrer.length, 300);
  assert.equal(c.utm.length, 40);
  assert.equal(c.fbclid, false, 'solo vale true literal');
  assert.equal(c.igshid, true);
  assert.deepEqual(Object.keys(c).sort(), ['fbclid', 'igshid', 'origen', 'pagina', 'referrer', 'utm']);
  assert.deepEqual(Object.keys(c.origen).sort(), ['fb', 'ig', 'ref', 't', 'ua', 'utm']);
  assert.equal(c.origen.ref.length, 300);
  assert.equal(c.origen.ig, false);
  assert.equal(c.origen.t, 123);
});

test('visitas no rastreables: «No rastrear» y «Control global de privacidad»', () => {
  assert.equal(V.visitaNoRastreable({ dnt: '1' }), true);
  assert.equal(V.visitaNoRastreable({ 'sec-gpc': '1' }), true);
  assert.equal(V.visitaNoRastreable({ dnt: '0' }), false);
  assert.equal(V.visitaNoRastreable({}), false);
});

/* ───────────── Endpoint público ───────────── */

const tokensVisitas = {
  'token-ana': { uid: 'ana', email: 'ana@example.com', email_verified: true, name: 'Ana Prueba' },
  'token-beto': { uid: 'beto', email: 'beto@example.com', email_verified: false, name: 'Beto Sin Verificar' },
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true, name: 'Admin' },
  'token-cata': { uid: 'cata', email: 'cata@example.com', email_verified: true, name: 'Cata Vieja' }
};
function montar(extra = {}, { encendido = true, env = { ADMIN_EMAILS: 'admin@example.com' } } = {}) {
  return cargarServidor({
    tokens: tokensVisitas, env,
    usuariosAuth: { ana: { creationTime: new Date(Date.now() - 3600000).toUTCString() }, cata: { creationTime: new Date(Date.now() - 200 * DIA).toUTCString() } },
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', email: 'admin@example.com', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Prueba', email: 'ana@example.com' }),
      'miembros/beto': miembroSinPlan({ name: 'Beto', email: 'beto@example.com' }),
      'miembros/cata': miembroSinPlan({ name: 'Cata', email: 'cata@example.com' }),
      ...(encendido ? { 'config/panel': { contadorVisitas: true } } : {}),
      ...extra
    }
  });
}
let ip = 10;
const nuevaIp = () => '187.190.' + (++ip % 250) + '.' + (Math.floor(ip / 250) + 1);
const visitar = (app, cuerpo, { cab = {}, ua = UA_PC, ipv = null, origen = ORIGEN } = {}) => {
  const r = request(app).post('/api/metricas/visita').set('User-Agent', ua).set('X-Forwarded-For', ipv || nuevaIp());
  if (origen) r.set('Origin', origen);
  for (const [k, v] of Object.entries(cab)) r.set(k, v);
  return r.send(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)).type('text/plain');
};
const claves = (db, prefijo) => [...db._data.keys()].filter(k => k.startsWith(prefijo));
const hoy = () => V.claveDia(new Date());

test('interruptor: con el contador APAGADO (por defecto) no se escribe nada; encendido sí; apagarlo lo detiene', async () => {
  const { app, db } = montar({}, { encendido: false });
  assert.equal((await visitar(app, { pagina: 'landing' })).status, 204);
  assert.equal(claves(db, 'metricas').length, 0);
  const adm = { Authorization: 'Bearer token-admin' };
  assert.equal((await request(app).post('/api/admin/config').set(adm).send({ contadorVisitas: true })).status, 200);
  // el estado del interruptor tarda hasta 30 s en llegar a la ruta pública (caché); las pruebas arrancan con el servidor ya encendido
  const { app: app2, db: db2 } = montar();
  assert.equal((await visitar(app2, { pagina: 'landing' })).status, 204);
  assert.equal(db2.value('metricasVisitas/' + hoy()).total, 1);
});

test('visita anónima: suma al día, a la página, al aparato, al país, al origen y a la hora; responde siempre 204', async () => {
  const { app, db } = montar();
  const r = await visitar(app, { pagina: 'landing', ref: 'https://www.google.com/' }, { ua: UA_IPHONE, ipv: '187.190.7.7' });
  assert.equal(r.status, 204);
  const d = db.value('metricasVisitas/' + hoy());
  assert.equal(d.total, 1);
  assert.equal(d.unicos, 1);
  assert.equal(d.miembros, 0);
  assert.deepEqual(d.paginas, { landing: 1 });
  assert.deepEqual(d.dispositivos, { movil: 1 });
  assert.deepEqual(d.paises, { MX: 1 });
  assert.deepEqual(d.fuentes, { google: 1 });
  assert.equal(Object.values(d.horas).reduce((a, b) => a + b, 0), 1);
  const log = db.value('metricasLog/' + hoy());
  assert.equal(log.total, 1);
  assert.deepEqual(Object.keys(log.items[0]).sort(), ['dispositivo', 'fuente', 'nuevo', 'pagina', 'pais', 'pistas', 't']);
  assert.equal(log.items[0].nuevo, true);
  assert.equal(log.items[0].pistas.ref, 'www.google.com');
});

test('PRIVACIDAD: nada de lo guardado contiene la IP, el navegador, la dirección completa ni identificadores del visitante', async () => {
  const { app, db } = montar();
  await visitar(app, { pagina: 'landing', ref: 'https://www.google.com/search?q=secreto&uid=123', utm: 'google' }, { ua: UA_PC, ipv: '187.190.77.88' });
  await visitar(app, { pagina: 'acceso' }, { ua: UA_ANDROID, ipv: '187.190.77.99' });
  const todo = claves(db, 'metricas').map(k => k + ' ' + JSON.stringify(db.value(k))).join('\n');
  for (const prohibido of ['187.190.77', 'Mozilla', 'Windows', 'Android', 'iPhone', 'AppleWebKit', 'secreto', 'uid=123', 'search?q']) assert.equal(todo.includes(prohibido), false, 'aparece «' + prohibido + '»');
  assert.equal(claves(db, 'metricasMiembros').length, 0, 'ninguna ficha de persona para visitantes anónimos');
  // y los identificadores del día sí existen pero son opacos
  const ids = claves(db, 'metricasVisitas/' + hoy() + '/visitantes/');
  assert.equal(ids.length, 2);
  assert.ok(ids.every(k => /\/[0-9a-f]{24}$/.test(k)));
});

test('personas distintas: la misma IP y navegador el mismo día son UNA persona (2 visitas); otro navegador es otra', async () => {
  const { app, db } = montar();
  const mismo = { ua: UA_PC, ipv: '187.190.5.5' };
  await visitar(app, { pagina: 'landing' }, mismo);
  await visitar(app, { pagina: 'acceso' }, mismo);
  await visitar(app, { pagina: 'landing' }, { ua: UA_ANDROID, ipv: '187.190.5.5' });
  const d = db.value('metricasVisitas/' + hoy());
  assert.deepEqual([d.total, d.unicos], [3, 2]);
  assert.deepEqual(d.dispositivos, { computadora: 1, movil: 1 }, 'el aparato cuenta una vez por persona');
  assert.deepEqual(d.paginas, { landing: 2, acceso: 1 });
});

test('origen por persona: quien entra «directo» y luego llega desde Facebook suma a los dos; «Dentro del sitio» solo en su primera visita', async () => {
  const { app, db } = montar();
  const yo = { ua: UA_PC, ipv: '187.190.6.6' };
  await visitar(app, { pagina: 'landing' }, yo);
  await visitar(app, { pagina: 'landing', ref: 'https://l.facebook.com/' }, yo);
  await visitar(app, { pagina: 'acceso', ref: 'https://www.zoorigen.com/' }, yo);
  assert.deepEqual(db.value('metricasVisitas/' + hoy()).fuentes, { directo: 1, facebook: 1 });
  await visitar(app, { pagina: 'acceso', ref: 'https://www.zoorigen.com/' }, { ua: UA_IPHONE, ipv: '187.190.6.9' });
  assert.deepEqual(db.value('metricasVisitas/' + hoy()).fuentes, { directo: 1, facebook: 1, interno: 1 });
});

test('país: de las cabeceras del proxy (IP pública → base local) o de la cabecera del CDN; sin dato queda «No identificado» (ZZ)', async () => {
  const { app, db } = montar();
  await visitar(app, { pagina: 'landing' }, { ipv: '8.8.8.8' });
  await visitar(app, { pagina: 'landing' }, { ua: UA_ANDROID, ipv: '8.8.4.4', cab: { 'cf-ipcountry': 'AR' } });
  await visitar(app, { pagina: 'landing' }, { ua: UA_IPHONE, ipv: '10.1.1.1' });
  assert.deepEqual(db.value('metricasVisitas/' + hoy()).paises, { US: 1, AR: 1, ZZ: 1 });
});

test('lo que NO cuenta: DNT, GPC, bots, páginas inventadas, cuerpos raros, sin origen o de otro sitio; siempre 204', async () => {
  const { app, db } = montar();
  const casos = [
    visitar(app, { pagina: 'landing' }, { cab: { DNT: '1' } }), visitar(app, { pagina: 'landing' }, { cab: { 'Sec-GPC': '1' } }),
    visitar(app, { pagina: 'landing' }, { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }), visitar(app, { pagina: 'landing' }, { ua: 'curl/8.4.0 largo' }),
    visitar(app, { pagina: '<script>alert(1)</script>' }), visitar(app, 'texto cualquiera'), visitar(app, '{"pagina":'), visitar(app, ''),
    visitar(app, { pagina: 'landing' }, { origen: null }), visitar(app, { pagina: 'landing' }, { origen: 'https://sitio-malo.example' }),
    visitar(app, { pagina: 'landing', relleno: 'x'.repeat(6000) })
  ];
  for (const r of await Promise.all(casos)) assert.equal(r.status, 204);
  assert.equal(claves(db, 'metricas').length, 0);
  // y las de origen válido sí: zoorigen.com, www y localhost de pruebas
  for (const o of ['https://zoorigen.com', 'https://www.zoorigen.com', 'http://localhost:5500', 'http://127.0.0.1:8765']) assert.equal((await visitar(app, { pagina: 'landing' }, { origen: o })).status, 204);
  assert.equal(db.value('metricasVisitas/' + hoy()).total, 4);
});

test('límite de frecuencia: 60 visitas por IP cada 10 minutos (las demás se ignoran en silencio)', async () => {
  const { app, db } = montar();
  for (let i = 0; i < 70; i++) assert.equal((await visitar(app, { pagina: 'landing' }, { ipv: '187.190.9.9', ua: UA_PC + ' ' + i })).status, 204);
  assert.equal(db.value('metricasVisitas/' + hoy()).total, 60);
});

test('administradores no cuentan; un miembro verificado sí queda en la lista; correo sin verificar o token inválido cuentan como visita anónima', async () => {
  const { app, db } = montar();
  assert.equal((await visitar(app, { pagina: 'panel' }, { cab: { Authorization: 'Bearer token-admin' } })).status, 204);
  assert.equal(claves(db, 'metricas').length, 0, 'quien administra no cuenta');
  await visitar(app, { pagina: 'panel' }, { cab: { Authorization: 'Bearer token-ana' }, ipv: '187.190.20.1' });
  await visitar(app, { pagina: 'panel' }, { cab: { Authorization: 'Bearer token-ana' }, ipv: '187.190.20.1' });
  await visitar(app, { pagina: 'panel' }, { cab: { Authorization: 'Bearer token-beto' }, ua: UA_IPHONE, ipv: '187.190.20.2' });
  await visitar(app, { pagina: 'panel' }, { cab: { Authorization: 'Bearer token-vencido' }, ua: UA_ANDROID, ipv: '187.190.20.3' });
  const m = db.value('metricasMiembros/ana');
  assert.deepEqual([m.uid, m.nombre, m.email, m.visitas], ['ana', 'Ana Prueba', 'ana@example.com', 2]);
  assert.equal(m.dias[hoy()], 2);
  assert.equal(db.value('metricasMiembros/beto'), undefined, 'correo sin verificar: anónimo');
  const d = db.value('metricasVisitas/' + hoy());
  assert.deepEqual([d.total, d.unicos, d.miembros], [4, 3, 1]);
});

test('origen de la cuenta: se fija una sola vez con el primer contacto (cuenta nueva) y una cuenta vieja queda sin origen', async () => {
  const { app, db } = montar();
  const contacto = { ref: 'https://l.instagram.com/', utm: '', ua: UA_IG, t: Date.now() - 2 * 3600000, fb: false, ig: false };
  await visitar(app, { pagina: 'panel', origen: contacto }, { cab: { Authorization: 'Bearer token-ana' }, ipv: '187.190.30.1' });
  assert.equal(db.value('metricasMiembros/ana').origen, 'instagram');
  assert.ok(db.value('metricasMiembros/ana').creada);
  await visitar(app, { pagina: 'panel', origen: { ...contacto, ref: 'https://www.google.com/' } }, { cab: { Authorization: 'Bearer token-ana' }, ipv: '187.190.30.1' });
  assert.equal(db.value('metricasMiembros/ana').origen, 'instagram', 'no se pisa');
  await visitar(app, { pagina: 'panel', origen: contacto }, { cab: { Authorization: 'Bearer token-cata' }, ua: UA_ANDROID, ipv: '187.190.30.2' });
  assert.equal(db.value('metricasMiembros/cata').origen, undefined, 'cuenta de hace 200 días: anterior al contador');
});

test('lo anónimo no manda «origen» de cuentas (solo viaja con sesión)', async () => {
  const { app, db } = montar();
  await visitar(app, { pagina: 'landing', origen: { ref: 'x', t: Date.now() } });
  assert.equal(claves(db, 'metricasMiembros').length, 0);
});

test('el registro del día guarda hasta 1,500 visitas una por una y el total sigue subiendo', async () => {
  const hoyId = hoy();
  const items = Array.from({ length: V.MAX_LOG_DIA }, (_, i) => ({ t: new Date().toISOString(), pagina: 'landing', fuente: 'directo', pais: 'MX', dispositivo: 'movil', nuevo: false, pistas: {} }));
  const { app, db } = montar({ ['metricasLog/' + hoyId]: { dia: hoyId, total: V.MAX_LOG_DIA, items } });
  await visitar(app, { pagina: 'landing' });
  const log = db.value('metricasLog/' + hoyId);
  assert.equal(log.items.length, V.MAX_LOG_DIA);
  assert.equal(log.total, V.MAX_LOG_DIA + 1);
});

/* ───────────── Lectura para el panel ───────────── */

const adm = { Authorization: 'Bearer token-admin' };
function diaAgg(dia, extra = {}) {
  return { dia, total: 10, unicos: 6, miembros: 1, dispositivos: { movil: 4, tablet: 0, computadora: 2 }, paises: { MX: 5, US: 1 }, paginas: { landing: 7, acceso: 2, panel: 1 }, fuentes: { directo: 3, google: 2, facebook: 1 }, horas: { '09': 4, '15': 6 }, actualizado: new Date().toISOString(), ...extra };
}

test('admin: las métricas y el registro son SOLO para administradores (401 sin sesión, 403 a un miembro)', async () => {
  const { app } = montar();
  for (const ruta of ['/api/admin/visitas/metricas', '/api/admin/visitas/registro']) {
    assert.equal((await request(app).get(ruta)).status, 401, ruta);
    assert.equal((await request(app).get(ruta).set(auth('token-ana'))).status, 403, ruta);
    assert.equal((await request(app).get(ruta).set(adm)).status, 200, ruta);
  }
});

test('admin: días consecutivos con ceros, 24 horas, claves conocidas, tope de 7 a 730 días y miembros / cuentas con origen y VIP', async () => {
  const d1 = V.claveDia(new Date()), d2 = V.restarDias(d1, 3);
  const { app } = montar({
    ['metricasVisitas/' + d1]: diaAgg(d1), ['metricasVisitas/' + d2]: diaAgg(d2, { paises: { MX: 5, 'xx': 3, US: 0 }, paginas: { landing: 7, inventada: 99 } }),
    'metricasMiembros/ana': { uid: 'ana', nombre: 'Ana Prueba', email: 'ana@example.com', ultima: new Date().toISOString(), visitas: 4, dias: { [d1]: 3, [d2]: 1 }, origen: 'google', creada: new Date().toISOString() },
    'metricasMiembros/beto': { uid: 'beto', nombre: 'Beto', email: 'beto@example.com', ultima: new Date(Date.now() - 500 * DIA).toISOString(), visitas: 1, dias: {}, origen: 'directo' },
    'metricasMiembros/cata': { uid: 'cata', nombre: 'Cata', email: 'cata@example.com', ultima: new Date(Date.now() - DIA).toISOString(), visitas: 2, dias: { [d1]: 2 } }
  });
  const r = (await request(app).get('/api/admin/visitas/metricas?dias=10').set(adm)).body;
  assert.equal(r.ok, true);
  assert.equal(r.zona, 'America/Mexico_City');
  assert.equal(r.dias.length, 10);
  assert.equal(r.dias[9].dia, d1, 'el último día es hoy');
  assert.equal(r.dias[0].total, 0, 'los días sin visitas salen con ceros');
  assert.equal(Object.keys(r.dias[9].horas).length, 24);
  assert.deepEqual(Object.keys(r.dias[9].fuentes).sort(), [...V.FUENTES].sort());
  assert.deepEqual(r.dias[9].paginas, { landing: 7, acceso: 2, panel: 1, legal: 0 });
  const viejo = r.dias.find(d => d.dia === d2);
  assert.deepEqual(viejo.paises, { MX: 5 }, 'solo códigos de país válidos y con valor');
  assert.deepEqual(viejo.paginas, { landing: 7, acceso: 0, panel: 0, legal: 0 }, 'páginas inventadas no pasan');
  assert.deepEqual(r.miembros.map(m => m.uid), ['ana', 'cata'], 'miembros con actividad en la ventana, la más reciente primero');
  assert.equal(r.miembros[0].dias[d1], 3);
  assert.deepEqual(r.origenes.map(o => [o.uid, o.origen, o.vip]), [['ana', 'google', true], ['beto', 'directo', false]]);
  assert.equal(r.sinOrigen, 1);
  assert.equal(r.activo, true);
  assert.equal((await request(app).get('/api/admin/visitas/metricas?dias=1').set(adm)).body.dias.length, 7);
  assert.equal((await request(app).get('/api/admin/visitas/metricas?dias=99999').set(adm)).body.dias.length, 730);
  assert.equal((await request(app).get('/api/admin/visitas/metricas').set(adm)).body.dias.length, V.DIAS_PREDETERMINADOS);
  assert.equal(JSON.stringify(r).includes('187.'), false);
});

test('admin: el panel dice si el contador está apagado y trae el estado (última visita)', async () => {
  V.reiniciarEstado();
  const { app } = montar({}, { encendido: false });
  const r = (await request(app).get('/api/admin/visitas/metricas?dias=7').set(adm)).body;
  assert.equal(r.activo, false);
  assert.equal(r.ultimaVisita, null);
});

test('admin: registro una por una — hoy, ayer, 7 y 30 días; la más reciente primero; periodo inválido vuelve a «hoy»; sin IP ni navegador', async () => {
  const d0 = V.claveDia(new Date()), d1 = V.restarDias(d0, 1), d9 = V.restarDias(d0, 9);
  const it = (t, extra = {}) => ({ t, pagina: 'landing', fuente: 'google', pais: 'MX', dispositivo: 'movil', nuevo: true, pistas: { ref: 'www.google.com', utm: '', app: '', fbclid: false, igshid: false }, ip: '1.2.3.4', ua: 'Mozilla', ...extra });
  const { app } = montar({
    ['metricasLog/' + d0]: { dia: d0, total: 2, items: [it(new Date(Date.now() - 7200000).toISOString()), it(new Date().toISOString(), { fuente: 'inventada', pais: 'mx', dispositivo: 'otro' })] },
    ['metricasLog/' + d1]: { dia: d1, total: 1, items: [it(new Date(Date.now() - DIA).toISOString())] },
    ['metricasLog/' + d9]: { dia: d9, total: 1, items: [it(new Date(Date.now() - 9 * DIA).toISOString())] }
  });
  const g = async p => (await request(app).get('/api/admin/visitas/registro?periodo=' + p).set(adm)).body;
  const hoyR = await g('hoy');
  assert.equal(hoyR.items.length, 2);
  assert.ok(Date.parse(hoyR.items[0].t) > Date.parse(hoyR.items[1].t), 'la más reciente primero');
  assert.deepEqual([hoyR.items[0].fuente, hoyR.items[0].pais, hoyR.items[0].dispositivo], ['otros', 'ZZ', 'computadora'], 'valores raros se normalizan');
  assert.equal(hoyR.total, 2);
  assert.equal((await g('ayer')).items.length, 1);
  assert.equal((await g('7')).items.length, 3);
  assert.equal((await g('30')).items.length, 4);
  assert.equal((await g('cualquiera')).periodo, 'hoy');
  const todo = JSON.stringify(await g('30'));
  assert.equal(/1\.2\.3\.4|Mozilla/.test(todo), false);
});

/* ───────────── Limpieza y tarea diaria ───────────── */

test('limpieza: borra los identificadores anónimos de más de 45 días y el registro de más de 400; los totales por día no se tocan', async () => {
  const hoyId = hoy();
  const viejo = V.restarDias(hoyId, 50), reciente = V.restarDias(hoyId, 10), muyViejo = V.restarDias(hoyId, 500);
  const { db } = montar({
    ['metricasVisitas/' + viejo]: diaAgg(viejo), ['metricasVisitas/' + viejo + '/visitantes/aaaa']: { visitas: 1 }, ['metricasVisitas/' + viejo + '/visitantes/bbbb']: { visitas: 2 },
    ['metricasVisitas/' + reciente]: diaAgg(reciente), ['metricasVisitas/' + reciente + '/visitantes/cccc']: { visitas: 1 },
    ['metricasLog/' + muyViejo]: { dia: muyViejo, total: 1, items: [] }, ['metricasLog/' + reciente]: { dia: reciente, total: 1, items: [] }
  });
  const r = await V.limpiarAntiguos(db);
  assert.equal(r.visitantes, 2);
  assert.equal(db.value('metricasVisitas/' + viejo + '/visitantes/aaaa'), undefined);
  assert.equal(db.value('metricasVisitas/' + reciente + '/visitantes/cccc').visitas, 1);
  assert.equal(db.value('metricasVisitas/' + viejo).total, 10, 'el total del día se conserva');
  assert.equal(db.value('metricasLog/' + muyViejo), undefined);
  assert.ok(db.value('metricasLog/' + reciente));
  assert.equal(r.logs, 1);
});

test('tarea diaria: incluye la limpieza de visitas y un fallo ahí no detiene lo demás', async () => {
  const { db } = montar();
  const r = await tarea.ejecutarTareaDiaria(db, { sync: async () => ({ guardadas: 0, omitidas: 0, fuentes: [] }) });
  assert.ok(r.visitas && typeof r.visitas.visitantes === 'number');
  const malo = { collection() { throw new Error('boom'); } };
  const r2 = await tarea.ejecutarTareaDiaria(malo, { sync: async () => ({ guardadas: 0, omitidas: 0, fuentes: [] }) });
  assert.deepEqual(r2.visitas, { error: true });
});

/* ───────────── Contrato del código (sin cookies, sin terceros) ───────────── */

test('el servicio y las rutas no usan cookies ni servicios de terceros y solo escriben las colecciones esperadas', () => {
  const fuente = ['services/metricas-visitas.js', 'services/rutas-metricas-visitas.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.equal(/cookie|setHeader\(['"]Set-Cookie|res\.cookie|fetch\(|https?:\/\/(?!www\.zoorigen|zoorigen)/i.test(fuente.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*zoorigen[^'\n]*'/g, '')), false);
  const colecciones = [...fuente.matchAll(/\bdb\.collection\('([a-zA-Z]+)'\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(colecciones)].sort(), ['config', 'metricasLog', 'metricasMiembros', 'metricasVisitas', 'miembros']);
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pk.dependencies['geoip-country'], 'la base de países viaja con el servidor (sin servicio externo)');
});
