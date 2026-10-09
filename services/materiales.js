'use strict';

// ══ MATERIALES (PDF) ══
// Catálogo: data/materiales/catalogo.json (lista). Archivos: data/materiales/<archivo>.pdf. Se leen UNA vez al arrancar.
// El único camino al disco es el catálogo VALIDADO: el archivo debe llamarse como <algo>.pdf (sin carpetas ni ".."),
// existir dentro de la carpeta de materiales (también tras resolver enlaces simbólicos) y empezar con "%PDF-".
// Lo inválido se descarta con aviso en consola y queda en `errores` (nunca con la ruta del disco).
// Acceso:  'miembros' abre con membresía vigente · 'retos' abre con membresía y retos superados >= requiereRetos
//          · administrador: todo abierto · sin membresía: nada abre.

const fs = require('fs');
const path = require('path');
const { limpiarTexto, urlHttps } = require('./texto');

const ID_MATERIAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARCHIVO_PDF = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/;
const TIPOS = Object.freeze(['guia', 'plantilla', 'checklist', 'glosario', 'infografia', 'presentacion']);
const ACCESOS = Object.freeze(['miembros', 'retos']);
const ETIQUETA = /<[a-z/!?]/i;
const ID_MAXIMO = 60;
const BYTES_CATALOGO = 1024 * 1024;
const BYTES_PDF_MAXIMO = 30 * 1024 * 1024;
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
  if (!ACCESOS.includes(crudo.acceso)) falla('"acceso" debe ser "miembros" o "retos"');
  if (typeof crudo.archivo !== 'string' || !ARCHIVO_PDF.test(crudo.archivo)) {
    falla('"archivo" debe ser un nombre como <id>.pdf (sin carpetas, sin "..", en minúsculas)');
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
    falla('Un material de acceso "miembros" no lleva "requiereRetos"');
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

// Comprueba en disco que el archivo existe DENTRO de la carpeta de materiales y es un PDF. Devuelve la ruta real.
function verificarArchivo(carpeta, archivo) {
  const base = fs.realpathSync(carpeta);
  let real;
  try { real = fs.realpathSync(path.join(base, archivo)); } catch (_) { return falla('No se encontró el archivo PDF'); }
  const relativa = path.relative(base, real);
  if (!relativa || relativa.startsWith('..') || path.isAbsolute(relativa) || relativa.includes(path.sep)) {
    falla('El archivo PDF debe estar directamente dentro de la carpeta de materiales');
  }
  const info = fs.statSync(real);
  if (!info.isFile()) falla('El PDF no es un archivo normal');
  if (info.size < 8) falla('El archivo PDF está vacío');
  if (info.size > BYTES_PDF_MAXIMO) falla('El archivo PDF pesa más de 30 MB');
  const fd = fs.openSync(real, 'r');
  try {
    const cabecera = Buffer.alloc(5);
    fs.readSync(fd, cabecera, 0, 5, 0);
    if (cabecera.toString('latin1') !== '%PDF-') falla('El archivo no es un PDF válido');
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
      const { real, bytes } = verificarArchivo(carpeta, m.archivo);
      vistos.add(m.id);
      materiales.push({ ...m, ruta: real, bytes });
    } catch (error) {
      registrarError(referencia, error instanceof ErrorMaterial ? error.message : 'No se pudo revisar el archivo');
    }
  });
  return { materiales, errores };
}

// ── Estado de acceso ──  estado: { superados, membresia, esAdmin }
function acceso(material, estado) {
  const e = estado || {};
  const superados = Number.isInteger(e.superados) && e.superados > 0 ? e.superados : 0;
  const membresia = Boolean(e.esAdmin || e.membresia);
  let desbloqueado = false;
  if (e.esAdmin) desbloqueado = true;
  else if (e.membresia) desbloqueado = material.acceso === 'miembros' || superados >= material.requiereRetos;
  const faltan = desbloqueado || material.acceso !== 'retos' ? 0 : Math.max(0, material.requiereRetos - (membresia ? superados : 0));
  return { desbloqueado, faltan, soloMiembros: !membresia };
}

// Lo que se lista (sin ruta, sin nombre de archivo, sin tamaño)
function resumenMaterial(material, estado) {
  const a = acceso(material, estado);
  return {
    id: material.id, titulo: material.titulo, tipo: material.tipo, area: material.area, descripcion: material.descripcion,
    paginas: material.paginas, acceso: material.acceso, requiereRetos: material.requiereRetos || 0, licencia: material.licencia,
    desbloqueado: a.desbloqueado, faltan: a.faltan, soloMiembros: a.soloMiembros
  };
}

const resumenMateriales = (materiales, estado) => (materiales || []).map(m => resumenMaterial(m, estado));

// Busca por id EXACTO en el catálogo validado (jamás compone rutas con lo que escribe el cliente)
function buscarMaterial(materiales, id) {
  if (typeof id !== 'string' || id.length > ID_MAXIMO || !ID_MATERIAL.test(id)) return null;
  return (materiales || []).find(m => m.id === id) || null;
}

module.exports = {
  ID_MATERIAL, ARCHIVO_PDF, TIPOS, ACCESOS,
  normalizarMaterial, verificarArchivo, cargarMateriales, acceso, resumenMaterial, resumenMateriales, buscarMaterial
};
