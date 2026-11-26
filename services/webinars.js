'use strict';

// ══ CLASES EN VIVO (webinars) ══
// Automatiza lo que antes hacía el administrador a mano: crea el Google Meet (o guarda uno manual),
// avisa a los miembros, y cuando la clase termina busca la grabación en el Drive de la cuenta dedicada
// y la sube sola a Bunny Stream. El navegador NUNCA ve `meetUrl` ni `bunnyVideoId` hasta el momento
// justo de entrar o reproducir: viven en una colección separada que solo lee este servidor.
//
// Colecciones:
//   sesiones/{id}              público, solo lectura: titulo, descripcion, instructor, duracionMin,
//                              inicioISO, estado ('programada'|'terminada'), tieneGrabacion, creadoEn
//   sesionesPrivadas/{id}      mismo id, SOLO servidor: meetUrl, calendarEventId, driveArchivoId,
//                              bunnyVideoId, videoManual, creadoPor
//   sesionesPrueba/{id}        mismo esquema que sesiones, pero nunca sale en el listado público
//   sesionesPruebaPrivadas/{id}
//   webinarsAuto/{id}          estado de la automatización Drive→Bunny (paso, actualizadoEn, mensaje)
//   sesionInscripciones/{id}__{uid}   "Mis registradas" de un miembro
//
// Todas se escriben SOLO con el Admin SDK (las reglas de Firestore niegan al navegador).

const { texto, enlaceInterno, aIso, idSeguro } = require('./texto');
const { crearAviso, crearNotificacionGlobal } = require('./avisos');

const DURACION_MIN_MIN = 15;
const DURACION_MIN_MAX = 240;
const VENTANA_ANTES_MIN = 10;     // el enlace se puede pedir desde 10 min antes de la hora de inicio...
const VENTANA_DESPUES_MIN = 60;   // ...y hasta 60 min después de que debería haber terminado
const GRABACION_DESDE_HORAS = 3;  // la búsqueda en Drive mira desde 3 h antes del inicio...
const GRABACION_HASTA_HORAS = 12; // ...hasta 12 h después (clases que se alargan o se suben tarde)

class ErrorWebinar extends Error {
  constructor(status, mensaje, codigo, extra) { super(mensaje); this.status = status; this.codigo = codigo; if (extra) Object.assign(this, extra); }
}

const colPublica = esPrueba => (esPrueba ? 'sesionesPrueba' : 'sesiones');
const colPrivada = esPrueba => (esPrueba ? 'sesionesPruebaPrivadas' : 'sesionesPrivadas');

function finISODe(inicioISO, duracionMin) {
  return new Date(new Date(inicioISO).getTime() + duracionMin * 60000).toISOString();
}

function validarDatos({ titulo, descripcion, instructor, duracionMin, inicioISO }) {
  const t = texto(titulo, 140);
  if (t.length < 3) throw new ErrorWebinar(400, 'Escribe un título para la clase (mínimo 3 letras).', 'titulo-invalido');
  const inst = texto(instructor, 120);
  if (inst.length < 3) throw new ErrorWebinar(400, 'Escribe el nombre del instructor.', 'instructor-invalido');
  const desc = texto(descripcion, 600, { saltos: true });
  const dur = Number(duracionMin);
  if (!Number.isInteger(dur) || dur < DURACION_MIN_MIN || dur > DURACION_MIN_MAX) {
    throw new ErrorWebinar(400, `La duración debe ser un número entero de ${DURACION_MIN_MIN} a ${DURACION_MIN_MAX} minutos.`, 'duracion-invalida');
  }
  const inicioMs = Date.parse(inicioISO);
  if (!Number.isFinite(inicioMs)) throw new ErrorWebinar(400, 'La fecha y hora de la clase no son válidas.', 'fecha-invalida');
  return { titulo: t, descripcion: desc, instructor: inst, duracionMin: dur, inicioISO: new Date(inicioMs).toISOString() };
}

