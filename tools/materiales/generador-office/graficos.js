'use strict';

// exceljs no crea gráficas: este módulo las añade DESPUÉS, escribiendo directamente las partes OOXML (dibujo + gráfica) dentro del .xlsx.
// Soporta barras (columnas), líneas y dispersión (curvas). Las gráficas leen sus datos de rangos de las hojas, así que se actualizan solas.

const JSZip = require('jszip');

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const textoRico = (texto, tam, negrita) => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${tam}" b="${negrita ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="es-MX" sz="${tam}" b="${negrita ? 1 : 0}"/><a:t>${esc(texto)}</a:t></a:r></a:p></c:rich></c:tx>`;
const tituloEje = texto => (texto ? `<c:title>${textoRico(texto, 1000, false)}<c:overlay val="0"/></c:title>` : '');
const relleno = c => `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>`;

function serie(s, i, tipo) {
  const nombre = /^[^!]+![$A-Z0-9:]+$/.test(s.nombre) ? `<c:tx><c:strRef><c:f>${esc(s.nombre)}</c:f></c:strRef></c:tx>` : `<c:tx><c:v>${esc(s.nombre)}</c:v></c:tx>`;
  const color = s.color || '1F5F3A';
  if (tipo === 'barras') {
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${nombre}<c:spPr>${relleno(color)}</c:spPr><c:invertIfNegative val="0"/>` +
      `<c:cat><c:strRef><c:f>${esc(s.categorias)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${esc(s.valores)}</c:f></c:numRef></c:val></c:ser>`;
  }
  if (tipo === 'lineas') {
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${nombre}<c:spPr><a:ln w="28575" cap="rnd">${relleno(color)}<a:round/></a:ln></c:spPr>` +
      `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${relleno(color)}</c:spPr></c:marker>` +
      `<c:cat><c:strRef><c:f>${esc(s.categorias)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${esc(s.valores)}</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser>`;
  }
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${nombre}<c:spPr><a:ln w="28575" cap="rnd">${relleno(color)}<a:round/></a:ln></c:spPr>` +
    `<c:marker><c:symbol val="circle"/><c:size val="7"/><c:spPr>${relleno(color)}</c:spPr></c:marker>` +
    `<c:xVal><c:numRef><c:f>${esc(s.categorias)}</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>${esc(s.valores)}</c:f></c:numRef></c:yVal><c:smooth val="0"/></c:ser>`;
}

function xmlGrafica(g) {
  const tipo = g.tipo;
  const series = g.series.map((s, i) => serie(s, i, tipo)).join('');
  const ejeCat = `<c:catAx><c:axId val="50010"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${tituloEje(g.tituloX)}<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50020"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const ejeX = `<c:valAx><c:axId val="50010"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${tituloEje(g.tituloX)}<c:numFmt formatCode="${esc(g.formatoX || 'General')}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50020"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
  const ejeY = `<c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D8DDD6"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>${tituloEje(g.tituloY)}<c:numFmt formatCode="${esc(g.formatoY || '#,##0')}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010"/><c:crosses val="autoZero"/><c:crossBetween val="${tipo === 'dispersion' ? 'midCat' : 'between'}"/></c:valAx>`;
  let cuerpo;
  if (tipo === 'barras') cuerpo = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="70"/><c:axId val="50010"/><c:axId val="50020"/></c:barChart>${ejeCat}${ejeY}`;
  else if (tipo === 'lineas') cuerpo = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="50010"/><c:axId val="50020"/></c:lineChart>${ejeCat}${ejeY}`;
  else cuerpo = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series}<c:axId val="50010"/><c:axId val="50020"/></c:scatterChart>${ejeX}${ejeY}`;
  const leyenda = g.series.length > 1 || g.leyenda ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/>` +
    `<c:chart><c:title>${textoRico(g.titulo, 1400, true)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${cuerpo}</c:plotArea>${leyenda}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D8DDD6"/></a:solidFill></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="es-MX"/></a:p></c:txPr></c:chartSpace>`;
}

