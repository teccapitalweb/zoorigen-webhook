'use strict';

// Certificado en PDF (pdfkit + qrcode) y correo con el PDF adjunto (Resend simulado).
const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const { generarCertificadoPdf, seguro, urlVerificacion } = require('../services/certificado-pdf');
const correo = require('../services/correo');

const base = {
  nombre: 'Wendoline Hernández Núñez', curso: 'Biología, ecología y conservación de tiburones', area: 'Fauna silvestre',
  horas: 8, sesiones: 12, folio: 'ZOO-2026-ABC12345', emitido: '2026-09-24T20:30:00Z'
};
const paginas = pdf => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
// Texto del PDF SIN comprimir: todas las cadenas hexadecimales de los TJ, en orden
const textoDe = pdf => [...pdf.toString('latin1').matchAll(/<([0-9a-fA-F]{2,})>/g)]
  .map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('');

test('PDF: empieza con %PDF, es una sola página A4 horizontal y pesa algo', async () => {
  const pdf = await generarCertificadoPdf(base);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 20000, 'incluye logo y QR');
  assert.equal(paginas(pdf), 1);
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 841\.89 595\.28\]/);
});

test('PDF: trae el folio, el nombre, el curso, la fecha y las horas visibles', async () => {
  const texto = textoDe(await generarCertificadoPdf(base, { comprimir: false }));
  for (const esperado of ['ZOO-2026-ABC12345', 'Wendoline Hernández Núñez', 'tiburones', 'Fauna silvestre', '12 clases', '8 horas', '24 de septiembre de 2026', 'CERTIFICADO']) {
    assert.ok(texto.includes(esperado), `falta "${esperado}" en: ${texto.slice(0, 200)}`);
  }
});

test('PDF: el QR apunta a la página pública de verificación del folio', async () => {
  const original = QRCode.toBuffer;
  const textos = [];
  QRCode.toBuffer = (...args) => { textos.push(args[0]); return original.apply(QRCode, args); };
  try {
    await generarCertificadoPdf(base);
    await generarCertificadoPdf({ ...base, urlVerificacion: 'https://otro.example/v?folio=X' });
  } finally { QRCode.toBuffer = original; }
  assert.equal(textos[0], 'https://www.zoorigen.com/pages/verificar.html?folio=ZOO-2026-ABC12345');
  assert.equal(textos[1], 'https://otro.example/v?folio=X');
  assert.equal(urlVerificacion('ZOO-2026-ABC12345'), textos[0]);
  assert.equal(urlVerificacion('ZOO-2026-ABC12345', 'https://zoorigen.test/'), 'https://zoorigen.test/pages/verificar.html?folio=ZOO-2026-ABC12345');
});

test('PDF: nombres y cursos muy largos, o con caracteres raros, no rompen ni agregan páginas', async () => {
  const largo = await generarCertificadoPdf({
    ...base, nombre: 'María de los Ángeles Guadalupe Fernández de la Cruz y Rodríguez Montes de Oca de la Torre',
    curso: 'Programa integral avanzado de manejo, bienestar, reproducción, nutrición, sanidad y conservación de fauna silvestre bajo cuidado humano en unidades de manejo ambiental y zoológicos de México y Latinoamérica'
  });
  assert.equal(paginas(largo), 1);
  const raro = await generarCertificadoPdf({ ...base, nombre: 'Юрий 李雷 \u{1F600} Núñez', curso: 'Curso especial «Ñandú» – \u{1F600}' });
  assert.equal(paginas(raro), 1);
  const vacio = await generarCertificadoPdf({ folio: 'ZOO-2026-ABC12345', emitido: 'no es fecha' });
  assert.equal(paginas(vacio), 1);
});

test('PDF: sin horas ni clases no muestra "0 horas"', async () => {
  const texto = textoDe(await generarCertificadoPdf({ ...base, horas: 0, sesiones: 0 }, { comprimir: false }));
  assert.doesNotMatch(texto, /0 horas|0 clases/);
  assert.match(texto, /Modalidad en línea/);
});

test('seguro(): conserva acentos y ñ, y simplifica lo que la fuente del PDF no soporta', () => {
  assert.equal(seguro('Ángeles Núñez'), 'Ángeles Núñez');
  assert.equal(seguro('Curso \u{1F600} especial'), 'Curso especial');
  assert.equal(seguro('Café – «bien»'), 'Café – «bien»');
  assert.equal(seguro(null), '');
});

// ── Correo ──

function simularResend(respuesta = { ok: true, status: 200 }) {
  const llamadas = [];
  const fetchImpl = async (url, opc) => { llamadas.push({ url, cuerpo: JSON.parse(opc.body), cabeceras: opc.headers }); return respuesta; };
  return { llamadas, fetchImpl };
}
const datosCorreo = {
  para: 'ana@example.com', nombre: 'Ana María Pérez', curso: 'Biología de tiburones', horas: 6, sesiones: 12, area: 'Fauna silvestre',
  emitido: '2026-10-12T18:30:00.000Z', folio: 'ZOO-2026-3F9A12BC', panelUrl: 'https://www.zoorigen.com'
};
const config = { apiKey: 're_prueba', from: 'Zoorigen <no-reply@zoorigen.com>' };

