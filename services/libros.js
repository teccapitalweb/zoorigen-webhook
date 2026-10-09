'use strict';

// ══ LIBROS que se desbloquean con retos (lectura dentro de la plataforma) ══
// Contenido: data/libros/<id>.json (se lee UNA vez al arrancar). Todo lo inválido se descarta con un aviso en
// consola y queda anotado en `errores` (lo ve la administración en GET /api/admin/libros).
// Reglas de acceso (módulo puro, sin Express ni Firestore):
//   · administrador: todo desbloqueado.
//   · sin membresía vigente: los libros se listan, pero desbloqueado=false y soloMiembros=true.
//   · con membresía: se desbloquea al superar `requiereRetos` retos (el conteo sale de services/retos.js).

const fs = require('fs');
const path = require('path');
const { limpiarTexto, urlHttps } = require('./texto');
const avisos = require('./avisos');

const ID_LIBRO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_MAXIMO = 60;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ETIQUETA = /<[a-z/!?]/i; // cualquier "<" que abra una etiqueta, cierre, comentario o instrucción
const PAGINAS_MIN = 3;
const PAGINAS_MAX = 40;
const RETOS_MIN = 1;
const RETOS_MAX = 200;
const BYTES_MAXIMOS = 1024 * 1024;
const ENLACE_AVISO = 'club-pdfs.html';

const L = Object.freeze({
  titulo: 140, subtitulo: 220, autor: 120, categoria: 60, icono: 16, resumen: 600,
  paginaTitulo: 160, parrafo: 4000, item: 600, fuentes: 40, fuenteNombre: 220, revisionItems: 40, revisionTexto: 800
});

// ── Validación ──
class ErrorLibro extends Error {}
const falla = mensaje => { throw new ErrorLibro(mensaje); };

// Texto de una línea (o con saltos) sin etiquetas; lanza ErrorLibro si no sirve
function cadena(valor, campo, max, { minimo = 1, saltos = false, opcional = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (opcional) return '';
    falla(`Falta "${campo}"`);
  }
  if (typeof valor !== 'string') falla(`"${campo}" debe ser texto`);
  const t = limpiarTexto(valor, { saltos });
  if (ETIQUETA.test(t)) falla(`"${campo}" no puede llevar etiquetas HTML`);
  if (t.length < minimo) falla(`"${campo}" está vacío`);
  if (t.length > max) falla(`"${campo}" es demasiado largo (máximo ${max} caracteres)`);
  return t;
}

function listaDeTextos(valor, campo, maxItems, maxTexto, { opcional = true, minimo = 1 } = {}) {
  if (valor === undefined || valor === null) {
    if (opcional) return undefined;
    falla(`Falta "${campo}"`);
  }
  if (!Array.isArray(valor)) falla(`"${campo}" debe ser una lista`);
  if (valor.length < minimo) falla(`"${campo}" no puede estar vacía`);
  if (valor.length > maxItems) falla(`"${campo}" tiene demasiados elementos (máximo ${maxItems})`);
  return valor.map((v, i) => cadena(v, `${campo}[${i + 1}]`, maxTexto, { saltos: true }));
}

// Revisión (preguntas de repaso u otro apoyo): estructura libre pero acotada y sin etiquetas
function limpiarLibre(valor, campo, profundidad = 0) {
  if (typeof valor === 'string') return cadena(valor, campo, L.revisionTexto, { saltos: true, minimo: 0, opcional: true });
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : falla(`"${campo}" tiene un número no válido`);
  if (typeof valor === 'boolean') return valor;
  if (profundidad >= 3) falla(`"${campo}" está demasiado anidado`);
  if (Array.isArray(valor)) {
    if (valor.length > L.revisionItems) falla(`"${campo}" tiene demasiados elementos`);
    return valor.map((v, i) => limpiarLibre(v, `${campo}[${i + 1}]`, profundidad + 1));
  }
  if (valor && typeof valor === 'object') {
    const claves = Object.keys(valor);
    if (claves.length > 12) falla(`"${campo}" tiene demasiados campos`);
    const salida = {};
    for (const k of claves) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) falla(`"${campo}" tiene un nombre de campo no válido`);
      salida[k] = limpiarLibre(valor[k], `${campo}.${k}`, profundidad + 1);
    }
    return salida;
  }
  return falla(`"${campo}" tiene un valor no válido`);
}

