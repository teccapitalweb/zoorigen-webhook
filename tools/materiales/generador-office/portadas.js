'use strict';

// Portadas propias (900 x 1230) de los materiales nuevos: ilustraciones vectoriales de Zoorigen, en colores sólidos y sin IA externa.
// Cada una muestra el tipo de archivo (hoja de cálculo, diapositivas o documento) y un motivo del tema. La tarjeta con el título la pone
// el sitio encima, en la parte baja: aquí no hay texto salvo la marca.
// Uso: node portadas.js <carpeta de salida>

const fs = require('fs');
const path = require('path');
const { capturar } = require('./chrome');
const { COLOR } = require('./comun');

const BASE = { excel: '#1F5F3A', powerpoint: '#C75402', pdf: '#1F5F8F' };
const ACENTO = '#E8A317'; const CREMA = '#FBF8F1';

const MOTIVOS = {
  botiquin: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M12 11v5M9.5 13.5h5"/>',
  libro: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  peso: '<path d="M3 20h18"/><path d="M5 20 8 6h8l3 14"/><path d="M12 6V3"/><circle cx="12" cy="13" r="2.5"/>',
  calendario: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 15l2 2 4-4"/>',
  mapa: '<path d="M4 7l5-3 6 3 5-3v13l-5 3-6-3-5 3z"/><path d="M9 4v13M15 7v13"/>',
  dinero: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2a3 3 0 0 0-2.5-1.2c-1.7 0-3 1-3 2.3 0 3 6 1.6 6 4.4 0 1.3-1.3 2.3-3 2.3a3.4 3.4 0 0 1-2.8-1.4M12 6v2m0 8v2"/>',
  hoja: '<path d="M5 21c.5-4.5 2.5-8 7-10"/><path d="M9 18c6.2 0 10.5-3.3 11-12V4h-4c-9 0-12 4-12 9 0 1 0 3 2 5z"/>',
  plato: '<circle cx="12" cy="13" r="8"/><circle cx="12" cy="13" r="4"/><path d="M3 4v5M5 4v5M7 4v5M5 9v11"/>',
  escudo: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  camara: '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  marco: '<path d="M12 3v18M9 21h6M5 6h14"/><path d="M5 6l-2 6a3 3 0 0 0 6 0zM19 6l-2 6a3 3 0 0 0 6 0z"/>',
  ojo: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  registro: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  plan: '<path d="M4 20V8l8-5 8 5v12z"/><path d="M9 20v-6h6v6"/>',
  lista: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8l1.5 1.5L12 7"/><path d="M8 14l1.5 1.5L12 13"/><path d="M14 8h3M14 14h3"/>',
  alto: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  tubo: '<path d="M9 3h6"/><path d="M10 3v12a3 3 0 0 0 6 0V3"/><path d="M10 9h6"/>'
};

// Ilustración de «hoja de cálculo» dentro de la hoja crema (coordenadas locales 0..660 x 0..640)
function ilustracionExcel() {
  const colores = ['#1F5F3A', '#2F7A4F', '#E8A317', '#C75402', '#B42318'];
  let celdas = '';
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
    const x = 40 + c * 116; const y = 130 + r * 56;
    const relleno = (r + c) % 7 === 3 ? '#FDEFD0' : (r === 2 && c === 4 ? '#FDE7E4' : (r === 4 && c === 2 ? '#E7F0E9' : '#ffffff'));
    celdas += `<rect x="${x}" y="${y}" width="116" height="56" fill="${relleno}" stroke="#D8DDD6" stroke-width="2"/>`;
    if (c > 0 && r % 2 === 0) celdas += `<rect x="${x + 22}" y="${y + 22}" width="${40 + ((r * 13 + c * 7) % 40)}" height="10" rx="5" fill="#9aa79f" opacity=".6"/>`;
  }
  const cab = [0, 1, 2, 3, 4].map(c => `<rect x="${40 + c * 116}" y="74" width="116" height="56" fill="#1F5F3A" stroke="#D8DDD6" stroke-width="2"/><rect x="${62 + c * 116}" y="96" width="60" height="12" rx="6" fill="#fff" opacity=".85"/>`).join('');
  const barras = [60, 110, 85, 150, 120].map((h, i) => `<rect x="${430 + i * 36}" y="${510 - h}" width="26" height="${h}" rx="4" fill="${colores[i % 5]}"/>`).join('');
  return `<rect x="40" y="26" width="300" height="30" rx="8" fill="#1F5F3A"/><circle cx="60" cy="41" r="6" fill="#E8A317"/>${cab}${celdas}
    <rect x="410" y="330" width="214" height="200" rx="14" fill="#fff" stroke="#1F5F3A" stroke-width="4"/>${barras}<path d="M430 520h170" stroke="#1F5F3A" stroke-width="3"/>`;
}

