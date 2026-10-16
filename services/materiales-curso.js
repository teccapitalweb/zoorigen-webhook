'use strict';

// ══ MATERIALES LIGADOS A UN CURSO Y A UNA CLASE ══
// Un material (PDF) puede ir ligado a un curso y, dentro del curso, a una clase:
//   · con curso y clase N  → se abre cuando la persona TERMINA la clase N de ese curso (la marcó como vista; el servidor ya
//                            exigió el orden, las preguntas y el juego para registrarla). Es la regla "por clases".
//   · con curso y sin clase → material general del curso: se abre con membresía vigente.
//   · sin curso y con `requiereRetos` N → se abre con membresía y N retos superados (igual que los libros).
//   · sin curso ni retos → se abre con membresía vigente.
//   · administrador: todo abierto · sin membresía: nada abre (el catálogo sí se ve, con el candado "Solo para miembros").
// Dos fuentes comparten estas reglas:
//   1) el catálogo de archivos del servidor (data/materiales/catalogo.json), con `acceso: "curso"`, `cursoId` y `clase`;
//   2) la colección `pdfs` de Firestore (la que llena el administrador desde el panel con un enlace de Drive), con los campos
//      opcionales `cursoId`, `clase` y `requiereRetos`.
// El enlace de Drive y los archivos los entrega SOLO el servidor, y solo a quien cumple la regla (rutas-materiales.js).
// Nada de aquí lee ni escribe Firestore: las funciones son puras y se prueban sin servidor.

const { texto } = require('./texto');

const ID_CURSO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}$/;
const ID_DRIVE = /^[A-Za-z0-9_-]{10,200}$/;
const CLASE_MAX = 500;
const RETOS_MAX = 200;

// Id de curso válido o '' (nunca compone rutas con lo que escribe el cliente: solo se usa como clave de documento)
function idCurso(valor) {
  return typeof valor === 'string' && ID_CURSO.test(valor.trim()) ? valor.trim() : '';
}

// Número de clase tal como lo ve la persona (1 = primera clase). 0 = sin clase (material de todo el curso).
function numeroClase(valor) {
  const n = typeof valor === 'string' && /^\d{1,3}$/.test(valor.trim()) ? Number(valor.trim()) : valor;
  return Number.isInteger(n) && n >= 1 && n <= CLASE_MAX ? n : 0;
}

function retosRequeridos(valor) {
  const n = typeof valor === 'string' && /^\d{1,3}$/.test(valor.trim()) ? Number(valor.trim()) : valor;
  return Number.isInteger(n) && n >= 1 && n <= RETOS_MAX ? n : 0;
}

// Enlace de Drive que se entrega a quien tiene permiso (nunca se arma con texto libre: solo con el id validado)
function enlacesDrive(driveId) {
  if (typeof driveId !== 'string' || !ID_DRIVE.test(driveId)) return null;
  return { ver: `https://drive.google.com/file/d/${driveId}/view`, vista: `https://drive.google.com/file/d/${driveId}/preview` };
}

// Normaliza un documento de `pdfs/{id}` (lo escribe el administrador). Devuelve null si no sirve para mostrarse.
// Un `cursoId` escrito pero inválido NO se ignora (el material quedaría abierto sin querer): se marca `configuracionInvalida`.
function normalizarPdfDrive(id, doc) {
  if (typeof id !== 'string' || !id || !doc || typeof doc !== 'object') return null;
  const titulo = texto(doc.title, 140);
  const driveId = typeof doc.driveId === 'string' ? doc.driveId.trim() : '';
  if (!titulo || !ID_DRIVE.test(driveId)) return null;
  const crudoCurso = doc.cursoId === undefined || doc.cursoId === null ? '' : String(doc.cursoId).trim();
  const cursoId = idCurso(crudoCurso);
  const crudoClase = doc.clase === undefined || doc.clase === null || doc.clase === '' ? 0 : doc.clase;
  const clase = numeroClase(crudoClase);
  const paginas = Number.isInteger(doc.pages) && doc.pages > 0 && doc.pages <= 2000 ? doc.pages : 0;
  return {
    id, fuente: 'drive', titulo, area: texto(doc.area, 60) || 'General', paginas, driveId,
    cursoId, clase: cursoId ? clase : 0, requiereRetos: cursoId ? 0 : retosRequeridos(doc.requiereRetos),
    configuracionInvalida: Boolean((crudoCurso && !cursoId) || (crudoClase && !clase)),
    creado: typeof doc.createdAt === 'string' ? doc.createdAt : ''
  };
}

// Qué clase de regla usa un material
function condicionDe(m) {
  if (m && m.cursoId) return m.clase ? 'clase' : 'curso';
  if (m && m.requiereRetos > 0) return 'retos';
  return 'miembros';
}

const esConjunto = v => v instanceof Set;

