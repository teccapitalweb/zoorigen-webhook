'use strict';
// Texto por página de un PDF (solo desarrollo): sirve para detectar páginas casi vacías o cortes raros. Uso: node texto-pdf.js <archivo.pdf>
const fs = require('fs');
(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const arch of process.argv.slice(2)) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(arch)), isEvalSupported: false }).promise;
    const salida = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const t = await (await doc.getPage(i)).getTextContent();
      const texto = t.items.map(x => x.str).join(' ').replace(/\s+/g, ' ');
      salida.push(`p${i}: ${texto.length} car. · ${texto.slice(0, 60)}…${texto.slice(-50)}`);
    }
    console.log(arch.split(/[\/]/).pop()); salida.forEach(s => console.log('  ' + s));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
