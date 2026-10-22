'use strict';

// Presentaciones de Zoorigen. Cada diapositiva se describe con PRIMITIVAS (rectángulos, textos, imágenes) en pulgadas sobre un lienzo de
// 13.33 x 7.5; de ahí salen dos cosas: el .pptx (pptxgenjs) y una vista previa en HTML para revisar el diseño con Chrome.
// Diseño: fondo crema, verde de marca #1F5F3A, acentos dorado #E8A317 y naranja #C75402, todo en colores sólidos (sin degradados),
// Georgia para los títulos y Calibri para el texto (fuentes que ya traen Windows, Mac y PowerPoint en línea).

const path = require('path');
const PptxGenJS = require('pptxgenjs');
const { COLOR, VERSION, FECHA_TEXTO } = require('./comun');

const W = 13.333; const H = 7.5;
const LOGO = path.join(__dirname, 'recursos', 'logo-zoorigen.png');
const TITULOS = 'Georgia'; const TEXTO = 'Calibri';
const c = x => x;

/* ───── medición aproximada del texto (para colocar bloques sin que se encimen) ───── */
function lineas(texto, ancho, tam, factor = 0.5) {
  const porLinea = Math.max(8, Math.floor((ancho * 72) / (tam * factor)));
  let n = 0;
  for (const parrafo of String(texto).split('\n')) {
    const palabras = parrafo.split(/\s+/); let actual = 0; let l = 1;
    for (const p of palabras) { if (actual + p.length + (actual ? 1 : 0) > porLinea) { l += 1; actual = p.length; } else actual += p.length + (actual ? 1 : 0); }
    n += l;
  }
  return n;
}
const altoTexto = (texto, ancho, tam, interlineado = 1.18) => lineas(texto, ancho, tam) * tam * interlineado / 72;

/* ───── primitivas ───── */
const rect = (x, y, w, h, o = {}) => ({ t: 'rect', x, y, w, h, fill: o.fill, line: o.line, lineW: o.lineW || 1, radio: o.radio || 0 });
const elipse = (x, y, w, h, o = {}) => ({ t: 'elipse', x, y, w, h, fill: o.fill, line: o.line, lineW: o.lineW || 1 });
const texto = (s, x, y, w, h, o = {}) => ({ t: 'texto', s, x, y, w, h, tam: o.tam || 20, color: o.color || COLOR.tinta, negrita: !!o.negrita, cursiva: !!o.cursiva, fuente: o.fuente || TEXTO, alinear: o.alinear || 'left', vertical: o.vertical || 'top', interlineado: o.interlineado || 1.1 });
const imagen = (ruta, x, y, w, h) => ({ t: 'img', ruta, x, y, w, h });

/* ───── elementos comunes ───── */
function marco(prims, { n, total, etiqueta }) {
  prims.push(rect(0, 0, 0.22, H, { fill: COLOR.verde }));
  prims.push(rect(0, 0, 0.22, 0.9, { fill: COLOR.dorado }));
  prims.push(texto('Zoorigen · Club VIP' + (etiqueta ? ' · ' + etiqueta : ''), 0.7, 7.02, 8, 0.3, { tam: 10.5, color: COLOR.gris }));
  prims.push(texto(`${n} / ${total}`, 11.6, 7.02, 1.1, 0.3, { tam: 10.5, color: COLOR.gris, alinear: 'right' }));
}
const titulo = (prims, s, o = {}) => {
  prims.push(texto(o.etiqueta || '', 0.7, 0.38, 9, 0.3, { tam: 11.5, color: COLOR.naranja, negrita: true }));
  prims.push(texto(s, 0.7, 0.68, 11.9, 1.0, { tam: o.tam || 32, color: COLOR.verde, negrita: true, fuente: TITULOS, vertical: 'top' }));
};
function nota(prims, s, y = 6.1) {
  const h = Math.max(0.62, altoTexto(s, 11.2, 13.5) + 0.38);
  prims.push(rect(0.7, y, 11.9, h, { fill: COLOR.doradoClaro }));
  prims.push(rect(0.7, y, 0.08, h, { fill: COLOR.dorado }));
  prims.push(texto(s, 0.98, y + 0.08, 11.4, h - 0.16, { tam: 13.5, color: COLOR.tinta, vertical: 'middle' }));
}

