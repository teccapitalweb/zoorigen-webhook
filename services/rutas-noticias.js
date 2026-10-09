'use strict';

// ══ RUTAS: noticias del sector, datos curiosos y avisos (campana) ══
// server.js llama a montarRutasNoticias(app, deps) con lo que ya existe (autenticarFirebase, autenticarAdmin,
// db, errorHttp). Colecciones SOLO DEL SERVIDOR: noticiasSector, avisos/{uid}/items, notificacionesGlobales,
// datosCuriosos, config/noticiasSector, config/datosCuriosos. El sitio no las lee ni las escribe: usa estos endpoints.

const crypto = require('crypto');
const { permitirSolicitud } = require('./rutas-club');
const avisos = require('./avisos');
const noticias = require('./noticias');
const datos = require('./datos-curiosos');
const { ejecutarTareaDiaria, avisarNoticiasNuevas } = require('./tarea-diaria');
const { texto, enlaceInterno, ID_VALIDO } = require('./texto');

const LECTURAS_POR_MINUTO = 60;
const ESCRITURAS_ADMIN_POR_MINUTO = 30;
const SYNC_POR_MINUTO = 3;
const ENLACE_NOTICIAS = 'club-noticias.html';

// Compara dos textos sin filtrar su largo ni el punto donde difieren
function clavesIguales(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function montarRutasNoticias(app, deps) {
  const { express, db, autenticarFirebase, autenticarAdmin, errorHttp } = deps;
  const cronKey = String(deps.cronKey || '').trim();
  const limites = { lecturas: new Map(), admin: new Map(), sync: new Map(), cron: new Map() };

  const limitar = (mapa, clave, maximo) => {
    if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error(`[Noticias ${etiqueta || 'api'}]`, err);
    return res.status(500).json({ error: mensajeGenerico });
  }

  // Envoltura común: sin caché, sesión (miembro o administrador) y límite de peticiones
  const miembro = (mensajeGenerico, etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };
  const administrador = (mensajeGenerico, etiqueta, fn, { mapa = limites.admin, maximo = ESCRITURAS_ADMIN_POR_MINUTO } = {}) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitar(mapa, decoded.uid, maximo);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };

  const cuerpoDe = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const idDe = req => {
    const id = req.params.id;
    if (!ID_VALIDO.test(id)) throw errorHttp(400, 'El identificador no es válido');
    return id;
  };

  // ════════════════════════════════════════════════════════════
  // MIEMBRO: cualquier persona con sesión (no exige membresía)
  // ════════════════════════════════════════════════════════════
  // GET /api/noticias?limit=7 — últimas noticias (máx. 30, por defecto 7)
  app.get('/api/noticias', miembro('No se pudieron cargar las noticias', 'noticias', async (req, res) => {
    const n = Number.parseInt(req.query.limit, 10);
    return res.json({ ok: true, noticias: await noticias.listarNoticias(db, Number.isFinite(n) ? n : undefined) });
  }));

  // GET /api/avisos — personales (30) + globales (15), más recientes primero, máx. 40
  app.get('/api/avisos', miembro('No se pudieron cargar tus avisos', 'avisos', async (req, res, decoded) => {
    return res.json({ ok: true, avisos: await avisos.listarAvisos(db, decoded.uid) });
  }));

  // ════════════════════════════════════════════════════════════
  // ADMINISTRADOR — noticias
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/noticias', administrador('No se pudieron cargar las noticias', 'admin-noticias', async (req, res) => {
    return res.json({ ok: true, noticias: await noticias.listarNoticiasAdmin(db) });
  }));

  app.post('/api/admin/noticias', express.json(), administrador('No se pudo publicar la noticia', 'admin-noticias', async (req, res) => {
    const r = noticias.validarNoticiaAdmin(req.body);
    if (r.error) throw errorHttp(400, r.error);
    const noticia = await noticias.publicarNoticiaAdmin(db, r.datos);
    let aviso = null;
    if (r.datos.avisar) {
      aviso = await avisos.crearNotificacionGlobal(db, {
        id: `noticia_${noticia.id}`, tipo: 'noticia', titulo: `📰 ${noticia.titulo}`, descripcion: noticia.extracto,
        enlace: ENLACE_NOTICIAS, origen: 'admin'
      });
    }
    return res.json({ ok: true, noticia, avisoCreado: Boolean(aviso && aviso.creado) });
  }));

  app.post('/api/admin/noticias/sync', administrador('No se pudo sincronizar las noticias', 'admin-sync', async (req, res) => {
    const r = await noticias.syncNoticias(db);
    const aviso = await avisarNoticiasNuevas(db, r);
    return res.json({ ok: true, guardadas: r.guardadas, omitidas: r.omitidas, fuentes: r.fuentes, eliminadas: r.eliminadas, avisoCreado: Boolean(aviso && aviso.creado) });
  }, { mapa: limites.sync, maximo: SYNC_POR_MINUTO }));

  app.post('/api/admin/noticias/:id/eliminar', administrador('No se pudo eliminar la noticia', 'admin-noticias', async (req, res) => {
    const id = idDe(req);
    if (!(await noticias.eliminarNoticia(db, id))) throw errorHttp(404, 'Esa noticia no existe');
    return res.json({ ok: true });
  }));

  // ════════════════════════════════════════════════════════════
  // ADMINISTRADOR — datos curiosos
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/datos-curiosos', administrador('No se pudo cargar el banco de datos curiosos', 'admin-datos', async (req, res) => {
    await datos.sembrarSiVacia(db);
    return res.json({ ok: true, datos: await datos.listarDatos(db) });
  }));

  app.post('/api/admin/datos-curiosos', express.json(), administrador('No se pudo guardar el dato curioso', 'admin-datos', async (req, res) => {
    const cuerpo = cuerpoDe(req);
    const r = datos.validarDato(cuerpo);
    if (r.error) throw errorHttp(400, r.error);
    const dato = await datos.crearDato(db, r.datos);
    const envio = cuerpo.enviarYa === true ? await datos.enviarDato(db, dato) : null;
    const actual = envio && envio.enviado ? (await datos.listarDatos(db)).find(d => d.id === dato.id) : null;
    return res.json({ ok: true, dato: actual || dato, enviado: Boolean(envio && envio.enviado) });
  }));

  app.post('/api/admin/datos-curiosos/:id/actualizar', express.json(), administrador('No se pudo actualizar el dato curioso', 'admin-datos', async (req, res) => {
    const id = idDe(req);
    const cuerpo = cuerpoDe(req);
    const cambios = {};
    if (cuerpo.texto !== undefined || cuerpo.tema !== undefined) {
      const r = datos.validarDato({ texto: cuerpo.texto, tema: cuerpo.tema }, { parcial: true });
      if (r.error) throw errorHttp(400, r.error);
      Object.assign(cambios, r.datos);
    }
    if (cuerpo.activo !== undefined) {
      if (typeof cuerpo.activo !== 'boolean') throw errorHttp(400, 'El estado "activo" debe ser verdadero o falso');
      cambios.activo = cuerpo.activo;
    }
    if (!Object.keys(cambios).length) throw errorHttp(400, 'No hay nada que actualizar');
    const dato = await datos.actualizarDato(db, id, cambios);
    if (!dato) throw errorHttp(404, 'Ese dato curioso no existe');
    return res.json({ ok: true, dato });
  }));

  app.post('/api/admin/datos-curiosos/:id/eliminar', administrador('No se pudo eliminar el dato curioso', 'admin-datos', async (req, res) => {
    const id = idDe(req);
    if (!(await datos.eliminarDato(db, id))) throw errorHttp(404, 'Ese dato curioso no existe');
    return res.json({ ok: true });
  }));

  app.post('/api/admin/datos-curiosos/:id/enviar', administrador('No se pudo enviar el dato curioso', 'admin-datos', async (req, res) => {
    const id = idDe(req);
    const existente = (await datos.listarDatos(db)).find(d => d.id === id);
    if (!existente) throw errorHttp(404, 'Ese dato curioso no existe');
    const envio = await datos.enviarDato(db, existente);
    if (!envio.enviado && envio.motivo !== 'ya-enviado') throw errorHttp(500, 'No se pudo crear el aviso del dato curioso');
    return res.json({ ok: true, enviado: envio.enviado, ...(envio.enviado ? {} : { yaEnviado: true }) });
  }));

  // ════════════════════════════════════════════════════════════
  // ADMINISTRADOR — avisos globales (campana)
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/avisos', administrador('No se pudieron cargar los avisos', 'admin-avisos', async (req, res) => {
    return res.json({ ok: true, avisos: await avisos.listarGlobalesAdmin(db) });
  }));

  app.post('/api/admin/avisos', express.json(), administrador('No se pudo crear el aviso', 'admin-avisos', async (req, res) => {
    const cuerpo = cuerpoDe(req);
    if (typeof cuerpo.tipo !== 'string' || !avisos.TIPOS_GLOBALES.includes(cuerpo.tipo)) throw errorHttp(400, 'El tipo de aviso no es válido');
    if (typeof cuerpo.titulo !== 'string') throw errorHttp(400, 'El título es obligatorio (de 3 a 120 caracteres)');
    const titulo = texto(cuerpo.titulo, avisos.LIMITES.titulo + 1);
    if (titulo.length < 3 || titulo.length > avisos.LIMITES.titulo) throw errorHttp(400, 'El título debe tener entre 3 y 120 caracteres');
    if (typeof cuerpo.descripcion !== 'string') throw errorHttp(400, 'La descripción es obligatoria (hasta 320 caracteres)');
    const descripcion = texto(cuerpo.descripcion, avisos.LIMITES.descripcion + 1);
    if (descripcion.length < 3 || descripcion.length > avisos.LIMITES.descripcion) throw errorHttp(400, 'La descripción debe tener entre 3 y 320 caracteres');
    let enlace = '';
    if (cuerpo.enlace !== undefined && cuerpo.enlace !== null && cuerpo.enlace !== '') {
      if (typeof cuerpo.enlace !== 'string') throw errorHttp(400, 'El enlace no es válido');
      enlace = enlaceInterno(cuerpo.enlace, avisos.LIMITES.enlace);
      if (!enlace || String(cuerpo.enlace).trim().length > avisos.LIMITES.enlace) throw errorHttp(400, 'El enlace debe ser una página del sitio (hasta 40 caracteres, sin espacios)');
    }
    const r = await avisos.crearNotificacionGlobal(db, { tipo: cuerpo.tipo, titulo, descripcion, enlace, origen: 'admin' });
    if (!r.creado) throw errorHttp(500, 'No se pudo crear el aviso');
    return res.json({ ok: true, id: r.id });
  }));

  app.post('/api/admin/avisos/:id/eliminar', administrador('No se pudo eliminar el aviso', 'admin-avisos', async (req, res) => {
    const id = idDe(req);
    const ref = db.collection('notificacionesGlobales').doc(id);
    if (!(await ref.get()).exists) throw errorHttp(404, 'Ese aviso no existe');
    await ref.delete();
    return res.json({ ok: true });
  }));

  // ════════════════════════════════════════════════════════════
  // Disparo manual de la tarea diaria: GET /cron/noticias?key=CRON_KEY (o cabecera x-cron-key)
  // ════════════════════════════════════════════════════════════
  app.get('/cron/noticias', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const enviada = typeof req.query.key === 'string' ? req.query.key : (typeof req.get('x-cron-key') === 'string' ? req.get('x-cron-key') : '');
      // Sin CRON_KEY configurada la ruta queda cerrada para todos
      if (!cronKey || !enviada || !clavesIguales(enviada, cronKey)) return res.status(401).json({ error: 'No autorizado' });
      limitar(limites.cron, 'cron', 6);
      const r = await ejecutarTareaDiaria(db, { minHoras: 0 });
      return res.json({ ok: true, ...r });
    } catch (error) {
      return responderError(res, error, 'No se pudo ejecutar la tarea de noticias', 'cron');
    }
  });

  return { limites };
}

module.exports = { montarRutasNoticias, clavesIguales };
