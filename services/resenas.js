'use strict';

// ══ RESEÑAS DE CURSOS ════════════════════════════════════════════
// Al terminar un curso (y tener su certificado) la persona lo califica de 1 a 5 estrellas y, si quiere, deja un comentario.
//  · Solo el servidor escribe: comprueba que la persona SÍ tiene el certificado de ese curso (no se califica sin haberlo terminado).
//  · Una reseña por persona y por curso (`resenas/{uid}__{cursoId}`): si vuelve a calificar, se actualiza la misma.
//  · Solo la administración las lee (por el servidor); no se publican en ningún lado. Sin regla de Firestore: el navegador no las toca.

const COL_RESENAS = 'resenas';
const MAX_COMENTARIO = 500;
const MAX_POR_HORA = 20;
const TOPE_LECTURA = 2000;

function errorHttp(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}

// Valida y limpia lo que manda el navegador
function validarResena({ cursoId, estrellas, comentario }) {
  const id = String(cursoId == null ? '' : cursoId).trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw errorHttp(400, 'Curso inválido');
  const n = Number(estrellas);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw errorHttp(400, 'Elige de 1 a 5 estrellas');
  if (comentario != null && typeof comentario !== 'string') throw errorHttp(400, 'El comentario debe ser texto');
  const texto = String(comentario || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_COMENTARIO);
  return { cursoId: id, estrellas: n, comentario: texto };
}

// Tope de reseñas por persona y hora (frena abusos sin molestar a nadie real)
function crearLimitador({ ahora = () => Date.now(), max = MAX_POR_HORA } = {}) {
  const usos = new Map();
  return uid => {
    const t = ahora();
    const recientes = (usos.get(uid) || []).filter(x => t - x < 3600000);
    if (recientes.length >= max) throw errorHttp(429, 'Demasiadas reseñas seguidas. Intenta más tarde');
    recientes.push(t);
    usos.set(uid, recientes);
  };
}

// Fecha de un certificado (texto ISO, Date o marca de tiempo de Firestore) en milisegundos; 0 si no se puede leer
function milisegundos(valor) {
  if (!valor) return 0;
  if (typeof valor.toMillis === 'function') return Number(valor.toMillis()) || 0;
  const ms = valor instanceof Date ? valor.getTime() : Date.parse(String(valor));
  return Number.isFinite(ms) ? ms : 0;
}

function crearServicio({ db, ahora = () => Date.now() }) {
  const docId = (uid, cursoId) => uid + '__' + cursoId;

  // El certificado de esa persona para ese curso: los firmados por el servidor (uid/cursoId) y los anteriores del navegador (memberUid/courseId)
  async function certificadoDe(uid, cursoId) {
    const nuevo = await db.collection('certificados').where('uid', '==', uid).where('cursoId', '==', cursoId).limit(1).get();
    if (!nuevo.empty) return nuevo.docs[0].data() || {};
    const viejo = await db.collection('certificados').where('memberUid', '==', uid).where('courseId', '==', cursoId).limit(1).get();
    return viejo.empty ? null : (viejo.docs[0].data() || {});
  }

  async function guardar({ uid, nombre, email, cursoId, estrellas, comentario }) {
    if (!uid) throw errorHttp(401, 'Sesión inválida');
    const r = validarResena({ cursoId, estrellas, comentario });
    // Solo quien terminó el curso (tiene su certificado) puede calificarlo
    const cert = await certificadoDe(uid, r.cursoId);
    if (!cert) throw errorHttp(403, 'Primero termina el curso para poder calificarlo');
    const tituloCurso = String(cert.curso || cert.courseTitle || '').slice(0, 160);
    const ref = db.collection(COL_RESENAS).doc(docId(uid, r.cursoId));
    const previa = await ref.get();
    const t = ahora();
    const datos = {
      uid, cursoId: r.cursoId, curso: tituloCurso,
      nombre: String(nombre || cert.nombre || cert.memberName || '').slice(0, 120), email: String(email || cert.memberEmail || '').toLowerCase().slice(0, 160),
      estrellas: r.estrellas, comentario: r.comentario,
      creadaMs: previa.exists && Number(previa.data().creadaMs) ? Number(previa.data().creadaMs) : t,
      actualizadaMs: t
    };
    await ref.set(datos);
    return { cursoId: r.cursoId, estrellas: r.estrellas, comentario: r.comentario, actualizada: previa.exists };
  }

  // Lo que esa persona ya calificó (para no volver a preguntarle)
  async function mias(uid) {
    const snap = await db.collection(COL_RESENAS).where('uid', '==', uid).limit(300).get();
    return snap.docs.map(d => { const x = d.data(); return { cursoId: x.cursoId, estrellas: x.estrellas, comentario: x.comentario || '' }; });
  }

  // Los cursos que esa persona ya terminó (con certificado): { cursoId, curso, emitidoMs }, el más reciente primero. Sirve para saber
  // a qué curso preguntarle «¿Qué te pareció?» (el título lo trae el certificado) sin que el navegador tenga que adivinarlo.
  async function terminados(uid) {
    const [nuevos, viejos] = await Promise.all([
      db.collection('certificados').where('uid', '==', uid).limit(200).get(),
      db.collection('certificados').where('memberUid', '==', uid).limit(200).get()
    ]);
    const por = new Map();
    for (const d of nuevos.docs.concat(viejos.docs)) {
      const c = d.data() || {};
      const cursoId = String(c.cursoId || c.courseId || '');
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(cursoId)) continue;
      const ms = milisegundos(c.emitido || c.issuedAt);
      const previo = por.get(cursoId);
      if (!previo || ms > previo.emitidoMs) por.set(cursoId, { cursoId, curso: String(c.curso || c.courseTitle || '').slice(0, 160), emitidoMs: ms });
    }
    return [...por.values()].sort((a, b) => b.emitidoMs - a.emitidoMs);
  }

  // Todas, de la más reciente a la más antigua (para la administración)
  async function todas({ limite = 1000 } = {}) {
    const tope = Math.min(Math.max(Math.floor(Number(limite)) || 1000, 1), TOPE_LECTURA);
    const snap = await db.collection(COL_RESENAS).orderBy('actualizadaMs', 'desc').limit(tope).get();
    return snap.docs.map(d => {
      const x = d.data();
      return { uid: x.uid, nombre: x.nombre || '', email: x.email || '', cursoId: x.cursoId, curso: x.curso || '', estrellas: x.estrellas, comentario: x.comentario || '', creadaMs: x.creadaMs || 0, actualizadaMs: x.actualizadaMs || 0 };
    });
  }

  return { guardar, mias, terminados, todas };
}

module.exports = { crearServicio, validarResena, crearLimitador, MAX_COMENTARIO, COL_RESENAS, TOPE_LECTURA };
