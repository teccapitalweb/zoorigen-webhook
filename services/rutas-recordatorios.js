'use strict';

// ══ RUTAS: recordatorios de pago (baja, cupón de la persona, preferencia y panel de administración) ══
// Públicas (la firma del enlace es la prueba):
//   GET  /baja-recordatorios?u=<uid>&t=<firma>     página de confirmación en la marca (NO da de baja: los lectores de correo abren los enlaces)
//   POST /baja-recordatorios?u=<uid>&t=<firma>     da de baja (el botón de la página y el «un clic» de Gmail y Yahoo: List-Unsubscribe=One-Click)
// Con sesión de Firebase verificada:
//   GET  /api/recordatorios/mi-cupon               el cupón vigente de ESTA cuenta (o null); nunca datos de otras cuentas
//   GET  /api/recordatorios/preferencia            { recibe, baja }
//   POST /api/recordatorios/preferencia            { recibe: true|false, origen: 'registro'|'perfil' }  (la casilla del registro y el interruptor del perfil)
// Administración (verificada en el servidor, con límite de peticiones y bitácora adminAcciones):
//   GET  /api/admin/recordatorios                  interruptor, envíos de hoy, próximos envíos, conteos y estadísticas
//   GET  /api/admin/recordatorios/lista            tabla por persona con búsqueda y filtro por etapa
//   POST /api/admin/recordatorios/modo             { modo: 'activo' | 'apagado', confirmo: true }
//   POST /api/admin/recordatorios/limites          { topeDiario, maxPorCorrida }
//   POST /api/admin/recordatorios/ensayo           dry-run: quién recibiría qué correo ahora (sin enviar ni crear cupones)
//   POST /api/admin/recordatorios/prueba           { paso: 1..7 | 'todos', ciclo?: 1..3 } manda al correo de quien administra un correo de prueba con un cupón real de prueba

const { permitirSolicitud } = require('./rutas-club');
const R = require('./recordatorios-pago');
const C = require('./recordatorios-correo');

const esc = C.esc;
const UID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;

function pagina(titulo, cuerpoHtml, { estado = 200 } = {}) {
  return { estado, html: `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex,nofollow">
<title>${esc(titulo)} · Zoorigen</title></head>
<body style="margin:0;background:#F4F1EA;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#16241B;">
  <div style="max-width:480px;margin:40px auto;padding:0 14px;">
    <div style="background:#FFFFFF;border:1px solid #E3DDCF;border-radius:16px;overflow:hidden;">
      <div style="background:#1F5F3A;padding:22px 24px;text-align:center;border-bottom:4px solid #E8A317;">
        <img src="${C.URL_LOGO}" width="64" height="64" alt="Zoorigen" style="display:block;margin:0 auto 8px;border-radius:50%;border:2px solid #FFFFFF;">
        <div style="font-size:22px;font-weight:800;color:#FFFFFF;">Zoorigen</div>
      </div>
      <div style="padding:26px 24px;">${cuerpoHtml}</div>
    </div>
    <p style="font-size:12px;line-height:1.6;color:#6B776E;text-align:center;margin:14px 0 0;">Zoorigen · Tehuacán, Puebla, México · <a href="${C.URL_AVISO}" style="color:#4F5E53;">Aviso de privacidad</a></p>
  </div>
</body></html>` };
}
const paginaInvalida = () => pagina('Enlace no válido', '<h1 style="margin:0 0 10px;font-size:21px;">Enlace no válido</h1><p style="margin:0;font-size:15px;line-height:1.6;color:#35443A;">Este enlace de baja no es válido o está incompleto. Si quieres dejar de recibir promociones, escríbenos a ' + esc(C.CORREO_CONTACTO) + ' y lo hacemos por ti.</p>', { estado: 400 });
const paginaConfirmar = (uid, firma) => pagina('Darte de baja',
  `<h1 style="margin:0 0 10px;font-size:21px;">¿Ya no quieres recibir promociones?</h1>
   <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#35443A;">Si confirmas, dejaremos de enviarte recordatorios y promociones sobre la membresía, incluidos los códigos de descuento. Tu cuenta y los servicios del Club no cambian.</p>
   <form method="POST" action="/baja-recordatorios?u=${encodeURIComponent(uid)}&amp;t=${encodeURIComponent(firma)}"><button type="submit" style="border:0;background:#1F5F3A;color:#FFFFFF;font-size:15px;font-weight:700;padding:13px 24px;border-radius:10px;cursor:pointer;">Sí, darme de baja</button></form>
   <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#5E6A60;">Si fue un error, simplemente cierra esta página: no se hizo ningún cambio.</p>`);
