'use strict';

// ══ MATERIALES (PDF, Excel y PowerPoint) ══
// Catálogo: data/materiales/catalogo.json (lista). Archivos: data/materiales/<archivo>. Se leen UNA vez al arrancar.
// El archivo depende del tipo: los de siempre (guia, plantilla, checklist, glosario, infografia, presentacion) son .pdf; "excel" es .xlsx
// y "powerpoint" es .pptx. El único camino al disco es el catálogo VALIDADO: el nombre no lleva carpetas ni "..", el archivo existe dentro
// de la carpeta de materiales (también tras resolver enlaces simbólicos) y su firma coincide ("%PDF-" para PDF; ZIP para .xlsx y .pptx).
// Lo inválido se descarta con aviso en consola y queda en `errores` (nunca con la ruta del disco).
// Acceso:  'miembros' abre con membresía vigente · 'retos' abre con membresía y retos superados >= requiereRetos
//          · 'curso' (con "cursoId" y, opcional, "clase") abre con membresía cuando la persona terminó esa clase del curso
//            (services/materiales-curso.js) · administrador: todo abierto · sin membresía: nada abre.

const fs = require('fs');
const path = require('path');
const { limpiarTexto, urlHttps } = require('./texto');
const porCurso = require('./materiales-curso');

const ID_MATERIAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARCHIVO_PDF = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/;
const ARCHIVO_MATERIAL = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(pdf|xlsx|pptx)$/;
const TIPOS = Object.freeze(['guia', 'plantilla', 'checklist', 'glosario', 'infografia', 'presentacion', 'excel', 'powerpoint']);
// Formato del archivo que se entrega según el tipo (con su Content-Type correcto). Los de Office se descargan; el PDF se abre en la página.
const FORMATOS = Object.freeze({
  pdf: { extension: 'pdf', contentType: 'application/pdf', etiqueta: 'PDF', abreEnLinea: true },
  excel: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', etiqueta: 'Excel', abreEnLinea: false },
  powerpoint: { extension: 'pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', etiqueta: 'PowerPoint', abreEnLinea: false }
});
const formatoDe = tipo => (tipo === 'excel' ? 'excel' : tipo === 'powerpoint' ? 'powerpoint' : 'pdf');
const VERSION_MATERIAL = /^\d{1,3}(?:\.\d{1,3}){0,2}$/;
const FECHA_MATERIAL = /^\d{4}-\d{2}-\d{2}$/;
const ACCESOS = Object.freeze(['miembros', 'retos', 'curso']);
const ETIQUETA = /<[a-z/!?]/i;
const ID_MAXIMO = 60;
const BYTES_CATALOGO = 1024 * 1024;
const BYTES_ARCHIVO_MAXIMO = 30 * 1024 * 1024;
const RETOS_MIN = 1;
const RETOS_MAX = 200;
const L = Object.freeze({ titulo: 140, area: 60, descripcion: 400, licencia: 200, fuentes: 40, fuenteNombre: 220 });

class ErrorMaterial extends Error {}
const falla = mensaje => { throw new ErrorMaterial(mensaje); };

function cadena(valor, campo, max, { opcional = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (opcional) return '';
    falla(`Falta "${campo}"`);
  }
  if (typeof valor !== 'string') falla(`"${campo}" debe ser texto`);
  const t = limpiarTexto(valor);
  if (ETIQUETA.test(t)) falla(`"${campo}" no puede llevar etiquetas HTML`);
  if (!t) falla(`"${campo}" está vacío`);
  if (t.length > max) falla(`"${campo}" es demasiado largo (máximo ${max} caracteres)`);
  return t;
}