// ── Estado de acceso ──
// estado: { membresia, esAdmin, superados, vistas: Map<cursoId, Set<índice de clase desde 0>>, cursos: Map<cursoId, { titulo, total } | null> }
// Devuelve { desbloqueado, condicion, faltan (retos), soloMiembros, cursoTitulo, pendiente (curso o clase que no existen) }.
function acceso(m, estado) {
  const e = estado || {};
  const condicion = condicionDe(m);
  const membresia = Boolean(e.esAdmin || e.membresia);
  const superados = Number.isInteger(e.superados) && e.superados > 0 ? e.superados : 0;
  const info = m.cursoId && e.cursos instanceof Map ? e.cursos.get(m.cursoId) : undefined;
  const cursoTitulo = info && info.titulo ? info.titulo : '';
  // Ligado a un curso que no existe, o a una clase que el curso no tiene: se ve, pero nadie (salvo el administrador) lo abre
  // hasta que se corrija en el panel; así un error de captura no deja el material abierto ni cerrado para siempre sin aviso.
  const pendiente = Boolean(m.configuracionInvalida) ||
    Boolean(m.cursoId && e.cursos instanceof Map && (!info || (m.clase && info.total > 0 && m.clase > info.total)));
  let desbloqueado = false;
  if (e.esAdmin) desbloqueado = true;
  else if (e.membresia && !pendiente) {
    if (condicion === 'clase') {
      const vistas = e.vistas instanceof Map ? e.vistas.get(m.cursoId) : null;
      desbloqueado = esConjunto(vistas) && vistas.has(m.clase - 1);
    } else if (condicion === 'retos') desbloqueado = superados >= m.requiereRetos;
    else desbloqueado = true;
  }
  const faltan = desbloqueado || condicion !== 'retos' ? 0 : Math.max(0, m.requiereRetos - (membresia ? superados : 0));
  return { desbloqueado, condicion, faltan, soloMiembros: !membresia, cursoTitulo, pendiente };
}

// Campos que se suman al resumen de un material cuando está ligado a un curso o pide retos (nunca llevan ruta, archivo ni enlace)
function camposDeCondicion(m, a) {
  const campos = { condicion: a.condicion };
  if (m.cursoId) {
    campos.cursoId = m.cursoId;
    campos.clase = m.clase || 0;
    campos.cursoTitulo = a.cursoTitulo || '';
    if (a.pendiente) campos.pendiente = true;
  }
  return campos;
}

// Resumen de un PDF de Drive para la lista (sin driveId ni enlaces)
function resumenPdfDrive(m, estado) {
  const a = acceso(m, estado);
  return {
    id: m.id, fuente: 'drive', titulo: m.titulo, area: m.area, paginas: m.paginas, requiereRetos: m.requiereRetos,
    ...camposDeCondicion(m, a), desbloqueado: a.desbloqueado, faltan: a.faltan, soloMiembros: a.soloMiembros
  };
}

// Códigos y mensajes cuando no se puede abrir (en español, sin datos internos)
function bloqueo(m, estado) {
  const a = acceso(m, estado);
  if (a.desbloqueado) return null;
  if (a.soloMiembros) return { codigo: 'membresia-requerida', mensaje: 'Los materiales son parte de la membresía. Activa tu suscripción para abrirlos' };
  if (a.pendiente) return { codigo: 'material-no-disponible', mensaje: 'Este material todavía no está disponible. Estamos terminando de prepararlo' };
  if (a.condicion === 'clase') {
    return { codigo: 'clase-pendiente', mensaje: `Se desbloquea al terminar la clase ${m.clase} del curso${a.cursoTitulo ? ' «' + a.cursoTitulo + '»' : ''}` };
  }
  return { codigo: 'retos-insuficientes', mensaje: `Todavía está bloqueado: ${a.faltan === 1 ? 'te falta 1 reto' : 'te faltan ' + a.faltan + ' retos'} por superar` };
}

// Une las dos fuentes y las agrupa por curso: { [cursoId]: [resumen...] } ordenado por clase y luego por título
function agruparPorCurso(resumenes) {
  const mapa = {};
  for (const r of resumenes) {
    if (!r.cursoId) continue;
    (mapa[r.cursoId] = mapa[r.cursoId] || []).push(r);
  }
  for (const lista of Object.values(mapa)) {
    lista.sort((a, b) => ((a.clase || 999) - (b.clase || 999)) || String(a.titulo).localeCompare(String(b.titulo), 'es'));
  }
  return mapa;
}

module.exports = {
  ID_CURSO, ID_DRIVE, CLASE_MAX, RETOS_MAX,
  idCurso, numeroClase, retosRequeridos, enlacesDrive, normalizarPdfDrive, condicionDe,
  acceso, camposDeCondicion, resumenPdfDrive, bloqueo, agruparPorCurso
};