const paginaListo = () => pagina('Listo',
  `<h1 style="margin:0 0 10px;font-size:21px;">Listo, ya no te enviaremos promociones</h1>
   <p style="margin:0;font-size:15px;line-height:1.6;color:#35443A;">Te diste de baja de los recordatorios y promociones por correo. No volverás a recibirlos. Tu cuenta sigue igual, y si algún día quieres la membresía, estará en <a href="${C.SITIO}" style="color:#1F5F3A;">zoorigen.com</a>.</p>`);
const paginaError = () => pagina('No se pudo completar', '<h1 style="margin:0 0 10px;font-size:21px;">No se pudo completar</h1><p style="margin:0;font-size:15px;line-height:1.6;color:#35443A;">Intenta de nuevo en unos minutos. Si el problema sigue, escríbenos a ' + esc(C.CORREO_CONTACTO) + '.</p>', { estado: 500 });

function montarRutasRecordatorios(app, deps) {
  const { db, autenticarFirebase, errorHttp, recordatorios, claveBaja, express } = deps;
  const limites = { baja: new Map(), sesion: new Map() };
  const limitar = (mapa, clave, maximo) => { if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo'); };
  const analizadorJson = express.json({ limit: '1kb' });
  const analizadorForm = express.urlencoded({ extended: false, limit: '1kb' });

  const responderPagina = (res, p) => res.status(p.estado).set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8' }).send(p.html);
  const datosBaja = req => {
    const uid = typeof req.query.u === 'string' ? req.query.u : '';
    const firma = typeof req.query.t === 'string' ? req.query.t : '';
    return { uid, firma, valido: UID_VALIDO.test(uid) && R.bajaValida(claveBaja, uid, firma) };
  };

  app.get('/baja-recordatorios', (req, res) => {
    try { limitar(limites.baja, req.ip || 'ip', 60); } catch (e) { return responderPagina(res, pagina('Demasiadas solicitudes', '<p>Espera un momento e intenta de nuevo.</p>', { estado: 429 })); }
    const d = datosBaja(req);
    return responderPagina(res, d.valido ? paginaConfirmar(d.uid, d.firma) : paginaInvalida());
  });
  app.post('/baja-recordatorios', analizadorForm, async (req, res) => {
    try { limitar(limites.baja, req.ip || 'ip', 30); } catch (e) { return responderPagina(res, pagina('Demasiadas solicitudes', '<p>Espera un momento e intenta de nuevo.</p>', { estado: 429 })); }
    const d = datosBaja(req);
    if (!d.valido) return responderPagina(res, paginaInvalida());
    try {
      await recordatorios.darDeBaja(d.uid);   // si la cuenta ya no existe, igual se responde «listo» (no se revela nada)
      return responderPagina(res, paginaListo());
    } catch (err) {
      console.error('[Recordatorios baja]', err && err.message);
      return responderPagina(res, paginaError());
    }
  });

  const conSesion = (generico, etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(limites.sesion, decoded.uid, 30);
      return await fn(req, res, decoded);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message });
      console.error(`[Recordatorios ${etiqueta}]`, err && err.message);
      return res.status(500).json({ error: generico });
    }
  };

  app.get('/api/recordatorios/mi-cupon', conSesion('No se pudo consultar tu cupón', 'mi-cupon', async (req, res, decoded) => {
    const snap = await db.collection('miembros').doc(decoded.uid).get();
    const cupon = snap.exists ? await recordatorios.miCupon(decoded.uid, snap.data()) : null;
    // Solo lo de ESTA cuenta y solo lo que la pantalla necesita
    return res.json({ ok: true, cupon: cupon ? { codigo: cupon.codigo, monto: cupon.monto, precioMes: cupon.precioMes, precioFinal: cupon.precioFinal, venceMs: cupon.venceMs, restanteMs: cupon.restanteMs } : null });
  }));
  app.get('/api/recordatorios/preferencia', conSesion('No se pudo leer tu preferencia', 'preferencia', async (req, res, decoded) => {
    const p = await recordatorios.leerPreferencia(decoded.uid);
    return res.json({ ok: true, recibe: p.recibe, baja: p.baja });
  }));
  app.post('/api/recordatorios/preferencia', analizadorJson, conSesion('No se pudo guardar tu preferencia', 'preferencia', async (req, res, decoded) => {
    const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof cuerpo.recibe !== 'boolean') throw errorHttp(400, 'Indica si quieres recibir promociones (true o false)');
    const origen = cuerpo.origen === 'registro' ? 'registro' : 'perfil';
    // La casilla del registro puede llegar un instante antes de que exista la ficha: la preferencia se guarda igual
    const p = await recordatorios.fijarPreferencia(decoded.uid, cuerpo.recibe, origen);
    return res.json({ ok: true, recibe: p.recibe, baja: p.baja });
  }));
}

