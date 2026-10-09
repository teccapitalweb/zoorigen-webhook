'use strict';

// ══ AVISOS (la campana del sitio) ══
// Personales: avisos/{uid}/items/{id}      -> los crea el servidor cuando le pasa algo a la persona.
// Globales:   notificacionesGlobales/{id}  -> para todos (noticias nuevas, dato curioso, avisos del equipo).
// Ambas colecciones son SOLO DEL SERVIDOR (Admin SDK). Lo leído/descartado lo guarda el navegador.
// Los textos se guardan tal cual (recortados y sin caracteres de control); el sitio los escapa al mostrarlos.

const { texto, enlaceInterno, aIso, idSeguro } = require('./texto');

const TIPOS_PERSONALES = Object.freeze(['certificado', 'logro', 'premio', 'libro', 'xp', 'bienvenida']);
const TIPOS_GLOBALES = Object.freeze(['noticia', 'dato', 'sistema', 'clase', 'curso', 'general']);
const LIMITES = Object.freeze({ titulo: 120, texto: 240, descripcion: 320, enlace: 40 });
const MAX_PERSONALES = 30;
const MAX_GLOBALES = 15;
const MAX_TOTAL = 40;
const MAX_ADMIN_GLOBALES = 50;

// Icono y color por tipo (el sitio los pinta tal cual)
const PRESETS = Object.freeze({
  certificado: { icono: '🎓', color: '#2F7A4F' },
  logro: { icono: '🏅', color: '#E8A317' },
  premio: { icono: '🎁', color: '#D4572F' },
  libro: { icono: '📖', color: '#8B7FBA' },
  xp: { icono: '⭐', color: '#D4A017' },
  bienvenida: { icono: '👋', color: '#2AA4D5' },
  noticia: { icono: '📰', color: '#2AA4D5' },
  dato: { icono: '💡', color: '#E8A317' },
  sistema: { icono: '⚙️', color: '#6B7280' },
  clase: { icono: '🎬', color: '#8B7FBA' },
  curso: { icono: '📚', color: '#2F7A4F' },
  general: { icono: '🔔', color: '#6FBF73' }
});

function presetDe(tipo) {
  return PRESETS[tipo] || PRESETS.general;
}

const coleccionPersonal = (db, uid) => db.collection('avisos').doc(uid).collection('items');

// Escribe el documento SOLO si no existe (dentro de una transacción: dos llamadas a la vez crean uno).
async function crearSiNoExiste(db, ref, datos) {
  return db.runTransaction(async tx => {
    const actual = await tx.get(ref);
    if (actual.exists) return false;
    tx.set(ref, datos);
    return true;
  });
}

// Crea un aviso personal. Id determinista (p. ej. "logro_l4"): si ya existe NO se sobrescribe, así repetir
// el mismo evento nunca duplica ni revive un aviso. NUNCA lanza: devuelve { creado, id } o { creado:false, motivo }.
async function crearAviso(db, uid, datos, { ahora = new Date() } = {}) {
  try {
    const { id, tipo, titulo, texto: cuerpo, enlace } = datos || {};
    if (typeof uid !== 'string' || !uid.trim() || uid.includes('/')) return { creado: false, motivo: 'uid-invalido' };
    const docId = idSeguro(id);
    if (!docId) return { creado: false, motivo: 'id-invalido' };
    if (!TIPOS_PERSONALES.includes(tipo)) return { creado: false, motivo: 'tipo-invalido' };
    const tituloLimpio = texto(titulo, LIMITES.titulo);
    if (!tituloLimpio) return { creado: false, motivo: 'titulo-vacio' };
    const creado = await crearSiNoExiste(db, coleccionPersonal(db, uid).doc(docId), {
      tipo, titulo: tituloLimpio, texto: texto(cuerpo, LIMITES.texto), enlace: enlaceInterno(enlace, LIMITES.enlace), creadoEn: ahora
    });
    return { creado, id: docId };
  } catch (error) {
    console.error('[Avisos] No se pudo crear el aviso personal:', error && error.message);
    return { creado: false, motivo: 'error' };
  }
}

// Crea un aviso global. Con `id` es idempotente (no sobrescribe); sin `id` se genera uno nuevo.
// Tampoco lanza: { creado, id } o { creado:false, motivo }.
async function crearNotificacionGlobal(db, datos, { ahora = new Date() } = {}) {
  try {
    const { id, tipo, titulo, descripcion, enlace, origen = 'auto' } = datos || {};
    if (!TIPOS_GLOBALES.includes(tipo)) return { creado: false, motivo: 'tipo-invalido' };
    const tituloLimpio = texto(titulo, LIMITES.titulo);
    if (!tituloLimpio) return { creado: false, motivo: 'titulo-vacio' };
    const docId = id ? idSeguro(id) : `adm_${ahora.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
    if (!docId) return { creado: false, motivo: 'id-invalido' };
    const { icono, color } = presetDe(tipo);
    const creado = await crearSiNoExiste(db, db.collection('notificacionesGlobales').doc(docId), {
      tipo, icono, color, titulo: tituloLimpio, descripcion: texto(descripcion, LIMITES.descripcion),
      enlace: enlaceInterno(enlace, LIMITES.enlace), origen: origen === 'admin' ? 'admin' : 'auto', creadoEn: ahora
    });
    return { creado, id: docId };
  } catch (error) {
    console.error('[Avisos] No se pudo crear el aviso global:', error && error.message);
    return { creado: false, motivo: 'error' };
  }
}

function vistaPersonal(doc) {
  const d = doc.data() || {};
  const p = presetDe(d.tipo);
  return {
    id: doc.id, ambito: 'personal', tipo: String(d.tipo || 'xp'), titulo: String(d.titulo || ''), texto: String(d.texto || ''),
    enlace: String(d.enlace || ''), icono: p.icono, color: p.color, fecha: aIso(d.creadoEn)
  };
}

function vistaGlobal(doc) {
  const d = doc.data() || {};
  const p = presetDe(d.tipo);
  return {
    id: doc.id, ambito: 'global', tipo: String(d.tipo || 'general'), titulo: String(d.titulo || ''), texto: String(d.descripcion || ''),
    enlace: String(d.enlace || ''), icono: String(d.icono || p.icono), color: String(d.color || p.color), fecha: aIso(d.creadoEn)
  };
}

// Mezcla las últimas 30 personales y 15 globales, más recientes primero, máximo 40.
async function listarAvisos(db, uid) {
  const [personales, globales] = await Promise.all([
    coleccionPersonal(db, uid).orderBy('creadoEn', 'desc').limit(MAX_PERSONALES).get(),
    db.collection('notificacionesGlobales').orderBy('creadoEn', 'desc').limit(MAX_GLOBALES).get()
  ]);
  return [...personales.docs.map(vistaPersonal), ...globales.docs.map(vistaGlobal)]
    .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0))
    .slice(0, MAX_TOTAL);
}

// Últimos 50 avisos globales (panel de administración)
async function listarGlobalesAdmin(db) {
  const snap = await db.collection('notificacionesGlobales').orderBy('creadoEn', 'desc').limit(MAX_ADMIN_GLOBALES).get();
  return snap.docs.map(doc => ({ ...vistaGlobal(doc), origen: (doc.data() || {}).origen === 'admin' ? 'admin' : 'auto' }));
}

module.exports = {
  TIPOS_PERSONALES, TIPOS_GLOBALES, LIMITES, PRESETS, presetDe,
  crearAviso, crearNotificacionGlobal, listarAvisos, listarGlobalesAdmin
};