// Devuelve el libro normalizado (solo campos conocidos) o lanza ErrorLibro con el motivo en español.
function normalizarLibro(crudo) {
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) falla('El archivo debe contener un objeto JSON');
  const id = typeof crudo.id === 'string' ? crudo.id : '';
  if (!id || id.length > ID_MAXIMO || !ID_LIBRO.test(id)) falla('El "id" solo puede llevar minúsculas, números y guiones');
  if (!Number.isInteger(crudo.requiereRetos) || crudo.requiereRetos < RETOS_MIN || crudo.requiereRetos > RETOS_MAX) {
    falla(`"requiereRetos" debe ser un entero de ${RETOS_MIN} a ${RETOS_MAX}`);
  }
  if (typeof crudo.color !== 'string' || !COLOR.test(crudo.color)) falla('"color" debe ser un color como #2F7A4F');
  if (typeof crudo.actualizado !== 'string' || !FECHA.test(crudo.actualizado) || Number.isNaN(Date.parse(crudo.actualizado))) {
    falla('"actualizado" debe ser una fecha AAAA-MM-DD');
  }

  const libro = {
    id,
    titulo: cadena(crudo.titulo, 'titulo', L.titulo, { minimo: 3 }),
    subtitulo: cadena(crudo.subtitulo, 'subtitulo', L.subtitulo, { opcional: true }),
    autor: cadena(crudo.autor, 'autor', L.autor),
    categoria: cadena(crudo.categoria, 'categoria', L.categoria),
    color: crudo.color,
    icono: cadena(crudo.icono, 'icono', L.icono),
    resumen: cadena(crudo.resumen, 'resumen', L.resumen, { minimo: 10, saltos: true }),
    requiereRetos: crudo.requiereRetos,
    actualizado: crudo.actualizado
  };

  if (crudo.fuentes !== undefined) {
    if (!Array.isArray(crudo.fuentes)) falla('"fuentes" debe ser una lista');
    if (crudo.fuentes.length > L.fuentes) falla(`"fuentes" tiene demasiados elementos (máximo ${L.fuentes})`);
    libro.fuentes = crudo.fuentes.map((f, i) => {
      if (!f || typeof f !== 'object') falla(`La fuente ${i + 1} no es válida`);
      const url = urlHttps(f.url);
      if (!url) falla(`La fuente ${i + 1} necesita una dirección https válida`);
      return { nombre: cadena(f.nombre, `fuentes[${i + 1}].nombre`, L.fuenteNombre), url };
    });
  } else libro.fuentes = [];

  if (!Array.isArray(crudo.paginas)) falla('"paginas" debe ser una lista');
  if (crudo.paginas.length < PAGINAS_MIN || crudo.paginas.length > PAGINAS_MAX) {
    falla(`El libro debe tener de ${PAGINAS_MIN} a ${PAGINAS_MAX} páginas (tiene ${crudo.paginas.length})`);
  }
  libro.paginas = crudo.paginas.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) falla(`La página ${i + 1} no es válida`);
    const pagina = {
      titulo: cadena(p.titulo, `paginas[${i + 1}].titulo`, L.paginaTitulo),
      parrafos: listaDeTextos(p.parrafos, `paginas[${i + 1}].parrafos`, 30, L.parrafo, { opcional: false })
    };
    const lista = listaDeTextos(p.lista, `paginas[${i + 1}].lista`, 30, L.item);
    if (lista && lista.length) pagina.lista = lista;
    return pagina;
  });

  if (crudo.revision !== undefined) {
    if (!Array.isArray(crudo.revision)) falla('"revision" debe ser una lista');
    libro.revision = limpiarLibre(crudo.revision, 'revision');
  }
  if (crudo.prueba === true) libro.prueba = true;
  return libro;
}

// ── Carga desde disco ──
// Devuelve { libros, errores } (libros ordenados por requiereRetos y luego id). Nunca lanza.
// `errores`: [{ archivo, error }] con el nombre del archivo (nunca la ruta del disco).
function cargarLibros(carpeta, { avisar = true } = {}) {
  const libros = [];
  const errores = [];
  const registrarError = (archivo, error) => {
    errores.push({ archivo, error });
    if (avisar) console.warn(`[Libros] Se descartó "${archivo}": ${error}`);
  };

  let nombres;
  try {
    nombres = fs.readdirSync(carpeta);
  } catch (_) {
    registrarError('(carpeta de libros)', 'No se pudo leer la carpeta de libros');
    return { libros, errores };
  }

  const vistos = new Set();
  for (const nombre of nombres.filter(n => n.toLowerCase().endsWith('.json')).sort()) {
    try {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(nombre)) falla('El nombre del archivo debe ser <id>.json (minúsculas, números y guiones)');
      const ruta = path.join(carpeta, nombre);
      const info = fs.lstatSync(ruta);
      if (!info.isFile()) falla('No es un archivo normal');
      if (info.size > BYTES_MAXIMOS) falla('El archivo pesa más de 1 MB');
      let crudo;
      try { crudo = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (_) { falla('El archivo no es un JSON válido'); }
      const libro = normalizarLibro(crudo);
      if (nombre !== `${libro.id}.json`) falla(`El nombre del archivo debe coincidir con el id ("${libro.id}.json")`);
      if (vistos.has(libro.id)) falla('Ya existe otro libro con ese id');
      vistos.add(libro.id);
      libros.push(libro);
    } catch (error) {
      registrarError(nombre, error instanceof ErrorLibro ? error.message : 'No se pudo leer el archivo');
    }
  }
  libros.sort((a, b) => a.requiereRetos - b.requiereRetos || (a.id < b.id ? -1 : 1));
  return { libros, errores };
}

