'use strict';

// Plantilla de los PDF nuevos (Chrome sin ventana): portada, índice, secciones con formatos para llenar y pie con versión, fecha y aviso.
// Colores sólidos (sin degradados) y tipografía segura (Georgia + Segoe UI/Calibri).

const fs = require('fs');
const path = require('path');
const { COLOR, VERSION, FECHA_TEXTO } = require('./comun');

const LOGO = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'recursos', 'logo-zoorigen.png')).toString('base64');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const AVISO_PIE = 'Material de apoyo: no sustituye el criterio profesional ni la asesoría legal.';
const V = '#' + COLOR.verde; const VM = '#' + COLOR.verdeMedio; const DOR = '#' + COLOR.dorado; const NAR = '#' + COLOR.naranja;

const MOTIVOS = {
  lista: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8l1.5 1.5L12 7"/><path d="M8 14l1.5 1.5L12 13"/><path d="M14 8h3M14 14h3"/>',
  registro: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  plan: '<path d="M4 20V8l8-5 8 5v12z"/><path d="M9 20v-6h6v6"/>',
  ojo: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  escudo: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  tubo: '<path d="M9 3h6"/><path d="M10 3v12a3 3 0 0 0 6 0V3"/><path d="M10 9h6"/>'
};

function bloque(b) {
  switch (b.t) {
    case 'p': return `<p>${esc(b.texto)}</p>`;
    case 'sub': return `<h3>${esc(b.texto)}</h3>`;
    case 'ul': return `<ul>${b.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    case 'ol': return `<ol>${b.items.map(x => `<li>${esc(x)}</li>`).join('')}</ol>`;
    case 'casillas': return `<ul class="cas">${b.items.map(x => `<li><i></i><span>${esc(x)}</span></li>`).join('')}</ul>`;
    case 'campos': return `<div class="campos c${b.columnas || 2}">${b.items.map(x => `<div class="campo"><label>${esc(x)}</label><span></span></div>`).join('')}</div>`;
    case 'lineas': return `<div class="lineas">${b.etiqueta ? `<label>${esc(b.etiqueta)}</label>` : ''}${'<span></span>'.repeat(b.n || 3)}</div>`;
    case 'aviso': return `<div class="aviso">${esc(b.texto)}</div>`;
    case 'tabla': return `<table class="t"><thead><tr>${b.cab.map((c, i) => `<th${b.anchos ? ` style="width:${b.anchos[i]}"` : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.filas.map(f => `<tr>${f.map((c, i) => `<td${i === 0 ? ' class="pri"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'registro': return `<table class="t reg"><thead><tr>${b.cab.map((c, i) => `<th${b.anchos ? ` style="width:${b.anchos[i]}"` : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: b.filas || 8 }, () => `<tr>${b.cab.map(() => '<td></td>').join('')}</tr>`).join('')}</tbody></table>`;
    case 'verificacion': return `<table class="t ver"><thead><tr><th>Qué se revisa</th><th>Sí</th><th>Parcial</th><th>No</th><th>N/A</th><th>Observaciones</th></tr></thead><tbody>${b.items.map(x => `<tr><td class="pri">${esc(x)}</td><td><i></i></td><td><i></i></td><td><i></i></td><td><i></i></td><td></td></tr>`).join('')}</tbody></table>`;
    case 'saltar': return '<div class="salto"></div>';
    default: return '';
  }
}

const CSS = (papel) => `
@page portada { size: ${papel}; margin: 0; }
@page cuerpo { size: ${papel}; margin: 0.6in 0.7in 0.85in; @bottom-left { content: 'Zoorigen · Versión ${VERSION} · ${FECHA_TEXTO} · ${AVISO_PIE}'; font: 7.2pt 'Segoe UI', Arial, sans-serif; color: #6b7a70; vertical-align: top; padding-top: 8px; } @bottom-right { content: counter(page); font: 8pt 'Segoe UI', Arial, sans-serif; color: #6b7a70; vertical-align: top; padding-top: 8px; } }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: 'Segoe UI', Calibri, Arial, sans-serif; color: #${COLOR.tinta}; font-size: 10.5pt; line-height: 1.45; }
.portada { page: portada; width: 100%; height: 11in; background: ${V}; color: #fff; position: relative; page-break-after: always; break-after: page; overflow: hidden; }
.portada .tarjeta { position: absolute; left: 0.8in; top: 0.8in; background: #fff; border-radius: 12px; padding: 12px 18px; }
.portada .tarjeta img { height: 62px; display: block; }
.portada .motivo { position: absolute; right: -0.9in; top: 2.2in; opacity: .16; }
.portada .barra { position: absolute; left: 0.8in; top: 3.3in; width: 1.3in; height: 8px; background: ${DOR}; }
.portada .etq { position: absolute; left: 0.8in; top: 3.55in; font-size: 12pt; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; color: ${DOR}; }
.portada h1 { position: absolute; left: 0.8in; top: 4in; width: 6.2in; font-family: Georgia, 'Times New Roman', serif; font-size: 34pt; line-height: 1.1; }
.portada .sub { position: absolute; left: 0.8in; top: 7.2in; width: 6in; font-size: 14pt; line-height: 1.4; color: #DCEBDD; }
.portada .pie { position: absolute; left: 0.8in; right: 0.8in; bottom: 0.7in; font-size: 9.5pt; color: #B7D3BB; border-top: 1px solid rgba(255,255,255,.25); padding-top: 10px; }
.portada .franja { position: absolute; right: 0; top: 0; bottom: 0; width: 0.55in; background: ${VM}; border-left: 6px solid ${DOR}; }
.cuerpo { page: cuerpo; }
.indice { page-break-after: always; break-after: page; }
h1.ti { font-family: Georgia, serif; font-size: 22pt; color: ${V}; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 3px solid ${DOR}; }
.indice ol { list-style: none; counter-reset: n; display: grid; gap: 6px; margin-top: 10px; }
.indice li { counter-increment: n; display: flex; gap: 14px; align-items: center; font-size: 11.5pt; padding: 5px 12px; background: #${COLOR.grisClaro}; border-radius: 8px; }
.indice li::before { content: counter(n); flex: 0 0 26px; height: 26px; border-radius: 50%; background: ${V}; color: #fff; font-weight: 700; font-size: 11pt; display: inline-flex; align-items: center; justify-content: center; }
.indice .intro { margin: 8px 0 14px; color: #34423a; }
h2 { font-family: Georgia, serif; font-size: 17pt; color: ${V}; margin: 20px 0 10px; padding-bottom: 5px; border-bottom: 2px solid ${DOR}; break-after: avoid; break-inside: avoid; }
.junta { break-inside: avoid; }
h2 small { font: 700 8.5pt 'Segoe UI', sans-serif; color: ${NAR}; letter-spacing: .14em; text-transform: uppercase; display: block; margin-bottom: 2px; }
h3 { font-size: 11.5pt; color: ${NAR}; margin: 12px 0 5px; break-after: avoid; }
p { margin-bottom: 8px; }
ul, ol { margin: 4px 0 10px 1.25em; display: grid; gap: 3px; }
.cas { list-style: none; margin-left: 0; gap: 7px; }
.cas li { display: flex; gap: 10px; align-items: flex-start; break-inside: avoid; }
.cas i, .ver i { flex: 0 0 14px; width: 14px; height: 14px; border: 1.6px solid ${V}; border-radius: 3px; margin-top: 3px; display: inline-block; }
.campos { display: grid; gap: 10px 22px; margin: 8px 0; }
.campos.c1 { grid-template-columns: 1fr; } .campos.c2 { grid-template-columns: 1fr 1fr; } .campos.c3 { grid-template-columns: 1fr 1fr 1fr; }
.campo { break-inside: avoid; }
.campo label, .lineas label { display: block; font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; color: ${VM}; font-weight: 700; }
.campo span { display: block; height: 22px; border-bottom: 1.3px solid #1d2a22; }
.lineas { margin: 8px 0 10px; break-inside: avoid; }
.lineas span { display: block; height: 24px; border-bottom: 1px solid #9aa79f; }
.aviso { margin: 12px 0; padding: 10px 14px; border-left: 5px solid ${DOR}; background: #${COLOR.doradoClaro}; border-radius: 3px 10px 10px 3px; font-size: 10pt; break-inside: avoid; }
table.t { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 9.5pt; break-inside: auto; }
table.t th { background: ${V}; color: #fff; text-align: left; padding: 6px 8px; border: 1px solid ${V}; font-size: 8.8pt; }
table.t td { border: 1px solid #c8cfc6; padding: 5px 8px; vertical-align: top; }
table.t tr { break-inside: avoid; }
table.t tbody tr:nth-child(even) td { background: #f7f5ee; }
table.t td.pri { font-weight: 600; }
table.reg td { height: 28px; }
table.ver td { height: 30px; text-align: center; } table.ver td.pri { text-align: left; } table.ver th { text-align: center; } table.ver th:first-child { text-align: left; } table.ver td:first-child { width: 40%; } table.ver td:nth-child(n+2):nth-child(-n+5) { width: 7%; } table.ver td i { margin: 0 auto; }
.salto { break-after: page; page-break-after: always; height: 0; }
.fuentes { margin-top: 14px; padding: 10px 14px; background: #f4f6f2; border-radius: 10px; font-size: 8.3pt; color: #4a5a50; break-inside: avoid; }
.fuentes h4 { font-size: 8.5pt; letter-spacing: .1em; text-transform: uppercase; color: ${VM}; margin-bottom: 4px; }
.fuentes ul { margin: 0 0 0 1em; gap: 1px; word-break: break-word; }
`;

// d: { titulo, etiqueta, subtitulo, motivo, intro, secciones: [{ titulo, etiqueta?, bloques, nueva? }], fuentes: [..] }
function htmlDocumento(d, { papel = 'Letter' } = {}) {
  const motivo = `<svg class="motivo" width="620" height="620" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width=".7" stroke-linecap="round" stroke-linejoin="round">${MOTIVOS[d.motivo] || MOTIVOS.lista}</svg>`;
  const portada = `<section class="portada"><div class="tarjeta"><img src="${LOGO}" alt="Zoorigen"></div>${motivo}<div class="barra"></div><div class="etq">${esc(d.etiqueta)} · Club VIP Zoorigen</div>
    <h1>${esc(d.titulo)}</h1><div class="sub">${esc(d.subtitulo)}</div><div class="franja"></div>
    <div class="pie">Material original de Zoorigen · Versión ${VERSION} · ${FECHA_TEXTO}<br>${esc(AVISO_PIE)} Uso exclusivo de miembros del Club VIP.</div></section>`;
  const indice = `<section class="cuerpo indice"><h1 class="ti">Contenido</h1><p class="intro">${esc(d.intro || '')}</p><ol>${d.secciones.map(s => `<li>${esc(s.titulo)}</li>`).join('')}</ol>
    <div class="aviso" style="margin-top:22px">${esc(d.avisoInicial || 'Este documento es un material de apoyo. No sustituye el criterio profesional, la asesoría legal ni los formatos oficiales que la autoridad solicite. Consulta siempre la normatividad vigente.')}</div></section>`;
  const cuerpo = d.secciones.map((s, i) => `${s.nueva ? '<div class="salto"></div>' : ''}<div${s.junta ? ' class="junta"' : ''}><h2><small>${esc(s.etiqueta || 'Sección ' + (i + 1))}</small>${esc(s.titulo)}</h2>${s.bloques.map(bloque).join('')}</div>`).join('\n');
  const fuentes = (d.fuentes || []).length ? `<div class="fuentes"><h4>Fuentes y referencias</h4><ul>${d.fuentes.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(d.titulo)}</title><style>${CSS(papel)}</style></head><body>${portada}${indice}<main class="cuerpo">${cuerpo}${fuentes}</main></body></html>`;
}

/* ───── Carteles A4 (uno por hoja, para imprimir) ───── */
const ICONOS = {
  mano: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.4 16a2 2 0 0 1 3.2-2.4L8 15"/>',
  alto: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  escudo: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  ojo: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  hoja: '<path d="M5 21c.5-4.5 2.5-8 7-10"/><path d="M9 18c6.2 0 10.5-3.3 11-12V4h-4c-9 0-12 4-12 9 0 1 0 3 2 5z"/>',
  lista: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8l1.5 1.5L12 7"/><path d="M8 14l1.5 1.5L12 13"/><path d="M14 8h3M14 14h3"/>'
};
function htmlCarteles(carteles) {
  const paginas = carteles.map(c => `<section class="h"><div class="banda"></div>
    <div class="cab"><div class="logo"><img src="${LOGO}" alt="Zoorigen"></div><div class="et">${esc(c.etiqueta)}</div></div>
    <svg class="ico" width="150" height="150" viewBox="0 0 24 24" fill="none" stroke="${c.color || V}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONOS[c.icono] || ICONOS.lista}</svg>
    <h1 style="color:${c.color || V}">${esc(c.titulo)}</h1>
    ${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : ''}
    ${c.items ? `<ul class="${c.items.length > 4 ? 'many' : ''}">${c.items.map(x => `<li><b></b><span>${esc(x)}</span></li>`).join('')}</ul>` : ''}
    <div class="blanco">${(c.campos || []).map(x => `<div><label>${esc(x)}</label><span></span></div>`).join('')}</div>
    <div class="pie"><span>${esc(c.pie || '')}</span><span>Cartel de apoyo de Zoorigen · Versión ${VERSION}</span></div></section>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Carteles imprimibles</title><style>
  @page { size: A4; margin: 0; } * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: 'Segoe UI', Calibri, Arial, sans-serif; color: #${COLOR.tinta}; }
  .h { position: relative; width: 210mm; height: 297mm; page-break-after: always; break-after: page; overflow: hidden; background: #fff; padding: 18mm 20mm 20mm 26mm; }
  .banda { position: absolute; left: 0; top: 0; bottom: 0; width: 10mm; background: ${V}; border-right: 3mm solid ${DOR}; }
  .cab { display: flex; justify-content: space-between; align-items: center; }
  .logo img { height: 17mm; display: block; } .et { font-size: 12pt; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: ${NAR}; }
  .ico { display: block; margin: 12mm auto 4mm; width: 36mm; height: 36mm; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 50pt; line-height: 1.05; text-align: center; margin: 0 0 8mm; }
  .sub { font-size: 20pt; text-align: center; color: #34423a; margin-bottom: 9mm; }
  ul { list-style: none; display: grid; gap: 6mm; margin: 4mm 6mm; }
  li { display: flex; gap: 6mm; align-items: flex-start; font-size: 22pt; line-height: 1.25; }
  ul.many { gap: 3mm; } ul.many li { font-size: 17pt; } ul.many li b { flex-basis: 8mm; height: 8mm; margin-top: 1.5mm; }
  li b { flex: 0 0 11mm; height: 11mm; border-radius: 50%; background: ${V}; margin-top: 2mm; display: inline-block; }
  .blanco { position: absolute; left: 26mm; right: 20mm; bottom: 28mm; display: grid; gap: 6mm; } .blanco label { font-size: 10pt; text-transform: uppercase; letter-spacing: .1em; color: ${VM}; font-weight: 700; display: block; } .blanco span { display: block; height: 9mm; border-bottom: 0.5mm solid #1d2a22; }
  .pie { position: absolute; left: 26mm; right: 20mm; bottom: 9mm; display: flex; justify-content: space-between; font-size: 8.5pt; color: #6b7a70; }
  </style></head><body>${paginas}</body></html>`;
}

module.exports = { htmlDocumento, htmlCarteles, esc };
