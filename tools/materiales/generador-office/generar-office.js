'use strict';

// Genera TODOS los materiales nuevos (8 Excel, 5 PowerPoint, 7 PDF) directamente en data/materiales/, valida los .xlsx
// (fórmulas, listas, formatos condicionales, gráficas), comprueba que cada archivo sea un ZIP/PDF válido y pese menos de 2 MB,
// agrega las entradas al catálogo (data/materiales/catalogo.json) y escribe la lista de revisión humana
// (tools/materiales/contenido/revision-materiales-office.json).
// Uso (desde esta carpeta, con `npm install` hecho):  node generar-office.js [carpeta-de-materiales]
// Las dependencias de aquí (exceljs, pptxgenjs, hyperformula...) son SOLO de desarrollo: el servidor no las carga nunca.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { VERSION, FECHA } = require('./comun');
const { libros } = require('./excel');
const { decks } = require('./ppt-contenido');
const { docs } = require('./pdf-contenido');
const { aPptx } = require('./pptx');
const { htmlDocumento, htmlCarteles } = require('./pdf');
const { aPDF } = require('./chrome');
const { validar } = require('./validar-xlsx');

const SALIDA = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'data', 'materiales'));
const CONTENIDO = path.resolve(__dirname, '..', 'contenido');
const MAX_BYTES = 2 * 1024 * 1024;
const URL_LGVS = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LGVS.pdf';
const URL_LFSA = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFSA.pdf';

// Datos de los libros de Excel (los PDF y las presentaciones traen los suyos en pdf-contenido.js y ppt-contenido.js).
// nivel: 'bajo' = organización o planeación sin contenido normativo ni clínico; 'medio' = conviene que lo revise un especialista.
const EXCEL = {
  'inventario-botiquin-caducidad': {
    titulo: 'Inventario de botiquín con alerta de caducidad', area: 'Sanidad y manejo de fauna silvestre', acceso: 'miembros', revisar: ['médico veterinario'],
    paraQuien: 'Médicos veterinarios, cuidadores y personal de UMA, zoológicos y centros',
    descripcion: 'Libro de Excel para llevar el inventario de insumos de botiquín, con colores que avisan qué caduca pronto o ya caducó y una gráfica de existencias. Sin dosis ni indicaciones.',
    revision: [{ afirmacion: 'Solo organiza existencias y fechas de caducidad que tú capturas; no recomienda productos, dosis ni usos clínicos.', fuente: 'Criterio editorial', confianza: 'alto' }]
  },
  'libro-entradas-salidas-insumos': {
    titulo: 'Libro de entradas y salidas de insumos', area: 'Administración de la unidad', acceso: 'miembros', revisar: [],
    paraQuien: 'Administradores y responsables de UMA, zoológicos, centros y clínicas',
    descripcion: 'Libro de Excel con entradas, salidas y saldo automático por insumo. Es un control interno de apoyo: no es un formato contable, fiscal ni oficial.',
    revision: [{ afirmacion: 'Se aclara dentro del libro que no es un formato contable, fiscal ni oficial.', fuente: 'Criterio editorial', confianza: 'alto' }]
  },
  'peso-curva-crecimiento': {
    titulo: 'Registro de peso y curva de crecimiento por ejemplar', area: 'Bienestar animal', acceso: 'miembros', revisar: ['biólogo'],
    paraQuien: 'Cuidadores, biólogos y médicos veterinarios',
    descripcion: 'Libro de Excel para anotar pesajes por ejemplar, ver la ganancia entre pesajes y dibujar su curva de crecimiento. No trae pesos de referencia por especie.',
    revision: [{ afirmacion: 'No incluye pesos ideales ni rangos de referencia por especie; solo calcula con los pesos que se capturan.', fuente: 'Omisión deliberada', confianza: 'alto' }]
  },
  'calendario-preventivo-protocolo': {
    titulo: 'Calendario de vacunación y desparasitación con tu protocolo', area: 'Sanidad y manejo de fauna silvestre', acceso: 'retos', requiereRetos: 4, revisar: ['médico veterinario'],
    paraQuien: 'Médicos veterinarios y responsables de la salud de colecciones o planteles',
    descripcion: 'Libro de Excel donde escribes TU protocolo (nombre, intervalo y primera fecha) y calcula próximas fechas y vencimientos con alertas de color. No incluye productos, dosis ni esquemas.',
    revision: [{ afirmacion: 'El libro no propone vacunas, productos, dosis ni intervalos: la persona escribe su protocolo definido por su médico veterinario.', fuente: 'Omisión deliberada', confianza: 'alto' },
      { afirmacion: 'Conviene que un médico veterinario confirme que la redacción de las instrucciones no sugiere un esquema.', fuente: 'Criterio editorial; requiere revisión de un médico veterinario', confianza: 'medio' }]
  },
  'registro-ingresos-bajas-traslados': {
    titulo: 'Registro de ingresos, bajas y traslados de ejemplares', area: 'Registro y trazabilidad de fauna silvestre', acceso: 'retos', requiereRetos: 6, revisar: ['abogado'],
    paraQuien: 'Responsables de UMA, PIMVS, zoológicos y centros',
    descripcion: 'Libro de Excel para llevar un registro interno de movimientos de ejemplares y ver un resumen anual por especie. No sustituye el inventario ni los avisos oficiales.',
    revision: [{ afirmacion: 'Se aclara que es un registro interno de apoyo y que los avisos, informes e inventarios oficiales se hacen en los formatos y plazos de la autoridad.', fuente: 'Criterio editorial; requiere revisión de un abogado', confianza: 'medio' }]
  },
  'presupuesto-anual-uma-zoologico': {
    titulo: 'Presupuesto anual de una UMA o zoológico', area: 'Administración de la unidad', acceso: 'retos', requiereRetos: 10, revisar: [],
    paraQuien: 'Administradores, responsables de UMA, zoológicos y centros, y consultores',
    descripcion: 'Libro de Excel con presupuesto por categoría y mes, comparación contra el gasto real, totales y gráficas. Las cifras de ejemplo son inventadas y se borran.',
    revision: [{ afirmacion: 'Todas las cifras son ejemplos ficticios marcados como EJEMPLO; no representan costos reales.', fuente: 'Criterio editorial', confianza: 'alto' }]
  },
  'bitacora-enriquecimiento-semanal': {
    titulo: 'Bitácora de enriquecimiento ambiental semanal', area: 'Bienestar animal', acceso: 'miembros', revisar: ['biólogo'],
    paraQuien: 'Cuidadores, biólogos y personal de bienestar',
    descripcion: 'Libro de Excel para programar y registrar actividades de enriquecimiento por recinto, con resumen semanal y respuesta observada.',
    revision: [{ afirmacion: 'Los tipos de enriquecimiento son categorías generales; la elección y seguridad de cada actividad depende de la especie y del criterio profesional.', fuente: 'Criterio editorial', confianza: 'alto' }]
  },
  'control-alimentacion-recintos': {
    titulo: 'Control de alimentación por recinto', area: 'Bienestar animal', acceso: 'miembros', revisar: ['médico veterinario'],
    paraQuien: 'Cuidadores, nutriólogos y responsables de zoológicos, UMA y centros',
    descripcion: 'Libro de Excel para anotar alimento ofrecido y sobrante por recinto, con consumo, porcentaje y costo. No incluye dietas ni cantidades recomendadas.',
    revision: [{ afirmacion: 'No incluye dietas ni cantidades recomendadas por especie; solo calcula con lo que se captura.', fuente: 'Omisión deliberada', confianza: 'alto' }]
  }
};