function montarRutasAdminRecordatorios(app, deps, a) {
  const { errorHttp, recordatorios } = deps;
  const { conAdmin, anotarAccion, analizadorJson } = a;

  app.get('/api/admin/recordatorios', conAdmin('No se pudo leer el estado de los recordatorios', 'recordatorios', async (req, res, decoded) => {
    const resumen = await recordatorios.resumen();
    // correoAdmin: a esta dirección (y solo a ella) llegan los correos de prueba
    return res.json({ ok: true, generado: new Date().toISOString(), configurado: Boolean(recordatorios.listoParaEnviar()), correoAdmin: String(decoded.email || '').toLowerCase(), ...resumen });
  }));

  app.get('/api/admin/recordatorios/lista', conAdmin('No se pudo leer la lista', 'recordatorios-lista', async (req, res) => {
    const etapa = recordatorios.ETAPAS.includes(req.query.etapa) ? req.query.etapa : 'todas';
    const lista = await recordatorios.listado({ q: String(req.query.q || '').slice(0, 80), etapa, pagina: parseInt(req.query.pagina, 10) || 1 });
    return res.json({ ok: true, etapa, ...lista });
  }));

  app.post('/api/admin/recordatorios/modo', analizadorJson, conAdmin('No se pudo cambiar el interruptor', 'recordatorios-modo', async (req, res, decoded) => {
    const modo = req.body && req.body.modo;
    if (!['activo', 'apagado'].includes(modo)) throw errorHttp(400, 'El modo debe ser «activo» o «apagado»');
    if (modo === 'activo') {
      if (req.body.confirmo !== true) throw errorHttp(400, 'Para activarlo hay que confirmar en la ventana del panel');
      if (!recordatorios.listoParaEnviar()) throw Object.assign(errorHttp(409, 'No se puede activar: falta configurar el correo (RESEND_API_KEY y MAIL_FROM) o la llave de firmas (CERTIFICATE_SIGNING_KEY) en el servidor'), { codigo: 'sin-configurar' });
    }
    const cfg = await recordatorios.fijarModo(modo, decoded.email);
    await anotarAccion(decoded, 'recordatorios-modo', '', modo === 'activo' ? 'Activó los recordatorios de pago por correo' : 'Apagó los recordatorios de pago por correo', { modo });
    return res.json({ ok: true, modo: cfg.modo });
  }, { escritura: true }));

  app.post('/api/admin/recordatorios/limites', analizadorJson, conAdmin('No se pudieron guardar los límites', 'recordatorios-limites', async (req, res, decoded) => {
    const cuerpo = req.body || {};
    const ok = v => Number.isInteger(v) && v >= 1;
    if (!ok(cuerpo.topeDiario) || !ok(cuerpo.maxPorCorrida)) throw errorHttp(400, 'Escribe números enteros mayores que cero');
    if (cuerpo.topeDiario > R.CONFIG.topeDiarioMaximo) throw errorHttp(400, 'El tope diario máximo es ' + R.CONFIG.topeDiarioMaximo);
    if (cuerpo.maxPorCorrida > R.CONFIG.maxPorCorridaMaximo) throw errorHttp(400, 'El máximo por corrida es ' + R.CONFIG.maxPorCorridaMaximo);
    const cfg = await recordatorios.fijarLimites({ topeDiario: cuerpo.topeDiario, maxPorCorrida: cuerpo.maxPorCorrida });
    await anotarAccion(decoded, 'recordatorios-limites', '', `Cambió los límites de recordatorios: ${cfg.topeDiario} al día y ${cfg.maxPorCorrida} por corrida`, { topeDiario: cfg.topeDiario, maxPorCorrida: cfg.maxPorCorrida });
    return res.json({ ok: true, topeDiario: cfg.topeDiario, maxPorCorrida: cfg.maxPorCorrida });
  }, { escritura: true }));

  app.post('/api/admin/recordatorios/ensayo', analizadorJson, conAdmin('No se pudo hacer el ensayo', 'recordatorios-ensayo', async (req, res, decoded) => {
    const r = await recordatorios.procesar({ ensayo: true });
    await anotarAccion(decoded, 'recordatorios-ensayo', '', `Hizo un ensayo de recordatorios: ${r.recibirian.length} personas recibirían un correo ahora`, { personas: r.recibirian.length });
    return res.json({ ok: true, ...r });
  }, { escritura: true }));

  app.post('/api/admin/recordatorios/prueba', analizadorJson, conAdmin('No se pudo enviar el correo de prueba', 'recordatorios-prueba', async (req, res, decoded) => {
    const correo = String(decoded.email || '').toLowerCase();
    if (!correo.includes('@')) throw errorHttp(400, 'Tu sesión no tiene correo');
    const pedido = req.body && req.body.paso;
    const ciclo = Math.min(R.CONFIG.maxCiclos, Math.max(1, Math.floor(Number(req.body && req.body.ciclo)) || 1));
    const pasos = pedido === 'todos' ? R.SERIE.map(s => s.paso) : [Number(pedido)];
    if (!pasos.every(p => Number.isInteger(p) && R.definicion(p))) throw errorHttp(400, 'Elige un paso de 1 a ' + R.PASO_ULTIMO + ' o «todos»');
    if (!recordatorios.listoParaEnviar()) throw Object.assign(errorHttp(409, 'No se puede enviar: falta configurar el correo (RESEND_API_KEY y MAIL_FROM) en el servidor'), { codigo: 'sin-configurar' });
    const enviados = [];
    for (const paso of pasos) {
      enviados.push(await recordatorios.enviarPrueba({ paso, ciclo, correo, nombre: decoded.name || '' }));
      if (pasos.length > 1) await new Promise(r => setTimeout(r, 1200));
    }
    await anotarAccion(decoded, 'recordatorios-prueba', '', `Se mandó a sí mismo ${pasos.length === 1 ? 'el correo de prueba del paso ' + pasos[0] : 'los ' + pasos.length + ' correos de prueba'} (vuelta ${ciclo})`, { pasos, ciclo });
    return res.json({ ok: true, enviados, para: correo });
  }, { escritura: true }));
}

module.exports = { montarRutasRecordatorios, montarRutasAdminRecordatorios, paginaConfirmar, paginaListo, paginaInvalida };
