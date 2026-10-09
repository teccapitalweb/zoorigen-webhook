'use strict';

// ══ RUTAS: libros (lectura en la plataforma) y materiales (PDF) que se abren con membresía y retos ══
// server.js llama a montarRutasMateriales(app, deps) con lo que ya existe y con el contexto que devuelve
// montarRutasClub (leerContexto, leerEstadoRetos, limitar...). Los libros y el catálogo de PDF se cargan UNA vez al arrancar
// (services/libros.js y services/materiales.js). Cuántos retos superó la persona sale de retosUsuario/{uid}
// (misma función que usa /api/retos). Nada de aquí escribe en Firestore salvo los avisos de la campana.

const fs = require('fs');
const { permitirSolicitud } = require('./rutas-club');
const libros = require('./libros');
const materiales = require('./materiales');

const LECTURAS_POR_MINUTO = 60;
const DESCARGAS_POR_MINUTO = 20;

function montarRutasMateriales(app, deps) {
  const { db, autenticarFirebase, autenticarAdmin, errorHttp, club, catalogoLibros, catalogoMateriales } = deps;
  const limites = { lecturas: new Map(), descargas: new Map(), admin: new Map() };

  const limitar = (mapa, clave, maximo) => {
    if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

  // Los mensajes de error de aquí son siempre en español y nunca llevan rutas del disco
  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) {
      const cuerpo = { error: err.message };
      if (err.codigo) cuerpo.codigo = err.codigo;
      return res.status(err.status).json(cuerpo);
    }
    console.error(`[Materiales ${etiqueta || 'api'}]`, err && err.message);
    return res.status(500).json({ error: mensajeGenerico });
  }

  // Envoltura común: sin caché, sesión, límite y contexto (administrador / membresía / retos superados)
  const conEstado = (mensajeGenerico, etiqueta, mapa, maximo, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(mapa, decoded.uid, maximo);
      const ctx = await club.leerContexto(decoded.uid);
      // Solo se leen los retos de quien puede usarlos (el administrador los tiene todos abiertos igual)
      const superados = ctx.membresia ? (await club.leerEstadoRetos(decoded.uid)).superados : 0;
      const estado = { superados, membresia: ctx.membresia, esAdmin: ctx.esAdmin };
      return await fn(req, res, decoded, estado);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };

  const conAdmin = (mensajeGenerico, etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitar(limites.admin, decoded.uid, LECTURAS_POR_MINUTO);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };

  const noExiste = mensaje => errorHttp(404, mensaje);
  const bloqueado = (item, estado, que) => {
    const sinMembresia = !(estado.membresia || estado.esAdmin);
    const faltan = libros.acceso({ requiereRetos: item.requiereRetos || 0 }, estado).faltan;
    return Object.assign(
      errorHttp(403, sinMembresia
        ? `${que} son parte de la membresía. Activa tu suscripción para abrirlos`
        : `Todavía está bloqueado: ${faltan === 1 ? 'te falta 1 reto' : 'te faltan ' + faltan + ' retos'} por superar`),
      { codigo: sinMembresia ? 'membresia-requerida' : 'retos-insuficientes', extra: { requiere: item.requiereRetos || 0, superados: estado.superados, faltan } }
    );
  };
  // responderError arma el cuerpo con { error, codigo }; aquí se le suman requiere / superados / faltan
  const rechazar = (res, err) => res.status(403).json({ error: err.message, codigo: err.codigo, ...err.extra });

  // ════════════════════════════════════════════════════════════
  // LIBROS
  // ════════════════════════════════════════════════════════════
  // GET /api/libros — lista SIN páginas. Aquí mismo se avisa de los libros ya ganados (por si se ganaron antes).
  app.get('/api/libros', conEstado('No se pudieron cargar los libros', 'libros', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    await libros.avisarLibros(db, decoded.uid, catalogoLibros.libros, estado);
    return res.json({
      ok: true, membresia: estado.membresia || estado.esAdmin, superados: estado.superados,
      libros: libros.resumenLibros(catalogoLibros.libros, estado)
    });
  }));

  // GET /api/libros/:id — el libro completo solo si está desbloqueado
  app.get('/api/libros/:id', conEstado('No se pudo abrir el libro', 'libro', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const libro = (typeof req.params.id === 'string' && libros.ID_LIBRO.test(req.params.id))
      ? catalogoLibros.libros.find(l => l.id === req.params.id) : null;
    if (!libro) throw noExiste('Ese libro no existe');
    const completo = libros.libroCompleto(libro, estado);
    if (!completo) return rechazar(res, bloqueado(libro, estado, 'Los libros'));
    return res.json({ ok: true, libro: completo });
  }));

  // ════════════════════════════════════════════════════════════
  // MATERIALES (PDF)
  // ════════════════════════════════════════════════════════════
  app.get('/api/materiales', conEstado('No se pudieron cargar los materiales', 'materiales', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    return res.json({
      ok: true, membresia: estado.membresia || estado.esAdmin, superados: estado.superados,
      materiales: materiales.resumenMateriales(catalogoMateriales.materiales, estado)
    });
  }));

  // GET /api/materiales/:id/archivo — el PDF solo si se puede abrir. El navegador lo pide con fetch + Bearer y
  // lo muestra con una URL de blob. El archivo sale ÚNICAMENTE del catálogo validado.
  app.get('/api/materiales/:id/archivo', conEstado('No se pudo abrir el material', 'archivo', limites.descargas, DESCARGAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const material = materiales.buscarMaterial(catalogoMateriales.materiales, req.params.id);
    if (!material) throw noExiste('Ese material no existe');
    if (!materiales.acceso(material, estado).desbloqueado) return rechazar(res, bloqueado(material, estado, 'Los materiales'));
    let contenido;
    try {
      contenido = await fs.promises.readFile(material.ruta);
    } catch (_) {
      throw noExiste('El archivo de este material no está disponible por ahora');
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${material.id}.pdf"`,
      'Content-Length': String(contenido.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(contenido);
  }));

  // ════════════════════════════════════════════════════════════
  // ADMINISTRADOR (solo lectura): qué se cargó y qué se descartó
  // ════════════════════════════════════════════════════════════
  const todoAbierto = { superados: 0, membresia: true, esAdmin: true };
  app.get('/api/admin/libros', conAdmin('No se pudo cargar el estado de los libros', 'admin-libros', async (req, res) => {
    return res.json({
      ok: true,
      libros: catalogoLibros.libros.map(l => ({ ...libros.resumenLibro(l, todoAbierto), actualizado: l.actualizado, fuentes: l.fuentes.length, prueba: l.prueba === true })),
      errores: catalogoLibros.errores
    });
  }));

  app.get('/api/admin/materiales', conAdmin('No se pudo cargar el estado de los materiales', 'admin-materiales', async (req, res) => {
    return res.json({
      ok: true,
      materiales: catalogoMateriales.materiales.map(m => ({ ...materiales.resumenMaterial(m, todoAbierto), kb: Math.max(1, Math.round(m.bytes / 1024)) })),
      errores: catalogoMateriales.errores
    });
  }));

  return { limites };
}

module.exports = { montarRutasMateriales, LECTURAS_POR_MINUTO, DESCARGAS_POR_MINUTO };
