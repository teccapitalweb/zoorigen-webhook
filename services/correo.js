'use strict';

// ══ CORREOS DE ZOORIGEN · plantilla y envío por Resend ══
// El correo estándar de Firebase sale de firebaseapp.com (dominio compartido) y suele terminar en spam.
// Aquí se arma un correo con la identidad de Zoorigen y se envía desde un dominio propio verificado en Resend.
// Variables de entorno (se configuran en Railway, nunca en el código):
//   RESEND_API_KEY  llave de Resend
//   MAIL_FROM       remitente verificado en Resend, p. ej. "Zoorigen <no-reply@zoorigen.com>"
// Sin RESEND_API_KEY no se envía nada y el sitio usa el correo estándar de Firebase como respaldo.

const { texto: limpiar } = require('./texto');

const SITIO = 'https://www.zoorigen.com';

function esc(valor) {
  return String(valor == null ? '' : valor).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function primerNombre(nombre) {
  const limpio = String(nombre || '').trim().split(/\s+/)[0] || '';
  return limpio.slice(0, 40);
}

// `detalleHtml` (opcional) va entre el párrafo y el botón; `pieHtml` (opcional) reemplaza el bloque del enlace copiable.
function marco({ titulo, saludo, parrafo, textoBoton, enlace, notaFinal, detalleHtml = '', pieHtml = '' }) {
  const link = esc(enlace);
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:#F4F1EA;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1EA;padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E3DDCF;">
        <tr><td style="background:#1F5F3A;padding:26px 28px;text-align:center;border-bottom:4px solid #E8A317;">
          <div style="font-size:26px;font-weight:800;color:#FFFFFF;letter-spacing:-.4px;">Zoorigen</div>
          <div style="font-size:12px;font-weight:600;color:#F3D890;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">Club VIP · Fauna silvestre</div>
        </td></tr>
        <tr><td style="padding:30px 28px;">
          <h1 style="margin:0 0 12px;font-size:21px;color:#16241B;">${esc(saludo)}</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#35443A;">${esc(parrafo)}</p>
          ${detalleHtml}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
            <tr><td style="border-radius:10px;background:#E8A317;">
              <a href="${link}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:700;color:#1F1D17;text-decoration:none;">${esc(textoBoton)}</a>
            </td></tr>
          </table>
          ${pieHtml || `<p style="margin:0 0 6px;font-size:12.5px;line-height:1.5;color:#5E6A60;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
          <p style="margin:0 0 20px;font-size:11.5px;line-height:1.5;color:#1F5F3A;word-break:break-all;">${link}</p>`}
          <p style="margin:0;font-size:12.5px;line-height:1.5;color:#5E6A60;">${esc(notaFinal)}</p>
        </td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:11.5px;color:#7A8579;">Zoorigen · zoorigen.com</p>
    </td></tr>
  </table>
</body></html>`;
}

// Correo para confirmar la dirección de correo de una cuenta nueva.
function plantillaVerificacion({ nombre, enlace }) {
  const n = primerNombre(nombre);
  const saludo = (n ? 'Hola ' + n : 'Hola') + ', confirma tu correo';
  const parrafo = 'Para activar tu cuenta y entrar al Club VIP de Zoorigen, confirma que este correo es tuyo.';
  const notaFinal = 'Si tú no creaste esta cuenta, ignora este mensaje: no se activará nada.';
  const asunto = 'Verifica tu correo · Zoorigen';
  return {
    asunto,
    html: marco({ titulo: asunto, saludo, parrafo, textoBoton: 'Verificar mi correo', enlace, notaFinal }),
    texto: `${saludo}\n\n${parrafo}\n\nConfirma tu correo aquí:\n${enlace}\n\n${notaFinal}\n`
  };
}

// Envía un correo con Resend. Devuelve true/false; nunca lanza (el llamador decide qué hacer si falla).
// adjuntos (opcional): [{ filename, content }] con content en base64 (formato de la API de Resend).
async function enviarConResend({ para, asunto, html, texto, adjuntos }, { apiKey, from, fetchImpl } = {}) {
  const llave = apiKey !== undefined ? apiKey : (process.env.RESEND_API_KEY || '').trim();
  const remitente = from !== undefined ? from : (process.env.MAIL_FROM || '').trim();
  if (!llave || !remitente) return { ok: false, motivo: 'sin-configurar' };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, motivo: 'sin-fetch' };
  try {
    const r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + llave, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: remitente, to: [para], subject: asunto, html, text: texto,
        ...(Array.isArray(adjuntos) && adjuntos.length ? { attachments: adjuntos } : {})
      })
    });
    if (!r.ok) {
      let cuerpo = '';
      try { cuerpo = String(await r.text()).slice(0, 160); } catch (e) { /* sin cuerpo */ }
      console.error('[Correo] Resend respondió', r.status, cuerpo);
      return { ok: false, motivo: 'rechazado', status: r.status };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Correo] No se pudo enviar:', err && err.message);
    return { ok: false, motivo: 'error-red' };
  }
}

// Correo cuando se emite un certificado (una sola vez). Sin emojis; el PDF va adjunto si se pudo generar.
function plantillaCertificado({ nombre, curso, folio, horas, sesiones, panelUrl, conAdjunto }) {
  const base = String(panelUrl || SITIO).replace(/\/+$/, '');
  const urlPanel = base + '/pages/club-certificados.html';
  const urlVerificar = base + '/pages/verificar.html?folio=' + encodeURIComponent(String(folio || ''));
  const n = primerNombre(nombre);
  const nombreCurso = limpiar(curso, 120) || 'tu curso';
  const saludo = n ? `¡Felicidades, ${n}!` : '¡Felicidades!';
  const datos = [];
  if (Number(horas) > 0) datos.push(`${Number(horas)} ${Number(horas) === 1 ? 'hora' : 'horas'}`);
  if (Number(sesiones) > 0) datos.push(`${Number(sesiones)} ${Number(sesiones) === 1 ? 'clase' : 'clases'}`);
  const linea = datos.length ? datos.join(' · ') + ' · ' : '';
  const detalleHtml = `<p style="margin:0 0 18px;font-size:17px;font-weight:700;line-height:1.4;color:#16241B;">${esc(nombreCurso)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;background:#F7F4EC;border:1px solid #E3DDCF;border-radius:10px;">
            <tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;color:#35443A;">
              ${esc(linea)}Folio del certificado:<br>
              <strong style="font-size:15px;letter-spacing:.5px;color:#16241B;">${esc(folio)}</strong>
            </td></tr>
          </table>`;
  const nota = conAdjunto ? 'Adjuntamos tu certificado en PDF. ' : '';
  const pieHtml = `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#35443A;">${esc(nota)}Puedes descargarlo de nuevo cuando quieras desde tu panel, en la sección <strong>Mis certificados</strong>.</p>
          <p style="margin:0 0 20px;font-size:12.5px;line-height:1.6;color:#5E6A60;">Cualquier persona puede comprobar que es auténtico aquí:<br>
            <a href="${esc(urlVerificar)}" style="color:#1F5F3A;word-break:break-all;">${esc(urlVerificar)}</a></p>`;
  const asunto = `Completaste ${limpiar(nombreCurso, 80)}: tu certificado está listo`;
  const notaFinal = 'Este aviso se envía una sola vez, cuando se emite tu certificado.';
  return {
    asunto, urlPanel, urlVerificar,
    html: marco({
      titulo: 'Tu certificado · Zoorigen', saludo, parrafo: 'Completaste el curso:', textoBoton: 'Ver mi certificado en el panel',
      enlace: urlPanel, notaFinal, detalleHtml, pieHtml
    }),
    texto: `${saludo}\n\nCompletaste el curso: ${nombreCurso}\nFolio del certificado: ${folio}\n\n${nota}Descárgalo de nuevo desde tu panel (sección Mis certificados): ${urlPanel}\nVerificación pública: ${urlVerificar}\n\n${notaFinal}\n`
  };
}

// Envía el correo del certificado con el PDF adjunto. Devuelve true/false; nunca lanza.
// Sin RESEND_API_KEY o MAIL_FROM no hace nada (ni genera el PDF) y devuelve false.
async function enviarCorreoCertificado(datos, { apiKey, from, fetchImpl, generarPdf } = {}) {
  const d = datos || {};
  const llave = apiKey !== undefined ? apiKey : (process.env.RESEND_API_KEY || '').trim();
  const remitente = from !== undefined ? from : (process.env.MAIL_FROM || '').trim();
  if (!llave || !remitente || !d.para || !d.folio) return false;
  const base = String(d.panelUrl || SITIO).replace(/\/+$/, '');
  let adjunto = null;
  try {
    const generar = generarPdf || require('./certificado-pdf').generarCertificadoPdf;
    const pdf = await generar({
      nombre: d.nombre, curso: d.curso, area: d.area, horas: d.horas, sesiones: d.sesiones, folio: d.folio, emitido: d.emitido,
      urlVerificacion: base + '/pages/verificar.html?folio=' + encodeURIComponent(String(d.folio))
    });
    adjunto = { filename: 'Certificado-' + String(d.folio).replace(/[^A-Za-z0-9_-]/g, '') + '.pdf', content: Buffer.from(pdf).toString('base64') };
  } catch (err) {
    console.warn('[Correo] No se pudo generar el PDF del certificado:', err && err.message);
  }
  const plantilla = plantillaCertificado({ ...d, conAdjunto: Boolean(adjunto) });
  const r = await enviarConResend(
    { para: d.para, asunto: plantilla.asunto, html: plantilla.html, texto: plantilla.texto, adjuntos: adjunto ? [adjunto] : [] },
    { apiKey: llave, from: remitente, fetchImpl }
  );
  return Boolean(r && r.ok);
}

// Firebase genera un enlace que abre su página genérica. Se conserva solo el código y se manda a
// nuestra propia página de confirmación (pages/verificar-correo.html).
function enlacePropioDeVerificacion(enlaceFirebase, sitio) {
  const base = (sitio || SITIO).replace(/\/+$/, '');
  try {
    const codigo = new URL(enlaceFirebase).searchParams.get('oobCode');
    if (codigo) return base + '/pages/verificar-correo.html?oobCode=' + encodeURIComponent(codigo);
  } catch (e) { /* enlace inesperado: se usa tal cual */ }
  return enlaceFirebase;
}

module.exports = {
  plantillaVerificacion, plantillaCertificado, enviarConResend, enviarCorreoCertificado,
  enlacePropioDeVerificacion, primerNombre, esc, SITIO
};
