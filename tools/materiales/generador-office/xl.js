'use strict';

// Ayudas para armar libros de Excel con exceljs: banda de título, hoja «Instrucciones», tablas con listas desplegables,
// columnas calculadas, formato condicional y filas de EJEMPLO que se pueden borrar.

const ExcelJS = require('exceljs');
const { COLOR, AVISO_GENERAL, VERSION, FECHA_TEXTO, letra } = require('./comun');

const FUENTE = 'Calibri';
const argb = c => 'FF' + c;
const relleno = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(c) }, bgColor: { argb: argb(c) } });
const borde = { top: { style: 'thin', color: { argb: argb(COLOR.linea) } }, left: { style: 'thin', color: { argb: argb(COLOR.linea) } }, bottom: { style: 'thin', color: { argb: argb(COLOR.linea) } }, right: { style: 'thin', color: { argb: argb(COLOR.linea) } } };

function libro(titulo, descripcion) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zoorigen'; wb.lastModifiedBy = 'Zoorigen'; wb.created = new Date('2026-10-22T12:00:00Z'); wb.modified = new Date('2026-10-22T12:00:00Z');
  wb.title = titulo; wb.subject = descripcion || titulo; wb.company = 'Zoorigen'; wb.keywords = 'Zoorigen; Club VIP; material de apoyo';
  wb.calcProperties = { fullCalcOnLoad: true };
  return wb;
}

// Banda verde con el título y una línea gris con el aviso; devuelve la fila siguiente libre
function banda(ws, titulo, subtitulo, columnas) {
  const ultima = letra(Math.max(columnas || 8, 2));
  ws.mergeCells(`A1:${ultima}1`);
  const t = ws.getCell('A1');
  t.value = titulo; t.font = { name: FUENTE, size: 16, bold: true, color: { argb: argb(COLOR.blanco) } };
  t.fill = relleno(COLOR.verde); t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;
  ws.mergeCells(`A2:${ultima}2`);
  const s = ws.getCell('A2');
  s.value = subtitulo || ('Zoorigen · Club VIP · Versión ' + VERSION + ' · ' + FECHA_TEXTO);
  s.font = { name: FUENTE, size: 10, italic: true, color: { argb: argb(COLOR.gris) } };
  s.fill = relleno(COLOR.doradoClaro); s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  ws.getRow(2).height = 22;
  return 4;
}

function hoja(wb, nombre, { color = COLOR.verde, congelar = null } = {}) {
  const ws = wb.addWorksheet(nombre, { properties: { tabColor: { argb: argb(color) } }, views: congelar ? [{ state: 'frozen', xSplit: congelar.x || 0, ySplit: congelar.y || 0, showGridLines: false }] : [{ showGridLines: false }] });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 1 };
  return ws;
}

