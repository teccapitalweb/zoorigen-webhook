'use strict';

// Genera el certificado en PDF (A4 horizontal) para adjuntarlo al correo.
// Reproduce el diseño de pages/ver-certificado.html del sitio (lienzo de 1000x707 px, misma proporción
// que A4): marco verde y dorado, logo, nombre, curso, QR de verificación, firma y sello.
// Usa las fuentes estándar de PDF (Times/Helvetica/Courier): no depende de archivos de fuentes.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const ANCHO = 1000;
const ALTO = 707;
const A4_ANCHO = 841.89;
const A4_ALTO = 595.28;
const VERDE = '#1F5F3A';
const DORADO = '#E8A317';
const DORADO_OSCURO = '#8A6B20';
const TINTA = '#1A2620';
const GRIS = '#5A6A62';
const SELLO = '#B0411D';
const SITIO = 'https://www.zoorigen.com';

const ASSETS = path.join(__dirname, '..', 'assets', 'cert');
const leer = nombre => { try { return fs.readFileSync(path.join(ASSETS, nombre)); } catch (_) { return null; } };
// Si el logo no está, el encabezado queda con texto (el certificado se genera igual)
const LOGO = leer('logo.png');

// Las fuentes estándar de PDF solo cubren Latin-1/CP1252: se conservan acentos y ñ,
// y cualquier otro carácter se simplifica para que nunca salga un símbolo roto.
const SOPORTADO = new RegExp('[\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]');
const MARCAS = new RegExp('[\u0300-\u036f]', 'g');
function seguro(texto) {
  return Array.from(String(texto == null ? '' : texto).normalize('NFC')).map(c => {
    if (SOPORTADO.test(c)) return c;
    const base = c.normalize('NFD').replace(MARCAS, '');
    return SOPORTADO.test(base) && base.length === 1 ? base : '';
  }).join('').replace(/\s+/g, ' ').trim();
}

function fechaLarga(valor) {
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Mexico_City' });
  } catch (_) { return d.toISOString().slice(0, 10); }
}

// Enlace que lleva el QR: la página pública de verificación del sitio
function urlVerificacion(folio, base = SITIO) {
  return `${String(base || SITIO).replace(/\/+$/, '')}/pages/verificar.html?folio=${encodeURIComponent(String(folio || ''))}`;
}

// Rombo pequeño centrado en (cx, cy) con "r" de radio
function rombo(doc, cx, cy, r, color) {
  doc.moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy).closePath().fillColor(color, 1).fill();
}

// Ornamento de esquina (mismo trazo que el SVG del sitio, viewBox 100 -> 80 px)
function ornamento(doc, x, y, espejoX, espejoY) {
  doc.save();
  doc.translate(x + (espejoX ? 80 : 0), y + (espejoY ? 80 : 0));
  doc.scale(espejoX ? -0.8 : 0.8, espejoY ? -0.8 : 0.8);
  doc.lineWidth(1.2).lineCap('round');
  doc.strokeColor(DORADO, 0.7).moveTo(0, 30).quadraticCurveTo(20, 5, 45, 0).stroke();
  doc.strokeColor(DORADO, 0.5).moveTo(10, 40).quadraticCurveTo(25, 20, 40, 10).stroke();
  doc.fillColor(DORADO, 0.8).circle(5, 28, 3).fill().circle(28, 5, 3).fill();
  doc.fillColor(VERDE, 0.6).moveTo(15, 15).quadraticCurveTo(25, 10, 32, 18).quadraticCurveTo(25, 25, 15, 15).closePath().fill();
  doc.restore();
}