function ilustracionPowerPoint() {
  const lineas = [0, 1, 2].map(i => `<circle cx="72" cy="${470 + i * 52}" r="13" fill="#C75402"/><rect x="102" y="${461 + i * 52}" width="${360 - i * 60}" height="18" rx="9" fill="#8b9a90" opacity=".55"/>`).join('');
  return `<rect x="80" y="110" width="520" height="292" rx="14" fill="#E8EEE9" stroke="#D8DDD6" stroke-width="3" transform="translate(30 30)"/>
    <rect x="40" y="70" width="560" height="330" rx="14" fill="#fff" stroke="#1D2A22" stroke-width="4"/>
    <rect x="40" y="70" width="560" height="70" rx="14" fill="#C75402"/><rect x="40" y="110" width="560" height="30" fill="#C75402"/><rect x="72" y="92" width="280" height="22" rx="11" fill="#fff"/>
    <rect x="72" y="176" width="240" height="22" rx="11" fill="#1F5F3A"/><rect x="72" y="214" width="320" height="14" rx="7" fill="#8b9a90" opacity=".6"/><rect x="72" y="244" width="280" height="14" rx="7" fill="#8b9a90" opacity=".6"/><rect x="72" y="274" width="300" height="14" rx="7" fill="#8b9a90" opacity=".6"/>
    <rect x="410" y="170" width="150" height="190" rx="12" fill="#FBF1D8" stroke="#E8A317" stroke-width="3"/><circle cx="485" cy="240" r="34" fill="#E8A317"/><rect x="430" y="296" width="110" height="14" rx="7" fill="#C75402" opacity=".7"/><rect x="440" y="322" width="90" height="12" rx="6" fill="#8b9a90" opacity=".6"/>
    ${lineas}`;
}

function ilustracionPdf() {
  const checks = [0, 1, 2, 3, 4].map(i => `<rect x="86" y="${200 + i * 66}" width="30" height="30" rx="7" fill="${i < 3 ? '#1F5F3A' : '#fff'}" stroke="#1F5F3A" stroke-width="4"/>${i < 3 ? `<path d="M93 ${215 + i * 66}l7 8 12-15" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : ''}<rect x="136" y="${208 + i * 66}" width="${250 - (i % 3) * 40}" height="14" rx="7" fill="#8b9a90" opacity=".6"/>`).join('');
  return `<rect x="150" y="14" width="360" height="600" rx="14" fill="#E8EEE9" stroke="#D8DDD6" stroke-width="3" transform="rotate(5 330 314)"/>
    <rect x="70" y="30" width="520" height="590" rx="14" fill="#fff" stroke="#1D2A22" stroke-width="4"/>
    <rect x="86" y="62" width="300" height="26" rx="13" fill="#1F5F8F"/><rect x="86" y="104" width="420" height="12" rx="6" fill="#8b9a90" opacity=".5"/><rect x="86" y="130" width="360" height="12" rx="6" fill="#8b9a90" opacity=".5"/>
    ${checks}<rect x="420" y="480" width="150" height="110" rx="12" fill="#FBF1D8" stroke="#E8A317" stroke-width="3"/><rect x="438" y="506" width="110" height="12" rx="6" fill="#C75402" opacity=".7"/><rect x="438" y="532" width="90" height="12" rx="6" fill="#8b9a90" opacity=".6"/><rect x="438" y="558" width="100" height="12" rx="6" fill="#8b9a90" opacity=".6"/>`;
}

function svgPortada({ tipo, motivo }) {
  const base = BASE[tipo];
  const ilus = tipo === 'excel' ? ilustracionExcel() : tipo === 'powerpoint' ? ilustracionPowerPoint() : ilustracionPdf();
  const etiqueta = { excel: 'EXCEL', powerpoint: 'POWERPOINT', pdf: 'PDF' }[tipo];
  const ancho = etiqueta.length * 19 + 50;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1230" viewBox="0 0 900 1230">
    <rect width="900" height="1230" fill="${base}"/>
    <g transform="translate(470 60) scale(17)" fill="none" stroke="#fff" stroke-opacity=".13" stroke-width=".55" stroke-linecap="round" stroke-linejoin="round">${MOTIVOS[motivo] || MOTIVOS.lista}</g>
    <rect x="0" y="0" width="34" height="1230" fill="${ACENTO}"/>
    <g transform="translate(80 130)"><rect x="0" y="0" width="740" height="850" rx="30" fill="${CREMA}"/><g transform="translate(14 70) scale(1.08)">${ilus}</g></g>
    <g transform="translate(90 1040)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><g transform="scale(4)" stroke-opacity=".95">${MOTIVOS[motivo] || MOTIVOS.lista}</g></g>
    <rect x="210" y="1062" width="${ancho}" height="44" rx="22" fill="${ACENTO}"/><text x="${210 + ancho / 2}" y="1092" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="21" fill="#1D2A22" letter-spacing="3">${etiqueta}</text>
  </svg>`;
}

