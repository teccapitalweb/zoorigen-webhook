'use strict';

// ══ RUTAS: clases en vivo (webinars) ══
// Persona con sesión:
//   GET  /api/webinars                 próximas clases (públicas; + las de prueba si es superadmin)
//   GET  /api/webinars/:id/unirse      { meetUrl } SOLO dentro de la ventana de la clase y con membresía (o admin)
//   POST /api/webinars/:id/inscribirme / DELETE ... → "Mis registradas"
//   POST /api/bunny/webinar-embed-token   { sesionId } -> token firmado para ver la grabación
// Administración (montada desde services/rutas-admin.js, con conAdmin + anotarAccion):
//   GET    /api/admin/webinars
//   POST   /api/admin/webinars                 { esPrueba?, ...datos } crea (Meet automático o manual)
//   PUT    /api/admin/webinars/:id             edita
//   DELETE /api/admin/webinars/:id             elimina (y el evento de Calendar si aplica)
//   POST   /api/admin/webinars/:id/video-manual     { bunnyVideoId } fija un video a mano
//   POST   /api/admin/webinars/:id/reintentar-grabacion
//   GET    /api/admin/webinars/legado-pendiente     cuántas clases viejas falta proteger
//   POST   /api/admin/webinars/proteger-enlaces
// Las reglas del servicio están en services/webinars.js.

const { permitirSolicitud } = require('./rutas-club');
const { ErrorWebinar } = require('./webinars');

const POR_MINUTO = 60;

function responderError(res, err, generico, etiqueta) {
  if (err && err.status) {
    const cuerpo = { error: err.message };
    if (err.codigo) cuerpo.codigo = err.codigo;
    return res.status(err.status).json(cuerpo);
  }
  console.error(`[Webinars ${etiqueta || 'api'}]`, err && err.message);
  return res.status(500).json({ error: generico });
}

function montarRutasWebinars(app, deps) {
  const { db, admin, autenticarFirebase, errorHttp, club, webinars, esAdminPorDocumentos, tienePlanVigente, analizadorJson } = deps;
  const limites = { lecturas: new Map(), escrituras: new Map() };
  const limitar = (mapa, uid, maximo) => {
    if (!permitirSolicitud(mapa, uid, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

  async function contexto(uid) {
    const [adminDoc, miembroDoc, usuarioDoc] = await Promise.all([
      db.collection('admins').doc(uid).get(), db.collection('miembros').doc(uid).get(), db.collection('usuarios').doc(uid).get()
    ]);
    return { adminDoc, miembroDoc, usuarioDoc };
  }

  const conSesion = (generico, etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(limites.lecturas, decoded.uid, POR_MINUTO);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, generico, etiqueta);
    }
  };

  app.get('/api/webinars', conSesion('No se pudieron cargar las clases en vivo', 'listar', async (req, res, decoded) => {
    const esSuperadmin = webinars.esSuperadminPorCorreo(decoded);
    const sesiones = await webinars.listarPublico({ esSuperadmin });
    const inscritas = await webinars.misInscripciones(decoded.uid);
    return res.json({ ok: true, sesiones: sesiones.map(s => ({ ...s, inscrito: inscritas.includes(s.id) })) });
  }));

  app.get('/api/webinars/:id/unirse', conSesion('No se pudo obtener el enlace de la clase', 'unirse', async (req, res, decoded) => {
    const esPrueba = req.query.prueba === '1';
    const { adminDoc, miembroDoc, usuarioDoc } = await contexto(decoded.uid);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc, decoded);
    const esSuperadmin = webinars.esSuperadminPorCorreo(decoded);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    const r = await webinars.obtenerEnlaceParaUnirse(req.params.id, { esAdmin, esSuperadmin, tienePlan, esPrueba });
    return res.json({ ok: true, ...r });
  }));

  app.post('/api/webinars/:id/inscribirme', analizadorJson, conSesion('No se pudo registrar tu inscripción', 'inscribirme', async (req, res, decoded) => {
    limitar(limites.escrituras, decoded.uid, POR_MINUTO);
    const esPrueba = req.body && req.body.esPrueba === true;
    await webinars.inscribirme(req.params.id, decoded.uid, { esPrueba });
    return res.json({ ok: true });
  }));

  app.delete('/api/webinars/:id/inscribirme', conSesion('No se pudo quitar tu inscripción', 'cancelar-inscripcion', async (req, res, decoded) => {
    limitar(limites.escrituras, decoded.uid, POR_MINUTO);
    await webinars.cancelarInscripcion(req.params.id, decoded.uid);
    return res.json({ ok: true });
  }));

  app.post('/api/bunny/webinar-embed-token', analizadorJson, conSesion('No se pudo preparar la grabación', 'embed-token', async (req, res, decoded) => {
    const { bunny } = deps;
    if (!bunny || !bunny.configurado()) return res.status(503).json({ error: 'Bunny Stream (clases en vivo) no está configurado en Railway' });
    const sesionId = String((req.body && req.body.sesionId) || '').trim();
    const esPrueba = req.body && req.body.esPrueba === true;
    if (!sesionId) throw errorHttp(400, 'Falta el id de la clase');
    const { adminDoc, miembroDoc, usuarioDoc } = await contexto(decoded.uid);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc, decoded);
    const esSuperadmin = webinars.esSuperadminPorCorreo(decoded);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    if (esPrueba && !esAdmin && !esSuperadmin) throw errorHttp(404, 'No encontramos esa clase');
    if (!esPrueba && !esAdmin && !tienePlan) throw errorHttp(403, 'Necesitas una membresía activa para ver esta grabación');
    const colPriv = esPrueba ? 'sesionesPruebaPrivadas' : 'sesionesPrivadas';
    const priv = await db.collection(colPriv).doc(sesionId).get();
    const bunnyVideoId = priv.exists ? (priv.data() || {}).bunnyVideoId : null;
    if (!bunnyVideoId) throw errorHttp(404, 'Esta clase todavía no tiene una grabación disponible');
    const { embedUrl, expires } = require('./bunny-videos').firmarToken({
      libraryId: deps.bunnyLibraryId, authKey: deps.bunnyTokenAuthKey, videoId: bunnyVideoId, ttlSegundos: deps.bunnyTtlSegundos || 300
    });
    return res.json({ ok: true, embedUrl, expires });
  }));

  return { servicio: webinars };
}

