'use strict';

// ══ RUTAS: libros (lectura en la plataforma) y materiales (PDF) que se abren con membresía y retos ══
// server.js llama a montarRutasMateriales(app, deps) con lo que ya existe y con el contexto que devuelve
// montarRutasClub (leerContexto, leerEstadoRetos, limitar...). Los libros y el catálogo de PDF se cargan UNA vez al arrancar
// (services/libros.js y services/materiales.js). Cuántos retos superó la persona sale de retosUsuario/{uid}
// (misma función que usa /api/retos). Nada de aquí escribe en Firestore salvo los avisos de la campana.
// Materiales ligados a un curso y a una clase (services/materiales-curso.js): se abren cuando la persona terminó esa clase
// (miembros/{uid}/progresoCursos/{cursoId}.sesionesVistas, que escribe solo este servidor). Los PDF de Drive que carga el
// administrador (colección pdfs) también salen de aquí: el enlace se entrega solo a quien cumple la regla.

const fs = require('fs');
const { permitirSolicitud } = require('./rutas-club');
const libros = require('./libros');
const materiales = require('./materiales');
const porCurso = require('./materiales-curso');
const cert = require('./certificados');
const creditos = require('./creditos');

const LECTURAS_POR_MINUTO = 60;
const DESCARGAS_POR_MINUTO = 20;