// Valida una entrada del catálogo (sin tocar el disco). Devuelve la entrada normalizada o lanza ErrorMaterial.
function normalizarMaterial(crudo) {
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) falla('La entrada debe ser un objeto');
  const id = typeof crudo.id === 'string' ? crudo.id : '';
  if (!id || id.length > ID_MAXIMO || !ID_MATERIAL.test(id)) falla('El "id" solo puede llevar minúsculas, números y guiones');
  if (!TIPOS.includes(crudo.tipo)) falla(`"tipo" debe ser uno de: ${TIPOS.join(', ')}`);
  if (!ACCESOS.includes(crudo.acceso)) falla('"acceso" debe ser "miembros", "retos" o "curso"');
  const extension = FORMATOS[formatoDe(crudo.tipo)].extension;
  if (typeof crudo.archivo !== 'string' || !ARCHIVO_MATERIAL.test(crudo.archivo) || !crudo.archivo.endsWith('.' + extension)) {
    falla(`"archivo" debe ser un nombre como <id>.${extension} (sin carpetas, sin "..", en minúsculas) para el tipo "${crudo.tipo}"`);
  }
  if (!Number.isInteger(crudo.paginas) || crudo.paginas < 1 || crudo.paginas > 1000) falla('"paginas" debe ser un entero de 1 a 1000');

  const material = {
    id, titulo: cadena(crudo.titulo, 'titulo', L.titulo), tipo: crudo.tipo, area: cadena(crudo.area, 'area', L.area),
    descripcion: cadena(crudo.descripcion, 'descripcion', L.descripcion), archivo: crudo.archivo,
    paginas: crudo.paginas, acceso: crudo.acceso, licencia: cadena(crudo.licencia, 'licencia', L.licencia)
  };
  if (crudo.acceso === 'retos') {
    if (!Number.isInteger(crudo.requiereRetos) || crudo.requiereRetos < RETOS_MIN || crudo.requiereRetos > RETOS_MAX) {
      falla(`"requiereRetos" debe ser un entero de ${RETOS_MIN} a ${RETOS_MAX} cuando el acceso es "retos"`);
    }
    material.requiereRetos = crudo.requiereRetos;
  } else if (crudo.requiereRetos !== undefined && crudo.requiereRetos !== null) {
    falla(`Un material de acceso "${crudo.acceso}" no lleva "requiereRetos"`);
  }
  if (crudo.acceso === 'curso') {
    const cursoId = porCurso.idCurso(crudo.cursoId);
    if (!cursoId) falla('Un material de acceso "curso" necesita "cursoId" (el id del curso)');
    material.cursoId = cursoId;
    if (crudo.clase !== undefined && crudo.clase !== null) {
      const clase = porCurso.numeroClase(crudo.clase);
      if (!clase) falla('"clase" debe ser un entero de 1 a ' + porCurso.CLASE_MAX + ' (la primera clase es la 1)');
      material.clase = clase;
    } else material.clase = 0;
  } else if ((crudo.cursoId !== undefined && crudo.cursoId !== null) || (crudo.clase !== undefined && crudo.clase !== null)) {
    falla('Solo un material de acceso "curso" lleva "cursoId" y "clase"');
  }
  if (crudo.version !== undefined && crudo.version !== null) {
    if (typeof crudo.version !== 'string' || !VERSION_MATERIAL.test(crudo.version)) falla('"version" debe verse como 1.0');
    material.version = crudo.version;
  }
  if (crudo.fecha !== undefined && crudo.fecha !== null) {
    const f = typeof crudo.fecha === 'string' && FECHA_MATERIAL.test(crudo.fecha) ? new Date(crudo.fecha + 'T00:00:00Z') : null;
    if (!f || Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== crudo.fecha) falla('"fecha" debe ser AAAA-MM-DD');
    material.fecha = crudo.fecha;
  }
  if (crudo.fuentes !== undefined) {
    if (!Array.isArray(crudo.fuentes)) falla('"fuentes" debe ser una lista');
    if (crudo.fuentes.length > L.fuentes) falla(`"fuentes" tiene demasiados elementos (máximo ${L.fuentes})`);
    material.fuentes = crudo.fuentes.map((f, i) => {
      if (!f || typeof f !== 'object') falla(`La fuente ${i + 1} no es válida`);
      const url = urlHttps(f.url);
      if (!url) falla(`La fuente ${i + 1} necesita una dirección https válida`);
      return { nombre: cadena(f.nombre, `fuentes[${i + 1}].nombre`, L.fuenteNombre), url };
    });
  }
  return material;
}

// Comprueba en disco que el archivo existe DENTRO de la carpeta de materiales y que su firma corresponde al tipo
// (PDF, o ZIP para Excel y PowerPoint). Devuelve la ruta real.
function verificarArchivo(carpeta, archivo, tipo) {
  const base = fs.realpathSync(carpeta);
  let real;
  try { real = fs.realpathSync(path.join(base, archivo)); } catch (_) { return falla('No se encontró el archivo del material'); }
  const relativa = path.relative(base, real);
  if (!relativa || relativa.startsWith('..') || path.isAbsolute(relativa) || relativa.includes(path.sep)) {
    falla('El archivo debe estar directamente dentro de la carpeta de materiales');
  }
  const info = fs.statSync(real);
  if (!info.isFile()) falla('El material no es un archivo normal');
  if (info.size < 8) falla('El archivo del material está vacío');
  if (info.size > BYTES_ARCHIVO_MAXIMO) falla('El archivo del material pesa más de 30 MB');
  const fd = fs.openSync(real, 'r');
  try {
    const cabecera = Buffer.alloc(5);
    fs.readSync(fd, cabecera, 0, 5, 0);
    if (formatoDe(tipo) === 'pdf') {
      if (cabecera.toString('latin1') !== '%PDF-') falla('El archivo no es un PDF válido');
    } else if (cabecera.slice(0, 4).toString('latin1') !== 'PK\u0003\u0004') {
      falla('El archivo no es un documento de Office válido');
    }
  } finally { fs.closeSync(fd); }
  return { real, bytes: info.size };
}