// Hoja «Instrucciones»: objetivo, pasos, notas y el aviso general. Queda protegida (sin contraseña) para que no se borre por error.
function instrucciones(wb, { titulo, para, pasos = [], notas = [], ejemplo = true, hojas = [] }) {
  const ws = hoja(wb, 'Instrucciones', { color: COLOR.dorado });
  ws.columns = [{ width: 3 }, { width: 28 }, { width: 100 }];
  ws.mergeCells('A1:C1');
  const t = ws.getCell('A1'); t.value = titulo; t.font = { name: FUENTE, size: 18, bold: true, color: { argb: argb(COLOR.blanco) } };
  t.fill = relleno(COLOR.verde); t.alignment = { vertical: 'middle', indent: 1 }; ws.getRow(1).height = 34;
  ws.mergeCells('A2:C2');
  const s = ws.getCell('A2'); s.value = 'Zoorigen · Club VIP · Versión ' + VERSION + ' · ' + FECHA_TEXTO + ' · Material original de Zoorigen';
  s.font = { name: FUENTE, size: 10, italic: true, color: { argb: argb(COLOR.gris) } }; s.fill = relleno(COLOR.doradoClaro); s.alignment = { indent: 1 };
  let fila = 4;
  const titulillo = texto => {
    ws.mergeCells(`B${fila}:C${fila}`);
    const c = ws.getCell(`B${fila}`); c.value = texto; c.font = { name: FUENTE, size: 12, bold: true, color: { argb: argb(COLOR.verde) } };
    c.border = { bottom: { style: 'medium', color: { argb: argb(COLOR.dorado) } } }; fila += 1;
  };
  const parrafo = (a, b) => {
    const c1 = ws.getCell(`B${fila}`); const c2 = ws.getCell(`C${fila}`);
    c1.value = a; c1.font = { name: FUENTE, size: 11, bold: true, color: { argb: argb(COLOR.tinta) } }; c1.alignment = { vertical: 'top', wrapText: true };
    c2.value = b; c2.font = { name: FUENTE, size: 11, color: { argb: argb(COLOR.tinta) } }; c2.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(fila).height = Math.max(18, Math.ceil(String(b).length / 95) * 16 + 4);
    fila += 1;
  };
  titulillo('Para qué sirve');
  parrafo('', para);
  fila += 1;
  if (hojas.length) { titulillo('Qué hay en cada hoja'); hojas.forEach(([n, d]) => parrafo(n, d)); fila += 1; }
  titulillo('Cómo usarlo, paso a paso');
  pasos.forEach((p, i) => parrafo('Paso ' + (i + 1), p));
  fila += 1;
  titulillo('Colores y celdas');
  parrafo('Celdas blancas', 'Son para que escribas o elijas de una lista.');
  parrafo('Celdas grises', 'Se calculan solas con fórmulas: no las borres ni escribas encima.');
  if (ejemplo) parrafo('Filas de EJEMPLO', 'Las filas marcadas con la palabra EJEMPLO (fondo dorado claro) solo muestran cómo se llena. Bórralas antes de empezar con tus datos reales: selecciona la fila y usa «Eliminar contenido» para conservar las fórmulas.');
  fila += 1;
  if (notas.length) { titulillo('Ten en cuenta'); notas.forEach(n => parrafo('', n)); fila += 1; }
  titulillo('Aviso');
  parrafo('', AVISO_GENERAL);
  ws.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  return ws;
}

// Estilo de las celdas de una columna: 'entrada' (blanca, se llena), 'calc' (gris, fórmula)
function estiloCelda(cell, tipo, formato) {
  cell.font = { name: FUENTE, size: 11, color: { argb: argb(tipo === 'calc' ? COLOR.gris : COLOR.tinta) } };
  cell.border = borde;
  if (tipo === 'calc') cell.fill = relleno(COLOR.grisClaro);
  if (formato) cell.numFmt = formato;
  cell.alignment = { vertical: 'middle', wrapText: false };
  cell.protection = { locked: tipo === 'calc' };
}

/* Tabla con encabezado verde.
   cols: [{ clave, titulo, ancho, tipo: 'entrada' | 'calc', formato, lista: [..] | 'Hoja!$A$2:$A$50', fecha: true, numero: {min,max}, formula: fila => '...' }]
   opciones: { fila0, filas, ejemplos: [ {clave: valor...} ], notaEjemplo: 'clave de la columna donde va la palabra EJEMPLO' } */
