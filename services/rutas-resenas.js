'use strict';

// ══ RUTAS: reseñas de cursos ══
// Persona con sesión (verificada en el servidor):
//   POST /api/resenas        { cursoId, estrellas (1 a 5), comentario (opcional, hasta 500) } guarda o actualiza SU reseña de ese curso;
//                            el servidor comprueba que tiene el certificado de ese curso (403 si no) y limita a 20 reseñas por hora
//   GET  /api/resenas/mias   lo que esa persona ya calificó ({ resenas: [{ cursoId, estrellas, comentario }] }, para no volver a preguntarle) y los cursos
//                            que ya terminó ({ terminados: [{ cursoId, curso, emitidoMs }] }, con el título del certificado, el más reciente primero)
// Administración (verificada en el servidor, con límite de peticiones):
//   GET  /api/admin/resenas  todas las reseñas, de la más reciente a la más antigua (?limite=, hasta 2000) con nombre, correo, curso, estrellas y comentario
// Las reglas del servicio están en services/resenas.js. No se publica ningún comentario en el sitio.

const { permitirSolicitud } = require('./rutas-club');
const panel = require('./admin-panel');
const resenas = require('./resenas');

const LECTURAS_POR_MINUTO = 60;
const ESCRITURAS_POR_MINUTO = 20;

function responderError(res, err, generico, etiqueta) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(`[Reseñas ${etiqueta || 'api'}]`, err && err.message);
  return res.status(500).json({ error: generico });
}

function montarRutasResenas(app, deps) {
  const { db, autenticarFirebase, errorHttp } = deps;
  const servicio = resenas.crearServicio({ db });
  const limitarPorHora = resenas.crearLimitador();
  const limites = { lecturas: new Map(), escrituras: new Map() };
  const limitar = (mapa, clave, maximo) => {
    if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };
  const conSesion = (generico, etiqueta, mapa, maximo, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(mapa, decoded.uid, maximo);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, generico, etiqueta);
    }
  };

  app.post('/api/resenas', deps.analizadorJson || ((req, res, next) => next()), conSesion('No se pudo guardar tu reseña', 'guardar', limites.escrituras, ESCRITURAS_POR_MINUTO, async (req, res, decoded) => {
    limitarPorHora(decoded.uid);
    const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
    const miembro = await db.collection('miembros').doc(decoded.uid).get();
    const datos = (miembro.exists && miembro.data()) || {};
    const r = await servicio.guardar({
      uid: decoded.uid, nombre: panel.limpiarTexto(datos.name || datos.displayName || decoded.name || '', 120), email: decoded.email,
      cursoId: cuerpo.cursoId, estrellas: cuerpo.estrellas, comentario: cuerpo.comentario
    });
    console.log('Reseña:', r.estrellas, 'estrellas ·', r.cursoId, '·', decoded.uid, r.actualizada ? '(actualizada)' : '');
    return res.json({ ok: true, ...r });
  }));

  app.get('/api/resenas/mias', conSesion('No se pudieron consultar tus reseñas', 'mias', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded) => {
    const [resenasMias, terminados] = await Promise.all([servicio.mias(decoded.uid), servicio.terminados(decoded.uid)]);
    return res.json({ ok: true, resenas: resenasMias, terminados });
  }));

  return { servicio };
}

function montarRutasAdminResenas(app, deps, a) {
  const servicio = resenas.crearServicio({ db: deps.db });
  app.get('/api/admin/resenas', a.conAdmin('No se pudieron leer las reseñas', 'resenas', async (req, res) => {
    return res.json({ ok: true, resenas: await servicio.todas({ limite: Number(req.query.limite) || 1000 }) });
  }));
}

module.exports = { montarRutasResenas, montarRutasAdminResenas };