const PORTADAS = {
  'inventario-botiquin-caducidad': { tipo: 'excel', motivo: 'botiquin' }, 'libro-entradas-salidas-insumos': { tipo: 'excel', motivo: 'libro' }, 'peso-curva-crecimiento': { tipo: 'excel', motivo: 'peso' },
  'calendario-preventivo-protocolo': { tipo: 'excel', motivo: 'calendario' }, 'registro-ingresos-bajas-traslados': { tipo: 'excel', motivo: 'mapa' }, 'presupuesto-anual-uma-zoologico': { tipo: 'excel', motivo: 'dinero' },
  'bitacora-enriquecimiento-semanal': { tipo: 'excel', motivo: 'hoja' }, 'control-alimentacion-recintos': { tipo: 'excel', motivo: 'plato' },
  'ppt-bioseguridad-recintos': { tipo: 'powerpoint', motivo: 'escudo' }, 'ppt-enriquecimiento-ambiental': { tipo: 'powerpoint', motivo: 'hoja' }, 'ppt-fototrampeo-muestreo': { tipo: 'powerpoint', motivo: 'camara' },
  'ppt-uma-pimvs-zoologicos': { tipo: 'powerpoint', motivo: 'marco' }, 'ppt-observacion-conductual-etogramas': { tipo: 'powerpoint', motivo: 'ojo' },
  'cuarentena-recepcion-ejemplares': { tipo: 'pdf', motivo: 'escudo' }, 'formato-necropsia-mortalidad': { tipo: 'pdf', motivo: 'registro' }, 'plantilla-plan-manejo-uma': { tipo: 'pdf', motivo: 'plan' },
  'etograma-hoja-observacion': { tipo: 'pdf', motivo: 'ojo' }, 'carteles-visitantes-senales': { tipo: 'pdf', motivo: 'alto' }, 'checklist-auditoria-bienestar': { tipo: 'pdf', motivo: 'lista' }, 'guia-rotulado-trazabilidad-muestras': { tipo: 'pdf', motivo: 'tubo' }
};

function generar(carpeta, ids = Object.keys(PORTADAS)) {
  fs.mkdirSync(carpeta, { recursive: true });
  for (const id of ids) {
    const p = PORTADAS[id];
    capturar(`<!doctype html><html><body style="margin:0">${svgPortada(p)}</body></html>`, path.join(carpeta, `material-${id.replace(/^guia-/, "")}.png`), 900, 1230);
  }
  return ids.length;
}

module.exports = { PORTADAS, svgPortada, generar };

if (require.main === module) { console.log('portadas:', generar(process.argv[2] || path.join(__dirname, 'portadas'))); }
