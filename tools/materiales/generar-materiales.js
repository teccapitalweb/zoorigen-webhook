// Genera los PDF de materiales (presentaciones y guías) a partir de los JSON de contenido, con Chrome sin ventana.
// Uso: node generar-materiales.js <carpeta-contenido> <carpeta-salida> [presentaciones|guias|todo]
//   carpeta-contenido: donde están presentaciones.json y guias.json
//   carpeta-salida:    donde se escriben <id>.pdf y catalogo-parcial.json
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');

const [contenidoArg, salidaArg, que = 'todo'] = process.argv.slice(2);
const contenido = contenidoArg && path.resolve(contenidoArg), salida = salidaArg && path.resolve(salidaArg);
if (!contenido || !salida) { console.error('Faltan carpetas'); process.exit(1); }
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LOGO = 'C:/TECCAPITAL/ZOORIGEN/assets/img/logo/zoorigen-logo-remaster-v1.png';
const logoUri = 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64');
fs.mkdirSync(salida, { recursive: true });

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Las claves de normas (NOM-059-SEMARNAT-2010) no deben partirse en dos renglones.
const titulo = s => esc(s).split(/(NOM-[0-9]+-[A-Z]+-[0-9]+)/).map((x, i) => i % 2 ? '<span style="white-space:nowrap">' + x + '</span>' : x).join('');

/* Motivos decorativos simples (sin fotos ni personajes con derechos), uno por tema. */
const MOTIVOS = {
  norma: '<path d="M12 3v18"/><path d="M9 21h6"/><path d="M5 6h14"/><path d="M5 6l-2 6a3 3 0 0 0 6 0l-2 -6"/><path d="M19 6l-2 6a3 3 0 0 0 6 0l-2 -6"/>',
  bienestar: '<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/><path d="M3.5 12h3l1.5 -3l2 6l1 -3h2.5"/>',
  abejas: '<path d="M12 3l4 2.3v4.6l-4 2.3l-4 -2.3v-4.6z"/><path d="M6 12.6l4 2.3v4.6l-4 2.3l-4 -2.3v-4.6z"/><path d="M18 12.6l4 2.3v4.6l-4 2.3l-4 -2.3v-4.6z"/>',
  hoja: '<path d="M5 21c.5 -4.5 2.5 -8 7 -10"/><path d="M9 18c6.218 0 10.5 -3.288 11 -12v-2h-4.014c-9 0 -11.986 4 -12 9c0 1 0 3 2 5h3z"/>'
};
const TEMAS = {
  'intro-nom-059': { motivo: 'norma', c1: '#1F5F3A', c2: '#2F7A4F', acento: '#E8A317', etiqueta: 'Normatividad' },
  'bienestar-cinco-dominios': { motivo: 'bienestar', c1: '#7A3A0E', c2: '#C75402', acento: '#F5C62E', etiqueta: 'Bienestar animal' },
  'polinizadores-abejas': { motivo: 'abejas', c1: '#6B5200', c2: '#D4A017', acento: '#1F5F3A', etiqueta: 'Apicultura' }
};

/* Si hay mucho texto en una diapositiva se usa una letra un poco menor para que no se encime con la nota. */
const denso = d => { const n = (d.puntos || []).join(' ').length + (d.nota || '').length; return ((d.puntos || []).length >= 5 && n > 600) || n > 820 ? ' denso' : ''; };

