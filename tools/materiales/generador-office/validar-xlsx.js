'use strict';

// Reabre cada .xlsx con exceljs, comprueba hojas, validaciones, formatos condicionales y gráficas, y calcula TODAS las fórmulas con
// HyperFormula para asegurar que con los datos de ejemplo no salen #REF!, #DIV/0!, #NAME?, #VALUE! (solo se permite #N/A donde la hoja
// lo usa a propósito para que las gráficas no dibujen puntos vacíos).
// Uso: node validar-xlsx.js <carpeta o archivo.xlsx> ...

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { HyperFormula } = require('hyperformula');

const SERIAL = d => (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;

async function validar(archivo, { esperarGraficas = null } = {}) {
  const buf = fs.readFileSync(archivo);
  const informe = { archivo: path.basename(archivo), bytes: buf.length, hojas: [], problemas: [], formulas: 0, validaciones: 0, formatosCondicionales: 0, graficas: 0, protegidas: [] };
  const zip = await JSZip.loadAsync(buf);
  informe.graficas = Object.keys(zip.files).filter(f => /^xl\/charts\/chart\d+\.xml$/.test(f)).length;
  // XML bien formado (etiquetas abiertas y cerradas) en las partes de gráficas y dibujos
  for (const f of Object.keys(zip.files).filter(f => /^xl\/(charts|drawings)\/[^/]+\.xml$/.test(f))) {
    const xml = await zip.file(f).async('string');
    const pila = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z0-9:]+)([^>]*?)(\/?)>/g)) {
      if (m[2].startsWith('?')) continue;
      if (m[4] === '/') continue;
      if (m[1] === '/') { const x = pila.pop(); if (x !== m[2]) { informe.problemas.push(`XML mal formado en ${f}: se esperaba </${x}> y vino </${m[2]}>`); break; } } else pila.push(m[2]);
    }
    if (pila.length) informe.problemas.push(`XML sin cerrar en ${f}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const hojas = {};
  wb.eachSheet(ws => {
    informe.hojas.push(ws.name);
    const filas = [];
    const dv = ws.dataValidations && ws.dataValidations.model ? Object.keys(ws.dataValidations.model).length : 0;
    informe.validaciones += dv;
    informe.formatosCondicionales += (ws.conditionalFormattings || []).length;
    if (ws.sheetProtection) informe.protegidas.push(ws.name);
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        let v = cell.value;
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          if (v.formula !== undefined) { v = '=' + v.formula; informe.formulas += 1; }
          else if (v.richText) v = v.richText.map(x => x.text).join('');
          else if (v.result !== undefined) v = v.result;
          else v = String(v);
        }
        if (v instanceof Date) v = SERIAL(v);
        while (filas.length < r) filas.push([]);
        filas[r - 1][c - 1] = v === undefined ? null : v;
      });
    });
    hojas[ws.name] = filas.map(f => Array.from(f, x => (x === undefined ? null : x)));
  });
  if (!informe.hojas.includes('Instrucciones')) informe.problemas.push('Falta la hoja Instrucciones');
  if (informe.hojas[0] !== 'Instrucciones') informe.problemas.push('La hoja Instrucciones debe ir primero');
  if (!informe.validaciones) informe.problemas.push('No tiene validaciones de datos (listas desplegables)');
  if (esperarGraficas !== null && informe.graficas !== esperarGraficas) informe.problemas.push(`Se esperaban ${esperarGraficas} gráficas y hay ${informe.graficas}`);
  // calcular con HyperFormula
  const hf = HyperFormula.buildFromSheets(hojas, { licenseKey: 'gpl-v3', useColumnIndex: false });
  const errores = {};
  for (const nombre of hf.getSheetNames()) {
    const id = hf.getSheetId(nombre);
    const dim = hf.getSheetDimensions(id);
    for (let r = 0; r < dim.height; r++) for (let c = 0; c < dim.width; c++) {
      const v = hf.getCellValue({ sheet: id, row: r, col: c });
      if (v && typeof v === 'object' && v.type) {
        const tipo = v.value || v.type;
        if (tipo === '#N/A' && /Curva/.test(nombre)) continue; // permitido: puntos vacíos de la gráfica
        const clave = `${nombre}:${tipo}`;
        (errores[clave] = errores[clave] || []).push(`${String.fromCharCode(65 + (c % 26))}${r + 1}`);
      }
    }
  }
  for (const [k, celdas] of Object.entries(errores)) informe.problemas.push(`Error de fórmula ${k} en ${celdas.length} celdas (${celdas.slice(0, 4).join(', ')}…)`);
  informe.hf = hf;
  return informe;
}

module.exports = { validar };

if (require.main === module) {
  (async () => {
    const entradas = process.argv.slice(2);
    let malos = 0;
    for (const e of entradas) {
      const archivos = fs.statSync(e).isDirectory() ? fs.readdirSync(e).filter(f => f.endsWith('.xlsx')).map(f => path.join(e, f)) : [e];
      for (const a of archivos) {
        const i = await validar(a);
        console.log(`${i.problemas.length ? 'MAL' : 'ok '}  ${i.archivo}  ${(i.bytes / 1024).toFixed(0)} KB  hojas=${i.hojas.join('/')}  fórmulas=${i.formulas}  listas=${i.validaciones}  formatos=${i.formatosCondicionales}  gráficas=${i.graficas}`);
        i.problemas.forEach(p => console.log('      - ' + p));
        if (i.problemas.length) malos++;
      }
    }
    process.exit(malos ? 1 : 0);
  })().catch(e => { console.error(e); process.exit(1); });
}
