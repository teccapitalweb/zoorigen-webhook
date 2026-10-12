'use strict';

// ══ RUTAS: progreso de cursos, quizzes y certificados firmados por el servidor ══
// server.js llama a montarRutasCertificados(app, deps) con lo que ya existe (autenticación, reglas de
// membresía y de clases gratis, índice de cursos) y con el contexto de montarRutasClub (`club`).
// Las reglas puras están en services/certificados.js.
//
// Seguridad:
//  - El progreso vive en miembros/{uid}/progresoCursos/{cursoId} y los certificados en certificados/{folio}.
//    Los escribe SOLO este servidor (Admin SDK). El uid sale siempre del token, nunca del cuerpo.
//  - Una clase solo se marca vista con las mismas reglas con que se abre su video (administrador, plan
//    vigente, o clase gratis / prueba gratuita), en orden y con su quiz contestado.
//  - El certificado se crea UNA sola vez, dentro de la misma transacción que completa el curso, con folio
//    determinista y firma HMAC-SHA256. Sin CERTIFICATE_SIGNING_KEY el servidor arranca igual, pero no
//    emite ni verifica certificados (503) y la última clase no se guarda, para reintentar después.
//  - La verificación pública solo muestra nombre, curso, área, horas, sesiones, instructor y fecha.

const express = require('express');
const { permitirSolicitud } = require('./rutas-club');
const avisos = require('./avisos');
const correo = require('./correo');
const referidos = require('./referidos');
const { texto } = require('./texto');
const cert = require('./certificados');

const LECTURAS_POR_MINUTO = 60;
const ESCRITURAS_POR_MINUTO = 60;
const ADMIN_POR_MINUTO = 30;
const CONSULTAS_PUBLICAS = 30;
const VENTANA_PUBLICA_MS = 10 * 60 * 1000;
const LIMITE_CUERPO = '20kb';
const MENSAJE_SIN_LLAVE = 'Los certificados aún no están configurados';