function tabla(ws, cols, { fila0 = 4, filas = 200, ejemplos = [], columnaNota = null, altoCab = 34 } = {}) {
  const mapa = {};
  cols.forEach((c, i) => { mapa[c.clave] = letra(i + 1); ws.getColumn(i + 1).width = c.ancho || 16; });
  cols.forEach((c, i) => {
    const celda = ws.getCell(fila0, i + 1);
    celda.value = c.titulo;
    celda.font = { name: FUENTE, size: 11, bold: true, color: { argb: argb(COLOR.blanco) } };
    celda.fill = relleno(c.tipo === 'calc' ? COLOR.verdeMedio : COLOR.verde);
    celda.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    celda.border = borde;
  });
  ws.getRow(fila0).height = altoCab;
  const primera = fila0 + 1; const ultima = fila0 + filas;
  for (let r = primera; r <= ultima; r++) {
    cols.forEach((c, i) => {
      const celda = ws.getCell(r, i + 1);
      if (c.tipo === 'calc' && c.formula) celda.value = { formula: c.formula(r, mapa) };
      estiloCelda(celda, c.tipo === 'calc' ? 'calc' : 'entrada', c.formato);
    });
  }
  // listas desplegables y validaciones
  cols.forEach((c, i) => {
    const col = letra(i + 1); const rango = `${col}${primera}:${col}${ultima}`;
    if (c.lista) {
      const f = Array.isArray(c.lista) ? ['"' + c.lista.join(',') + '"'] : [c.lista];
      ws.dataValidations.add(rango, { type: 'list', allowBlank: true, formulae: f, showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Elige de la lista', error: 'Elige una opción de la lista desplegable.', showInputMessage: !!c.ayuda, promptTitle: c.titulo, prompt: c.ayuda || '' });
    } else if (c.fecha) {
      ws.dataValidations.add(rango, { type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(Date.UTC(1990, 0, 1))], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Fecha', error: 'Escribe una fecha válida, por ejemplo 15/03/2026.', showInputMessage: !!c.ayuda, promptTitle: c.titulo, prompt: c.ayuda || '' });
    } else if (c.numero) {
      ws.dataValidations.add(rango, { type: 'decimal', operator: 'between', allowBlank: true, formulae: [c.numero.min, c.numero.max], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Número', error: `Escribe un número entre ${c.numero.min} y ${c.numero.max}.`, showInputMessage: !!c.ayuda, promptTitle: c.titulo, prompt: c.ayuda || '' });
    } else if (c.ayuda && c.tipo !== 'calc') {
      ws.dataValidations.add(rango, { type: 'custom', allowBlank: true, formulae: ['TRUE'], showInputMessage: true, promptTitle: c.titulo, prompt: c.ayuda });
    }
  });
  // ejemplos
  ejemplos.forEach((ej, k) => {
    const r = primera + k;
    cols.forEach((c, i) => {
      if (c.tipo === 'calc') return;
      const celda = ws.getCell(r, i + 1);
      if (ej[c.clave] !== undefined) celda.value = ej[c.clave];
    });
    if (columnaNota && mapa[columnaNota]) {
      const nota = ws.getCell(`${mapa[columnaNota]}${r}`); nota.value = 'EJEMPLO';
    }
    cols.forEach((c, i) => {
      if (c.tipo === 'calc') return;
      const celda = ws.getCell(r, i + 1);
      celda.fill = relleno(COLOR.doradoClaro);
      celda.font = { name: FUENTE, size: 11, italic: true, color: { argb: argb(COLOR.tinta) } };
    });
  });
  return { primera, ultima, col: mapa, fila0 };
}

let prioridad = 1;
function formatoCondicional(ws, ref, formula, { relleno: bg, color, negrita = true, parar = false } = {}) {
  const style = {};
  if (bg) style.fill = { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(bg) }, fgColor: { argb: argb(bg) } };
  if (color || negrita) style.font = { color: color ? { argb: argb(color) } : undefined, bold: negrita };
  ws.addConditionalFormatting({ ref, rules: [{ type: 'expression', formulae: [formula], style, priority: prioridad++, stopIfTrue: parar }] });
}

function etiqueta(ws, celda, texto, opciones = {}) {
  const c = ws.getCell(celda); c.value = texto;
  c.font = { name: FUENTE, size: opciones.size || 11, bold: opciones.negrita !== false, color: { argb: argb(opciones.color || COLOR.verde) } };
  if (opciones.relleno) c.fill = relleno(opciones.relleno);
  c.alignment = { vertical: 'middle', wrapText: !!opciones.ajustar, horizontal: opciones.alinear || 'left' };
  if (opciones.borde) c.border = borde;
  return c;
}

function parametro(ws, celdaEtiqueta, celdaValor, texto, valor, formato) {
  etiqueta(ws, celdaEtiqueta, texto, { color: COLOR.tinta });
  const c = ws.getCell(celdaValor); c.value = valor;
  c.font = { name: FUENTE, size: 12, bold: true, color: { argb: argb(COLOR.verde) } }; c.fill = relleno(COLOR.blanco); c.border = borde;
  c.alignment = { horizontal: 'center' }; c.protection = { locked: false };
  if (formato) c.numFmt = formato;
  return c;
}

module.exports = { ExcelJS, FUENTE, argb, relleno, borde, libro, banda, hoja, instrucciones, tabla, formatoCondicional, etiqueta, parametro, estiloCelda };
