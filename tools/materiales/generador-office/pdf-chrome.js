'use strict';
// Vista previa de un PDF con Chrome (pdf.js dentro de la página, controlado por CDP): hoja de contacto de sus páginas. Solo desarrollo.
// Uso: node pdf-chrome.js <archivo.pdf> <salida.png> [primeraPagina] [cuantas]
const fs = require('fs'); const path = require('path'); const http = require('http');
const { Navegador, pausa } = require('C:/TECCAPITAL/ZOORIGEN-LOCAL/verificacion/cdp.js');
const [arch, salida, primera = '1', cuantas = '6'] = process.argv.slice(2);
const raiz = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
const pagina = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#555}#g{display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:1500px}canvas{background:#fff}</style></head><body><div id="g"></div>
<script type="module">
import * as pdfjs from '/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
const doc = await pdfjs.getDocument('/doc.pdf').promise;
const ini = ${Number(primera)}, fin = Math.min(doc.numPages, ini + ${Number(cuantas)} - 1);
for (let i = ini; i <= fin; i++) { const p = await doc.getPage(i); const vp = p.getViewport({ scale: 0.55 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; document.getElementById('g').appendChild(c); await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; }
window.__listo = true;
</script></body></html>`;
const servidor = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(pagina); }
  if (req.url === '/doc.pdf') { res.setHeader('Content-Type', 'application/pdf'); return res.end(fs.readFileSync(arch)); }
  if (req.url.startsWith('/pdfjs/')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(raiz, req.url.slice(7)))); }
  res.statusCode = 404; res.end();
}).listen(0, '127.0.0.1', async () => {
  const origen = 'http://127.0.0.1:' + servidor.address().port;
  const n = new Navegador({ ancho: 1516, alto: 900, movil: false, origen });
  await n.iniciar(); await n.ir(origen + '/', 500);
  for (let i = 0; i < 40; i++) { if (await n.evaluar('window.__listo === true')) break; await pausa(500); }
  const m = await n.cdp('Page.getLayoutMetrics');
  const r = await n.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1516, height: Math.ceil(m.cssContentSize.height), scale: 1 } });
  fs.writeFileSync(salida, Buffer.from(r.data, 'base64'));
  await n.cerrar(); servidor.close(); console.log('listo', salida);
});