// Firma del director (los mismos trazos del SVG del sitio, viewBox 210x54)
const TRAZOS_FIRMA = [
  'M 15 18 C 10 12, 8 20, 10 28 C 12 36, 18 38, 22 32 M 10 24 L 17 23',
  'M 24 26 C 23 23, 25 20, 28 22 C 29 23, 29 26, 28 28 C 27 30, 25 30, 24 28',
  'M 31 28 C 31 24, 32 22, 33 22 C 34 22, 34 24, 33 28 M 33 18 L 33 19',
  'M 36 18 C 36 24, 36 28, 37 30 C 38 30, 40 28, 42 26 M 37 26 C 39 27, 41 29, 42 32',
  'M 45 16 C 45 22, 45 28, 46 30 M 45 25 C 47 23, 49 22, 50 24 M 47 25 C 48 27, 50 30, 51 32',
  'M 54 30 C 60 25, 68 26, 72 30',
  'M 85 18 C 82 16, 78 18, 78 22 C 78 25, 84 24, 85 27 C 86 30, 82 32, 78 30',
  'M 88 28 C 87 25, 89 22, 92 23 C 93 24, 93 27, 92 29 C 90 30, 88 29, 88 28 M 93 22 L 93 30',
  'M 96 20 C 96 25, 96 29, 97 30 C 98 29, 99 27, 99 24',
  'M 101 28 C 101 25, 103 22, 106 24 C 107 25, 107 28, 106 30 C 104 31, 102 30, 101 28 M 107 23 L 107 30',
  'M 110 28 C 113 25, 116 24, 118 26 C 119 28, 116 30, 114 30 C 115 32, 117 32, 119 30',
  'M 130 18 C 130 24, 130 30, 131 32 M 130 20 C 134 19, 138 21, 138 25 C 138 28, 134 29, 130 28 M 136 28 C 138 30, 140 32, 142 33',
  'M 8 42 C 30 38, 60 44, 90 40 C 120 36, 150 44, 185 38 C 195 37, 200 40, 198 44'
];

function dibujarFirma(doc, x, y) {
  doc.save();
  doc.translate(x, y);
  doc.lineWidth(1.5).lineCap('round').lineJoin('round').strokeColor('#1A3D24');
  for (const d of TRAZOS_FIRMA) doc.path(d).stroke();
  doc.restore();
}

function dibujarSello(doc, cx, cy) {
  doc.save();
  doc.rotate(-12, { origin: [cx, cy] });
  doc.circle(cx, cy, 47.5).fillColor('#D55A28', 0.06).fill();
  doc.lineWidth(2).strokeColor('#D55A28', 0.5).circle(cx, cy, 47.5).stroke();
  doc.lineWidth(1.2).strokeColor('#D55A28', 0.45).dash(3, { space: 2.5 }).circle(cx, cy, 39).stroke().undash();
  doc.font('Times-Bold').fillColor(SELLO, 1);
  doc.fontSize(6.4).text('CERTIFICADO', cx - 40, cy - 25, { width: 80, align: 'center', characterSpacing: 1.2, lineBreak: false });
  rombo(doc, cx, cy - 11, 3.2, '#D55A28');
  doc.font('Times-Bold').fontSize(9.5).fillColor(VERDE, 1)
    .text('MÉXICO', cx - 40, cy - 3, { width: 80, align: 'center', characterSpacing: 2, lineBreak: false });
  doc.font('Times-Bold').fontSize(6.2).fillColor(SELLO, 0.85)
    .text('OFICIAL', cx - 40, cy + 15, { width: 80, align: 'center', characterSpacing: 1.2, lineBreak: false });
  doc.restore();
}

/**
 * Devuelve un Buffer con el PDF.
 * datos: { nombre, curso, area, horas, sesiones, folio, emitido, urlVerificacion?, instructor? }
 * opciones.comprimir (por defecto true): solo las pruebas lo apagan para poder leer el texto del PDF.
 */
