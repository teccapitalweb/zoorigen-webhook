'use strict';

// Carpetas temporales de libros y materiales para las pruebas (nada se escribe en data/).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PDF_PRUEBA = path.join(__dirname, '..', 'fixtures', 'materiales', 'guia-prueba.pdf');
// Documento de Office minimo para las pruebas: lo unico que el servidor revisa es la firma ZIP (bytes 50 4B 03 04), asi que basta con esto
const OFFICE_PRUEBA = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(96, 7)]);
const LIBRO_PRUEBA = path.join(__dirname, '..', 'fixtures', 'libros', 'libro-prueba.json');

const carpetaTemporal = prefijo => fs.mkdtempSync(path.join(os.tmpdir(), `zoo-${prefijo}-`));

// Libro válido con ese id y umbral (3 páginas)
function libroValido(id, requiereRetos, extra = {}) {
  return {
    id, titulo: `Libro ${id}`, subtitulo: 'Subtítulo de prueba', autor: 'Equipo Zoorigen', categoria: 'Pruebas', color: '#2F7A4F',
    icono: '📘', resumen: `Resumen del libro ${id} para las pruebas.`, requiereRetos, actualizado: '2026-10-01',
    fuentes: [{ nombre: 'Fuente', url: 'https://example.org/f' }],
    paginas: [1, 2, 3].map(n => ({ titulo: `Página ${n} de ${id}`, parrafos: [`Texto secreto ${n} de ${id}.`] })),
    ...extra
  };
}

// Crea una carpeta con estos libros (objetos) y devuelve su ruta
function carpetaLibros(libros) {
  const dir = carpetaTemporal('libros');
  for (const l of libros) fs.writeFileSync(path.join(dir, `${l.id}.json`), JSON.stringify(l));
  return dir;
}

// Crea una carpeta de materiales: entradas = lista de entradas del catálogo; cada archivo declarado se crea con el PDF de prueba (o con un Office mínimo si es .xlsx o .pptx)
function carpetaMateriales(entradas, { crearArchivos = true } = {}) {
  const dir = carpetaTemporal('mats');
  fs.writeFileSync(path.join(dir, 'catalogo.json'), JSON.stringify(entradas));
  if (crearArchivos) {
    for (const e of entradas) {
      if (e && typeof e.archivo === 'string' && /^[a-z0-9-]+\.pdf$/.test(e.archivo)) fs.copyFileSync(PDF_PRUEBA, path.join(dir, e.archivo));
      else if (e && typeof e.archivo === 'string' && /^[a-z0-9-]+\.(xlsx|pptx)$/.test(e.archivo)) fs.writeFileSync(path.join(dir, e.archivo), OFFICE_PRUEBA);
    }
  }
  return dir;
}

function materialValido(id, acceso = 'miembros', requiereRetos, extra = {}) {
  return {
    id, titulo: `Material ${id}`, tipo: 'guia', area: 'Pruebas', descripcion: `Descripción de ${id}.`, archivo: `${id}.${{ excel: 'xlsx', powerpoint: 'pptx' }[extra.tipo] || 'pdf'}`,
    paginas: 1, acceso, ...(acceso === 'retos' ? { requiereRetos } : {}), licencia: 'Uso interno de pruebas', ...extra
  };
}

module.exports = { PDF_PRUEBA, OFFICE_PRUEBA, LIBRO_PRUEBA, carpetaTemporal, libroValido, carpetaLibros, carpetaMateriales, materialValido };
