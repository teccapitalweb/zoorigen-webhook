'use strict';

// enviarConResend ahora admite cabeceras (List-Unsubscribe), etiquetas, responder-a y clave de idempotencia, y distingue el límite de Resend (429).
// Los usos anteriores (verificación y certificados) no cambian. Ejecutar: node --test test/correo-cabeceras.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const correo = require('../services/correo');

const base = { para: 'a@x.com', asunto: 'Asunto', html: '<p>h</p>', texto: 't' };
const config = fetchImpl => ({ apiKey: 're_prueba', from: 'Zoorigen <no-reply@zoorigen.com>', fetchImpl });

test('sin cabeceras ni etiquetas el cuerpo es el de siempre (sin campos nuevos)', async () => {
  let enviado;
  const r = await correo.enviarConResend(base, config(async (url, opc) => { enviado = { url, opc }; return { ok: true, status: 200 }; }));
  assert.deepEqual(r, { ok: true });
  const cuerpo = JSON.parse(enviado.opc.body);
  assert.deepEqual(Object.keys(cuerpo).sort(), ['from', 'html', 'subject', 'text', 'to']);
  assert.equal(enviado.opc.headers['Idempotency-Key'], undefined);
  assert.equal(enviado.opc.headers.Authorization, 'Bearer re_prueba');
});

test('con cabeceras: List-Unsubscribe de un clic, etiquetas, responder-a e Idempotency-Key', async () => {
  let enviado;
  const r = await correo.enviarConResend({
    ...base,
    headers: { 'List-Unsubscribe': '<https://api.test/baja?u=1&t=2>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    tags: [{ name: 'tipo', value: 'recordatorio-pago' }], replyTo: 'zooorigen@gmail.com', idempotencyKey: 'zoorigen-recordatorio-ana-c1-p1'
  }, config(async (url, opc) => { enviado = opc; return { ok: true, status: 200 }; }));
  assert.equal(r.ok, true);
  const cuerpo = JSON.parse(enviado.body);
  assert.equal(cuerpo.headers['List-Unsubscribe'], '<https://api.test/baja?u=1&t=2>');
  assert.equal(cuerpo.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(cuerpo.tags, [{ name: 'tipo', value: 'recordatorio-pago' }]);
  assert.equal(cuerpo.reply_to, 'zooorigen@gmail.com');
  assert.equal(enviado.headers['Idempotency-Key'], 'zoorigen-recordatorio-ana-c1-p1');
});

test('la clave de idempotencia se recorta a 250 caracteres', async () => {
  let enviado;
  await correo.enviarConResend({ ...base, idempotencyKey: 'k'.repeat(400) }, config(async (url, opc) => { enviado = opc; return { ok: true }; }));
  assert.equal(enviado.headers['Idempotency-Key'].length, 250);
});

test('el límite de Resend (429) se distingue de un rechazo y trae cuánto esperar', async () => {
  const silenciar = console.error; console.error = () => {};
  try {
    const limite = await correo.enviarConResend(base, config(async () => ({ ok: false, status: 429, text: async () => 'rate', headers: { get: n => (n === 'retry-after' ? '12' : null) } })));
    assert.deepEqual(limite, { ok: false, motivo: 'limite', status: 429, esperarSegundos: 12 });
    const sinEspera = await correo.enviarConResend(base, config(async () => ({ ok: false, status: 429, text: async () => 'rate' })));
    assert.deepEqual(sinEspera, { ok: false, motivo: 'limite', status: 429 });
    const rechazo = await correo.enviarConResend(base, config(async () => ({ ok: false, status: 422, text: async () => 'dominio no verificado' })));
    assert.deepEqual(rechazo, { ok: false, motivo: 'rechazado', status: 422 });
    const red = await correo.enviarConResend(base, config(async () => { throw new Error('sin red'); }));
    assert.deepEqual(red, { ok: false, motivo: 'error-red' });
    assert.deepEqual(await correo.enviarConResend(base, { apiKey: '', from: '' }), { ok: false, motivo: 'sin-configurar' });
  } finally { console.error = silenciar; }
});