// ── Estado de acceso ──
// estado: { superados, membresia, esAdmin }
function acceso(libro, estado) {
  const e = estado || {};
  const superados = Number.isInteger(e.superados) && e.superados > 0 ? e.superados : 0;
  const membresia = Boolean(e.esAdmin || e.membresia);
  const desbloqueado = Boolean(e.esAdmin) || (Boolean(e.membresia) && superados >= libro.requiereRetos);
  const faltan = desbloqueado ? 0 : Math.max(0, libro.requiereRetos - (membresia ? superados : 0));
  return { desbloqueado, faltan, soloMiembros: !membresia };
}

// Lo que se lista: NUNCA lleva páginas, fuentes ni revisión
function resumenLibro(libro, estado) {
  const a = acceso(libro, estado);
  return {
    id: libro.id, titulo: libro.titulo, subtitulo: libro.subtitulo, autor: libro.autor, categoria: libro.categoria,
    color: libro.color, icono: libro.icono, resumen: libro.resumen, paginasTotal: libro.paginas.length,
    requiereRetos: libro.requiereRetos, desbloqueado: a.desbloqueado, faltan: a.faltan, soloMiembros: a.soloMiembros
  };
}

function resumenLibros(libros, estado) {
  return (libros || []).map(l => resumenLibro(l, estado));
}

// Libro completo (meta + páginas) solo si la persona lo tiene desbloqueado; si no, null
function libroCompleto(libro, estado) {
  if (!libro || !acceso(libro, estado).desbloqueado) return null;
  return {
    ...resumenLibro(libro, estado), actualizado: libro.actualizado, fuentes: libro.fuentes, paginas: libro.paginas,
    ...(libro.revision ? { revision: libro.revision } : {}), ...(libro.prueba ? { prueba: true } : {})
  };
}

const cuantos = v => (v && typeof v === 'object' ? v.superados : v);

// Libros que cruzan su umbral con este avance (antes < requiere <= despues). Acepta números o estados de retos.
// Si se cruzan varios umbrales de golpe, salen todos, del menor al mayor.
function librosNuevos(libros, antes, despues) {
  const a = Number.isInteger(cuantos(antes)) ? cuantos(antes) : 0;
  const d = Number.isInteger(cuantos(despues)) ? cuantos(despues) : 0;
  return (libros || [])
    .filter(l => a < l.requiereRetos && d >= l.requiereRetos)
    .map(l => ({ id: l.id, titulo: l.titulo, requiereRetos: l.requiereRetos }));
}

// ── Avisos en la campana ──
// Un aviso por libro ya ganado. Id fijo (libro_<id>): sale una sola vez aunque se llame muchas veces, así que
// también avisa a quien ganó sus retos antes de que existiera el libro. Los administradores y quien no tiene
// membresía no reciben avisos. NUNCA lanza. Devuelve la cantidad de avisos creados.
async function avisarLibros(db, uid, libros, estado) {
  let creados = 0;
  try {
    if (!estado || estado.esAdmin || !estado.membresia) return 0;
    const desbloqueados = (libros || []).filter(l => acceso(l, estado).desbloqueado);
    for (const libro of desbloqueados) {
      const primero = libro.id === (libros[0] && libros[0].id);
      const r = await avisos.crearAviso(db, uid, {
        id: `libro_${libro.id}`,
        tipo: 'libro',
        titulo: primero ? '¡Desbloqueaste tu primer libro!' : '¡Desbloqueaste un nuevo libro!',
        texto: `Superaste ${estado.superados} retos: ya puedes leer «${libro.titulo}» en PDFs y materiales.`,
        enlace: ENLACE_AVISO
      });
      if (r && r.creado) creados += 1;
    }
  } catch (error) {
    console.warn('[Libros] No se pudieron crear los avisos de libros:', error && error.message);
  }
  return creados;
}

module.exports = {
  ID_LIBRO, PAGINAS_MIN, PAGINAS_MAX, RETOS_MIN, RETOS_MAX, ENLACE_AVISO,
  normalizarLibro, cargarLibros, acceso, resumenLibro, resumenLibros, libroCompleto, librosNuevos, avisarLibros
};
