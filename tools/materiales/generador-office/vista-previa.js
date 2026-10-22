'use strict';
// Hoja de contacto (2 columnas) de las diapositivas de una presentación, para revisar el diseño con Chrome. Uso: node vista-previa.js <id> <salida.png> [pagina]
const P = require('./pptx'); const { capturar } = require('./chrome');
const { decks } = require('./ppt-contenido');
const [id, salida, pag = '1'] = process.argv.slice(2);
const d = decks.find(x => x.id === id);
const html = P.aHtml(d);
const secciones = html.match(/<section[\s\S]*?<\/section>(?=<section|<\/body>)/g);
const POR = 8; const ini = (Number(pag) - 1) * POR; const trozo = secciones.slice(ini, ini + POR);
const hoja = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:#666;width:1300px}.g{display:grid;grid-template-columns:640px 640px;gap:8px;padding:8px}.c{width:640px;height:360px;overflow:hidden;position:relative}.c>section{transform:scale(.5);transform-origin:0 0;page-break-after:auto!important}</style></head><body><div class="g">${trozo.map(s => `<div class="c">${s}</div>`).join('')}</div></body></html>`;
capturar(hoja, salida, 1300, Math.ceil(trozo.length / 2) * 368 + 16);
console.log('listo', trozo.length);
