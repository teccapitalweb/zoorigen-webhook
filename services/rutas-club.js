'use strict';

// ══ RUTAS DEL CLUB: logros, premios, retos, referidos y directorio ══
// Pegamento entre Express/Firestore y las reglas puras de services/. server.js llama a
// montarRutasClub(app, deps) pasando lo que ya existe (autenticarFirebase, esAdminPorDocumentos,
// tienePlanVigente, obtenerIndiceVideos...).
//
// Seguridad: todas las colecciones que usa este archivo son SOLO DEL SERVIDOR (las reglas de
// Firestore niegan lo que no listan): retosUsuario, premiosUsuario, actividadUsuario, referidos,
// dispositivosAnfitrion, codigosReferido, directorio. El navegador solo pregunta; nunca decide.

const logros = require('./logros');
const retos = require('./retos');
const premios = require('./premios');
const referidos = require('./referidos');

// Límite de solicitudes por clave en una ventana (memoria del proceso; suficiente para frenar abusos).
function permitirSolicitud(mapa, clave, ventanaMs, maximo) {
  const ahora = Date.now();
  if (mapa.size > 5000) {
    for (const [k, v] of mapa) if (ahora >= v.hasta) mapa.delete(k);
  }
  const actual = mapa.get(clave);
  if (!actual || ahora >= actual.hasta) { mapa.set(clave, { cantidad: 1, hasta: ahora + ventanaMs }); return true; }
  actual.cantidad += 1;
  return actual.cantidad <= maximo;
}

