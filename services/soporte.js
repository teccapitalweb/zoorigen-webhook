'use strict';

// ══ SOPORTE PRIVADO (buzón de soporte) ══
// Conversación 1-a-1 entre un miembro y la administración, como la de ICADEM: el miembro elige un tema,
// escribe su primer mensaje, y ve un hilo privado donde solo él y la administración pueden escribir.
// Todo pasa por el servidor (Admin SDK): el navegador nunca escribe directo a estas colecciones.
//
// Colecciones (solo servidor):
//   soporteTickets/{id}                uid, nombre, correo, tema, estado ('abierto'|'cerrado'),
//                                       creadoEn, actualizadoEn, mensajesCount, ultimoAutor
//   soporteTickets/{id}/mensajes/{id}   autorTipo ('miembro'|'admin'), autorNombre, texto, creadoEn

const { texto, enlaceInterno, aIso, idSeguro } = require('./texto');
const { crearAviso } = require('./avisos');

const TEMAS = Object.freeze({
  membresia: 'Mi membresía', cobros: 'Cobros y pagos', acceso: 'Acceso a mi cuenta', cursos: 'Cursos y materiales', otro: 'Otro tema'
});
const LIMITE_MENSAJE = 3000;
const LIMITE_TICKETS_POR_MIEMBRO = 300;

class ErrorSoporte extends Error {
  constructor(status, mensaje, codigo) { super(mensaje); this.status = status; this.codigo = codigo; }
}

function vistaTicket(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id, uid: String(d.uid || ''), nombre: String(d.nombre || ''), correo: String(d.correo || ''),
    tema: TEMAS[d.tema] ? d.tema : 'otro', temaLabel: TEMAS[d.tema] || TEMAS.otro,
    estado: d.estado === 'cerrado' ? 'cerrado' : 'abierto', mensajesCount: Number(d.mensajesCount) || 0,
    ultimoAutor: d.ultimoAutor === 'admin' ? 'admin' : 'miembro', creadoEn: aIso(d.creadoEn), actualizadoEn: aIso(d.actualizadoEn)
  };
}

function vistaMensaje(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id, autorTipo: d.autorTipo === 'admin' ? 'admin' : 'miembro', autorNombre: String(d.autorNombre || ''),
    texto: String(d.texto || ''), creadoEn: aIso(d.creadoEn)
  };
}