async function generarCertificadoPdf(datos, opciones = {}) {
  const { nombre, curso, area, horas, sesiones, folio, emitido } = datos || {};
  const enlace = (datos && datos.urlVerificacion) || urlVerificacion(folio);
  const qr = await QRCode.toBuffer(enlace, {
    margin: 0, width: 288, errorCorrectionLevel: 'M', color: { dark: '#14402A', light: '#FFFFFF' }
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [A4_ANCHO, A4_ALTO], margin: 0, compress: opciones.comprimir !== false,
      info: { Title: 'Certificado ' + seguro(folio), Author: 'Zoorigen Mexico', Subject: seguro(curso) }
    });
    const trozos = [];
    doc.on('data', t => trozos.push(t));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);

    try {
      // Se dibuja en el espacio 1000x707 del sitio. pdfkit decide los saltos de página con las
      // medidas SIN escalar, así que se le informa del espacio de dibujo real; el tamaño físico
      // de la hoja (A4) ya quedó fijado al crearla.
      doc.scale(A4_ANCHO / ANCHO);
      doc.page.width = ANCHO;
      doc.page.height = ALTO;
      const centro = ANCHO / 2;

      // Fondo crema y marcos (verde grueso, dorado fino, verde tenue)
      doc.rect(0, 0, ANCHO, ALTO).fill('#FDFAF0');
      doc.lineWidth(4).strokeColor(VERDE, 1).rect(22, 22, ANCHO - 44, ALTO - 44).stroke();
      doc.lineWidth(1).strokeColor(DORADO, 1).rect(32, 32, ANCHO - 64, ALTO - 64).stroke();
      doc.lineWidth(1).strokeColor(VERDE, 0.3).rect(38, 38, ANCHO - 76, ALTO - 76).stroke();
      ornamento(doc, 46, 46, false, false);
      ornamento(doc, ANCHO - 46 - 80, 46, true, false);
      ornamento(doc, 46, ALTO - 46 - 80, false, true);
      ornamento(doc, ANCHO - 46 - 80, ALTO - 46 - 80, true, true);

      // Encabezado: logo (o texto) a la izquierda y folio a la derecha
      if (LOGO) {
        doc.image(LOGO, 72, 54, { height: 56 });
        doc.font('Times-Italic').fontSize(10.5).fillColor(GRIS, 1)
          .text('MÉXICO · CAPACITACIÓN PROFESIONAL', 72 + 56 * (1604 / 822) + 14, 86, { lineBreak: false, characterSpacing: 1.6 });
      } else {
        doc.font('Times-Bold').fontSize(22).fillColor(VERDE, 1)
          .text('ZOORIGEN', 72, 62, { lineBreak: false, characterSpacing: 3 });
        doc.font('Times-Italic').fontSize(10.5).fillColor(GRIS, 1)
          .text('MÉXICO · CAPACITACIÓN PROFESIONAL', 72, 90, { lineBreak: false, characterSpacing: 1.6 });
      }
      const folioSeguro = seguro(folio) || '-';
      doc.font('Times-Italic').fontSize(9.5).fillColor(GRIS, 1)
        .text('FOLIO OFICIAL', 0, 64, { width: ANCHO - 72, align: 'right', characterSpacing: 1.8, lineBreak: false });
      doc.font('Courier-Bold').fontSize(13);
      const anchoFolio = doc.widthOfString(folioSeguro, { characterSpacing: 1.2 }) + 22;
      const xFolio = ANCHO - 72 - anchoFolio;
      doc.roundedRect(xFolio, 82, anchoFolio, 26, 3).fillColor(VERDE, 0.08).fill();
      doc.lineWidth(1).strokeColor(VERDE, 0.25).roundedRect(xFolio, 82, anchoFolio, 26, 3).stroke();
      doc.font('Courier-Bold').fontSize(13).fillColor(VERDE, 1)
        .text(folioSeguro, xFolio + 11, 89, { lineBreak: false, characterSpacing: 1.2 });
      doc.lineWidth(1).strokeColor(VERDE, 0.15).moveTo(72, 126).lineTo(ANCHO - 72, 126).stroke();

      // Adorno bajo el encabezado
      doc.lineWidth(1).strokeColor(DORADO, 0.8)
        .moveTo(centro - 72, 152).lineTo(centro - 14, 152).stroke()
        .moveTo(centro + 14, 152).lineTo(centro + 72, 152).stroke();
      rombo(doc, centro, 152, 5.5, DORADO);

      // Título
      doc.font('Times-Bold').fontSize(44).fillColor(VERDE, 1)
        .text('CERTIFICADO', 0, 166, { width: ANCHO, align: 'center', characterSpacing: 8, lineBreak: false });
      doc.font('Times-Italic').fontSize(16).fillColor(DORADO_OSCURO, 1)
        .text('de aprovechamiento', 0, 220, { width: ANCHO, align: 'center', characterSpacing: 3, lineBreak: false });

      // Destinatario
      doc.font('Times-Italic').fontSize(17).fillColor(GRIS, 1)
        .text('Se otorga el presente reconocimiento a', 0, 258, { width: ANCHO, align: 'center', lineBreak: false });
      const nombreSeguro = seguro(nombre) || 'Miembro VIP';
      let tamNombre = 42;
      doc.font('Times-BoldItalic');
      while (tamNombre > 20 && doc.fontSize(tamNombre).widthOfString(nombreSeguro) > 620) tamNombre--;
      doc.fontSize(tamNombre).fillColor(VERDE, 1)
        .text(nombreSeguro, 0, 288 + (42 - tamNombre) / 2, { width: ANCHO, align: 'center', lineBreak: false });
      doc.lineWidth(1).strokeColor(DORADO, 0.9)
        .moveTo(centro - 230, 344).lineTo(centro - 10, 344).stroke()
        .moveTo(centro + 10, 344).lineTo(centro + 230, 344).stroke();
      doc.circle(centro, 344, 3.5).fillColor(DORADO, 1).fill();

      // Curso
      doc.font('Times-Roman').fontSize(15).fillColor('#2A3A32', 1)
        .text('Por haber concluido satisfactoriamente el curso de capacitación profesional', 0, 366, { width: ANCHO, align: 'center', lineBreak: false });
      const cursoSeguro = seguro(curso) || 'Curso Zoorigen';
      let tamCurso = 26;
      doc.font('Times-BoldItalic');
      while (tamCurso > 15 && doc.fontSize(tamCurso).heightOfString(cursoSeguro, { width: 780, align: 'center' }) > 66) tamCurso--;
      const altoCurso = doc.fontSize(tamCurso).heightOfString(cursoSeguro, { width: 780, align: 'center' });
      doc.fillColor(VERDE, 1).text(cursoSeguro, (ANCHO - 780) / 2, 394, { width: 780, align: 'center' });

      // Área, clases y horas
      const meta = [seguro(area || 'General')];
      if (Number(sesiones) > 0) meta.push(`${Number(sesiones)} ${Number(sesiones) === 1 ? 'clase' : 'clases'}`);
      if (Number(horas) > 0) meta.push(`${Number(horas)} ${Number(horas) === 1 ? 'hora' : 'horas'}`);
      meta.push('Modalidad en línea');
      doc.font('Times-Italic').fontSize(12.5).fillColor(GRIS, 1)
        .text(meta.join('   ·   '), 0, 394 + altoCurso + 12, { width: ANCHO, align: 'center', lineBreak: false });

      doc.font('Times-Italic').fontSize(12).fillColor('#4A5A52', 1)
        .text('Reconociendo su dedicación, compromiso y empeño por continuar su formación profesional en beneficio de la fauna y la biodiversidad mexicana.',
          (ANCHO - 640) / 2, 394 + altoCurso + 40, { width: 640, align: 'center' });

      // Pie: firma · QR · fecha
      const colIzq = 118, colDer = ANCHO - 118 - 230;
      dibujarFirma(doc, colIzq + 10, 548);
      doc.lineWidth(1.5).strokeColor(TINTA, 1).moveTo(colIzq, 604).lineTo(colIzq + 230, 604).stroke();
      doc.font('Times-Bold').fontSize(10.5).fillColor(TINTA, 1)
        .text('ERICK DE JESÚS SALAS ROJAS', colIzq, 611, { width: 230, align: 'center', characterSpacing: 0.8, lineBreak: false });
      doc.font('Times-Italic').fontSize(10.5).fillColor(GRIS, 1)
        .text('Director General · Zoorigen México', colIzq, 627, { width: 230, align: 'center', lineBreak: false });

      doc.rect(centro - 41, 540, 82, 82).fillColor('#FFFFFF', 1).fill();
      doc.lineWidth(2).strokeColor(VERDE, 1).rect(centro - 41, 540, 82, 82).stroke();
      doc.image(qr, centro - 36, 545, { width: 72, height: 72 });
      doc.font('Times-Italic').fontSize(9.5).fillColor(GRIS, 1)
        .text('Escanea para verificar', centro - 80, 629, { width: 160, align: 'center', lineBreak: false });

      doc.font('Times-BoldItalic').fontSize(21).fillColor(VERDE, 1)
        .text(seguro(fechaLarga(emitido)) || '-', colDer, 566, { width: 230, align: 'center', lineBreak: false });
      doc.lineWidth(1.5).strokeColor(TINTA, 1).moveTo(colDer, 604).lineTo(colDer + 230, 604).stroke();
      doc.font('Times-Bold').fontSize(10.5).fillColor(TINTA, 1)
        .text('FECHA DE EXPEDICIÓN', colDer, 611, { width: 230, align: 'center', characterSpacing: 0.8, lineBreak: false });
      doc.font('Times-Italic').fontSize(10.5).fillColor(GRIS, 1)
        .text('Tehuacán, Puebla · México', colDer, 627, { width: 230, align: 'center', lineBreak: false });

      dibujarSello(doc, ANCHO - 95 - 47.5, 340);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generarCertificadoPdf, seguro, urlVerificacion, fechaLarga };
