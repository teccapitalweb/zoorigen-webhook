'use strict';
// Convierte páginas de un PDF a PNG para revisar el diseño (solo desarrollo). Uso: node pdf-a-png.js <archivo.pdf> <carpeta> [escala]
const fs = require('fs'); const path = require('path');
(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const [arch, salida, escala = '0.7'] = process.argv.slice(2);
  fs.mkdirSync(salida, { recursive: true });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(arch)), useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const pagina = await doc.getPage(i); const vp = pagina.getViewport({ scale: Number(escala) });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)); const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pagina.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    fs.writeFileSync(path.join(salida, `p${i}.png`), canvas.toBuffer('image/png'));
  }
  console.log('páginas', doc.numPages);
})().catch(e => { console.error(e); process.exit(1); });
