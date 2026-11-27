'use strict';

// ══ RUTAS: soporte privado (buzón 1-a-1 miembro ↔ administración) ══
// Persona con sesión:
//   GET  /api/soporte/tickets               mis mensajes de soporte
//   POST /api/soporte/tickets                { tema, mensaje } abre uno nuevo
//   GET  /api/soporte/tickets/:id            ese ticket + su hilo (solo el dueño)
//   POST /api/soporte/tickets/:id/mensajes   { texto } responde en el hilo (solo el dueño)
// Administración (montada desde services/rutas-admin.js, con conAdmin + anotarAccion):
//   GET  /api/admin/soporte/tickets          todos (?estado=abierto|cerrado)
//   GET  /api/admin/soporte/tickets/:id      ese ticket + su hilo (cualquier administrador)
//   POST /api/admin/soporte/tickets/:id/mensajes  { texto } responde como administración
//   POST /api/admin/soporte/tickets/:id/cerrar
//   POST /api/admin/soporte/tickets/:id/reabrir
// Las reglas del servicio están en services/soporte.js.

const { permitirSolicitud } = require('./rutas-club');

const POR_MINUTO = 30;

function responderError(res, err, generico, etiqueta) {
  if (err && err.status) {
    const cuerpo = { error: err.message };
    if (err.codigo) cuerpo.codigo = err.codigo;
    return res.status(err.status).json(cuerpo);
  }
  console.error(`[Soporte ${etiqueta || 'api'}]`, err && err.message);
  return res.status(500).json({ error: generico });
}

function montarRutasSoporte(app, deps) {
  const { db, autenticarFirebase, errorHttp, soporte, analizadorJson } = deps;
  const limites = { lecturas: new Map(), escrituras: new Map() };
  const limitar = (mapa, uid, maximo) => {
    if (!permitirSolicitud(mapa, uid, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

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

  async function nombreDe(uid, decoded) {
    try {
      const m = await db.collection('miembros').doc(uid).get();
      const d = m.data() || {};
      return d.nombre || d.name || decoded.name || '';
    } catch (_) { return decoded.name || ''; }
  }

  app.get('/api/soporte/tickets', conSesion('No se pudieron cargar tus mensajes de soporte', 'listar', async (req, res, decoded) => {
    const tickets = await soporte.misTickets(decoded.uid);
    return res.json({ ok: true, tickets, temas: soporte.TEMAS });
  }));

  app.post('/api/soporte/tickets', analizadorJson, conSesion('No se pudo enviar tu mensaje', 'crear', async (req, res, decoded) => {
    limitar(limites.escrituras, decoded.uid, 10);
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    const nombre = await nombreDe(decoded.uid, decoded);
    const ticket = await soporte.crearTicket({ uid: decoded.uid, nombre, correo: decoded.email || '', tema: c.tema, mensaje: c.mensaje });
    return res.json({ ok: true, ticket });
  }));

  app.get('/api/soporte/tickets/:id', conSesion('No se pudo cargar ese mensaje de soporte', 'obtener', async (req, res, decoded) => {
    const r = await soporte.obtenerTicket(req.params.id, { uid: decoded.uid, esAdmin: false });
    return res.json({ ok: true, ...r });
  }));

  app.post('/api/soporte/tickets/:id/mensajes', analizadorJson, conSesion('No se pudo enviar tu mensaje', 'responder', async (req, res, decoded) => {
    limitar(limites.escrituras, decoded.uid, 20);
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    const nombre = await nombreDe(decoded.uid, decoded);
    await soporte.responder(req.params.id, { autorUid: decoded.uid, autorTipo: 'miembro', autorNombre: nombre, texto: c.texto });
    return res.json({ ok: true });
  }));

  return { servicio: soporte };
}

function montarRutasAdminSoporte(app, deps, a) {
  const { soporte } = deps;
  const { conAdmin, anotarAccion, analizadorJson } = a;

  app.get('/api/admin/soporte/tickets', conAdmin('No se pudieron cargar los mensajes de soporte', 'admin-listar', async (req, res) => {
    const estado = req.query.estado === 'abierto' || req.query.estado === 'cerrado' ? req.query.estado : undefined;
    return res.json({ ok: true, tickets: await soporte.listarAdmin({ estado }) });
  }));

  app.get('/api/admin/soporte/tickets/:id', conAdmin('No se pudo cargar ese mensaje de soporte', 'admin-obtener', async (req, res) => {
    const r = await soporte.obtenerTicket(req.params.id, { esAdmin: true });
    return res.json({ ok: true, ...r });
  }));

  app.post('/api/admin/soporte/tickets/:id/mensajes', analizadorJson, conAdmin('No se pudo enviar la respuesta', 'admin-responder', async (req, res, decoded) => {
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    await soporte.responder(req.params.id, { autorUid: decoded.uid, autorTipo: 'admin', autorNombre: decoded.name || 'Equipo Zoorigen', texto: c.texto });
    await anotarAccion(decoded, 'soporte-responder', req.params.id, 'Respondió un mensaje de soporte');
    return res.json({ ok: true });
  }, { escritura: true }));

  app.post('/api/admin/soporte/tickets/:id/cerrar', conAdmin('No se pudo cerrar el ticket', 'admin-cerrar', async (req, res, decoded) => {
    await soporte.cambiarEstado(req.params.id, 'cerrado');
    await anotarAccion(decoded, 'soporte-cerrar', req.params.id, 'Cerró un mensaje de soporte');
    return res.json({ ok: true });
  }, { escritura: true }));

  app.post('/api/admin/soporte/tickets/:id/reabrir', conAdmin('No se pudo reabrir el ticket', 'admin-reabrir', async (req, res, decoded) => {
    await soporte.cambiarEstado(req.params.id, 'abierto');
    await anotarAccion(decoded, 'soporte-reabrir', req.params.id, 'Reabrió un mensaje de soporte');
    return res.json({ ok: true });
  }, { escritura: true }));
}

module.exports = { montarRutasSoporte, montarRutasAdminSoporte };