// Carga catalogo.json. Devuelve { materiales, errores }; cada material lleva `ruta` (uso interno del servidor:
// nunca se muestra) y `bytes`. Nunca lanza.
function cargarMateriales(carpeta, { avisar = true } = {}) {
  const materiales = [];
  const errores = [];
  const registrarError = (referencia, error) => {
    errores.push({ referencia, error });
    if (avisar) console.warn(`[Materiales] Se descartó ${referencia}: ${error}`);
  };

  let lista;
  try {
    const ruta = path.join(carpeta, 'catalogo.json');
    const info = fs.statSync(ruta);
    if (!info.isFile() || info.size > BYTES_CATALOGO) throw new Error('catalogo');
    lista = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch (_) {
    registrarError('catalogo.json', 'No se pudo leer el catálogo de materiales (debe ser una lista JSON)');
    return { materiales, errores };
  }
  if (!Array.isArray(lista)) {
    registrarError('catalogo.json', 'El catálogo debe ser una lista');
    return { materiales, errores };
  }

  const vistos = new Set();
  lista.forEach((crudo, i) => {
    const referencia = crudo && typeof crudo.id === 'string' && ID_MATERIAL.test(crudo.id) ? `"${crudo.id}"` : `la entrada ${i + 1}`;
    try {
      const m = normalizarMaterial(crudo);
      if (vistos.has(m.id)) falla('Ya existe otro material con ese id');
      const { real, bytes } = verificarArchivo(carpeta, m.archivo, m.tipo);
      vistos.add(m.id);
      materiales.push({ ...m, ruta: real, bytes });
    } catch (error) {
      registrarError(referencia, error instanceof ErrorMaterial ? error.message : 'No se pudo revisar el archivo');
    }
  });
  return { materiales, errores };
}

// ── Estado de acceso ──  estado: { superados, membresia, esAdmin, vistas, cursos } (vistas y cursos: solo para los de acceso "curso")
function acceso(material, estado) {
  if (material.acceso === 'curso') {
    const a = porCurso.acceso({ cursoId: material.cursoId, clase: material.clase, requiereRetos: 0 }, estado);
    return { desbloqueado: a.desbloqueado, faltan: 0, soloMiembros: a.soloMiembros, cursoTitulo: a.cursoTitulo, pendiente: a.pendiente };
  }
  const e = estado || {};
  const superados = Number.isInteger(e.superados) && e.superados > 0 ? e.superados : 0;
  const membresia = Boolean(e.esAdmin || e.membresia);
  let desbloqueado = false;
  if (e.esAdmin) desbloqueado = true;
  else if (e.membresia) desbloqueado = material.acceso === 'miembros' || superados >= material.requiereRetos;
  const faltan = desbloqueado || material.acceso !== 'retos' ? 0 : Math.max(0, material.requiereRetos - (membresia ? superados : 0));
  return { desbloqueado, faltan, soloMiembros: !membresia };
}

// Lo que se lista (sin ruta ni nombre de archivo). `formato` dice qué se descarga (pdf, excel o powerpoint); `tamanoKb` es el tamaño aproximado en KB (el tamaño exacto no se publica).
function resumenMaterial(material, estado) {
  const a = acceso(material, estado);
  const resumen = {
    id: material.id, titulo: material.titulo, tipo: material.tipo, area: material.area, descripcion: material.descripcion,
    paginas: material.paginas, acceso: material.acceso, requiereRetos: material.requiereRetos || 0, licencia: material.licencia,
    desbloqueado: a.desbloqueado, faltan: a.faltan, soloMiembros: a.soloMiembros, formato: formatoDe(material.tipo)
  };
  if (Number.isInteger(material.bytes)) resumen.tamanoKb = Math.max(1, Math.round(material.bytes / 1024));
  if (material.version) resumen.version = material.version;
  if (material.fecha) resumen.fecha = material.fecha;
  // Solo los ligados a un curso suman estos campos (el resto conserva la forma de siempre)
  if (material.acceso === 'curso') Object.assign(resumen, porCurso.camposDeCondicion({ cursoId: material.cursoId, clase: material.clase }, { condicion: porCurso.condicionDe(material), cursoTitulo: a.cursoTitulo, pendiente: a.pendiente }));
  return resumen;
}

const resumenMateriales = (materiales, estado) => (materiales || []).map(m => resumenMaterial(m, estado));

// Busca por id EXACTO en el catálogo validado (jamás compone rutas con lo que escribe el cliente)
function buscarMaterial(materiales, id) {
  if (typeof id !== 'string' || id.length > ID_MAXIMO || !ID_MATERIAL.test(id)) return null;
  return (materiales || []).find(m => m.id === id) || null;
}

module.exports = {
  ID_MATERIAL, ARCHIVO_PDF, ARCHIVO_MATERIAL, TIPOS, ACCESOS, FORMATOS, formatoDe,
  normalizarMaterial, verificarArchivo, cargarMateriales, acceso, resumenMaterial, resumenMateriales, buscarMaterial
};
