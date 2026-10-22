# Cómo se generaron los materiales (PDF)

Los PDF de `data/materiales/` salen de los textos de `contenido/` (presentaciones.json y guias.json) con
`generar-materiales.js`, que usa Chrome sin ventana. Sirve para regenerarlos si cambias un texto:

```
node tools/materiales/generar-materiales.js tools/materiales/contenido data/materiales todo
```

- Usa el logo del sitio (`C:/TECCAPITAL/ZOORIGEN/assets/img/logo/zoorigen-logo-remaster-v1.png`); si el sitio está en otra
  carpeta, cambia la constante `LOGO` del script.
- Escribe `catalogo-parcial-*.json` junto a los PDF: úsalo para actualizar `data/materiales/catalogo.json` (los umbrales de
  retos de las presentaciones están en la variable `umbrales` del script: 3, 10 y 20).
- Después de regenerar hay que reiniciar/desplegar el servidor: los catálogos se leen una sola vez al arrancar.
- Cada documento trae su lista `revision` (afirmaciones delicadas con su fuente y confianza). Las marcadas "medio" conviene
  que las revise un especialista antes de publicar.

## Materiales de Excel, PowerPoint y PDF nuevos (generador-office)

Los 20 materiales nuevos (8 Excel, 5 PowerPoint, 7 PDF) salen de `tools/materiales/generador-office/`. Esas dependencias
(exceljs, pptxgenjs, hyperformula, jszip) son SOLO de desarrollo: el servidor nunca las carga.

```
cd tools/materiales/generador-office
npm install
node generar-office.js            # escribe en data/materiales/, valida y actualiza catalogo.json
```

- `excel.js` (libros con fórmulas reales, listas, formato condicional y gráficas), `ppt-contenido.js` + `pptx.js` (presentaciones con
  notas del orador), `pdf-contenido.js` + `pdf.js` (PDF con Chrome sin ventana).
- `generar-office.js` valida cada .xlsx (`validar-xlsx.js`: fórmulas calculadas sin #REF!/#DIV/0!, listas, gráficas), comprueba que
  .xlsx/.pptx sean ZIP válidos, que cada archivo pese menos de 2 MB y que cada presentación tenga de 12 a 20 diapositivas con notas.
- Escribe `contenido/revision-materiales-office.json`: por material, versión, fecha, tamaño y la lista de afirmaciones con su
  fuente y confianza. Los marcados `nivelRevision: "medio"` conviene que los revise un especialista (abogado, veterinario o biólogo)
  antes de publicar.
- Portadas: `procesar-portadas-fotos.js` recorta (900 x 1230) y comprime a JPG las fotografías hechas fuera (carpeta del sitio
  `output/imagegen/`); `portadas.js` genera las ilustraciones PNG de respaldo. Van en `assets/img/materiales/` del sitio.
- Tipos nuevos del catálogo: `excel` (.xlsx) y `powerpoint` (.pptx); el servidor los entrega como adjunto, con su Content-Type,
  solo a quien cumple la regla (membresía, retos o créditos).
