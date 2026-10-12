'use strict';

// ══ CORREOS DE ZOORIGEN · plantilla y envío por Resend ══
// El correo estándar de Firebase sale de firebaseapp.com (dominio compartido) y suele terminar en spam.
// Aquí se arma un correo con la identidad de Zoorigen y se envía desde un dominio propio verificado en Resend.
// Variables de entorno (se configuran en Railway, nunca en el código):
//   RESEND_API_KEY  llave de Resend
//   MAIL_FROM       remitente verificado en Resend, p. ej. "Zoorigen <no-reply@zoorigen.com>"
// Sin RESEND_API_KEY no se envía nada y el sitio usa el correo estándar de Firebase como respaldo.

const SITIO = 'https://www.zoorigen.com';

function esc(valor) {
  return String(valor == null ? '' : valor).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function primerNombre(nombre) {
  const limpio = String(nombre || '').trim().split(/\s+/)[0] || '';
  return limpio.slice(0, 40);
}

function marco({ titulo, saludo, parrafo, textoBoton, enlace, notaFinal }) {
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
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
            <tr><td style="border-radius:10px;background:#E8A317;">
              <a href="${link}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:700;color:#1F1D17;text-decoration:none;">${esc(textoBoton)}</a>
            </td></tr>
          </table>
          <p style="margin:0 0 6px;font-size:12.5px;line-height:1.5;color:#5E6A60;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
          <p style="margin:0 0 20px;font-size:11.5px;line-height:1.5;color:#1F5F3A;word-break:break-all;">${link}</p>
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
async function enviarConResend({ para, asunto, html, texto }, { apiKey, from, fetchImpl } = {}) {
  const llave = apiKey !== undefined ? apiKey : (process.env.RESEND_API_KEY || '').trim();
  const remitente = from !== undefined ? from : (process.env.MAIL_FROM || '').trim();
  if (!llave || !remitente) return { ok: false, motivo: 'sin-configurar' };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, motivo: 'sin-fetch' };
  try {
    const r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + llave, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: remitente, to: [para], subject: asunto, html, text: texto })
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

module.exports = { plantillaVerificacion, enviarConResend, enlacePropioDeVerificacion, primerNombre, esc, SITIO };