function montarRutasMateriales(app, deps) {
  const { db, autenticarFirebase, autenticarAdmin, errorHttp, club, catalogoLibros, catalogoMateriales } = deps;
  // Importa (una sola vez por cuenta) el avance anterior de la persona antes de leer sus clases vistas. Nunca lanza.
  const importarAvanceAnterior = async uid => {
    try { if (typeof deps.importarLegado === 'function') await deps.importarLegado(uid); } catch (_) { /* se reintenta en la siguiente consulta */ }
  };
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
      // Lo que canjeó con créditos (services/creditos.js): se abre SOLO ese material, aunque no tenga membresía ni los retos
      estado.creditos = ctx.esAdmin ? new Set() : await creditos.leerDesbloqueos(db, decoded.uid).catch(() => new Set());
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

  // Título y número de clases de cada curso ligado a un material y, para quien tiene membresía, qué clases ya terminó.
  // Deja `cursos` y `vistas` en el estado (los usa materiales-curso.acceso). Solo lee los cursos que hacen falta.
  async function cargarCursosLigados(uid, estado, ids) {
    const lista = [...new Set(ids.filter(Boolean))].slice(0, 100);
    estado.cursos = new Map();
    estado.vistas = new Map();
    if (!lista.length) return estado;
    const conProgreso = Boolean(estado.membresia && !estado.esAdmin);
    if (conProgreso) await importarAvanceAnterior(uid);
    await Promise.all(lista.map(async id => {
      const snap = await db.collection('cursos').doc(id).get();
      const datos = snap.exists ? (snap.data() || {}) : null;
      estado.cursos.set(id, datos ? { titulo: cert.tituloDeCurso(datos), total: cert.leccionesDe(datos).length } : null);
      if (conProgreso && datos) {
        const progreso = await db.collection('miembros').doc(uid).collection('progresoCursos').doc(id).get();
        estado.vistas.set(id, new Set(cert.normalizarProgreso(progreso.exists ? progreso.data() : null).sesionesVistas));
      }
    }));
    return estado;
  }

  // PDF cargados por el administrador (colección pdfs): solo los que tienen título y un enlace de Drive válido
  async function leerPdfsDrive() {
    const snap = await db.collection('pdfs').get();
    const lista = [];
    for (const d of snap.docs) {
      const m = porCurso.normalizarPdfDrive(d.id, d.data());
      if (m) lista.push(m);
    }
    lista.sort((a, b) => (a.creado < b.creado ? 1 : a.creado > b.creado ? -1 : 0));
    return lista.slice(0, 300);
  }
  const idsDeCursos = lista => lista.map(m => m.cursoId).filter(Boolean);
  const bloqueado = (item, estado, que) => {
    if (item.acceso === 'curso' || item.fuente === 'drive') {
      const b = porCurso.bloqueo(item, estado);
      if (b) return Object.assign(errorHttp(403, b.mensaje), { codigo: b.codigo, extra: { requiere: item.requiereRetos || 0, superados: estado.superados, faltan: porCurso.acceso(item, estado).faltan } });
    }
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
  // Estado efectivo para UN material: si lo canjeó con créditos se abre como si cumpliera la regla; los demás siguen igual
  const paraMaterial = (estado, tipo, id) => creditos.estadoConCredito(estado, tipo, id, estado.creditos);
  const marcaCreditos = (resumen, estado, tipo, id) => (estado.creditos && estado.creditos.has(creditos.claveMaterial(tipo, id)) ? { ...resumen, porCreditos: true } : resumen);

  // ════════════════════════════════════════════════════════════
  // LIBROS
  // ════════════════════════════════════════════════════════════
  // GET /api/libros — lista SIN páginas. Aquí mismo se avisa de los libros ya ganados (por si se ganaron antes).
  app.get('/api/libros', conEstado('No se pudieron cargar los libros', 'libros', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    await libros.avisarLibros(db, decoded.uid, catalogoLibros.libros, estado);
    return res.json({
      ok: true, membresia: estado.membresia || estado.esAdmin, superados: estado.superados,
      libros: catalogoLibros.libros.map(l => marcaCreditos(libros.resumenLibro(l, paraMaterial(estado, 'libro', l.id)), estado, 'libro', l.id))
    });
  }));

  // GET /api/libros/:id — el libro completo solo si está desbloqueado
  app.get('/api/libros/:id', conEstado('No se pudo abrir el libro', 'libro', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const libro = (typeof req.params.id === 'string' && libros.ID_LIBRO.test(req.params.id))
      ? catalogoLibros.libros.find(l => l.id === req.params.id) : null;
    if (!libro) throw noExiste('Ese libro no existe');
    const completo = libros.libroCompleto(libro, paraMaterial(estado, 'libro', libro.id));
    if (!completo) return rechazar(res, bloqueado(libro, estado, 'Los libros'));
    return res.json({ ok: true, libro: completo });
  }));

  // ════════════════════════════════════════════════════════════
  // MATERIALES (PDF)
  // ════════════════════════════════════════════════════════════
  app.get('/api/materiales', conEstado('No se pudieron cargar los materiales', 'materiales', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    await cargarCursosLigados(decoded.uid, estado, idsDeCursos(catalogoMateriales.materiales));
    return res.json({
      ok: true, membresia: estado.membresia || estado.esAdmin, superados: estado.superados,
      materiales: catalogoMateriales.materiales.map(m => marcaCreditos(materiales.resumenMaterial(m, paraMaterial(estado, 'pdf', m.id)), estado, 'pdf', m.id))
    });
  }));

  // GET /api/materiales/:id/archivo — el PDF solo si se puede abrir. El navegador lo pide con fetch + Bearer y
  // lo muestra con una URL de blob. El archivo sale ÚNICAMENTE del catálogo validado.
  app.get('/api/materiales/:id/archivo', conEstado('No se pudo abrir el material', 'archivo', limites.descargas, DESCARGAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const material = materiales.buscarMaterial(catalogoMateriales.materiales, req.params.id);
    if (!material) throw noExiste('Ese material no existe');
    if (material.acceso === 'curso') await cargarCursosLigados(decoded.uid, estado, [material.cursoId]);
    if (!materiales.acceso(material, paraMaterial(estado, 'pdf', material.id)).desbloqueado) return rechazar(res, bloqueado(material, estado, 'Los materiales'));
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

  // ── PDF de Drive que carga el administrador (colección pdfs), con las mismas reglas por curso, clase y retos ──
  // GET /api/materiales/drive — la lista SIN el enlace. Quien no es miembro ve el catálogo con el candado "Solo miembros".
  app.get('/api/materiales/drive', conEstado('No se pudieron cargar los materiales', 'materiales-drive', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const lista = await leerPdfsDrive();
    await cargarCursosLigados(decoded.uid, estado, idsDeCursos(lista));
    return res.json({
      ok: true, membresia: estado.membresia || estado.esAdmin, superados: estado.superados,
      materiales: lista.map(m => (m.cursoId ? porCurso.resumenPdfDrive(m, estado) : marcaCreditos(porCurso.resumenPdfDrive(m, paraMaterial(estado, 'drive', m.id)), estado, 'drive', m.id)))
    });
  }));

  // GET /api/materiales/drive/:id/enlace — el enlace de Drive solo si la persona cumple la regla del material
  app.get('/api/materiales/drive/:id/enlace', conEstado('No se pudo abrir el material', 'enlace-drive', limites.descargas, DESCARGAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const id = typeof req.params.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(req.params.id) ? req.params.id : '';
    const snap = id ? await db.collection('pdfs').doc(id).get() : null;
    const material = snap && snap.exists ? porCurso.normalizarPdfDrive(id, snap.data()) : null;
    if (!material) throw noExiste('Ese material no existe');
    await cargarCursosLigados(decoded.uid, estado, [material.cursoId]);
    if (!porCurso.acceso(material, material.cursoId ? estado : paraMaterial(estado, 'drive', material.id)).desbloqueado) return rechazar(res, bloqueado(material, estado, 'Los materiales'));
    const enlaces = porCurso.enlacesDrive(material.driveId);
    if (!enlaces) throw noExiste('El archivo de este material no está disponible por ahora');
    return res.json({ ok: true, id: material.id, titulo: material.titulo, url: enlaces.ver, vista: enlaces.vista });
  }));

  // GET /api/materiales/cursos — los materiales ligados a un curso (de las dos fuentes), agrupados por curso, con su estado.
  // La pantalla del curso la usa para listar "Material de este curso" y decir qué falta para abrir cada uno.
  app.get('/api/materiales/cursos', conEstado('No se pudieron cargar los materiales de los cursos', 'materiales-cursos', limites.lecturas, LECTURAS_POR_MINUTO, async (req, res, decoded, estado) => {
    const catalogo = catalogoMateriales.materiales.filter(m => m.acceso === 'curso');
    const drive = (await leerPdfsDrive()).filter(m => m.cursoId);
    await cargarCursosLigados(decoded.uid, estado, [...idsDeCursos(catalogo), ...idsDeCursos(drive)]);
    const resumenes = [
      ...catalogo.map(m => ({ ...materiales.resumenMaterial(m, estado), fuente: 'catalogo' })),
      ...drive.map(m => porCurso.resumenPdfDrive(m, estado))
    ];
    return res.json({ ok: true, membresia: estado.membresia || estado.esAdmin, cursos: porCurso.agruparPorCurso(resumenes) });
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
    const drive = await leerPdfsDrive();
    const estado = await cargarCursosLigados('', { ...todoAbierto }, [...idsDeCursos(catalogoMateriales.materiales), ...idsDeCursos(drive)]);
    return res.json({
      ok: true,
      materiales: catalogoMateriales.materiales.map(m => ({ ...materiales.resumenMaterial(m, estado), kb: Math.max(1, Math.round(m.bytes / 1024)) })),
      // PDF de Drive cargados desde el panel: con su curso y clase, y si la liga es válida (el curso y la clase existen)
      drive: drive.map(m => {
        const info = m.cursoId ? estado.cursos.get(m.cursoId) : null;
        const ligaValida = !m.cursoId || Boolean(info && (!m.clase || m.clase <= info.total) && !m.configuracionInvalida);
        return { ...porCurso.resumenPdfDrive(m, estado), ligaValida };
      }),
      errores: catalogoMateriales.errores
    });
  }));

  return { limites };
}

module.exports = { montarRutasMateriales, LECTURAS_POR_MINUTO, DESCARGAS_POR_MINUTO };