function vistaPublica(doc, { esPrueba = false } = {}) {
  const d = doc.data() || {};
  return {
    id: doc.id, titulo: String(d.titulo || ''), descripcion: String(d.descripcion || ''), instructor: String(d.instructor || ''),
    duracionMin: Number(d.duracionMin) || 60, inicioISO: String(d.inicioISO || ''), estado: d.estado === 'terminada' ? 'terminada' : 'programada',
    tieneGrabacion: d.tieneGrabacion === true, esPrueba, creadoEn: aIso(d.creadoEn)
  };
}

function crearServicio({ db, admin, auth, google, bunny, superadminEmails = [] }) {
  const FieldValue = () => admin.firestore.FieldValue;
  const superadmins = new Set((superadminEmails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
  const uidsSuperadminCache = { en: 0, uids: [] };

  // Resuelve los uids de los correos superadmin (cuentas de Firebase Auth), con caché de 10 min:
  // sirve para avisarles en la campana de una clase de prueba sin tocar a nadie más.
  async function uidsSuperadmin() {
    if (!superadmins.size) return [];
    if (Date.now() - uidsSuperadminCache.en < 10 * 60 * 1000 && uidsSuperadminCache.uids.length) return uidsSuperadminCache.uids;
    const uids = [];
    for (const email of superadmins) {
      try { const u = await auth.getUserByEmail(email); uids.push(u.uid); } catch (_) { /* esa cuenta aún no existe */ }
    }
    uidsSuperadminCache.en = Date.now();
    uidsSuperadminCache.uids = uids;
    return uids;
  }

  function esSuperadminPorCorreo(decoded) {
    return Boolean(decoded && decoded.email_verified === true && typeof decoded.email === 'string' && superadmins.has(decoded.email.trim().toLowerCase()));
  }

  async function crear({ decoded, esPrueba = false, titulo, descripcion, instructor, duracionMin, inicioISO, crearMeet, meetManual }) {
    const v = validarDatos({ titulo, descripcion, instructor, duracionMin, inicioISO });
    let meetUrl = '';
    let calendarEventId = null;
    if (crearMeet) {
      if (!google || !google.configurado()) throw new ErrorWebinar(503, 'Google Meet no está configurado en Railway (faltan las variables GOOGLE_*).', 'google-no-configurado');
      const evento = await google.crearEvento({ titulo: v.titulo, descripcion: v.descripcion, inicioISO: v.inicioISO, finISO: finISODe(v.inicioISO, v.duracionMin) });
      meetUrl = evento.meetUrl; calendarEventId = evento.eventId;
    } else {
      meetUrl = texto(meetManual, 300);
      if (!/^https:\/\//i.test(meetUrl)) throw new ErrorWebinar(400, 'Pega un enlace de reunión válido (https://) o marca «Crear Meet automáticamente».', 'enlace-invalido');
    }

    const ref = db.collection(colPublica(esPrueba)).doc();
    await ref.set({ titulo: v.titulo, descripcion: v.descripcion, instructor: v.instructor, duracionMin: v.duracionMin, inicioISO: v.inicioISO, estado: 'programada', tieneGrabacion: false, creadoEn: FieldValue().serverTimestamp() });
    await db.collection(colPrivada(esPrueba)).doc(ref.id).set({ meetUrl, calendarEventId, driveArchivoId: null, bunnyVideoId: null, videoManual: false, creadoPor: decoded.uid });

    if (esPrueba) {
      const uids = await uidsSuperadmin();
      await Promise.all(uids.map(uid => crearAviso(db, uid, {
        id: `clase-prueba_${ref.id}`, tipo: 'curso', titulo: '🎬 Clase de prueba programada', texto: v.titulo, enlace: enlaceInterno('club-sesiones.html')
      })));
    } else {
      await crearNotificacionGlobal(db, {
        id: `clase-nueva_${ref.id}`, tipo: 'clase', titulo: '🎬 Nueva clase en vivo', descripcion: v.titulo, enlace: enlaceInterno('club-sesiones.html')
      });
    }
    return { id: ref.id, ...v, estado: 'programada', tieneGrabacion: false, esPrueba, meetUrl };
  }

  async function obtener(id, { esPrueba = false } = {}) {
    const [pub, priv] = await Promise.all([db.collection(colPublica(esPrueba)).doc(id).get(), db.collection(colPrivada(esPrueba)).doc(id).get()]);
    if (!pub.exists) throw new ErrorWebinar(404, 'No encontramos esa clase.', 'no-existe');
    return { pub, priv };
  }

  async function editar(id, cambios, { esPrueba = false } = {}) {
    const { pub, priv } = await obtener(id, { esPrueba });
    const actual = pub.data() || {};
    const privData = priv.exists ? priv.data() : {};
    const v = validarDatos({
      titulo: cambios.titulo ?? actual.titulo, descripcion: cambios.descripcion ?? actual.descripcion,
      instructor: cambios.instructor ?? actual.instructor, duracionMin: cambios.duracionMin ?? actual.duracionMin, inicioISO: cambios.inicioISO ?? actual.inicioISO
    });
    const cambioFecha = cambios.inicioISO !== undefined || cambios.duracionMin !== undefined;
    if (privData.calendarEventId && google && google.configurado() && (cambioFecha || cambios.titulo !== undefined || cambios.descripcion !== undefined)) {
      await google.editarEvento(privData.calendarEventId, { titulo: v.titulo, descripcion: v.descripcion, inicioISO: v.inicioISO, finISO: finISODe(v.inicioISO, v.duracionMin) });
    }
    let meetUrl = privData.meetUrl || '';
    if (!privData.calendarEventId && typeof cambios.meetManual === 'string') {
      const m = texto(cambios.meetManual, 300);
      if (m) { if (!/^https:\/\//i.test(m)) throw new ErrorWebinar(400, 'El enlace debe empezar con https://', 'enlace-invalido'); meetUrl = m; }
    }
    await db.collection(colPublica(esPrueba)).doc(id).set({ titulo: v.titulo, descripcion: v.descripcion, instructor: v.instructor, duracionMin: v.duracionMin, inicioISO: v.inicioISO }, { merge: true });
    if (meetUrl !== privData.meetUrl) await db.collection(colPrivada(esPrueba)).doc(id).set({ meetUrl }, { merge: true });
    return { id, ...v, esPrueba, meetUrl };
  }

  async function eliminar(id, { esPrueba = false } = {}) {
    const { priv } = await obtener(id, { esPrueba });
    const privData = priv.exists ? priv.data() : {};
    if (privData.calendarEventId && google && google.configurado()) {
      try { await google.eliminarEvento(privData.calendarEventId); } catch (error) { console.error('[Webinars] No se pudo borrar el evento de Calendar:', error && error.message); }
    }
    await Promise.all([
      db.collection(colPublica(esPrueba)).doc(id).delete(),
      db.collection(colPrivada(esPrueba)).doc(id).delete(),
      db.collection('webinarsAuto').doc(id).delete()
    ]);
    return { ok: true };
  }

  async function listarPublico({ esSuperadmin = false } = {}) {
    const snap = await db.collection('sesiones').orderBy('inicioISO', 'asc').limit(200).get();
    const reales = snap.docs.map(d => vistaPublica(d, { esPrueba: false }));
    if (!esSuperadmin) return reales;
    const snapPrueba = await db.collection('sesionesPrueba').orderBy('inicioISO', 'asc').limit(50).get();
    const pruebas = snapPrueba.docs.map(d => vistaPublica(d, { esPrueba: true }));
    return [...reales, ...pruebas].sort((a, b) => (a.inicioISO < b.inicioISO ? -1 : 1));
  }

  // Para el panel admin: todas las reales + todas las de prueba, con su estado de automatización.
  async function listarAdmin() {
    const [reales, pruebas] = await Promise.all([
      db.collection('sesiones').orderBy('inicioISO', 'desc').limit(300).get(),
      db.collection('sesionesPrueba').orderBy('inicioISO', 'desc').limit(100).get()
    ]);
    const filas = [...reales.docs.map(d => vistaPublica(d, { esPrueba: false })), ...pruebas.docs.map(d => vistaPublica(d, { esPrueba: true }))];
    if (!filas.length) return [];
    // Firestore.getAll() exige al menos un documento; sin clases todavía, filas está vacío.
    const autos = await db.getAll(...filas.map(f => db.collection('webinarsAuto').doc(f.id)));
    return filas.map((f, i) => ({ ...f, automatizacion: (autos[i].exists && autos[i].data().paso) || 'programada' }));
  }

  // El enlace de Meet solo se entrega dentro de la ventana de la clase (y nunca a quien no debe verla).
  async function obtenerEnlaceParaUnirse(id, { esAdmin, esSuperadmin, tienePlan, esPrueba }) {
    if (esPrueba && !esAdmin && !esSuperadmin) throw new ErrorWebinar(404, 'No encontramos esa clase.', 'no-existe');
    if (!esPrueba && !esAdmin && !tienePlan) throw new ErrorWebinar(403, 'Necesitas una membresía activa para entrar a esta clase.', 'sin-membresia');
    const { pub, priv } = await obtener(id, { esPrueba });
    const d = pub.data() || {};
    const inicioMs = Date.parse(d.inicioISO);
    const duracionMin = Number(d.duracionMin) || 60;
    const ahora = Date.now();
    if (ahora < inicioMs - VENTANA_ANTES_MIN * 60000 || ahora > inicioMs + duracionMin * 60000 + VENTANA_DESPUES_MIN * 60000) {
      throw new ErrorWebinar(409, 'El enlace solo está disponible cerca del horario de la clase.', 'fuera-de-ventana');
    }
    const meetUrl = priv.exists ? (priv.data() || {}).meetUrl : '';
    if (!meetUrl) throw new ErrorWebinar(503, 'Esta clase todavía no tiene un enlace de reunión.', 'sin-enlace');
    return { meetUrl };
  }

  async function fijarVideoManual(id, { esPrueba = false, bunnyVideoId }) {
    const vid = texto(bunnyVideoId, 80);
    if (!vid) throw new ErrorWebinar(400, 'Escribe el id del video en Bunny.', 'id-invalido');
    await Promise.all([
      db.collection(colPrivada(esPrueba)).doc(id).set({ bunnyVideoId: vid, videoManual: true }, { merge: true }),
      db.collection(colPublica(esPrueba)).doc(id).set({ tieneGrabacion: true, estado: 'terminada' }, { merge: true }),
      db.collection('webinarsAuto').doc(id).set({ paso: 'lista', actualizadoEn: new Date().toISOString(), mensaje: 'Video fijado a mano' })
    ]);
    return { ok: true };
  }

  async function estadoAutomatizacion(id) {
    const snap = await db.collection('webinarsAuto').doc(id).get();
    return snap.exists ? snap.data() : { paso: 'programada' };
  }

  // Un paso de la búsqueda Drive→Bunny para UNA sesión (lo usan el cron de services/webinar-tareas.js
  // y el botón «Reintentar» del panel). Nunca lanza: deja su resultado en webinarsAuto/{id}.
  async function buscarGrabacionParaSesion(id, { esPrueba = false } = {}) {
    const autoRef = db.collection('webinarsAuto').doc(id);
    const marcar = (paso, mensaje = '') => autoRef.set({ paso, mensaje, actualizadoEn: new Date().toISOString() }, { merge: true });
    try {
      const { pub, priv } = await obtener(id, { esPrueba });
      const d = pub.data() || {};
      const p = priv.exists ? priv.data() : {};
      if (p.bunnyVideoId || p.videoManual) return { yaListo: true };
      if (!google || !google.configurado() || !bunny || !bunny.configurado()) { await marcar('programada', 'Automatización no configurada'); return { omitida: true }; }
      const inicioMs = Date.parse(d.inicioISO);
      const duracionMin = Number(d.duracionMin) || 60;
      const desdeISO = new Date(inicioMs - GRABACION_DESDE_HORAS * 3600000).toISOString();
      const hastaISO = new Date(inicioMs + duracionMin * 60000 + GRABACION_HASTA_HORAS * 3600000).toISOString();
      if (Date.now() < inicioMs) return { aunNoEmpieza: true };

      const archivo = await google.buscarGrabacionEnDrive({ codigo: id, titulo: d.titulo, desdeISO, hastaISO });
      if (!archivo) { await marcar('programada', 'Grabación todavía no encontrada en Drive'); return { encontrada: false }; }

      await marcar('grabacion-encontrada', archivo.name);
      const buffer = await google.descargarArchivo(archivo.id);
      await marcar('subiendo-bunny');
      const videoId = await bunny.crearVideo({ titulo: d.titulo });
      await bunny.subirBinario({ videoId, buffer });
      await marcar('procesando-bunny');

      for (let intento = 0; intento < 20; intento++) {
        const estado = await bunny.estadoVideo({ videoId });
        if (estado === 4) break;
        if (estado === 5 || estado === 6) throw new Error('Bunny marcó la subida como fallida (estado ' + estado + ')');
        await new Promise(r => setTimeout(r, 3000));
      }
      await db.collection(colPrivada(esPrueba)).doc(id).set({ bunnyVideoId: videoId, driveArchivoId: archivo.id }, { merge: true });
      await db.collection(colPublica(esPrueba)).doc(id).set({ tieneGrabacion: true, estado: 'terminada' }, { merge: true });
      await marcar('lista', 'Subida a Bunny');
      return { listo: true, videoId };
    } catch (error) {
      console.error('[Webinars] Falló la automatización de', id, ':', error && error.message);
      await marcar('error', (error && error.message) || 'Error desconocido').catch(() => {});
      return { error: true };
    }
  }

  // ── Migración de clases anteriores: mueve un `meetUrl`/`zoomUrl` que haya quedado en el doc público
  // (escrito directo desde el navegador antes de este cambio) a la colección privada. ──
  async function legadoPendiente() {
    const snap = await db.collection('sesiones').limit(300).get();
    return snap.docs.filter(d => { const v = d.data() || {}; return typeof v.meetUrl === 'string' && v.meetUrl || typeof v.zoomUrl === 'string' && v.zoomUrl; });
  }

  async function protegerEnlaces() {
    const pendientes = await legadoPendiente();
    let migradas = 0;
    for (const doc of pendientes) {
      const v = doc.data() || {};
      const meetUrl = v.meetUrl || v.zoomUrl || '';
      const privRef = db.collection('sesionesPrivadas').doc(doc.id);
      const privSnap = await privRef.get();
      if (!privSnap.exists || !(privSnap.data() || {}).meetUrl) {
        await privRef.set({ meetUrl, calendarEventId: null, driveArchivoId: null, bunnyVideoId: null, videoManual: false, creadoPor: 'migracion' }, { merge: true });
      }
      await doc.ref.set({
        meetUrl: FieldValue().delete ? FieldValue().delete() : null, zoomUrl: FieldValue().delete ? FieldValue().delete() : null,
        estado: v.estado || 'programada', tieneGrabacion: v.tieneGrabacion === true
      }, { merge: true });
      migradas += 1;
    }
    return { migradas };
  }

  // ── "Mis registradas" ──
  async function inscribirme(id, uid, { esPrueba = false } = {}) {
    await obtener(id, { esPrueba }); // valida que exista
    await db.collection('sesionInscripciones').doc(`${id}__${uid}`).set({ sesionId: id, uid, esPrueba, inscritoEn: FieldValue().serverTimestamp() });
    return { ok: true };
  }
  async function cancelarInscripcion(id, uid) {
    await db.collection('sesionInscripciones').doc(`${id}__${uid}`).delete();
    return { ok: true };
  }
  async function misInscripciones(uid) {
    const snap = await db.collection('sesionInscripciones').where('uid', '==', uid).limit(200).get();
    return snap.docs.map(d => (d.data() || {}).sesionId).filter(Boolean);
  }

  return {
    crear, editar, eliminar, listarPublico, listarAdmin, obtenerEnlaceParaUnirse, fijarVideoManual, estadoAutomatizacion,
    buscarGrabacionParaSesion, legadoPendiente, protegerEnlaces, inscribirme, cancelarInscripcion, misInscripciones,
    esSuperadminPorCorreo, uidsSuperadmin
  };
}

module.exports = { ErrorWebinar, crearServicio, colPublica, colPrivada, validarDatos, vistaPublica, DURACION_MIN_MIN, DURACION_MIN_MAX };