function xmlDibujo(items) {
  const anclas = items.map((it, k) => {
    const a = it.ancla;
    return `<xdr:twoCellAnchor><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fila}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>${a.col + a.ancho}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fila + a.alto}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${k + 2}" name="Gráfico ${k + 1}" descr="${esc(it.g.titulo)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="rId${k + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anclas}</xdr:wsDr>`;
}

// buffer: contenido del .xlsx · graficos: [{ hoja, tipo, titulo, tituloX, tituloY, formatoX, formatoY, series: [{nombre, categorias, valores, color}], ancla: {col, fila, ancho, alto} }]
async function agregarGraficos(buffer, graficos) {
  const zip = await JSZip.loadAsync(buffer);
  const libro = await zip.file('xl/workbook.xml').async('string');
  const relsLibro = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const destinoDe = {};
  for (const m of relsLibro.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]); const t = /Target="([^"]+)"/.exec(m[0]);
    if (id && t) destinoDe[id[1]] = t[1].replace(/^\/?(xl\/)?/, 'xl/');
  }
  const archivoDeHoja = {};
  for (const m of libro.matchAll(/<sheet\b[^>]*>/g)) {
    const nombre = /name="([^"]*)"/.exec(m[0]); const rid = /r:id="([^"]+)"/.exec(m[0]);
    if (nombre && rid) archivoDeHoja[nombre[1].replace(/&amp;/g, '&')] = destinoDe[rid[1]];
  }
  let tipos = await zip.file('[Content_Types].xml').async('string');
  const porHoja = new Map();
  graficos.forEach(g => { if (!archivoDeHoja[g.hoja]) throw new Error('No existe la hoja ' + g.hoja); (porHoja.get(g.hoja) || porHoja.set(g.hoja, []).get(g.hoja)).push(g); });
  let nGrafica = 0; let nDibujo = 0;
  for (const [hoja, lista] of porHoja) {
    nDibujo += 1;
    const archivoHoja = archivoDeHoja[hoja];
    const carpeta = archivoHoja.replace(/[^/]+$/, ''); const base = archivoHoja.replace(/^.*\//, '');
    const relsRuta = `${carpeta}_rels/${base}.rels`;
    let rels = zip.file(relsRuta) ? await zip.file(relsRuta).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
    const idDibujo = 'rId' + (Math.max(0, ...ids) + 1);
    rels = rels.replace('</Relationships>', `<Relationship Id="${idDibujo}" Type="${NS_R}/drawing" Target="../drawings/drawing${nDibujo}.xml"/></Relationships>`);
    zip.file(relsRuta, rels);
    const items = [];
    const relsDibujo = [];
    lista.forEach(g => {
      nGrafica += 1;
      zip.file(`xl/charts/chart${nGrafica}.xml`, xmlGrafica(g));
      tipos = tipos.replace('</Types>', `<Override PartName="/xl/charts/chart${nGrafica}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      relsDibujo.push(`<Relationship Id="rId${relsDibujo.length + 1}" Type="${NS_R}/chart" Target="../charts/chart${nGrafica}.xml"/>`);
      items.push({ g, ancla: g.ancla });
    });
    zip.file(`xl/drawings/drawing${nDibujo}.xml`, xmlDibujo(items));
    zip.file(`xl/drawings/_rels/drawing${nDibujo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsDibujo.join('')}</Relationships>`);
    tipos = tipos.replace('</Types>', `<Override PartName="/xl/drawings/drawing${nDibujo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    // la etiqueta <drawing> va antes de legacyDrawing / tableParts / extLst si existen; si no, al final de la hoja
    let xml = await zip.file(archivoHoja).async('string');
    const etiqueta = `<drawing r:id="${idDibujo}"/>`;
    const posibles = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst'].map(t => xml.indexOf(t)).filter(i => i >= 0);
    const donde = posibles.length ? Math.min(...posibles) : xml.lastIndexOf('</worksheet>');
    xml = xml.slice(0, donde) + etiqueta + xml.slice(donde);
    if (!/xmlns:r=/.test(xml.slice(0, 600))) xml = xml.replace('<worksheet ', `<worksheet xmlns:r="${NS_R}" `);
    zip.file(archivoHoja, xml);
  }
  zip.file('[Content_Types].xml', tipos);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

module.exports = { agregarGraficos, xmlGrafica };