/* ───── tipos de diapositiva ───── */
const TIPOS = {
  portada: (d, ctx) => {
    const p = [rect(0, 0, W, H, { fill: COLOR.verde })];
    p.push(rect(0.7, 0.6, 2.5, 1.35, { fill: COLOR.blanco, radio: 0.12 }));
    p.push(imagen(LOGO, 0.82, 0.68, 2.26, 1.16));
    p.push(rect(0.7, 2.75, 1.2, 0.07, { fill: COLOR.dorado }));
    p.push(texto(d.etiqueta || 'Presentación', 0.7, 2.95, 9, 0.4, { tam: 15, color: COLOR.dorado, negrita: true }));
    p.push(texto(d.titulo, 0.7, 3.4, 10.8, 2.0, { tam: d.titulo.length > 60 ? 38 : 44, color: COLOR.blanco, negrita: true, fuente: TITULOS, interlineado: 1.05 }));
    p.push(texto(d.subtitulo || '', 0.7, 5.5, 10.2, 0.9, { tam: 20, color: 'DCEBDD' }));
    p.push(texto(`Material original de Zoorigen · Versión ${VERSION} · ${FECHA_TEXTO}`, 0.7, 6.85, 10, 0.35, { tam: 12, color: 'B7D3BB' }));
    p.push(rect(11.2, 0, 2.13, H, { fill: COLOR.verdeMedio }));
    p.push(rect(11.2, 0, 0.1, H, { fill: COLOR.dorado }));
    return p;
  },
  agenda: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo || 'Qué veremos', { etiqueta: 'Esquema' });
    const n = d.items.length; const columnas = n > 5 ? 2 : 1; const porCol = Math.ceil(n / columnas);
    d.items.forEach((it, i) => {
      const col = Math.floor(i / porCol); const fila = i % porCol;
      const x = 0.7 + col * 6.1; const y = 1.95 + fila * 0.95;
      p.push(elipse(x, y, 0.62, 0.62, { fill: COLOR.verde }));
      p.push(texto(String(i + 1), x, y, 0.62, 0.62, { tam: 20, color: COLOR.blanco, negrita: true, alinear: 'center', vertical: 'middle' }));
      p.push(texto(it, x + 0.85, y - 0.04, 5.0, 0.7, { tam: 20, vertical: 'middle' }));
    });
    return p;
  },
  seccion: (d, ctx) => {
    const p = [rect(0, 0, W, H, { fill: COLOR.verde })];
    p.push(texto(String(d.numero), 0.9, 1.7, 3, 2.6, { tam: 140, color: COLOR.dorado, negrita: true, fuente: TITULOS }));
    p.push(texto(d.titulo, 0.9, 4.2, 11, 1.4, { tam: 42, color: COLOR.blanco, negrita: true, fuente: TITULOS }));
    if (d.frase) p.push(texto(d.frase, 0.9, 5.7, 10.5, 1.0, { tam: 20, color: 'DCEBDD' }));
    p.push(texto(`${ctx.n} / ${ctx.total}`, 11.6, 7.02, 1.1, 0.3, { tam: 10.5, color: 'B7D3BB', alinear: 'right' }));
    return p;
  },
  puntos: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo, { etiqueta: d.etiqueta });
    const ancho = d.lateral ? 7.6 : 11.9; let y = d.titulo.length > 52 ? 2.05 : 1.85;
    const tam = d.tam || (d.puntos.length >= 5 ? 20 : 22);
    d.puntos.forEach((s, i) => {
      const h = Math.max(0.5, altoTexto(s, ancho - 0.85, tam));
      p.push(elipse(0.7, y + 0.02, 0.46, 0.46, { fill: COLOR.verde }));
      p.push(texto(String(i + 1), 0.7, y + 0.02, 0.46, 0.46, { tam: 15, color: COLOR.blanco, negrita: true, alinear: 'center', vertical: 'middle' }));
      p.push(texto(s, 1.35, y, ancho - 0.65, h, { tam }));
      y += h + 0.22;
    });
    if (d.lateral) {
      p.push(rect(8.7, 1.85, 3.9, 3.9, { fill: COLOR.verdeClaro, radio: 0.1 }));
      p.push(texto(d.lateral.titulo, 8.95, 2.0, 3.4, 0.5, { tam: 16, color: COLOR.verde, negrita: true }));
      p.push(texto(d.lateral.texto, 8.95, 2.55, 3.4, 3.1, { tam: 15 }));
    }
    if (d.nota) nota(p, d.nota);
    return p;
  },
  tarjetas: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo, { etiqueta: d.etiqueta });
    const n = d.tarjetas.length; const columnas = n === 4 ? 2 : n; const filas = Math.ceil(n / columnas);
    const gap = 0.3; const w = (11.9 - gap * (columnas - 1)) / columnas; const alto = filas === 1 ? (n >= 4 ? 3.0 : 3.5) : 1.8;
    const colores = [COLOR.verde, COLOR.naranja, COLOR.dorado, COLOR.azul, COLOR.verdeMedio];
    d.tarjetas.forEach((t, i) => {
      const col = i % columnas; const fila = Math.floor(i / columnas);
      const x = 0.7 + col * (w + gap); const y = 1.95 + fila * (alto + 0.25);
      p.push(rect(x, y, w, alto, { fill: COLOR.blanco, line: COLOR.linea, radio: 0.08 }));
      p.push(rect(x, y, w, 0.12, { fill: colores[i % colores.length] }));
      p.push(texto(t.t, x + 0.25, y + 0.28, w - 0.5, 0.55, { tam: 19, color: COLOR.verde, negrita: true }));
      p.push(texto(t.x, x + 0.25, y + 0.9, w - 0.5, alto - 1.05, { tam: filas === 1 ? 16 : 15 }));
    });
    if (d.nota) nota(p, d.nota, filas === 1 ? 5.6 : 6.0);
    return p;
  },
  proceso: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo, { etiqueta: d.etiqueta });
    const n = d.pasos.length; const gap = 0.18; const w = (11.9 - gap * (n - 1)) / n;
    d.pasos.forEach((s, i) => {
      const x = 0.7 + i * (w + gap);
      p.push(rect(x, 2.0, w, 0.85, { fill: i % 2 ? COLOR.verdeMedio : COLOR.verde, radio: 0.08 }));
      p.push(texto(String(i + 1), x + 0.12, 2.0, 0.5, 0.85, { tam: 24, color: COLOR.dorado, negrita: true, vertical: 'middle', fuente: TITULOS }));
      p.push(texto(s.t, x + 0.6, 2.0, w - 0.7, 0.85, { tam: n > 5 ? 13 : 15, color: COLOR.blanco, negrita: true, vertical: 'middle' }));
      p.push(rect(x, 2.95, w, 2.3, { fill: COLOR.blanco, line: COLOR.linea, radio: 0.06 }));
      p.push(texto(s.x, x + 0.12, 3.05, w - 0.24, 2.15, { tam: n > 5 ? 13 : 15 }));
    });
    if (d.nota) nota(p, d.nota, 5.6);
    return p;
  },
  comparacion: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo, { etiqueta: d.etiqueta });
    [[d.izq, 0.7, COLOR.verde], [d.der, 6.85, COLOR.naranja]].forEach(([col, x, color]) => {
      p.push(rect(x, 1.95, 5.75, 0.6, { fill: color, radio: 0.06 }));
      p.push(texto(col.t, x + 0.2, 1.95, 5.4, 0.6, { tam: 18, color: COLOR.blanco, negrita: true, vertical: 'middle' }));
      p.push(rect(x, 2.6, 5.75, 3.2, { fill: COLOR.blanco, line: COLOR.linea }));
      let y = 2.75;
      col.items.forEach(s => { const h = Math.max(0.4, altoTexto(s, 5.2, 16)); p.push(rect(x + 0.2, y + 0.12, 0.12, 0.12, { fill: color })); p.push(texto(s, x + 0.45, y, 5.1, h, { tam: 16 })); y += h + 0.16; });
    });
    if (d.nota) nota(p, d.nota, 6.0);
    return p;
  },
  tabla: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo, { etiqueta: d.etiqueta });
    p.push({ t: 'tabla', x: 0.7, y: 1.95, w: 11.9, cab: d.cabeceras, filas: d.filas, anchos: d.anchos, tam: d.tam || 15 });
    if (d.nota) nota(p, d.nota, 6.1);
    return p;
  },
  cierre: (d, ctx) => {
    const p = []; marco(p, ctx); titulo(p, d.titulo || 'Fuentes y aviso', { etiqueta: 'Para seguir' });
    let y = 1.9;
    p.push(texto('Fuentes consultadas', 0.7, y, 6, 0.4, { tam: 15, color: COLOR.naranja, negrita: true })); y += 0.45;
    d.fuentes.forEach(f => { const h = Math.max(0.36, altoTexto(f, 11.6, 13)); p.push(rect(0.7, y + 0.1, 0.1, 0.1, { fill: COLOR.dorado })); p.push(texto(f, 0.95, y, 11.6, h, { tam: 13 })); y += h + 0.1; });
    y += 0.15;
    const aviso = d.aviso || 'Material de apoyo de Zoorigen: no sustituye el criterio profesional ni la asesoría legal. Consulta siempre la normatividad vigente y a tu asesor legal o médico veterinario responsable.';
    const h = Math.max(0.9, altoTexto(aviso, 11.2, 14) + 0.4);
    p.push(rect(0.7, y, 11.9, h, { fill: COLOR.doradoClaro })); p.push(rect(0.7, y, 0.08, h, { fill: COLOR.dorado }));
    p.push(texto(aviso, 0.98, y + 0.1, 11.4, h - 0.2, { tam: 14, vertical: 'middle' }));
    return p;
  }
};

