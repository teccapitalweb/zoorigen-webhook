'use strict';

// Piezas comunes de los generadores de Excel y PowerPoint de Zoorigen.
// Identidad: verde de marca #1F5F3A, acentos dorado #E8A317 y naranja #C75402; colores sólidos (sin degradados).
// SOLO se usa para GENERAR los archivos (devDependencies de esta carpeta): el servidor nunca carga exceljs ni pptxgenjs.

const VERSION = '1.0';
const FECHA = '2026-10-22';
const FECHA_TEXTO = '22 de octubre de 2026';
const COLOR = Object.freeze({
  verde: '1F5F3A', verdeMedio: '2F7A4F', verdeClaro: 'E7F0E9', dorado: 'E8A317', doradoClaro: 'FBF1D8', naranja: 'C75402',
  tinta: '1D2A22', gris: '6B7A70', grisClaro: 'F1F3EF', linea: 'D8DDD6', blanco: 'FFFFFF', rojo: 'B42318', rojoClaro: 'FDE7E4',
  ambar: 'B7791F', ambarClaro: 'FDEFD0', azul: '1F5F8F', azulClaro: 'E4EFF8'
});
const AVISO_GENERAL = 'Material de apoyo de Zoorigen: no sustituye el criterio profesional ni la asesoría legal. Consulta siempre la normatividad vigente.';

// Dos columnas de letras A, B, ... AA
function letra(n) { let s = ''; let x = n; while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; }

module.exports = { VERSION, FECHA, FECHA_TEXTO, COLOR, AVISO_GENERAL, letra };
