'use strict';

// Correo de confirmación: plantilla, envío por Resend (simulado) y ruta POST /api/auth/send-verification.
const test = require('node:test');
const assert = require('node:assert/strict');
const correo = require('../services/correo');
const { request, cargarServidor, auth, tokensDe } = require('./helpers/club');

test('plantilla: estructura igual a la de Alintec con identidad Zoorigen, y todo escapado', () => {
  const p = correo.plantillaVerificacion({ nombre: '<b>Ana</b> María', enlace: 'https://www.zoorigen.com/pages/verificar-correo.html?oobCode=ABC&x=1' });
  assert.equal(p.asunto, 'Verifica tu correo · Zoorigen');
  assert.match(p.html, /Hola &lt;b&gt;Ana&lt;\/b&gt;, confirma tu correo/);
  assert.doesNotMatch(p.html, /<b>Ana/);
  assert.match(p.html, /Verificar mi correo/);
  assert.match(p.html, /Si el botón no funciona, copia y pega este enlace en tu navegador/);
  assert.match(p.html, /Si tú no creaste esta cuenta, ignora este mensaje: no se activará nada/);
  assert.match(p.html, /oobCode=ABC&amp;x=1/);
  assert.match(p.html, /#1F5F3A/);
  assert.match(p.texto, /oobCode=ABC&x=1/);
  assert.doesNotMatch(p.html, /\p{Extended_Pictographic}/u, 'sin emojis');
  assert.equal(correo.plantillaVerificacion({ nombre: '', enlace: 'x' }).html.includes('Hola, confirma tu correo'), true);
});

test('enlace propio: conserva solo el código y apunta a verificar-correo.html', () => {
  const f = 'https://club-zoorigen.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=CODIGO%2F1&apiKey=k&lang=es';
  const e = correo.enlacePropioDeVerificacion(f, 'https://www.zoorigen.com/');
  assert.equal(e, 'https://www.zoorigen.com/pages/verificar-correo.html?oobCode=CODIGO%2F1');
  assert.equal(correo.enlacePropioDeVerificacion('no es url', 'https://x.com'), 'no es url');
});

test('enviarConResend: sin configurar no envía; con configuración llama a Resend con el cuerpo correcto', async () => {
  assert.deepEqual(await correo.enviarConResend({ para: 'a@x.com', asunto: 's', html: 'h', texto: 't' }, { apiKey: '', from: '' }), { ok: false, motivo: 'sin-configurar' });
  const llamadas = [];
  const fetchImpl = async (url, opc) => { llamadas.push({ url, opc }); return { ok: true, status: 200 }; };
  const r = await correo.enviarConResend({ para: 'a@x.com', asunto: 'Asunto', html: '<p>h</p>', texto: 't' }, { apiKey: 're_prueba', from: 'Zoorigen <no-reply@zoorigen.com>', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(llamadas[0].url, 'https://api.resend.com/emails');
  assert.equal(llamadas[0].opc.headers.Authorization, 'Bearer re_prueba');
  const cuerpo = JSON.parse(llamadas[0].opc.body);
  assert.deepEqual(cuerpo.to, ['a@x.com']);
  assert.equal(cuerpo.from, 'Zoorigen <no-reply@zoorigen.com>');
  const rechazo = await correo.enviarConResend({ para: 'a@x.com', asunto: 's', html: 'h', texto: 't' }, { apiKey: 'k', from: 'f', fetchImpl: async () => ({ ok: false, status: 422, text: async () => 'dominio no verificado' }) });
  assert.equal(rechazo.ok, false);
  assert.equal(rechazo.motivo, 'rechazado');
  const caida = await correo.enviarConResend({ para: 'a@x.com', asunto: 's', html: 'h', texto: 't' }, { apiKey: 'k', from: 'f', fetchImpl: async () => { throw new Error('sin red'); } });
  assert.equal(caida.motivo, 'error-red');
});

function conResend(fn) {
  return async () => {
    const anterior = { fetch: global.fetch, k: process.env.RESEND_API_KEY, f: process.env.MAIL_FROM };
    const llamadas = [];
    global.fetch = async (url, opc) => { llamadas.push({ url, opc }); return { ok: true, status: 200 }; };
    process.env.RESEND_API_KEY = 're_prueba'; process.env.MAIL_FROM = 'Zoorigen <no-reply@zoorigen.com>';
    try { await fn(llamadas); } finally {
      global.fetch = anterior.fetch;
      if (anterior.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = anterior.k;
      if (anterior.f === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = anterior.f;
    }
  };
}

const servidor = () => cargarServidor({ tokens: { ...tokensDe('ana'), 'token-verificada': { uid: 'ver', email: 'ver@example.com', email_verified: true } } });

test('POST /api/auth/send-verification: sin sesión 401', async () => {
  const { app } = servidor();
  assert.equal((await request(app).post('/api/auth/send-verification')).status, 401);
});

test('POST /api/auth/send-verification: ya verificada no manda nada', conResend(async llamadas => {
  const { app } = servidor();
  const r = await request(app).post('/api/auth/send-verification').set(auth('token-verificada'));
  assert.equal(r.status, 200);
  assert.equal(r.body.yaVerificado, true);
  assert.equal(llamadas.length, 0);
}));

test('POST /api/auth/send-verification: genera el enlace, lo manda a Resend y limita a 1 por minuto', conResend(async llamadas => {
  const { app, registroAuth } = servidor();
  const r = await request(app).post('/api/auth/send-verification').set(auth('token-ana'));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(registroAuth.enlaces.length, 1);
  assert.equal(registroAuth.enlaces[0].email, 'ana@example.com');
  const cuerpo = JSON.parse(llamadas[0].opc.body);
  assert.deepEqual(cuerpo.to, ['ana@example.com']);
  assert.match(cuerpo.html, /verificar-correo\.html\?oobCode=CODIGO-PRUEBA/);
  assert.doesNotMatch(cuerpo.html, /firebaseapp\.com/);
  const otra = await request(app).post('/api/auth/send-verification').set(auth('token-ana'));
  assert.equal(otra.status, 429);
}));

test('POST /api/auth/send-verification: sin RESEND_API_KEY responde 503 con código para usar el respaldo de Firebase', async () => {
  const k = process.env.RESEND_API_KEY, f = process.env.MAIL_FROM;
  delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
  try {
    const { app } = servidor();
    const r = await request(app).post('/api/auth/send-verification').set(auth('token-ana'));
    assert.equal(r.status, 503);
    assert.equal(r.body.codigo, 'correo-no-configurado');
  } finally {
    if (k !== undefined) process.env.RESEND_API_KEY = k;
    if (f !== undefined) process.env.MAIL_FROM = f;
  }
});

test('POST /api/auth/send-verification: si Resend rechaza responde 502', async () => {
  const anterior = { fetch: global.fetch, k: process.env.RESEND_API_KEY, f: process.env.MAIL_FROM };
  global.fetch = async () => ({ ok: false, status: 403, text: async () => 'no' });
  process.env.RESEND_API_KEY = 're_prueba'; process.env.MAIL_FROM = 'Zoorigen <no-reply@zoorigen.com>';
  const silenciar = console.error; console.error = () => {};
  try {
    const { app } = servidor();
    const r = await request(app).post('/api/auth/send-verification').set(auth('token-ana'));
    assert.equal(r.status, 502);
  } finally {
    console.error = silenciar;
    global.fetch = anterior.fetch;
    if (anterior.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = anterior.k;
    if (anterior.f === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = anterior.f;
  }
});