function htmlPresentacion(p) {
  const t = TEMAS[p.id] || { motivo: 'hoja', c1: '#1F5F3A', c2: '#2F7A4F', acento: '#E8A317', etiqueta: p.area || 'Zoorigen' };
  const total = p.diapositivas.length;
  const motivo = (tam, op) => `<svg class="motivo" width="${tam}" height="${tam}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-opacity="${op}" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round">${MOTIVOS[t.motivo]}</svg>`;
  const slides = p.diapositivas.map((d, i) => {
    if (i === 0) {
      return `<section class="s portada"><div class="portada__motivo">${motivo(620, 0.16)}</div>
        <img class="logo" src="${logoUri}" alt="Zoorigen">
        <div class="portada__txt"><div class="etq">${esc(t.etiqueta)} · Club VIP Zoorigen</div><h1>${titulo(d.titulo)}</h1>
        <ul class="intro">${d.puntos.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="pie pie--claro"><span>Presentación original de Zoorigen</span><span>${i + 1} / ${total}</span></div></section>`;
    }
    if (i === total - 1) {
      return `<section class="s cierre denso"><div class="banda"></div><div class="cuerpo"><div class="etq etq--oscuro">Para seguir</div><h2>${esc(d.titulo)}</h2>
        <div class="dos"><ol class="puntos">${d.puntos.map((x, k) => `<li><b>${k + 1}</b><span>${esc(x)}</span></li>`).join('')}</ol>
        <div class="fuentes"><h4>Fuentes consultadas</h4><ul>${(p.fuentes || []).slice(0, 7).map(f => `<li>${esc(f.nombre)}</li>`).join('')}</ul></div></div>
        ${d.nota ? `<div class="nota"><b>Para profundizar</b>${esc(d.nota)}</div>` : ''}</div>
        <div class="pie"><span>© Zoorigen · Material informativo, no sustituye asesoría profesional ni la normatividad vigente</span><span>${i + 1} / ${total}</span></div></section>`;
    }
    return `<section class="s contenido${denso(d)}"><div class="banda"></div><div class="deco">${motivo(300, 0.1)}</div><div class="cuerpo"><div class="etq etq--oscuro">${esc(t.etiqueta)}</div>
      <h2>${esc(d.titulo)}</h2><ol class="puntos">${d.puntos.map((x, k) => `<li><b>${k + 1}</b><span>${esc(x)}</span></li>`).join('')}</ol>
      ${d.nota ? `<div class="nota"><b>Para profundizar</b>${esc(d.nota)}</div>` : ''}</div>
      <div class="pie"><span>Zoorigen · Club VIP</span><span>${i + 1} / ${total}</span></div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(p.titulo)}</title><style>
  @page { size: 1280px 720px; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: 'Segoe UI', Arial, sans-serif; color: #1d2a22; }
  .s { position: relative; width: 1280px; height: 720px; overflow: hidden; page-break-after: always; break-after: page; background: #fbf8f1; }
  .s:last-child { page-break-after: auto; }
  .banda { position: absolute; left: 0; top: 0; bottom: 0; width: 22px; background: linear-gradient(180deg, ${t.c1}, ${t.c2}); }
  .deco { position: absolute; right: -40px; top: 40px; }
  .deco .motivo { stroke: ${t.c2}; stroke-opacity: .16; }
  .cuerpo { position: absolute; left: 80px; right: 90px; top: 50px; bottom: 70px; display: flex; flex-direction: column; }
  .etq { font-size: 15px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; color: ${t.acento}; }
  .etq--oscuro { color: ${t.c2}; }
  h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 52px; line-height: 1.08; color: ${t.c1}; margin: 10px 0 26px; max-width: 980px; }
  .puntos { list-style: none; display: flex; flex-direction: column; gap: 14px; max-width: 1000px; }
  .puntos li { display: flex; gap: 18px; align-items: flex-start; font-size: 29px; line-height: 1.28; }
  .puntos b { flex: 0 0 44px; height: 44px; border-radius: 50%; background: ${t.c1}; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 22px; margin-top: 2px; }
  .nota { margin-top: auto; padding: 14px 20px; border-left: 6px solid ${t.acento}; background: rgba(29, 42, 34, .06); border-radius: 4px 12px 12px 4px; font-size: 17px; line-height: 1.45; color: #34423a; }
  .nota b { display: block; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: ${t.c2}; margin-bottom: 4px; }
  .pie { position: absolute; left: 80px; right: 90px; bottom: 22px; display: flex; justify-content: space-between; font-size: 14px; color: #6b7a70; }
  .pie--claro { color: rgba(255, 255, 255, .8); left: 70px; right: 70px; }
  .portada { background: linear-gradient(135deg, ${t.c1} 0%, #0c2417 78%); color: #fff; }
  .portada__motivo { position: absolute; right: -90px; top: 40px; opacity: 1; }
  .logo { position: absolute; left: 70px; top: 50px; height: 86px; }
  .portada__txt { position: absolute; left: 70px; top: 190px; width: 820px; }
  .portada h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 66px; line-height: 1.06; margin: 14px 0 28px; color: #fff; }
  .intro { list-style: none; display: flex; flex-direction: column; gap: 10px; font-size: 24px; color: rgba(255, 255, 255, .88); border-left: 5px solid ${t.acento}; padding-left: 22px; }
  .denso h2 { font-size: 42px; margin-bottom: 14px; }
  .denso .puntos { gap: 8px; }
  .denso .puntos li { font-size: 23px; line-height: 1.22; }
  .denso .puntos b { flex-basis: 38px; height: 38px; font-size: 19px; }
  .denso .nota { font-size: 14px; padding: 9px 16px; line-height: 1.38; }
  .cierre.denso .puntos li { font-size: 20px; }
  .cierre.denso h2 { font-size: 38px; margin-bottom: 10px; }
  .cierre .fuentes ul { font-size: 12.5px; line-height: 1.3; }
  .cierre .fuentes { padding: 10px 14px; }
  .cierre.denso .nota { font-size: 12.5px; line-height: 1.32; padding: 8px 14px; }
  .cierre .dos { display: grid; grid-template-columns: 1.4fr 1fr; gap: 40px; align-items: start; }
  .cierre .puntos li { font-size: 25px; }
  .cierre .nota { font-size: 15px; }
  .fuentes { background: rgba(29, 42, 34, .06); border-radius: 14px; padding: 16px 20px; }
  .fuentes h4 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: ${t.c2}; margin-bottom: 8px; }
  .fuentes ul { list-style: none; font-size: 15px; line-height: 1.45; color: #34423a; }
  .fuentes li { padding-left: 14px; position: relative; margin-bottom: 4px; }
  .fuentes li::before { content: '•'; position: absolute; left: 0; color: ${t.acento}; }
  </style></head><body>${slides}</body></html>`;
}

/* ───── Guías (hoja carta) ───── */
function htmlGuia(d) {
  const bloque = b => {
    switch (b.t) {
      case 'p': return `<p>${esc(b.texto)}</p>`;
      case 'subtitulo': return `<h3>${esc(b.texto)}</h3>`;
      case 'ul': return `<ul>${(b.items || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      case 'ol': return `<ol>${(b.items || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol>`;
      case 'casillas': return `<ul class="casillas">${(b.items || []).map(x => `<li><i></i><span>${esc(x)}</span></li>`).join('')}</ul>`;
      case 'campos': return `<div class="campos">${(b.items || []).map(x => `<div class="campo"><label>${esc(x)}</label><span></span></div>`).join('')}</div>`;
      case 'terminos': return `<dl>${(b.items || []).map(x => `<dt>${esc(x.termino)}</dt><dd>${esc(x.def)}</dd>`).join('')}</dl>`;
      case 'aviso': return `<div class="aviso">${esc(b.texto)}</div>`;
      default: return '';
    }
  };
  const paginas = d.paginas.map((p, i) => `<section class="pg"><header><img src="${logoUri}" alt="Zoorigen"><div><small>${esc(d.area || 'Zoorigen')} · ${esc(d.tipo || '')}</small><strong>${esc(d.titulo)}</strong></div></header>
    <h2>${esc(p.titulo)}</h2>${(p.bloques || []).map(bloque).join('')}
    ${i === d.paginas.length - 1 && (d.fuentes || []).length ? `<div class="fuentes"><h4>Fuentes</h4><ul>${d.fuentes.map(f => `<li>${esc(f.nombre)}${f.url ? ' — ' + esc(f.url) : ''}</li>`).join('')}</ul></div>` : ''}
    <footer>© Zoorigen · Material informativo. No sustituye asesoría profesional ni la normatividad vigente. Uso exclusivo de miembros del Club VIP.</footer></section>`).join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(d.titulo)}</title><style>
  @page { size: Letter; margin: 0.55in 0.7in 0.85in; @bottom-left { content: '© Zoorigen · Material informativo · Uso exclusivo de miembros del Club VIP'; font-size: 7.5pt; color: #6b7a70; vertical-align: top; padding-top: 6px; } @bottom-right { content: 'Página ' counter(page); font-size: 8pt; color: #6b7a70; vertical-align: top; padding-top: 6px; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: 'Segoe UI', Arial, sans-serif; color: #1d2a22; font-size: 10.5pt; line-height: 1.45; }
  .pg + .pg header { display: none; }
  .pg { background: #fff; }
  .pg + .pg h2 { margin-top: 18px; }
  h2, h3, dt { break-after: avoid; } li, .campo, dd, .aviso { break-inside: avoid; }
  .pg:last-child { page-break-after: auto; }
  header { display: flex; align-items: center; gap: 14px; padding-bottom: 12px; margin-bottom: 18px; border-bottom: 3px solid #E8A317; }
  header img { height: 46px; }
  header small { display: block; font-size: 8.5pt; letter-spacing: .12em; text-transform: uppercase; color: #2F7A4F; font-weight: 700; }
  header strong { font-family: Georgia, serif; font-size: 13pt; color: #1F5F3A; }
  h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 21pt; line-height: 1.15; color: #1F5F3A; margin-bottom: 12px; }
  h3 { font-size: 12.5pt; color: #C75402; margin: 14px 0 6px; }
  p { margin-bottom: 9px; text-align: left; }
  ul, ol { margin: 4px 0 10px 1.2em; display: grid; gap: 4px; }
  .casillas { list-style: none; margin-left: 0; gap: 7px; }
  .casillas li { display: flex; gap: 10px; align-items: flex-start; }
  .casillas i { flex: 0 0 15px; height: 15px; border: 1.6px solid #1F5F3A; border-radius: 3px; margin-top: 3px; }
  .campos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 22px; margin: 8px 0; }
  .campo label { display: block; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: #2F7A4F; font-weight: 700; }
  .campo span { display: block; height: 20px; border-bottom: 1.4px solid #1d2a22; }
  dl { display: grid; grid-template-columns: 1fr; gap: 3px; }
  dt { font-weight: 700; color: #1F5F3A; margin-top: 7px; }
  dd { margin-left: 0; color: #34423a; font-size: 10.5pt; }
  .aviso { margin: 12px 0; padding: 10px 14px; border-left: 5px solid #E8A317; background: #fdf4e0; border-radius: 3px 10px 10px 3px; font-size: 10.5pt; }
  .fuentes { margin-top: 14px; padding: 10px 14px; background: #f4f6f2; border-radius: 10px; font-size: 8.5pt; color: #4a5a50; }
  .fuentes h4 { font-size: 8.5pt; letter-spacing: .1em; text-transform: uppercase; color: #2F7A4F; margin-bottom: 4px; }
  .fuentes ul { margin: 0 0 0 1em; gap: 1px; word-break: break-all; }
  footer { display: none; }
  </style></head><body>${paginas}</body></html>`;
}

function aPDF(html, destino) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-pdf-'));
  const archivo = path.join(dir, 'doc.html');
  fs.writeFileSync(archivo, html);
  if (process.env.GUARDAR_HTML) { fs.mkdirSync(path.join(salida, '_html'), { recursive: true }); fs.writeFileSync(path.join(salida, '_html', path.basename(destino, '.pdf') + '.html'), html); }
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-perfil-'));
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-pdf-header-footer', '--user-data-dir=' + perfil, '--virtual-time-budget=4000',
    '--print-to-pdf=' + destino, 'file:///' + archivo.replace(/\\/g, '/')], { timeout: 90000, stdio: 'ignore' });
  for (const d of [dir, perfil]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { /* Chrome aún cierra sus archivos: se limpia solo después */ } }
  if (!fs.existsSync(destino)) throw new Error('Chrome no generó ' + destino + ' (código ' + r.status + ')');
  const pdf = fs.readFileSync(destino, 'latin1');
  return (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

const catalogo = [];
if (que === 'presentaciones' || que === 'todo') {
  const { presentaciones } = JSON.parse(fs.readFileSync(path.join(contenido, 'presentaciones.json'), 'utf8'));
  const umbrales = { 'intro-nom-059': 3, 'bienestar-cinco-dominios': 10, 'polinizadores-abejas': 20 };
  for (const p of presentaciones) {
    const n = aPDF(htmlPresentacion(p), path.join(salida, p.id + '.pdf'));
    console.log('presentación', p.id, n, 'páginas');
    catalogo.push({ id: p.id, titulo: p.titulo, tipo: 'presentacion', area: p.area, descripcion: p.descripcion, archivo: p.id + '.pdf', paginas: n, acceso: 'retos', requiereRetos: umbrales[p.id] || 5, licencia: 'Original Zoorigen', fuentes: p.fuentes });
  }
}
if ((que === 'guias' || que === 'todo') && fs.existsSync(path.join(contenido, 'guias.json'))) {
  const { documentos } = JSON.parse(fs.readFileSync(path.join(contenido, 'guias.json'), 'utf8'));
  for (const d of documentos) {
    const n = aPDF(htmlGuia(d), path.join(salida, d.id + '.pdf'));
    console.log('guía', d.id, n, 'páginas');
    catalogo.push({ id: d.id, titulo: d.titulo, tipo: d.tipo === 'infografia' ? 'infografia' : d.tipo, area: d.area, descripcion: d.descripcion, archivo: d.id + '.pdf', paginas: n, acceso: 'miembros', licencia: 'Original Zoorigen', fuentes: d.fuentes });
  }
}
fs.writeFileSync(path.join(salida, 'catalogo-parcial-' + que + '.json'), JSON.stringify(catalogo, null, 2));
console.log('listo:', catalogo.length, 'documentos');