const nivelDe = revision => ((revision || []).some(r => r.confianza === 'medio' || r.confianza === 'bajo') ? 'medio' : 'bajo');

function fuentesDe(textos) {
  const out = [];
  const todo = (textos || []).join(' | ');
  if (/Ley General de Vida Silvestre/i.test(todo)) out.push({ nombre: 'Ley General de Vida Silvestre, Cámara de Diputados (texto vigente)', url: URL_LGVS });
  if (/Ley Federal de Sanidad Animal/i.test(todo)) out.push({ nombre: 'Ley Federal de Sanidad Animal, Cámara de Diputados (texto vigente)', url: URL_LFSA });
  return out;
}

async function esZip(ruta) {
  const buf = fs.readFileSync(ruta);
  if (buf.slice(0, 4).toString('latin1') !== 'PK\u0003\u0004') return 'no empieza como ZIP';
  const zip = await JSZip.loadAsync(buf);
  return zip.file('[Content_Types].xml') ? '' : 'falta [Content_Types].xml';
}

async function main() {
  fs.mkdirSync(SALIDA, { recursive: true });
  const entradas = [];
  const revisiones = [];
  const problemas = [];

  // 1) Excel
  for (const libro of libros) {
    const meta = EXCEL[libro.id];
    if (!meta) throw new Error('Falta metadatos del libro ' + libro.id);
    const archivo = `${libro.id}.xlsx`;
    const destino = path.join(SALIDA, archivo);
    fs.writeFileSync(destino, await libro.construir());
    const informe = await validar(destino);
    if (informe.problemas.length) problemas.push(`${archivo}: ${informe.problemas.join(' / ')}`);
    entradas.push({ ...meta, id: libro.id, tipo: 'excel', archivo, paginas: informe.hojas.length, detalle: `${informe.hojas.length} hojas, ${informe.formulas} fórmulas, ${informe.validaciones} listas, ${informe.graficas} gráficas` });
  }

  // 2) PowerPoint
  for (const d of decks) {
    const destino = path.join(SALIDA, d.archivo);
    const n = await aPptx(d, destino);
    entradas.push({ id: d.id, titulo: d.titulo, tipo: 'powerpoint', area: d.area, descripcion: d.descripcionCorta, archivo: d.archivo, paginas: n, acceso: 'retos', requiereRetos: d.retos, paraQuien: d.paraQuien, revisar: d.revisar || [], revision: d.revision || [], detalle: `${n} diapositivas con notas` });
  }

  // 3) PDF
  for (const d of docs) {
    const destino = path.join(SALIDA, d.archivo);
    const html = d.carteles ? htmlCarteles(d.carteles) : htmlDocumento(d, { papel: d.papel || 'Letter' });
    const n = aPDF(html, destino);
    const e = { id: d.id, titulo: d.titulo, tipo: d.tipo, area: d.area, descripcion: d.descripcionCorta, archivo: d.archivo, paginas: n, acceso: d.acceso, paraQuien: d.paraQuien, revisar: d.revisar || [], revision: d.revision || [], detalle: `${n} páginas`, fuentesTexto: d.fuentes || [] };
    if (d.acceso === 'retos') e.requiereRetos = d.requiereRetos;
    entradas.push(e);
  }

  // 4) Comprobaciones de cada archivo
  for (const e of entradas) {
    const ruta = path.join(SALIDA, e.archivo);
    const bytes = fs.statSync(ruta).size;
    e.bytes = bytes;
    if (bytes >= MAX_BYTES) problemas.push(`${e.archivo} pesa ${(bytes / 1048576).toFixed(2)} MB (máximo 2 MB)`);
    if (e.tipo === 'excel' || e.tipo === 'powerpoint') {
      const r = await esZip(ruta);
      if (r) problemas.push(`${e.archivo}: ${r}`);
      if (e.tipo === 'powerpoint') {
        const zip = await JSZip.loadAsync(fs.readFileSync(ruta));
        const diapos = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
        const notas = Object.keys(zip.files).filter(f => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).length;
        if (diapos !== e.paginas) problemas.push(`${e.archivo}: ${diapos} diapositivas en el ZIP y se esperaban ${e.paginas}`);
        if (diapos < 12 || diapos > 20) problemas.push(`${e.archivo}: ${diapos} diapositivas (se piden de 12 a 20)`);
        if (notas < diapos) problemas.push(`${e.archivo}: solo ${notas} diapositivas con notas del orador de ${diapos}`);
      }
    } else if (fs.readFileSync(ruta).slice(0, 5).toString('latin1') !== '%PDF-') problemas.push(`${e.archivo}: no es un PDF`);
  }

  // 5) Catálogo y lista de revisión
  const rutaCatalogo = path.join(SALIDA, 'catalogo.json');
  const previo = JSON.parse(fs.readFileSync(rutaCatalogo, 'utf8')).filter(m => !entradas.some(e => e.id === m.id));
  const nuevas = entradas.map(e => {
    const m = { id: e.id, titulo: e.titulo, tipo: e.tipo, area: e.area, descripcion: e.descripcion, archivo: e.archivo, paginas: e.paginas, acceso: e.acceso };
    if (e.acceso === 'retos') m.requiereRetos = e.requiereRetos;
    m.licencia = 'Original Zoorigen';
    m.version = VERSION; m.fecha = FECHA;
    const f = fuentesDe(e.fuentesTexto || (e.revision || []).map(r => r.fuente));
    if (f.length) m.fuentes = f;
    return m;
  });
  fs.writeFileSync(rutaCatalogo, JSON.stringify([...previo, ...nuevas], null, 2) + '\n');

  for (const e of entradas) {
    revisiones.push({
      id: e.id, titulo: e.titulo, tipo: e.tipo, archivo: e.archivo, bytes: e.bytes, version: VERSION, fecha: FECHA, contenido: e.detalle,
      paraQuien: e.paraQuien, acceso: e.acceso, requiereRetos: e.requiereRetos || 0,
      nivelRevision: nivelDe(e.revision), revisar: e.revisar, revision: e.revision
    });
  }
  fs.writeFileSync(path.join(CONTENIDO, 'revision-materiales-office.json'), JSON.stringify(revisiones, null, 2) + '\n');

  for (const e of entradas) console.log(`${e.archivo.padEnd(52)} ${String(Math.round(e.bytes / 1024)).padStart(5)} KB  ${e.detalle}  [revision ${nivelDe(e.revision)}]`);
  console.log(`\nTotal: ${entradas.length} archivos, ${(entradas.reduce((s, e) => s + e.bytes, 0) / 1048576).toFixed(2)} MB`);
  if (problemas.length) { console.error('\nPROBLEMAS:\n- ' + problemas.join('\n- ')); process.exitCode = 1; }
}

main().catch(err => { console.error(err); process.exit(1); });