function crearServicio({ db, admin, auth, adminEmails = [] }) {
  const FieldValue = () => admin.firestore.FieldValue;
  const correosAdmin = new Set((adminEmails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
  const uidsAdminCache = { en: 0, uids: [] };

  // Resuelve los uids de los correos administradores (cuenta de Firebase Auth), con caché de 10 min:
  // sirve para avisarles en la campana cuando un miembro abre o responde un ticket.
  async function uidsAdmin() {
    if (!correosAdmin.size) return [];
    if (Date.now() - uidsAdminCache.en < 10 * 60 * 1000 && uidsAdminCache.uids.length) return uidsAdminCache.uids;
    const uids = [];
    for (const correo of correosAdmin) {
      try { const u = await auth.getUserByEmail(correo); uids.push(u.uid); } catch (_) { /* esa cuenta aún no existe */ }
    }
    uidsAdminCache.en = Date.now();
    uidsAdminCache.uids = uids;
    return uids;
  }

  async function avisarAdmins({ ticketId, tituloCorto }) {
    const uids = await uidsAdmin();
    await Promise.all(uids.map(uid => crearAviso(db, uid, {
      id: `soporte-admin_${ticketId}_${Date.now()}`, tipo: 'soporte', titulo: '🎧 Nuevo mensaje de soporte', texto: tituloCorto, enlace: enlaceInterno('admin-club.html')
    })));
  }

  async function avisarMiembro({ uid, ticketId, mensajesCount }) {
    await crearAviso(db, uid, {
      id: `soporte-respuesta_${ticketId}_${mensajesCount}`, tipo: 'soporte', titulo: '🎧 Respondieron tu mensaje de soporte', texto: '', enlace: enlaceInterno('club-soporte.html')
    });
  }

  async function crearTicket({ uid, nombre, correo, tema, mensaje }) {
    if (!TEMAS[tema]) throw new ErrorSoporte(400, 'Elige un tema válido.', 'tema-invalido');
    const cuerpo = texto(mensaje, LIMITE_MENSAJE, { saltos: true });
    if (cuerpo.length < 3) throw new ErrorSoporte(400, 'Escribe tu mensaje (mínimo unas letras).', 'mensaje-vacio');
    const existentes = await db.collection('soporteTickets').where('uid', '==', uid).limit(LIMITE_TICKETS_POR_MIEMBRO).get();
    if (existentes.size >= LIMITE_TICKETS_POR_MIEMBRO) throw new ErrorSoporte(429, 'Tienes demasiados mensajes de soporte. Contáctanos por otro medio.', 'demasiados');
    const nombreLimpio = texto(nombre, 140) || 'Miembro';
    const correoLimpio = texto(correo, 160);
    const ref = db.collection('soporteTickets').doc();
    const ahora = FieldValue().serverTimestamp();
    await ref.set({ uid, nombre: nombreLimpio, correo: correoLimpio, tema, estado: 'abierto', mensajesCount: 1, ultimoAutor: 'miembro', creadoEn: ahora, actualizadoEn: ahora });
    await ref.collection('mensajes').doc().set({ autorTipo: 'miembro', autorUid: uid, autorNombre: nombreLimpio, texto: cuerpo, creadoEn: ahora });
    await avisarAdmins({ ticketId: ref.id, tituloCorto: `${nombreLimpio} · ${TEMAS[tema]}` });
    return { id: ref.id, tema, temaLabel: TEMAS[tema], estado: 'abierto', mensajesCount: 1 };
  }

  async function obtenerTicketDoc(id) {
    const doc = await db.collection('soporteTickets').doc(idSeguro(id) || 'x').get();
    if (!doc.exists) throw new ErrorSoporte(404, 'No encontramos ese mensaje de soporte.', 'no-existe');
    return doc;
  }

  // Ticket + sus mensajes. Un miembro solo puede ver el suyo; un admin puede ver cualquiera.
  async function obtenerTicket(id, { uid, esAdmin } = {}) {
    const doc = await obtenerTicketDoc(id);
    const fila = vistaTicket(doc);
    if (!esAdmin && fila.uid !== uid) throw new ErrorSoporte(403, 'Ese mensaje de soporte no te pertenece.', 'no-autorizado');
    const snapMensajes = await doc.ref.collection('mensajes').orderBy('creadoEn', 'asc').limit(500).get();
    return { ticket: fila, mensajes: snapMensajes.docs.map(vistaMensaje) };
  }

  async function misTickets(uid) {
    const snap = await db.collection('soporteTickets').where('uid', '==', uid).orderBy('actualizadoEn', 'desc').limit(100).get();
    return snap.docs.map(vistaTicket);
  }

  async function listarAdmin({ estado } = {}) {
    let q = db.collection('soporteTickets').orderBy('actualizadoEn', 'desc').limit(300);
    const snap = await q.get();
    let filas = snap.docs.map(vistaTicket);
    if (estado === 'abierto' || estado === 'cerrado') filas = filas.filter(f => f.estado === estado);
    return filas;
  }

  async function responder(id, { autorUid, autorTipo, autorNombre, texto: cuerpoCrudo }) {
    const doc = await obtenerTicketDoc(id);
    const actual = doc.data() || {};
    if (autorTipo === 'miembro' && actual.uid !== autorUid) throw new ErrorSoporte(403, 'Ese mensaje de soporte no te pertenece.', 'no-autorizado');
    const cuerpo = texto(cuerpoCrudo, LIMITE_MENSAJE, { saltos: true });
    if (cuerpo.length < 1) throw new ErrorSoporte(400, 'Escribe un mensaje.', 'mensaje-vacio');
    const nombreLimpio = texto(autorNombre, 140) || (autorTipo === 'admin' ? 'Equipo Zoorigen' : 'Miembro');
    const ahora = FieldValue().serverTimestamp();
    const mensajesCount = (Number(actual.mensajesCount) || 0) + 1;
    await doc.ref.collection('mensajes').doc().set({ autorTipo, autorUid: autorUid || null, autorNombre: nombreLimpio, texto: cuerpo, creadoEn: ahora });
    // Un mensaje nuevo (de cualquiera) siempre reabre el ticket: vuelve a necesitar atención.
    await doc.ref.set({ actualizadoEn: ahora, mensajesCount, ultimoAutor: autorTipo, estado: 'abierto' }, { merge: true });
    if (autorTipo === 'admin') await avisarMiembro({ uid: actual.uid, ticketId: doc.id, mensajesCount });
    else await avisarAdmins({ ticketId: doc.id, tituloCorto: `${nombreLimpio} · ${TEMAS[actual.tema] || TEMAS.otro}` });
    return { ok: true };
  }

  async function cambiarEstado(id, estado) {
    if (estado !== 'abierto' && estado !== 'cerrado') throw new ErrorSoporte(400, 'Estado no válido.', 'estado-invalido');
    const doc = await obtenerTicketDoc(id);
    await doc.ref.set({ estado, actualizadoEn: FieldValue().serverTimestamp() }, { merge: true });
    return { ok: true };
  }

  return { TEMAS, crearTicket, obtenerTicket, misTickets, listarAdmin, responder, cambiarEstado };
}

module.exports = { ErrorSoporte, crearServicio, TEMAS, vistaTicket, vistaMensaje };