function montarRutasClub(app, deps) {
  const {
    express, db, admin, autenticarFirebase, esAdminPorDocumentos, tienePlanVigente,
    obtenerIndiceVideos, leerEleccionPrueba, errorHttp
  } = deps;
  const FieldValue = admin.firestore.FieldValue;

  const limites = { lecturas: new Map(), retos: new Map(), premios: new Map() };
  const LECTURAS_POR_MINUTO = 60;
  const RETOS_POR_MINUTO = 60;       // contrato: 60 solicitudes por minuto por usuario
  const CANJES_POR_MINUTO = 10;

  const sinMembresia = mensaje => Object.assign(errorHttp(403, mensaje), { codigo: 'membresia-requerida' });

  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) {
      const cuerpo = { error: err.message };
      if (err.codigo) cuerpo.codigo = err.codigo;
      return res.status(err.status).json(cuerpo);
    }
    console.error(`[Club ${etiqueta || 'api'}]`, err);
    return res.status(500).json({ error: mensajeGenerico });
  }

  const limitar = (mapa, uid, maximo) => {
    if (!permitirSolicitud(mapa, uid, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

  // ── Contexto de la persona: ¿administrador?, ¿membresía vigente? (mismas reglas de siempre) ──
  async function leerContexto(uid) {
    const [adminDoc, miembroDoc, usuarioDoc] = await Promise.all([
      db.collection('admins').doc(uid).get(),
      db.collection('miembros').doc(uid).get(),
      db.collection('usuarios').doc(uid).get()
    ]);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    return {
      uid, esAdmin, tienePlan, membresia: esAdmin || tienePlan,
      miembro: miembroDoc.exists ? miembroDoc.data() : null,
      usuario: usuarioDoc.exists ? usuarioDoc.data() : null
    };
  }

  // ── Actividad: día activo (fecha de México, últimos 120) ──
  const DIAS_ACTIVIDAD = 120;
  async function registrarDiaActivo(uid, ahora = new Date()) {
    const ref = db.collection('actividadUsuario').doc(uid);
    const hoy = logros.fechaMexico(ahora);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const dias = snap.exists && Array.isArray(snap.data().dias) ? snap.data().dias.filter(d => typeof d === 'string') : [];
      if (dias.includes(hoy)) return dias;
      const nuevos = [...dias, hoy].sort().slice(-DIAS_ACTIVIDAD);
      tx.set(ref, { uid, dias: nuevos, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
      return nuevos;
    });
  }

  // ── Datos verificables para los logros ──
  // Los certificados y el foro los escribe el navegador (reglas de Firestore): son MENOS
  // confiables que los retos o los referidos. Por eso cada certificado solo cuenta si su curso
  // existe de verdad en `cursos`, un curso se cuenta una vez, y el XP tiene techo por tabla.
  async function datosParaLogros(ctx, dias, invitadosValidos) {
    const uid = ctx.uid;
    const indice = await obtenerIndiceVideos();
    const [certSnap, postsSnap, dirSnap] = await Promise.all([
      db.collection('certificados').where('memberUid', '==', uid).limit(200).get(),
      db.collection('foroPosts').where('authorUid', '==', uid).limit(200).get(),
      db.collection('directorio').doc(uid).get()
    ]);
    const cursosTerminados = new Set();
    const areas = new Set();
    for (const doc of certSnap.docs) {
      const cursoId = String((doc.data() || {}).courseId || '');
      const curso = cursoId && indice.datos ? indice.datos.get(cursoId) : null;
      if (!curso || cursosTerminados.has(cursoId)) continue;
      cursosTerminados.add(cursoId);
      if (curso.area) areas.add(curso.area);
    }
    let foroRespuestas = 0; let foroLikes = 0;
    for (const doc of postsSnap.docs) {
      const post = doc.data() || {};
      foroRespuestas += Math.min(50, Math.max(0, Number(post.repliesCount) || 0));
      const likes = Array.isArray(post.likes) ? post.likes : [];
      // Sin contar los me gusta que la propia persona se da, ni repetidos
      foroLikes += new Set(likes.filter(u => typeof u === 'string' && u !== uid)).size;
    }
    return {
      esVIP: ctx.membresia,
      completados: cursosTerminados.size,
      areas: areas.size,
      dias,
      tarjetaDir: dirSnap.exists,
      foroPosts: postsSnap.docs.length,
      foroRespuestas,
      foroLikes,
      invitadosValidos
    };
  }

  // ── Referidos: se completa en el bloque de referidos (por ahora, sin invitados) ──
  async function resumenReferidos(/* uid */) {
    return { validos: 0, xp: 0 };
  }

  // ── Premios guardados (colección premiosUsuario, solo servidor) ──
  async function leerPremiosGuardados(uid) {
    const snap = await db.collection('premiosUsuario').doc(uid).get();
    return premios.normalizarGuardado(snap.exists ? snap.data() : null);
  }

  // Un premio ganado no se pierde aunque el XP baje: solo se AGREGAN claves a `ganados`, y dentro de
  // una transacción para no pisar un canje simultáneo. También deja el XP total para la clasificación.
  async function guardarProgreso(uid, { claves, xpTotal, conRanking }) {
    const ref = db.collection('premiosUsuario').doc(uid);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const actual = snap.exists ? (snap.data() || {}) : {};
      const guardado = premios.normalizarGuardado(actual);
      const nuevas = claves.filter(c => !guardado.ganados.includes(c));
      const cambios = {};
      if (nuevas.length || !snap.exists) cambios.ganados = [...guardado.ganados, ...nuevas];
      if (!snap.exists) cambios.usados = [];
      if (conRanking && actual.xpTotal !== xpTotal) cambios.xpTotal = xpTotal;
      if (Object.keys(cambios).length) {
        tx.set(ref, { uid, ...cambios, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
      }
      return { ganados: cambios.ganados || guardado.ganados, usados: guardado.usados, nuevas };
    });
  }

  // ── Cálculo completo (nivel, XP, logros, premios) de una persona con membresía ──
  async function calcularResumen(ctx, { estadoRetos } = {}) {
    const uid = ctx.uid;
    const [dias, estado, referidosInfo] = await Promise.all([
      registrarDiaActivo(uid),
      estadoRetos ? Promise.resolve(estadoRetos) : leerEstadoRetos(uid),
      resumenReferidos(uid)
    ]);
    const datos = await datosParaLogros(ctx, dias, referidosInfo.validos);
    const ev = logros.evaluar(datos, estado, referidosInfo.xp);
    const claves = premios.clavesQueCumple({ nivelId: ev.nivel.id, invitadosValidos: referidosInfo.validos });
    const guardado = await guardarProgreso(uid, { claves, xpTotal: ev.xp.total, conRanking: !ctx.esAdmin });
    return { ev, estadoRetos: estado, guardado, referidos: referidosInfo };
  }

  async function leerEstadoRetos(uid) {
    const snap = await db.collection('retosUsuario').doc(uid).get();
    return retos.normalizarEstado(snap.exists ? snap.data() : null);
  }

  const NIVEL_VISTA_PREVIA = logros.infoNivel(0);

  // ════════════════════════════════════════════════════════════
  // GET /api/premios — nivel, XP, logros y premios
  // ════════════════════════════════════════════════════════════
  app.get('/api/premios', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);

      // Sin membresía: vista previa. No se calcula ni se escribe nada.
      if (!ctx.membresia) {
        const guardado = await leerPremiosGuardados(decoded.uid);
        const lista = premios.armarPremios({ ...guardado, membresia: false });
        return res.json({
          ok: true, membresia: false, nivel: NIVEL_VISTA_PREVIA,
          xp: { total: 0, logros: 0, retos: 0, referidos: 0 },
          racha: 0, diasActivos: 0, logros: logros.logrosVistaPrevia(), premios: lista, disponibles: 0
        });
      }

      const { ev, guardado } = await calcularResumen(ctx);
      const lista = premios.armarPremios({ ganados: guardado.ganados, usados: guardado.usados, membresia: ctx.tienePlan });
      return res.json({
        ok: true, membresia: true, nivel: ev.nivel, xp: ev.xp, racha: ev.racha, diasActivos: ev.diasActivos,
        logros: ev.logros, premios: lista, disponibles: lista.filter(p => p.disponible).length
      });
    } catch (error) {
      return responderError(res, error, 'No se pudieron cargar tus logros y premios', 'premios');
    }
  });

  // ════════════════════════════════════════════════════════════
  // RETOS
  // ════════════════════════════════════════════════════════════
  const CAMINO_VACIO = Object.freeze({ quiz: 0, detective: 0, orden: 0 });

  function vistaRetos(estado) {
    const hoy = logros.fechaMexico();
    return {
      superados: estado.superados,
      porReto: retos.resumenPorReto(estado),
      camino: estado.camino,
      retosHoy: estado.retosHoy.fecha === hoy ? estado.retosHoy.ids : [],
      totales: retos.TOTALES_CAMINO
    };
  }

  // GET /api/retos — progreso de la persona (y registra el día activo)
  app.get('/api/retos', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) {
        return res.json({
          ok: true, membresia: false, nivel: NIVEL_VISTA_PREVIA, xp: 0, superados: 0, porReto: {},
          camino: { ...CAMINO_VACIO }, retosHoy: [], totales: retos.TOTALES_CAMINO
        });
      }
      const { ev, estadoRetos } = await calcularResumen(ctx);
      return res.json({ ok: true, membresia: true, nivel: ev.nivel, xp: ev.xp.total, ...vistaRetos(estadoRetos) });
    } catch (error) {
      return responderError(res, error, 'No se pudieron cargar tus retos', 'retos');
    }
  });

  // Lee, aplica y guarda el estado de retos dentro de una transacción (dos solicitudes a la vez no se pisan)
  async function guardarRetos(uid, aplicar) {
    const ref = db.collection('retosUsuario').doc(uid);
    let salida;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const antes = retos.normalizarEstado(snap.exists ? snap.data() : null);
      const r = aplicar(antes);
      salida = { antes, ...r };
      if (r.guardar !== false) tx.set(ref, { ...r.estado, uid, actualizadoEn: FieldValue.serverTimestamp() });
    });
    return salida;
  }

  const resumenInsignias = lista => lista.map(i => ({ id: i.id, nombre: i.nombre }));

  // POST /api/retos/resultado — práctica diaria (XP una vez por reto por día)
  app.post('/api/retos/resultado', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.retos, decoded.uid, RETOS_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const datos = { retoId: cuerpo.retoId, puntaje: cuerpo.puntaje, total: cuerpo.total };
      const invalido = retos.validarResultado(datos);
      if (invalido) throw errorHttp(400, invalido);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('Los retos son parte de la membresía. Activa tu suscripción para resolverlos');

      const r = await guardarRetos(decoded.uid, antes => retos.aplicarResultado(antes, datos));
      const { ev } = await calcularResumen(ctx, { estadoRetos: r.estado });
      return res.json({
        ok: true, aprobado: r.aprobado, xpGanado: r.xpGanado, xp: ev.xp.total, nivel: ev.nivel,
        insigniasNuevas: resumenInsignias(retos.insigniasNuevas(r.antes, r.estado))
      });
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar el resultado del reto', 'retos');
    }
  });

  // POST /api/retos/camino — el servidor decide qué reto del camino está desbloqueado
  app.post('/api/retos/camino', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.retos, decoded.uid, RETOS_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const datos = { modo: cuerpo.modo, indice: cuerpo.indice, puntaje: cuerpo.puntaje, total: cuerpo.total };
      const invalido = retos.validarCaminoResultado(datos);
      if (invalido) throw errorHttp(400, invalido);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('Los retos son parte de la membresía. Activa tu suscripción para resolverlos');

      const r = await guardarRetos(decoded.uid, antes => {
        const o = retos.aplicarCaminoResultado(antes, datos);
        return { ...o, guardar: o.aceptado };
      });
      const salida = { ok: true, aceptado: r.aceptado, aprobado: r.aprobado, xpGanado: r.xpGanado, camino: r.estado.camino };
      if (r.aceptado) {
        const { ev } = await calcularResumen(ctx, { estadoRetos: r.estado });
        Object.assign(salida, { xp: ev.xp.total, nivel: ev.nivel, insigniasNuevas: resumenInsignias(retos.insigniasNuevas(r.antes, r.estado)) });
      }
      return res.json(salida);
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar tu avance en el camino', 'retos');
    }
  });

  // GET /api/retos/clasificacion — top 20 por XP total. Solo nombre público (primer nombre + inicial),
  // XP y nivel: nunca correo, teléfono ni membresía.
  app.get('/api/retos/clasificacion', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('La clasificación es parte de la membresía');

      const coleccion = db.collection('premiosUsuario');
      const top = await coleccion.where('xpTotal', '>', 0).orderBy('xpTotal', 'desc').limit(20).get();
      const perfiles = top.docs.length
        ? await db.getAll(...top.docs.map(d => db.collection('miembros').doc(d.id)))
        : [];
      let posicion = 0; let xpPrevio = null;
      const filas = top.docs.map((d, i) => {
        const xp = d.data().xpTotal;
        if (xp !== xpPrevio) { posicion = i + 1; xpPrevio = xp; }   // mismo XP = misma posición
        const perfil = perfiles[i] && perfiles[i].exists ? perfiles[i].data() : {};
        const nivel = logros.infoNivel(xp);
        return { posicion, nombre: referidos.aliasDeNombre(perfil.name || perfil.nombreCompleto), xp, nivel: { id: nivel.id, nombre: nivel.nombre } };
      });

      let yo = null;
      if (!ctx.esAdmin) {
        const mio = await coleccion.doc(decoded.uid).get();
        const xpMio = mio.exists ? mio.data().xpTotal : null;
        if (typeof xpMio === 'number' && xpMio > 0) {
          const mayores = (await coleccion.where('xpTotal', '>', xpMio).count().get()).data().count;
          yo = { posicion: mayores + 1, xp: xpMio };
        }
      }
      return res.json({ ok: true, top: filas, yo });
    } catch (error) {
      return responderError(res, error, 'No se pudo cargar la clasificación', 'retos');
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /api/premios/usar — canjea UN premio por UN curso adelantado
  // ════════════════════════════════════════════════════════════
  // El adelanto lo pinta el sitio (su calendario de 8 días): considera ABIERTOS los cursos que
  // estén en premiosUsuario/{uid}.usados[].cursoId. Aquí solo se decide si el canje es válido y
  // se registra, dentro de una transacción para que un doble clic o dos pestañas no gasten dos premios.
  app.post('/api/premios/usar', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      const uid = decoded.uid;
      limitar(limites.premios, uid, CANJES_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const cursoId = typeof cuerpo.cursoId === 'string' ? cuerpo.cursoId.trim() : '';
      if (!cursoId || cursoId.length > 200) throw errorHttp(400, 'Falta el curso que quieres abrir');

      const ctx = await leerContexto(uid);
      if (ctx.esAdmin) throw errorHttp(400, 'Las cuentas de administrador ya tienen todos los cursos abiertos');
      if (!ctx.tienePlan) throw sinMembresia('Necesitas una membresía activa para usar tu premio');

      // El curso debe existir de verdad en `cursos` (con un refresco limitado si no aparece)
      let curso = (await obtenerIndiceVideos()).datos.get(cursoId);
      if (!curso) {
        const fresco = await obtenerIndiceVideos({ forzar: true });
        if (!fresco.cargadoEn) throw errorHttp(503, 'No pudimos cargar los cursos. Intenta de nuevo en un momento');
        curso = fresco.datos.get(cursoId);
      }
      if (!curso) throw errorHttp(404, 'Ese curso no existe');
      if (curso.disponibleSiempre || curso.cursoMuestraGratis) throw errorHttp(409, 'Ese curso ya está abierto para todos');
      if ((await leerEleccionPrueba(uid)) === cursoId) throw errorHttp(409, 'Ese curso ya es tu prueba gratuita');

      // Pone al día los premios ganados (por nivel o por invitados) antes de buscar uno libre
      await calcularResumen(ctx);

      const ref = db.collection('premiosUsuario').doc(uid);
      const clave = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const guardado = premios.normalizarGuardado(snap.exists ? snap.data() : null);
        if (guardado.usados.some(u => u.cursoId === cursoId)) throw errorHttp(409, 'Ese curso ya fue adelantado con un premio');
        const libre = premios.premioLibre(guardado.ganados, guardado.usados);
        if (!libre) throw errorHttp(403, 'No tienes premios disponibles');
        tx.set(ref, {
          uid, ganados: guardado.ganados,
          usados: [...guardado.usados, { clave: libre, cursoId, fecha: new Date().toISOString() }],
          actualizadoEn: FieldValue.serverTimestamp()
        }, { merge: true });
        return libre;
      });
      return res.json({ ok: true, cursoId, clave });
    } catch (error) {
      return responderError(res, error, 'No se pudo usar el premio', 'premios');
    }
  });

  return { leerContexto, calcularResumen, leerEstadoRetos, limites, limitar, sinMembresia, responderError, FieldValue };
}

module.exports = { montarRutasClub, permitirSolicitud };
