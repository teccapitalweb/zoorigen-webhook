'use strict';

// Convierte las fotografías de portada (1024x1536, 2:3, hechas fuera con generación de imágenes) en las portadas del sitio:
// recorte centrado a la proporción de las portadas existentes (900x1230) y JPG de calidad ~80 (menos de 150 KB).
// No modifica ni borra los originales. Usa Chrome real (canvas) por CDP, sin librerías de imágenes.
// Uso: node procesar-portadas-fotos.js <carpeta-originales> <carpeta-salida>

const fs = require('fs');
const path = require('path');
const { Navegador } = require('C:/TECCAPITAL/ZOORIGEN-LOCAL/verificacion/cdp.js');

// original (sin "material-" ni .jpg) -> id del material
const MAPA = {
  'xl-botiquin-caducidad': 'inventario-botiquin-caducidad',
  'xl-libro-insumos': 'libro-entradas-salidas-insumos',
  'xl-peso-crecimiento': 'peso-curva-crecimiento',
  'xl-calendario-sanitario': 'calendario-preventivo-protocolo',
  'xl-registro-ejemplares': 'registro-ingresos-bajas-traslados',
  'xl-presupuesto-uma': 'presupuesto-anual-uma-zoologico',
  'xl-enriquecimiento-semanal': 'bitacora-enriquecimiento-semanal',
  'xl-alimentacion-recintos': 'control-alimentacion-recintos',
  'ppt-bioseguridad-recintos': 'ppt-bioseguridad-recintos',
  'ppt-enriquecimiento': 'ppt-enriquecimiento-ambiental',
  'ppt-fototrampeo': 'ppt-fototrampeo-muestreo',
  'ppt-uma-pimvs-zoologicos': 'ppt-uma-pimvs-zoologicos',
  'ppt-etogramas': 'ppt-observacion-conductual-etogramas',
  'pdf-cuarentena': 'cuarentena-recepcion-ejemplares',
  'pdf-necropsia-mortalidad': 'formato-necropsia-mortalidad',
  'pdf-plan-manejo-uma': 'plantilla-plan-manejo-uma',
  'pdf-etograma': 'etograma-hoja-observacion',
  'pdf-carteles-visitantes': 'carteles-visitantes-senales',
  'pdf-auditoria-bienestar': 'checklist-auditoria-bienestar',
  'pdf-rotulado-muestras': 'guia-rotulado-trazabilidad-muestras'
};
const ANCHO = 900, ALTO = 1230, MAX_BYTES = 150 * 1024;

(async () => {
  const [origen, salida] = process.argv.slice(2).map(p => path.resolve(p));
  fs.mkdirSync(salida, { recursive: true });
  const nav = new Navegador({ ancho: 900, alto: 900 });
  await nav.iniciar();
  try {
    await nav.ir('about:blank', 300);
    for (const [nombre, id] of Object.entries(MAPA)) {
      const datos = fs.readFileSync(path.join(origen, `material-${nombre}.jpg`)).toString('base64');
      let calidad = 0.82, base64 = '', bytes = Infinity;
      while (bytes > MAX_BYTES && calidad > 0.3) {
        base64 = await nav.evaluar(`(async () => {
          const img = new Image(); img.src = 'data:image/jpeg;base64,${datos}'; await img.decode();
          const c = document.createElement('canvas'); c.width = ${ANCHO}; c.height = ${ALTO};
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
          // recorte centrado: se escala al ancho y se corta lo que sobra arriba y abajo
          const escala = ${ANCHO} / img.naturalWidth, alto = img.naturalHeight * escala;
          g.drawImage(img, 0, (${ALTO} - alto) / 2, ${ANCHO}, alto);
          return c.toDataURL('image/jpeg', ${calidad}).split(',')[1];
        })()`);
        bytes = Buffer.from(base64, 'base64').length;
        if (bytes > MAX_BYTES) calidad -= 0.04;
      }
      fs.writeFileSync(path.join(salida, `material-${id.replace(/^guia-/, '')}.jpg`), Buffer.from(base64, 'base64'));
      console.log(`${id}.jpg  ${(bytes / 1024).toFixed(0)} KB  calidad ${calidad.toFixed(2)}`);
    }
  } finally { await nav.cerrar(); }
})().catch(e => { console.error(e); process.exit(1); });
