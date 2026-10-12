'use strict';

// ══ RUTAS: confirmación de correo ══
// POST /api/auth/send-verification  (sesión de Firebase)
//   Genera el enlace oficial de verificación con el SDK de administrador y lo envía con la plantilla de Zoorigen.
//   - Si el correo ya está verificado: { ok: true, yaVerificado: true }.
//   - Si falta configurar el envío (RESEND_API_KEY / MAIL_FROM): 503 con codigo 'correo-no-configurado'; el sitio usa
//     entonces el correo estándar de Firebase como respaldo.
//   - Límite: 1 envío por minuto y 6 por hora por cuenta.

const { permitirSolicitud } = require('./rutas-club');
const correo = require('./correo');

function montarRutasAuth(app, deps) {
  const { auth, autenticarFirebase, errorHttp, panelUrl } = deps;
  const enviar = deps.enviarCorreo || correo.enviarConResend;
  const ultimoEnvio = new Map();
  const porHora = new Map();

  app.post('/api/auth/send-verification', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      if (!decoded.email) throw errorHttp(400, 'Tu cuenta no tiene correo electrónico');
      if (decoded.email_verified === true) return res.json({ ok: true, yaVerificado: true });

      const ahora = Date.now();
      const previo = ultimoEnvio.get(decoded.uid);
      if (previo && ahora - previo < 60 * 1000) throw errorHttp(429, 'Espera un minuto antes de pedir otro correo');
      if (!permitirSolicitud(porHora, decoded.uid, 60 * 60 * 1000, 6)) throw errorHttp(429, 'Pediste muchos correos. Intenta de nuevo en un rato.');

      const sitio = (panelUrl || correo.SITIO).replace(/\/+$/, '');
      const enlaceFirebase = await auth.generateEmailVerificationLink(decoded.email, { url: sitio + '/pages/club-dashboard.html' });
      const enlace = correo.enlacePropioDeVerificacion(enlaceFirebase, sitio);
      const plantilla = correo.plantillaVerificacion({ nombre: decoded.name, enlace });
      const r = await enviar({ para: decoded.email, asunto: plantilla.asunto, html: plantilla.html, texto: plantilla.texto });
      if (!r || !r.ok) {
        if (r && r.motivo === 'sin-configurar') {
          const e = errorHttp(503, 'El envío de correos de Zoorigen todavía no está configurado');
          e.codigo = 'correo-no-configurado';
          throw e;
        }
        throw errorHttp(502, 'No se pudo enviar el correo de verificación');
      }
      ultimoEnvio.set(decoded.uid, ahora);
      if (ultimoEnvio.size > 5000) { for (const [k, t] of ultimoEnvio) if (ahora - t > 60 * 1000) ultimoEnvio.delete(k); }
      return res.json({ ok: true });
    } catch (err) {
      if (err && err.status) {
        const cuerpo = { error: err.message };
        if (err.codigo) cuerpo.codigo = err.codigo;
        return res.status(err.status).json(cuerpo);
      }
      console.error('[Auth send-verification]', err && err.message);
      return res.status(500).json({ error: 'No se pudo enviar el correo de verificación' });
    }
  });
}

module.exports = { montarRutasAuth };