function construirDiapositivas(def) {
  const total = def.diapositivas.length;
  return def.diapositivas.map((d, i) => ({ prims: TIPOS[d.tipo](d, { n: i + 1, total, etiqueta: def.etiqueta }), notas: d.notas || '' }));
}

/* ───── backend 1: .pptx ───── */
async function aPptx(def, destino) {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.author = 'Zoorigen'; pres.company = 'Zoorigen'; pres.title = def.titulo; pres.subject = def.descripcion || def.titulo;
  pres.theme = { headFontFace: TITULOS, bodyFontFace: TEXTO };
  const diapos = construirDiapositivas(def);
  diapos.forEach(({ prims, notas }) => {
    const s = pres.addSlide();
    s.background = { color: prims[0] && prims[0].t === 'rect' && prims[0].w >= W ? prims[0].fill : 'FBF8F1' };
    if (!(prims[0] && prims[0].t === 'rect' && prims[0].w >= W)) s.background = { color: 'FBF8F1' };
    for (const e of prims) {
      if (e.t === 'rect') {
        s.addShape(e.radio ? pres.ShapeType.roundRect : pres.ShapeType.rect, { x: e.x, y: e.y, w: e.w, h: e.h, fill: e.fill ? { color: e.fill } : { type: 'none' }, line: e.line ? { color: e.line, width: e.lineW * 0.75 } : { type: 'none' }, rectRadius: e.radio ? Math.min(e.radio, 0.5) : undefined });
      } else if (e.t === 'elipse') {
        s.addShape(pres.ShapeType.ellipse, { x: e.x, y: e.y, w: e.w, h: e.h, fill: e.fill ? { color: e.fill } : { type: 'none' }, line: e.line ? { color: e.line, width: e.lineW * 0.75 } : { type: 'none' } });
      } else if (e.t === 'texto') {
        s.addText(e.s, { x: e.x, y: e.y, w: e.w, h: e.h, fontFace: e.fuente, fontSize: e.tam, color: e.color, bold: e.negrita, italic: e.cursiva, align: e.alinear, valign: e.vertical, margin: 0, lineSpacingMultiple: e.interlineado, fit: 'none', wrap: true });
      } else if (e.t === 'img') {
        s.addImage({ path: e.ruta, x: e.x, y: e.y, w: e.w, h: e.h });
      } else if (e.t === 'tabla') {
        const anchos = e.anchos || e.cab.map(() => e.w / e.cab.length);
        const filas = [e.cab.map(t => ({ text: t, options: { bold: true, color: COLOR.blanco, fill: { color: COLOR.verde }, fontFace: TEXTO, fontSize: e.tam, valign: 'middle' } })),
          ...e.filas.map((f, i) => f.map((t, k) => ({ text: String(t), options: { color: COLOR.tinta, bold: k === 0, fill: { color: i % 2 ? 'F4F1E8' : COLOR.blanco }, fontFace: TEXTO, fontSize: e.tam, valign: 'middle' } })))];
        s.addTable(filas, { x: e.x, y: e.y, w: e.w, colW: anchos, border: { type: 'solid', color: COLOR.linea, pt: 0.75 }, margin: [0.06, 0.1, 0.06, 0.1] });
      }
    }
    if (notas) s.addNotes(notas);
  });
  await pres.writeFile({ fileName: destino });
  return diapos.length;
}