test('correo del certificado: lleva el PDF adjunto en base64 y el contenido esperado', async () => {
  const { llamadas, fetchImpl } = simularResend();
  const ok = await correo.enviarCorreoCertificado(datosCorreo, { ...config, fetchImpl });
  assert.equal(ok, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, 'https://api.resend.com/emails');
  assert.equal(llamadas[0].cabeceras.Authorization, 'Bearer re_prueba');
  const c = llamadas[0].cuerpo;
  assert.deepEqual(c.to, ['ana@example.com']);
  assert.equal(c.from, 'Zoorigen <no-reply@zoorigen.com>');
  assert.equal(c.attachments.length, 1);
  assert.equal(c.attachments[0].filename, 'Certificado-ZOO-2026-3F9A12BC.pdf');
  const pdf = Buffer.from(c.attachments[0].content, 'base64');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(paginas(pdf), 1);
  // asunto, texto y html
  assert.match(c.subject, /Biología de tiburones/);
  assert.match(c.subject, /certificado/i);
  assert.doesNotMatch(c.subject + c.html + c.text, /\p{Extended_Pictographic}/u, 'sin emojis');
  assert.match(c.html, /¡Felicidades, Ana!/);
  assert.match(c.html, /Biología de tiburones/);
  assert.match(c.html, /ZOO-2026-3F9A12BC/);
  assert.match(c.html, /href="https:\/\/www\.zoorigen\.com\/pages\/club-certificados\.html"/);
  assert.match(c.html, /https:\/\/www\.zoorigen\.com\/pages\/verificar\.html\?folio=ZOO-2026-3F9A12BC/);
  assert.match(c.html, /Adjuntamos tu certificado en PDF/);
  assert.match(c.html, /#1F5F3A/);
  assert.match(c.text, /Folio del certificado: ZOO-2026-3F9A12BC/);
});

test('correo del certificado: escapa el HTML de nombre y curso', async () => {
  const { llamadas, fetchImpl } = simularResend();
  await correo.enviarCorreoCertificado({ ...datosCorreo, nombre: '<script>alert(1)</script>', curso: 'Curso <b>"x"</b> & más' }, { ...config, fetchImpl });
  const html = llamadas[0].cuerpo.html;
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>"x"/);
  assert.match(html, /&lt;b&gt;&quot;x&quot;&lt;\/b&gt; &amp; más/);
});

test('correo del certificado: sin llave de Resend o sin remitente no envía ni genera el PDF, y devuelve false', async () => {
  const { llamadas, fetchImpl } = simularResend();
  let pdfs = 0;
  const generarPdf = async () => { pdfs++; return Buffer.from('%PDF-'); };
  assert.equal(await correo.enviarCorreoCertificado(datosCorreo, { apiKey: '', from: 'x', fetchImpl, generarPdf }), false);
  assert.equal(await correo.enviarCorreoCertificado(datosCorreo, { apiKey: 'k', from: '', fetchImpl, generarPdf }), false);
  assert.equal(await correo.enviarCorreoCertificado({ ...datosCorreo, para: '' }, { ...config, fetchImpl, generarPdf }), false);
  assert.equal(llamadas.length, 0);
  assert.equal(pdfs, 0);
});

test('correo del certificado: si el PDF no se puede generar el correo sale igual, sin adjunto', async () => {
  const { llamadas, fetchImpl } = simularResend();
  const aviso = console.warn; console.warn = () => {};
  try {
    const ok = await correo.enviarCorreoCertificado(datosCorreo, { ...config, fetchImpl, generarPdf: async () => { throw new Error('sin pdf'); } });
    assert.equal(ok, true);
  } finally { console.warn = aviso; }
  assert.equal(llamadas[0].cuerpo.attachments, undefined);
  assert.doesNotMatch(llamadas[0].cuerpo.html, /Adjuntamos tu certificado/);
});

test('correo del certificado: si Resend rechaza o no hay red devuelve false sin lanzar', async () => {
  const error = console.error; console.error = () => {};
  try {
    const rechazo = await correo.enviarCorreoCertificado(datosCorreo, { ...config, fetchImpl: async () => ({ ok: false, status: 422, text: async () => 'dominio' }) });
    assert.equal(rechazo, false);
    const caida = await correo.enviarCorreoCertificado(datosCorreo, { ...config, fetchImpl: async () => { throw new Error('sin red'); } });
    assert.equal(caida, false);
  } finally { console.error = error; }
});

test('enviarConResend: sin adjuntos el cuerpo no trae "attachments" (el correo de verificación no cambia)', async () => {
  const { llamadas, fetchImpl } = simularResend();
  await correo.enviarConResend({ para: 'a@x.com', asunto: 's', html: 'h', texto: 't' }, { ...config, fetchImpl });
  assert.equal('attachments' in llamadas[0].cuerpo, false);
  await correo.enviarConResend({ para: 'a@x.com', asunto: 's', html: 'h', texto: 't', adjuntos: [{ filename: 'a.pdf', content: 'QQ==' }] }, { ...config, fetchImpl });
  assert.deepEqual(llamadas[1].cuerpo.attachments, [{ filename: 'a.pdf', content: 'QQ==' }]);
});