function montarRutasCertificados(app, deps) {
  const {
    db, admin, auth, autenticarFirebase, autenticarAdmin, esAdminPorDocumentos, tienePlanVigente,
    reglasPruebaParaVideo, videoEsGratis, obtenerIndiceVideos, errorHttp, club
  } = deps;
  const firmaClave = String(deps.firmaClave || '').trim();
  const corteLegado = String(deps.corteLegado || '').trim();
  const panelUrl = deps.panelUrl || correo.SITIO;
  const enviarCorreo = deps.enviarCorreoCertificado || correo.enviarCorreoCertificado;
  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;

  const limites = { lecturas: new Map(), escrituras: new Map(), admin: new Map(), publicas: new Map() };
  const MAXIMOS = { lecturas: LECTURAS_POR_MINUTO, escrituras: ESCRITURAS_POR_MINUTO, admin: ADMIN_POR_MINUTO };
  const analizadorJson = express.json({ limit: LIMITE_CUERPO });
  const pendientes = new Set(); // correos en segundo plano (las pruebas los esperan con esperar())

  const colCertificados = () => db.collection('certificados');
  const refProgreso = (uid, cursoId) => db.collection('miembros').doc(uid).collection('progresoCursos').doc(cursoId);
  const sinCertificados = () => errorHttp(503, MENSAJE_SIN_LLAVE);
  const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) {
      const cuerpo = { error: err.message };
      if (err.codigo) cuerpo.codigo = err.codigo;
      return res.status(err.status).json(cuerpo);
    }
    console.error(`[Certificados ${etiqueta || 'api'}]`, err && err.message);
    return res.status(500).json({ error: mensajeGenerico });
  }

  const limitar = (clase, clave) => {
    if (!permitirSolicitud(limites[clase], clave, 60 * 1000, MAXIMOS[clase])) {
      throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
    }
  };

  // Envoltura común de las rutas con sesión: sin caché, sesión de Firebase y límite por minuto.
  const conSesion = (clase, mensajeGenerico, etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(clase, decoded.uid);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };

  // El cuerpo JSON se lee DESPUÉS de saber quién es la persona.
  async function cuerpoJson(req, res) {
    try {
      await new Promise((resolver, rechazar) => analizadorJson(req, res, err => (err ? rechazar(err) : resolver())));
    } catch (err) {
      if (err && err.type === 'entity.too.large') throw errorHttp(413, 'Los datos enviados son demasiado grandes');
      throw errorHttp(400, 'Los datos enviados no son válidos');
    }
    return esObjeto(req.body) ? req.body : {};
  }

  function indiceDe(valor) {
    if (typeof valor === 'number') return Number.isInteger(valor) && valor >= 0 && valor < cert.MAX_LECCIONES ? valor : null;
    if (typeof valor === 'string' && /^[0-9]{1,4}$/.test(valor.trim())) {
      const n = Number(valor.trim());
      return n < cert.MAX_LECCIONES ? n : null;
    }
    return null;
  }

  const idCurso = valor => {
    const id = String(valor == null ? '' : valor);
    if (!cert.ID_CURSO_REGEX.test(id)) throw errorHttp(404, 'Curso no encontrado');
    return id;
  };

  async function leerCurso(cursoId) {
    const snap = await db.collection('cursos').doc(cursoId).get();
    if (!snap.exists) throw errorHttp(404, 'Curso no encontrado');
    return snap.data() || {};
  }

  // Misma regla que /api/bunny/embed-token: administrador, plan vigente, clase gratis o prueba gratuita.
  async function exigirAcceso(uid, leccion) {
    const [adminDoc, miembroDoc, usuarioDoc] = await Promise.all([
      db.collection('admins').doc(uid).get(),
      db.collection('miembros').doc(uid).get(),
      db.collection('usuarios').doc(uid).get()
    ]);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    const acceso = {
      esAdmin, tienePlan,
      miembro: miembroDoc.exists ? miembroDoc.data() : null,
      usuario: usuarioDoc.exists ? usuarioDoc.data() : null
    };
    if (esAdmin || tienePlan) return acceso;
    const videoId = typeof leccion.videoId === 'string' ? leccion.videoId.trim() : '';
    let gratis = false;
    if (videoId) {
      const prueba = await reglasPruebaParaVideo(uid, videoId, miembroDoc, usuarioDoc);
      gratis = prueba.permite || await videoEsGratis(videoId, { refrescar: true, incluirFija: !prueba.quitaClaseFija });
    }
    if (!gratis) throw errorHttp(403, 'Necesitas una membresía activa para completar esta clase');
    return acceso;
  }

  // ════════════════════════════════════════════════════════════
  // Importación ÚNICA del progreso viejo (miembros/{uid}.courseProgress, lo escribía el navegador)
  // ════════════════════════════════════════════════════════════
  // Solo si existe LEGACY_PROGRESS_IMPORT_BEFORE y la cuenta de Firebase Auth se creó antes de esa fecha.
  // Solo clases que existen en el curso. Nunca emite certificados. Nunca lanza: si algo falla se registra y
  // la consulta sigue (la importación se reintenta en la siguiente).
  async function importarLegadoSiCorresponde(uid) {
    try {
      const corte = cert.corteLegado(corteLegado);
      if (!Number.isFinite(corte)) return;
      const miembroRef = db.collection('miembros').doc(uid);
      const miembroSnap = await miembroRef.get();
      if (!miembroSnap.exists) return;
      const miembro = miembroSnap.data() || {};
      if (miembro.progresoLegadoImportado === true) return;
      const viejo = miembro.courseProgress;
      if (!esObjeto(viejo) || !Object.keys(viejo).length) return;

      let creacion = null;
      try {
        const info = await auth.getUser(uid);
        creacion = info && info.metadata && info.metadata.creationTime;
      } catch (_) { return; } // sin dato de la cuenta: no es elegible
      if (!cert.cuentaElegibleParaLegado(creacion, corte)) return;

      const ids = Object.keys(viejo).filter(id => cert.ID_CURSO_REGEX.test(id)).slice(0, cert.MAX_CURSOS_LEGADO);
      const cursoSnaps = await Promise.all(ids.map(id => db.collection('cursos').doc(id).get()));
      const cursos = new Map(cursoSnaps.map((s, i) => [ids[i], s.exists ? s.data() : null]));
      const [porMiembro, porUid] = await Promise.all([
        colCertificados().where('memberUid', '==', uid).limit(200).get(),
        colCertificados().where('uid', '==', uid).limit(200).get()
      ]);
      const certificados = new Map();
      for (const d of [...porMiembro.docs, ...porUid.docs]) certificados.set(d.id, { ...d.data(), id: d.id });
      const plan = cert.planearImportacionLegado({
        uid, courseProgress: viejo, cursos, certificados: [...certificados.values()], llave: firmaClave
      });

      await db.runTransaction(async tx => {
        const actual = await tx.get(miembroRef);
        if (!actual.exists || (actual.data() || {}).progresoLegadoImportado === true) return;
        const refs = plan.items.map(item => refProgreso(uid, item.cursoId));
        const existentes = await Promise.all(refs.map(ref => tx.get(ref)));
        plan.items.forEach((item, n) => {
          const previo = existentes[n].exists ? existentes[n].data() : null;
          const unido = cert.unirProgreso(previo, item.doc);
          const datos = {
            cursoId: item.cursoId, uid, sesionesVistas: unido.sesionesVistas, quizzesAprobados: unido.quizzesAprobados,
            origenLegado: true, actualizadoEn: FieldValue.serverTimestamp()
          };
          if (unido.completado) {
            datos.completado = true;
            datos.certificadoFolio = unido.certificadoFolio;
            const fecha = item.completadoEnIso ? new Date(item.completadoEnIso) : null;
            if (fecha && !Number.isNaN(fecha.getTime()) && !(previo && previo.completadoEn)) datos.completadoEn = Timestamp.fromDate(fecha);
          }
          tx.set(refs[n], datos, { merge: true });
        });
        tx.set(miembroRef, { progresoLegadoImportado: true, progresoLegadoImportadoEn: FieldValue.serverTimestamp() }, { merge: true });
      });
    } catch (error) {
      console.error('[Certificados legado] No se pudo importar el progreso anterior:', error && error.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // GET /api/cursos/progreso — avance de la persona en todos sus cursos
  // ════════════════════════════════════════════════════════════
  app.get('/api/cursos/progreso', conSesion('lecturas', 'No se pudo cargar tu progreso', 'progreso', async (req, res, decoded) => {
    const uid = decoded.uid;
    await importarLegadoSiCorresponde(uid);
    const [snap, miembroSnap] = await Promise.all([
      db.collection('miembros').doc(uid).collection('progresoCursos').get(),
      db.collection('miembros').doc(uid).get()
    ]);
    const cursos = {};
    for (const doc of snap.docs) {
      const p = cert.normalizarProgreso(doc.data());
      cursos[doc.id] = {
        sesionesVistas: p.sesionesVistas,
        quizzesAprobados: p.quizzesAprobados,
        completado: p.completado,
        certificadoFolio: p.certificadoFolio
      };
    }
    const miembro = miembroSnap.exists ? (miembroSnap.data() || {}) : {};
    return res.json({ cursos, legadoImportado: miembro.progresoLegadoImportado === true });
  }));

  // ════════════════════════════════════════════════════════════
  // POST /api/cursos/:cursoId/quiz — califica las preguntas de una clase (práctica)
  // ════════════════════════════════════════════════════════════
  // Equivocarse no frena: se muestra cuál era la correcta y basta con haberlo contestado para poder
  // completar la clase. El campo se llama quizzesAprobados por compatibilidad (significa "contestados").
  app.post('/api/cursos/:cursoId/quiz', conSesion('escrituras', 'No se pudo validar el quiz', 'quiz', async (req, res, decoded) => {
    const uid = decoded.uid;
    const cuerpo = await cuerpoJson(req, res);
    const indice = indiceDe(cuerpo.sessionIndex);
    if (indice === null) throw errorHttp(400, 'sessionIndex inválido');
    const cursoId = idCurso(req.params.cursoId);
    const curso = await leerCurso(cursoId);
    const leccion = cert.leccionDe(curso, indice);
    if (!leccion) throw errorHttp(404, 'Clase no encontrada');
    await exigirAcceso(uid, leccion);

    const preguntas = cert.preguntasDeLeccion(leccion);
    if (!preguntas.length) return res.json({ aprobado: true, correctas: 0, total: 0, detalle: [] });
    const resultado = cert.calificarQuiz(preguntas, cuerpo.respuestas);
    if (!resultado) throw errorHttp(400, 'Respuestas inválidas');

    const ref = refProgreso(uid, cursoId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const previo = cert.normalizarProgreso(snap.exists ? snap.data() : null);
      if (previo.quizzesAprobados.includes(indice)) return;
      tx.set(ref, {
        cursoId, uid,
        quizzesAprobados: [...previo.quizzesAprobados, indice].sort((a, b) => a - b),
        actualizadoEn: FieldValue.serverTimestamp()
      }, { merge: true });
    });
    return res.json(resultado);
  }));

  // ════════════════════════════════════════════════════════════
  // POST /api/cursos/:cursoId/progreso — marca una clase como vista (y emite el certificado al terminar)
  // ════════════════════════════════════════════════════════════
  async function avisarCertificado(uid, c) {
    await avisos.crearAviso(db, uid, {
      id: 'cert_' + c.folio, tipo: 'certificado', titulo: '¡Certificado listo!',
      texto: `Completaste «${c.curso}». Ya puedes descargarlo en Mis certificados.`, enlace: 'certificados'
    });
  }

  // Correo con el PDF adjunto: en segundo plano, sin bloquear la respuesta; los errores solo se registran.
  function correoEnSegundoPlano(destino, c) {
    if (!destino) return;
    const tarea = Promise.resolve()
      .then(() => enviarCorreo({
        para: destino, nombre: c.nombre, curso: c.curso, horas: c.horas, sesiones: c.sesiones,
        area: c.area, emitido: c.emitido, folio: c.folio, panelUrl
      }))
      .catch(err => console.warn('[Certificados] Correo del certificado:', err && err.message))
      .finally(() => pendientes.delete(tarea));
    pendientes.add(tarea);
  }

  // XP del curso terminado con la misma lógica de siempre (services/logros.js vía calcularResumen).
  // Solo para quien tiene membresía y no es administrador; nunca lanza.
  async function bonoDelCurso(uid, cursoId, acceso) {
    try {
      if (acceso.esAdmin || !acceso.tienePlan) return null;
      const indice = await obtenerIndiceVideos();
      if (!(indice.datos && indice.datos.has(cursoId))) await obtenerIndiceVideos({ forzar: true });
      const ctx = await club.leerContexto(uid);
      const { ev } = await club.calcularResumen(ctx);
      const item = ev.cursos.lista.find(c => c.courseId === cursoId);
      return item ? { xp: item.xp, ordinal: item.n } : null;
    } catch (error) {
      console.warn('[Certificados] No se pudo calcular el XP del curso:', error && error.message);
      return null;
    }
  }

  app.post('/api/cursos/:cursoId/progreso', conSesion('escrituras', 'No se pudo guardar tu progreso', 'progreso', async (req, res, decoded) => {
    const uid = decoded.uid;
    const cuerpo = await cuerpoJson(req, res);
    const indice = indiceDe(cuerpo.sessionIndex);
    if (indice === null) throw errorHttp(400, 'sessionIndex inválido');
    const cursoId = idCurso(req.params.cursoId);
    const curso = await leerCurso(cursoId);
    const leccion = cert.leccionDe(curso, indice);
    if (!leccion) throw errorHttp(404, 'Clase no encontrada');
    const acceso = await exigirAcceso(uid, leccion);

    const total = cert.leccionesDe(curso).length;
    const exigeQuiz = cert.preguntasDeLeccion(leccion).length > 0;
    const nombre = cert.nombreParaCertificado({ miembro: acceso.miembro, usuario: acceso.usuario, token: decoded });
    const email = cert.correoDeMiembro({ miembro: acceso.miembro, usuario: acceso.usuario, token: decoded });
    const ahora = new Date();
    const ref = refProgreso(uid, cursoId);

    const salida = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const previo = cert.normalizarProgreso(snap.exists ? snap.data() : null);
      const avance = cert.evaluarAvance({ previo, indice, totalLecciones: total, exigeQuiz });
      if (!avance.ok) throw errorHttp(avance.status, avance.error);

      const datos = {
        cursoId, uid, sesionesVistas: avance.sesionesVistas, completado: avance.completado,
        actualizadoEn: FieldValue.serverTimestamp()
      };
      if (!avance.completado) {
        if (avance.cambia) tx.set(ref, datos, { merge: true });
        return { sesionesVistas: avance.sesionesVistas, completado: false, certificado: null, nuevo: false };
      }

      // Curso completo: hace falta la llave ANTES de guardar nada (así la última clase no se pierde)
      if (!firmaClave) throw sinCertificados();
      const folioNuevo = cert.folioCertificado(uid, cursoId, ahora);
      const [delProgreso, delFolio, delaPersona] = await Promise.all([
        /^[A-Za-z0-9_-]{1,64}$/.test(previo.certificadoFolio || '') && previo.certificadoFolio !== folioNuevo ? tx.get(colCertificados().doc(previo.certificadoFolio)) : null,
        tx.get(colCertificados().doc(folioNuevo)),
        tx.get(colCertificados().where('uid', '==', uid))
      ]);
      const candidatos = [];
      for (const d of [delProgreso, delFolio, ...delaPersona.docs]) {
        if (d && d.exists) {
          const c = d.data();
          if (c && String(c.folio) === d.id) candidatos.push(c);
        }
      }
      let existente = cert.certificadoValidoDeCurso(candidatos, uid, cursoId, firmaClave);
      let nuevo = false;
      if (!existente) {
        if (delFolio.exists) throw errorHttp(409, 'El folio existente requiere auditoría antes de continuar');
        existente = cert.construirCertificado({ uid, cursoId, curso, nombre, email, emitido: ahora, llave: firmaClave });
        tx.set(colCertificados().doc(existente.folio), { ...existente, createdAt: Timestamp.fromDate(ahora) });
        nuevo = true;
      }
      datos.certificadoFolio = existente.folio;
      if (!previo.completado) datos.completadoEn = Timestamp.fromDate(ahora);
      if (avance.cambia || !previo.completado || previo.certificadoFolio !== existente.folio) tx.set(ref, datos, { merge: true });
      return {
        sesionesVistas: avance.sesionesVistas, completado: true, certificado: cert.certificadoPublico(existente), nuevo,
        destino: email
      };
    });

    const respuesta = { ok: true, sesionesVistas: salida.sesionesVistas, completado: salida.completado, certificado: salida.certificado };
    if (salida.nuevo) {
      console.log('[Certificados] Curso completado:', cursoId, '· certificado', salida.certificado.folio, '· nuevo');
      await avisarCertificado(uid, salida.certificado);
      correoEnSegundoPlano(salida.destino, salida.certificado);
      const bono = await bonoDelCurso(uid, cursoId, acceso);
      if (bono) respuesta.bono = bono;
    }
    return res.json(respuesta);
  }));

  // ════════════════════════════════════════════════════════════
  // GET /api/certificados/:folio — verificación PÚBLICA (sin sesión)
  // ════════════════════════════════════════════════════════════
  app.get('/api/certificados/:folio', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const ip = referidos.ipDeSolicitud(req.headers, req.ip) || 'desconocida';
      if (!permitirSolicitud(limites.publicas, ip, VENTANA_PUBLICA_MS, CONSULTAS_PUBLICAS)) {
        throw errorHttp(429, 'Demasiadas verificaciones; intenta más tarde');
      }
      const folio = cert.normalizarFolio(req.params.folio);
      if (!folio) throw errorHttp(400, 'Folio inválido');
      if (!firmaClave) throw errorHttp(503, 'La verificación de certificados aún no está configurada');
      const snap = await colCertificados().doc(folio).get();
      const datos = snap.exists ? snap.data() : null;
      // Solo cuentan los firmados por el servidor y cuyo folio coincide con su documento
      if (!datos || String(datos.folio) !== folio || !cert.certificadoValido(datos, firmaClave)) {
        throw errorHttp(404, 'Certificado no encontrado');
      }
      return res.json({ valido: true, certificado: cert.certificadoPublico(datos) });
    } catch (error) {
      return responderError(res, error, 'No se pudo verificar el certificado', 'verificar');
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /api/admin/certificados — el administrador emite (o recupera) un certificado
  // ════════════════════════════════════════════════════════════
  app.post('/api/admin/certificados', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitar('admin', decoded.uid);
      const cuerpo = await cuerpoJson(req, res);
      const uid = typeof cuerpo.uid === 'string' ? cuerpo.uid.trim() : '';
      const cursoId = typeof cuerpo.cursoId === 'string' ? cuerpo.cursoId.trim() : '';
      if (!cert.UID_REGEX.test(uid)) throw errorHttp(400, 'uid inválido');
      if (!cert.ID_CURSO_REGEX.test(cursoId)) throw errorHttp(400, 'cursoId inválido');
      if (!firmaClave) throw sinCertificados();

      const [miembroSnap, usuarioSnap, cursoSnap] = await Promise.all([
        db.collection('miembros').doc(uid).get(),
        db.collection('usuarios').doc(uid).get(),
        db.collection('cursos').doc(cursoId).get()
      ]);
      const miembro = miembroSnap.exists ? miembroSnap.data() : null;
      const usuario = usuarioSnap.exists ? usuarioSnap.data() : null;
      if (!miembro && !usuario) throw errorHttp(404, 'Miembro no encontrado');
      if (!cursoSnap.exists) throw errorHttp(404, 'Curso no encontrado');
      const curso = cursoSnap.data() || {};

      // El folio incluye el año: sin esta búsqueda, reemitir en otro año crearía un segundo certificado
      const previos = await colCertificados().where('uid', '==', uid).get();
      const propios = previos.docs.filter(d => d.data() && String(d.data().folio) === d.id).map(d => d.data());
      const previo = cert.certificadoValidoDeCurso(propios, uid, cursoId, firmaClave);
      if (previo) return res.json({ ok: true, certificado: cert.certificadoPublico(previo) });

      const ahora = new Date();
      const horas = Number(cuerpo.horas);
      const sesiones = Number(cuerpo.sesiones);
      const nuevo = cert.construirCertificado({
        uid, cursoId, curso, origen: 'admin', emitido: ahora, llave: firmaClave,
        nombre: texto(cuerpo.nombre, 80) || cert.nombreParaCertificado({ miembro, usuario }),
        email: cert.correoDeMiembro({ miembro, usuario }),
        horas: Number.isFinite(horas) && horas > 0 ? horas : undefined,
        sesiones: Number.isInteger(sesiones) && sesiones > 0 ? Math.min(sesiones, cert.MAX_LECCIONES) : undefined
      });
      const ref = colCertificados().doc(nuevo.folio);
      const final = await db.runTransaction(async tx => {
        const actual = await tx.get(ref);
        if (actual.exists) {
          const datos = actual.data() || {};
          if (!cert.certificadoValido(datos, firmaClave) || String(datos.uid) !== uid || String(datos.cursoId) !== cursoId) {
            throw errorHttp(409, 'El folio existente requiere auditoría antes de continuar');
          }
          return datos;
        }
        tx.set(ref, { ...nuevo, createdAt: Timestamp.fromDate(ahora) });
        return nuevo;
      });
      return res.json({ ok: true, certificado: cert.certificadoPublico(final) });
    } catch (error) {
      return responderError(res, error, 'No se pudo emitir el certificado', 'admin');
    }
  });

  return {
    limites,
    esperar: () => Promise.allSettled([...pendientes]),
    firmaConfigurada: Boolean(firmaClave)
  };
}

module.exports = {
  montarRutasCertificados, LECTURAS_POR_MINUTO, ESCRITURAS_POR_MINUTO, CONSULTAS_PUBLICAS, VENTANA_PUBLICA_MS, MENSAJE_SIN_LLAVE
};