/* ───── backend 2: vista previa en HTML (una página de 1280x720 por diapositiva) ───── */
const px = v => Math.round(v * 96 * 10) / 10;
const escapar = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
function aHtml(def, { solo = null } = {}) {
  const diapos = construirDiapositivas(def);
  const hojas = diapos.map(({ prims }, i) => {
    if (solo && !solo.includes(i + 1)) return '';
    const cuerpo = prims.map(e => {
      if (e.t === 'rect') return `<div style="position:absolute;left:${px(e.x)}px;top:${px(e.y)}px;width:${px(e.w)}px;height:${px(e.h)}px;background:${e.fill ? '#' + e.fill : 'transparent'};${e.line ? `border:${e.lineW}px solid #${e.line};` : ''}${e.radio ? `border-radius:${px(e.radio)}px;` : ''}box-sizing:border-box"></div>`;
      if (e.t === 'elipse') return `<div style="position:absolute;left:${px(e.x)}px;top:${px(e.y)}px;width:${px(e.w)}px;height:${px(e.h)}px;background:${e.fill ? '#' + e.fill : 'transparent'};border-radius:50%"></div>`;
      if (e.t === 'img') return `<img src="file:///${e.ruta.replace(/\\/g, '/')}" style="position:absolute;left:${px(e.x)}px;top:${px(e.y)}px;width:${px(e.w)}px;height:${px(e.h)}px;object-fit:contain">`;
      if (e.t === 'texto') return `<div style="position:absolute;left:${px(e.x)}px;top:${px(e.y)}px;width:${px(e.w)}px;height:${px(e.h)}px;display:flex;flex-direction:column;justify-content:${e.vertical === 'middle' ? 'center' : 'flex-start'};text-align:${e.alinear};font-family:${e.fuente === TITULOS ? "Georgia,'Times New Roman',serif" : "Calibri,'Segoe UI',Arial,sans-serif"};font-size:${e.tam * 96 / 72}px;line-height:${e.interlineado * 1.1};color:#${e.color};font-weight:${e.negrita ? 700 : 400};font-style:${e.cursiva ? 'italic' : 'normal'};overflow:visible"><div>${escapar(e.s)}</div></div>`;
      if (e.t === 'tabla') {
        const anchos = e.anchos || e.cab.map(() => e.w / e.cab.length);
        return `<table style="position:absolute;left:${px(e.x)}px;top:${px(e.y)}px;width:${px(e.w)}px;border-collapse:collapse;font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:${e.tam * 96 / 72}px"><thead><tr>${e.cab.map((t, k) => `<th style="background:#${COLOR.verde};color:#fff;padding:6px 10px;text-align:left;width:${px(anchos[k])}px;border:1px solid #${COLOR.linea}">${escapar(t)}</th>`).join('')}</tr></thead><tbody>${e.filas.map((f, i) => `<tr>${f.map((t, k) => `<td style="padding:6px 10px;border:1px solid #${COLOR.linea};background:${i % 2 ? '#F4F1E8' : '#fff'};font-weight:${k === 0 ? 700 : 400}">${escapar(t)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      return '';
    }).join('');
    const fondo = prims[0] && prims[0].t === 'rect' && prims[0].w >= W ? '#' + prims[0].fill : '#FBF8F1';
    return `<section style="position:relative;width:1280px;height:720px;overflow:hidden;background:${fondo};page-break-after:always;break-after:page">${cuerpo}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:1280px 720px;margin:0}*{margin:0;padding:0}body{background:#888}</style></head><body>${hojas}</body></html>`;
}

module.exports = { W, H, aPptx, aHtml, construirDiapositivas, altoTexto, lineas, LOGO };
