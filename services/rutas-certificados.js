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
//  - Certificados anteriores (escritos por el navegador, sin firma): si pasan certificadoAnteriorAceptable se verifican
//    en público (anterior: true), se firman EN SU LUGAR (mismo folio) cuando su titular consulta el progreso y, al
//    completar el curso, se reutilizan en vez de emitir otro folio. Ver CERTIFICADOS_ANTERIORES_HASTA en el README.

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
  // CERTIFICADOS_ANTERIORES_HASTA (ISO): los certificados anteriores sin firma solo se aceptan si se emitieron hasta
  // esa fecha. Sin definir = modo transición (sin límite). Definida pero inválida: no se acepta ningún anterior.
  const limiteTexto = String(deps.limiteAnteriores || '').trim().replace(/^["']|["']$/g, '').trim();
  const limiteAnteriores = cert.limiteEnMs(limiteTexto);
  if (Number.isNaN(limiteAnteriores)) {
    console.warn('[Certificados] CERTIFICADOS_ANTERIORES_HASTA no es una fecha válida: no se aceptará ningún certificado anterior sin firma');
  }
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
  // Solo clases que existen en el curso. Nunca emite certificados. NO borra ni cambia miembros/{uid}.courseProgress:
  // el dato viejo queda intacto como respaldo y lo que se guarda en progresoCursos es siempre una UNIÓN.
  // Núcleo de la importación. Devuelve { estado, ... } y LANZA si algo falla (el llamador decide qué hacer):
  //   estado: 'importado' | 'ya-importado' | 'sin-progreso' | 'no-elegible' | 'sin-miembro'
  // Opciones (solo las usa el administrador desde el panel, nunca el navegador del miembro):
  //   aceptarCuentaPosterior: no exige que la cuenta sea anterior a la fecha de corte
  //   reintentar: vuelve a unir el avance viejo aunque ya se haya importado (nunca quita nada: es una unión)
  async function importarLegado(uid, { aceptarCuentaPosterior = false, reintentar = false } = {}) {
    const corte = cert.corteLegado(corteLegado);
    const miembroRef = db.collection('miembros').doc(uid);
    const miembroSnap = await miembroRef.get();
    if (!miembroSnap.exists) return { estado: 'sin-miembro' };
    const miembro = miembroSnap.data() || {};
    const yaImportado = miembro.progresoLegadoImportado === true;
    if (yaImportado && !reintentar) return { estado: 'ya-importado' };
    const viejo = miembro.courseProgress;
    if (!esObjeto(viejo) || !Object.keys(viejo).length) return { estado: 'sin-progreso' };

    if (!aceptarCuentaPosterior) {
      if (!Number.isFinite(corte)) return { estado: 'no-elegible', motivo: 'sin-corte' };
      let creacion = null;
      try {
        const info = await auth.getUser(uid);
        creacion = info && info.metadata && info.metadata.creationTime;
      } catch (_) { return { estado: 'no-elegible', motivo: 'sin-fecha-cuenta' }; } // sin dato de la cuenta: no es elegible
      if (!cert.cuentaElegibleParaLegado(creacion, corte)) return { estado: 'no-elegible', motivo: 'cuenta-posterior' };
    }

    const ids = cert.clavesDeCursoLegado(viejo);
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

    const hecho = await db.runTransaction(async tx => {
      const actual = await tx.get(miembroRef);
      if (!actual.exists) return false;
      // Otra consulta simultánea ya lo importó: no se repite (salvo reintento explícito, que es una unión inofensiva)
      if ((actual.data() || {}).progresoLegadoImportado === true && !reintentar) return false;
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
      if ((actual.data() || {}).progresoLegadoImportado !== true) {
        tx.set(miembroRef, { progresoLegadoImportado: true, progresoLegadoImportadoEn: FieldValue.serverTimestamp() }, { merge: true });
      }
      return true;
    });
    if (!hecho) return { estado: 'ya-importado' };
    return { estado: 'importado', cursosImportados: plan.items.length, clasesImportadas: plan.importadas, reintento: yaImportado };
  }

  // Versión automática: la usan las consultas del miembro. Nunca lanza: si algo falla se registra y la consulta sigue
  // (la importación se reintenta en la siguiente).
  async function importarLegadoSiCorresponde(uid) {
    try {
      await importarLegado(uid);
    } catch (error) {
      console.error('[Certificados legado] No se pudo importar el progreso anterior:', error && error.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // Certificados anteriores (escritos por el navegador) de la persona: firma en su lugar y progreso coherente
  // ════════════════════════════════════════════════════════════
  const MAX_CERTIFICADOS_POR_CONSULTA = 50;

  async function certificadosDelTitular(uid) {
    const [porUid, porMiembro] = await Promise.all([
      colCertificados().where('uid', '==', uid).limit(MAX_CERTIFICADOS_POR_CONSULTA).get(),
      colCertificados().where('memberUid', '==', uid).limit(MAX_CERTIFICADOS_POR_CONSULTA).get()
    ]);
    const unicos = new Map();
    for (const d of [...porUid.docs, ...porMiembro.docs]) if (!unicos.has(d.id)) unicos.set(d.id, { id: d.id, data: d.data() || {} });
    return [...unicos.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, MAX_CERTIFICADOS_POR_CONSULTA);
  }

  // Firma en su lugar (mismo folio, mismo documento) un anterior aceptable. Nunca cambia ni borra campos viejos.
  // Devuelve true si lo firmó. Una transacción por documento: si alguien lo firmó o lo cambió en el intertanto, no hace nada.
  async function firmarAnteriorEnSuLugar(fila, contexto) {
    const ref = colCertificados().doc(fila.id);
    return db.runTransaction(async tx => {
      const actual = await tx.get(ref);
      if (!actual.exists) return false;
      const datos = actual.data() || {};
      if (cert.certificadoValido(datos, firmaClave)) return false;
      const [reevaluada] = cert.evaluarCertificados([{ id: fila.id, data: datos }], contexto);
      if (!reevaluada || reevaluada.estado !== 'aceptable') return false;
      const r = cert.parcheAnteriorAutomatico(fila.id, datos, firmaClave);
      if (!r.ok) return false;
      tx.set(ref, { ...r.parche, validadoEn: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
  }

  // Con los certificados vigentes de la persona (firmados o anteriores aceptables):
  //  1) firma en su lugar los anteriores aceptables, también los duplicados (solo con CERTIFICATE_SIGNING_KEY);
  //  2) devuelve, por curso, la vista de progreso completada con UN certificado canónico (el que ya guarda el progreso,
  //     si no el firmado y, si no, el más antiguo) y la guarda de forma idempotente.
  // Todo el paso está protegido: nunca lanza ni rompe la respuesta del progreso (solo registra una advertencia).
  async function sincronizarCertificadosAnteriores(uid, { miembroExiste, progresos }) {
    const vistas = new Map();
    try {
      const docs = await certificadosDelTitular(uid);
      if (!docs.length) return vistas;
      const cursoIds = [...new Set(docs.map(d => String(d.data.cursoId || d.data.courseId || '')).filter(id => cert.ID_CURSO_REGEX.test(id)))];
      const cursoSnaps = await Promise.all(cursoIds.map(id => db.collection('cursos').doc(id).get()));
      const cursos = new Map(cursoSnaps.map((s, i) => [cursoIds[i], s.exists ? (s.data() || {}) : null]));
      let existeMiembro = miembroExiste;
      if (!existeMiembro) existeMiembro = (await db.collection('usuarios').doc(uid).get()).exists;

      const contexto = {
        llave: firmaClave, ahora: new Date(), limite: limiteAnteriores,
        cursoExiste: id => Boolean(cursos.get(id)),
        miembroExiste: id => id === uid && existeMiembro
      };
      const filas = cert.evaluarCertificados(docs, contexto)
        .filter(f => f.uid === uid && f.estado !== 'no-aceptable' && cert.ID_CURSO_REGEX.test(f.cursoId));
      if (!filas.length) return vistas;

      if (firmaClave) {
        for (const fila of filas) {
          if (fila.estado !== 'aceptable') continue;
          try {
            await firmarAnteriorEnSuLugar(fila, contexto);
          } catch (error) {
            console.warn('[Certificados] No se pudo firmar un certificado anterior:', fila.id, error && error.message);
          }
        }
      }

      const plan = cert.planearProgresoDesdeCertificados({ uid, vigentes: filas, progresos, cursos });
      for (const item of plan) {
        vistas.set(item.cursoId, item.vista);
        if (!item.escribir) continue;
        try {
          const datos = { ...item.doc, actualizadoEn: FieldValue.serverTimestamp() };
          const fecha = item.doc.completadoEnIso ? new Date(item.doc.completadoEnIso) : null;
          delete datos.completadoEnIso;
          if (fecha && !Number.isNaN(fecha.getTime())) datos.completadoEn = Timestamp.fromDate(fecha);
          await refProgreso(uid, item.cursoId).set(datos, { merge: true });
        } catch (error) {
          console.warn('[Certificados] No se pudo guardar el progreso de un certificado anterior:', item.cursoId, error && error.message);
        }
      }
    } catch (error) {
      console.warn('[Certificados] No se pudieron revisar los certificados anteriores:', error && error.message);
    }
    return vistas;
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
    // Certificados vigentes (firmados o anteriores aceptables): firma los anteriores y deja el progreso coherente
    const desdeCertificados = await sincronizarCertificadosAnteriores(uid, {
      miembroExiste: miembroSnap.exists,
      progresos: new Map(snap.docs.map(d => [d.id, d.data() || {}]))
    });
    // completadoEn: cuándo terminó el curso (la del progreso o, si no la trae, la emisión de su certificado)
    const fechas = new Map();
    const sinFecha = [];
    for (const doc of snap.docs) {
      const datos = doc.data() || {};
      const p = cert.normalizarProgreso(datos);
      if (!p.completado) continue;
      const iso = cert.fechaIso(datos.completadoEn);
      if (iso) fechas.set(doc.id, iso);
      else if (p.certificadoFolio && /^[A-Za-z0-9_-]{1,64}$/.test(p.certificadoFolio)) sinFecha.push({ id: doc.id, folio: p.certificadoFolio });
    }
    if (sinFecha.length) {
      const certs = await Promise.all(sinFecha.map(x => colCertificados().doc(x.folio).get()));
      certs.forEach((c, i) => {
        const d = c.exists ? (c.data() || {}) : null;
        const iso = d ? cert.fechaIso(d.emitido || d.issuedAt) : '';
        if (iso) fechas.set(sinFecha[i].id, iso);
      });
    }
    const cursos = {};
    for (const doc of snap.docs) {
      const p = cert.normalizarProgreso(doc.data());
      cursos[doc.id] = {
        sesionesVistas: p.sesionesVistas,
        quizzesAprobados: p.quizzesAprobados,
        completado: p.completado,
        certificadoFolio: p.certificadoFolio,
        completadoEn: p.completado ? (fechas.get(doc.id) || null) : null
      };
    }
    for (const [cursoId, vista] of desdeCertificados) cursos[cursoId] = vista;
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
    // Si la persona llega aquí sin haber pedido antes su progreso, primero se trae el avance anterior (así no se le pide
    // repetir clases que ya había terminado). Si ya se importó, es una sola lectura.
    await importarLegadoSiCorresponde(uid);

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
      const [delProgreso, delFolio, porUid, porMiembro] = await Promise.all([
        /^[A-Za-z0-9_-]{1,64}$/.test(previo.certificadoFolio || '') && previo.certificadoFolio !== folioNuevo ? tx.get(colCertificados().doc(previo.certificadoFolio)) : null,
        tx.get(colCertificados().doc(folioNuevo)),
        tx.get(colCertificados().where('uid', '==', uid)),
        // los que escribía el navegador usan memberUid
        tx.get(colCertificados().where('memberUid', '==', uid).limit(200))
      ]);
      const docs = [];
      const vistos = new Set();
      for (const d of [delProgreso, delFolio, ...porUid.docs, ...porMiembro.docs]) {
        if (d && d.exists && !vistos.has(d.id)) {
          vistos.add(d.id);
          docs.push({ id: d.id, data: d.data() || {} });
        }
      }
      // Los de esta persona y este curso: firmados, anteriores aceptables (se firman en su lugar) y no aceptables
      const filas = cert.evaluarCertificados(docs, {
        llave: firmaClave, ahora, limite: limiteAnteriores,
        cursoExiste: id => id === cursoId,
        miembroExiste: id => id === uid && Boolean(acceso.miembro || acceso.usuario)
      }).filter(f => f.uid === uid && f.cursoId === cursoId);
      // Canónico: el que ya guarda el progreso (si sigue vigente), si no el firmado y, si no, el aceptable más antiguo.
      // Los demás duplicados aceptables no bloquean nada.
      const vigentes = filas.filter(f => f.estado !== 'no-aceptable').sort(cert.compararVigentes);
      const guardado = vigentes.find(f => f.id === previo.certificadoFolio) || null;
      const canonico = guardado || vigentes[0] || null;
      const elegir = estado => (canonico && canonico.estado === estado ? canonico : null);

      let existente = null;
      const firmado = elegir('firmado');
      if (firmado) existente = firmado.data;
      let nuevo = false;
      let fechaCompletado = ahora;
      if (!existente) {
        const anterior = elegir('aceptable');
        if (anterior) {
          // Certificado anterior (escrito por el navegador): se conserva su folio; no se crea otro ni se avisa de nuevo
          const r = cert.parcheAnteriorAutomatico(anterior.id, anterior.data, firmaClave);
          if (!r.ok) throw errorHttp(409, 'El folio existente requiere auditoría antes de continuar');
          tx.set(colCertificados().doc(anterior.id), { ...r.parche, validadoEn: FieldValue.serverTimestamp() }, { merge: true });
          existente = { ...anterior.data, ...r.parche };
          const emision = new Date(anterior.emitido);
          if (!Number.isNaN(emision.getTime())) fechaCompletado = emision;
        } else {
          // Hay un documento de esta persona y curso (o en el folio nuevo) que no es válido ni aceptable
          if (delFolio.exists || filas.length) throw errorHttp(409, 'El folio existente requiere auditoría antes de continuar');
          existente = cert.construirCertificado({ uid, cursoId, curso, nombre, email, emitido: ahora, llave: firmaClave });
          // Si la persona ya confirmó su nombre en su primer certificado, este sale con el nombre de su perfil de ese momento
          // y queda fijo: cambiar el perfil después no modifica certificados ya emitidos.
          const fijo = Boolean(acceso.miembro && acceso.miembro.nombreCertificadoConfirmadoEn);
          tx.set(colCertificados().doc(existente.folio), {
            ...existente, createdAt: Timestamp.fromDate(ahora),
            ...(fijo ? { nombreConfirmado: true, nombreConfirmadoEn: FieldValue.serverTimestamp() } : {})
          });
          nuevo = true;
        }
      }
      datos.certificadoFolio = existente.folio;
      if (!previo.completado) datos.completadoEn = Timestamp.fromDate(fechaCompletado);
      if (avance.cambia || !previo.completado || previo.certificadoFolio !== existente.folio) tx.set(ref, datos, { merge: true });
      return {
        sesionesVistas: avance.sesionesVistas, completado: true, certificado: cert.certificadoPublico(existente), nuevo,
        destino: email
      };
    });

    const respuesta = { ok: true, sesionesVistas: salida.sesionesVistas, completado: salida.completado, certificado: salida.certificado };
    if (salida.nuevo && salida.certificado) {
      // Primer certificado de la cuenta sin nombre confirmado: el sitio pregunta "¿es este el nombre que quieres?" y
      // responde en POST /api/certificados/nombre. Solo al emitirse (repetir la última clase no lo vuelve a pedir; el
      // sitio también lo revisa al abrir "Mis certificados"). Nunca bloquea la respuesta si algo falla.
      try {
        const plan = await planNombre(uid, acceso.miembro);
        if (plan.preguntar && plan.folios.includes(salida.certificado.folio)) respuesta.confirmarNombre = true;
      } catch (error) {
        console.warn('[Certificados] No se pudo revisar la confirmación del nombre:', error && error.message);
      }
    }
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
  // POST /api/certificados/nombre — confirma (o corrige) el nombre del primer certificado, una sola vez
  // ════════════════════════════════════════════════════════════
  // Todos los certificados de la persona (uid y memberUid) y la decisión de si hay que preguntar el nombre.
  async function planNombre(uid, miembro) {
    const docs = await certificadosDelTitular(uid);
    return { docs, ...cert.nombrePorConfirmar(docs, miembro, firmaClave) };
  }

  app.post('/api/certificados/nombre', conSesion('escrituras', 'No se pudo confirmar el nombre del certificado', 'nombre', async (req, res, decoded) => {
    const uid = decoded.uid;
    const cuerpo = await cuerpoJson(req, res);
    if (!firmaClave) throw sinCertificados();
    const folio = cert.normalizarFolio(cuerpo.folio);
    if (!folio) throw errorHttp(400, 'Falta el folio del certificado');
    const nombre = cert.validarNombreCertificado(cuerpo.nombre);
    if (!nombre.ok) throw errorHttp(400, nombre.error);

    const [miembroSnap, usuarioSnap] = await Promise.all([
      db.collection('miembros').doc(uid).get(),
      db.collection('usuarios').doc(uid).get()
    ]);
    if (!miembroSnap.exists && !usuarioSnap.exists) throw errorHttp(403, 'Miembro no encontrado');
    const perfilRef = miembroSnap.exists ? miembroSnap.ref : usuarioSnap.ref;
    const miembro = miembroSnap.exists ? (miembroSnap.data() || {}) : (usuarioSnap.data() || {});

    const plan = await planNombre(uid, miembro);
    const propio = plan.docs.find(d => d.id === folio || String(d.data.folio) === folio);
    if (!propio || !cert.certificadoValido(propio.data, firmaClave)) throw errorHttp(404, 'Certificado no encontrado');
    if (miembro.nombreCertificadoConfirmadoEn || propio.data.nombreConfirmado === true) {
      throw errorHttp(409, 'El nombre de tu certificado ya fue confirmado');
    }
    if (!plan.preguntar || !plan.folios.includes(propio.id)) {
      throw errorHttp(409, 'El nombre solo se confirma en tu primer certificado');
    }

    await db.runTransaction(async tx => {
      const [perfil, ...certs] = await Promise.all([tx.get(perfilRef), ...plan.folios.map(id => tx.get(colCertificados().doc(id)))]);
      if (!perfil.exists) throw errorHttp(403, 'Miembro no encontrado');
      if ((perfil.data() || {}).nombreCertificadoConfirmadoEn) throw errorHttp(409, 'El nombre de tu certificado ya fue confirmado');
      certs.forEach(snap => {
        if (!snap.exists) return;
        const d = snap.data() || {};
        if (d.nombreConfirmado === true) return;
        // El nombre NO entra en la firma (folio, uid, curso, fecha y año): corregirlo no invalida el certificado
        tx.set(snap.ref, { nombre: nombre.valor, memberName: nombre.valor, nombreConfirmado: true, nombreConfirmadoEn: FieldValue.serverTimestamp() }, { merge: true });
      });
      // El nombre confirmado pasa también al perfil: los certificados que se emitan después usarán este nombre
      tx.set(perfilRef, {
        nombreCertificado: nombre.valor, name: nombre.valor, nombreCompleto: nombre.valor,
        nombreCertificadoConfirmadoEn: FieldValue.serverTimestamp(), nombreCertificadoFolio: propio.id,
        nameUpdatedAt: new Date().toISOString()
      }, { merge: true });
    });
    try { await auth.updateUser(uid, { displayName: nombre.valor }); }
    catch (error) { console.warn('[Certificados] No se pudo actualizar el nombre en la cuenta:', error && error.message); }

    // Si el nombre cambió, el correo que salió al emitirse llevaba el nombre anterior: se manda otro con el PDF ya corregido
    // (en segundo plano; un fallo del correo nunca afecta la confirmación).
    const destino = cert.correoDeMiembro({ miembro: miembroSnap.exists ? miembro : null, usuario: usuarioSnap.exists ? usuarioSnap.data() : null, token: decoded });
    for (const id of plan.folios) {
      const previo = plan.docs.find(d => d.id === id);
      if (!previo || previo.data.nombreConfirmado === true) continue;
      if (String(previo.data.nombre || previo.data.memberName || '') === nombre.valor) continue;
      correoEnSegundoPlano(destino, cert.certificadoPublico({ ...previo.data, nombre: nombre.valor }));
    }

    const anterior = String(propio.data.nombre || propio.data.memberName || '');
    console.log('[Certificados] Nombre confirmado:', uid, '·', propio.id, anterior && anterior !== nombre.valor ? '(corregido)' : '(sin cambios)');
    return res.json({ ok: true, nombre: nombre.valor, folio: propio.id, corregido: Boolean(anterior) && anterior !== nombre.valor });
  }));

  // ════════════════════════════════════════════════════════════
  // GET /api/certificados/:folio — verificación PÚBLICA (sin sesión)
  // ════════════════════════════════════════════════════════════
  // Datos públicos de un certificado anterior aceptable, o null. Solo lecturas (el firmado lo hace el titular al
  // abrir el sitio). Mismo criterio que el resto: forma del documento, curso y miembro existentes y límite de fecha.
  // Un duplicado (mismo uid y curso, otro folio) NO se rechaza: casi siempre es legítimo y puede estar impreso.
  async function verificarAnterior(folio, datos) {
    const sinExistencias = cert.certificadoAnteriorAceptable(datos, {
      id: folio, cursoExiste: true, miembroExiste: true, ahora: new Date(), limite: limiteAnteriores
    });
    if (!sinExistencias.aceptable) return null; // forma inválida, firma alterada o fuera de límite: sin más lecturas
    const { uid, cursoId } = sinExistencias;
    const [cursoSnap, miembroSnap] = await Promise.all([
      db.collection('cursos').doc(cursoId).get(),
      db.collection('miembros').doc(uid).get()
    ]);
    if (!cursoSnap.exists) return null;
    if (!miembroSnap.exists && !(await db.collection('usuarios').doc(uid).get()).exists) return null;

    return cert.certificadoPublico(sinExistencias.campos);
  }

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
      // Cuentan los firmados por el servidor y cuyo folio coincide con su documento
      if (datos && String(datos.folio) === folio && cert.certificadoValido(datos, firmaClave)) {
        return res.json({ valido: true, certificado: cert.certificadoPublico(datos) });
      }
      // Y los anteriores (escritos por el navegador) que pasan la revisión: solo lectura, no se escribe nada aquí
      const anterior = datos ? await verificarAnterior(folio, datos) : null;
      if (!anterior) throw errorHttp(404, 'Certificado no encontrado');
      return res.json({ valido: true, anterior: true, certificado: anterior });
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

  // ════════════════════════════════════════════════════════════
  // GET /api/admin/certificados/pendientes — certificados sin firma válida y su diagnóstico (solo lectura)
  // ════════════════════════════════════════════════════════════
  // Misma función de aceptación que la verificación pública, el progreso y el script de auditoría. No modifica nada.
  const MAX_CERTIFICADOS_ADMIN = 5000;
  app.get('/api/admin/certificados/pendientes', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitar('admin', decoded.uid);
      if (!firmaClave) throw sinCertificados();
      const [certs, cursos, miembros, usuarios] = await Promise.all([
        colCertificados().limit(MAX_CERTIFICADOS_ADMIN + 1).get(),
        db.collection('cursos').select().get(),
        db.collection('miembros').select().get(),
        db.collection('usuarios').select().get()
      ]);
      const truncado = certs.docs.length > MAX_CERTIFICADOS_ADMIN;
      const filas = cert.auditarCertificados({
        certificados: certs.docs.slice(0, MAX_CERTIFICADOS_ADMIN).map(d => ({ id: d.id, data: d.data() })),
        cursosIds: new Set(cursos.docs.map(d => d.id)),
        miembrosIds: new Set([...miembros.docs, ...usuarios.docs].map(d => d.id)),
        llave: firmaClave, ahora: new Date(), limite: limiteAnteriores
      });
      const resumen = { total: filas.length, firmados: 0, aceptables: 0, noAceptables: 0, duplicados: 0, porRazon: {} };
      const pendientes = [];
      for (const f of filas) {
        if (f.accion === 'ya-valido') { resumen.firmados += 1; continue; }
        if (f.aceptable) resumen.aceptables += 1; else resumen.noAceptables += 1;
        for (const razon of f.razones) resumen.porRazon[razon] = (resumen.porRazon[razon] || 0) + 1;
        if (f.notas.length) resumen.duplicados += 1;
        pendientes.push({
          folio: f.folio, aceptable: f.aceptable, razones: f.razones, notas: f.notas, uid: f.uid, cursoId: f.cursoId,
          nombre: f.nombre, curso: f.curso, emitido: f.emitido || null
        });
      }
      return res.json({
        modoTransicion: limiteTexto === '',
        limiteAnteriores: limiteTexto || null,
        truncado,
        resumen,
        certificados: pendientes
      });
    } catch (error) {
      return responderError(res, error, 'No se pudo revisar los certificados pendientes', 'pendientes');
    }
  });

  return {
    limites,
    importarLegado,
    esperar: () => Promise.allSettled([...pendientes]),
    firmaConfigurada: Boolean(firmaClave)
  };
}

module.exports = {
  montarRutasCertificados, LECTURAS_POR_MINUTO, ESCRITURAS_POR_MINUTO, CONSULTAS_PUBLICAS, VENTANA_PUBLICA_MS, MENSAJE_SIN_LLAVE
};
