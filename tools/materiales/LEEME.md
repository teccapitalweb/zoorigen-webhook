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