function montarRutasAdminWebinars(app, deps, a) {
  const { webinars } = deps;
  const { conAdmin, anotarAccion, analizadorJson } = a;

  app.get('/api/admin/webinars', conAdmin('No se pudieron cargar las clases en vivo', 'admin-listar', async (req, res) => {
    return res.json({ ok: true, sesiones: await webinars.listarAdmin() });
  }));

  app.post('/api/admin/webinars', analizadorJson, conAdmin('No se pudo crear la clase', 'admin-crear', async (req, res, decoded) => {
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    const fila = await webinars.crear({
      decoded, esPrueba: c.esPrueba === true, titulo: c.titulo, descripcion: c.descripcion, instructor: c.instructor,
      duracionMin: c.duracionMin, inicioISO: c.inicioISO, crearMeet: c.crearMeet !== false, meetManual: c.meetManual
    });
    await anotarAccion(decoded, 'webinar-crear', fila.id, `Programó ${c.esPrueba ? 'la clase de prueba' : 'la clase en vivo'} «${fila.titulo}»`, { esPrueba: fila.esPrueba });
    return res.json({ ok: true, sesion: fila });
  }, { escritura: true }));

  app.put('/api/admin/webinars/:id', analizadorJson, conAdmin('No se pudo editar la clase', 'admin-editar', async (req, res, decoded) => {
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    const fila = await webinars.editar(req.params.id, c, { esPrueba: c.esPrueba === true });
    await anotarAccion(decoded, 'webinar-editar', req.params.id, `Editó la clase «${fila.titulo}»`);
    return res.json({ ok: true, sesion: fila });
  }, { escritura: true }));

  app.delete('/api/admin/webinars/:id', conAdmin('No se pudo eliminar la clase', 'admin-eliminar', async (req, res, decoded) => {
    const esPrueba = req.query.prueba === '1';
    await webinars.eliminar(req.params.id, { esPrueba });
    await anotarAccion(decoded, 'webinar-eliminar', req.params.id, 'Eliminó una clase en vivo');
    return res.json({ ok: true });
  }, { escritura: true, limite: 'eliminaciones' }));

  app.post('/api/admin/webinars/:id/video-manual', analizadorJson, conAdmin('No se pudo fijar el video', 'admin-video-manual', async (req, res, decoded) => {
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    await webinars.fijarVideoManual(req.params.id, { esPrueba: c.esPrueba === true, bunnyVideoId: c.bunnyVideoId });
    await anotarAccion(decoded, 'webinar-video-manual', req.params.id, 'Fijó un video a mano para una clase en vivo');
    return res.json({ ok: true });
  }, { escritura: true }));

  app.post('/api/admin/webinars/:id/reintentar-grabacion', conAdmin('No se pudo buscar la grabación', 'admin-reintentar', async (req, res) => {
    const esPrueba = req.query.prueba === '1';
    const r = await webinars.buscarGrabacionParaSesion(req.params.id, { esPrueba });
    return res.json({ ok: true, resultado: r, automatizacion: await webinars.estadoAutomatizacion(req.params.id) });
  }, { escritura: true }));

  app.get('/api/admin/webinars/legado-pendiente', conAdmin('No se pudo revisar las clases anteriores', 'admin-legado', async (req, res) => {
    const pendientes = await webinars.legadoPendiente();
    return res.json({ ok: true, total: pendientes.length });
  }));

  app.post('/api/admin/webinars/proteger-enlaces', conAdmin('No se pudieron proteger los enlaces', 'admin-proteger', async (req, res, decoded) => {
    const r = await webinars.protegerEnlaces();
    await anotarAccion(decoded, 'webinar-proteger-enlaces', '', `Protegió ${r.migradas} clase(s) anteriores`, { migradas: r.migradas });
    return res.json({ ok: true, ...r });
  }, { escritura: true }));
}

module.exports = { montarRutasWebinars, montarRutasAdminWebinars };
