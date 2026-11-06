# Pendientes después de publicar

## Retirar la ruta vieja `POST /api/visita`

**Qué es.** La ruta del contador de visitas anterior (`services/rutas-admin-extra.js`). El sitio publicado hoy (`assets/js/visitas.js` en
`origin/main`) todavía la llama desde `https://www.zoorigen.com`. El sitio nuevo usa `POST /api/metricas/visita`
(`services/rutas-metricas-visitas.js`) y guarda en otra colección.

**Cómo está blindada mientras convive** (no se elimina, para no perder las cifras de hoy):
- Solo cuenta si la petición trae `Origin` de `zoorigen.com`, `www.zoorigen.com` o localhost de pruebas (el mismo chequeo que la ruta nueva,
  más lo que haya en `CORS_ORIGINS_VISITAS`). Cualquier otro origen, o sin origen, responde 204 sin contar.
- Topes iguales a los de la ruta nueva: 60 por IP y 3000 globales cada 10 minutos.
- Sigue respetando el interruptor del panel (Configuración > contador de visitas), «No rastrear» y los robots.

**Paso exacto, DESPUÉS de publicar el sitio nuevo:**

1. Confirmar que el sitio publicado ya NO llama a la ruta vieja y SÍ a la nueva. Con el sitio ya publicado, desde cualquier terminal:

   ```bash
   curl -s https://www.zoorigen.com/assets/js/visitas.js | grep -n "api/visita\|api/metricas/visita"
   ```

   Debe aparecer solo `api/metricas/visita` (por ejemplo `/api/metricas/visita`) y **ninguna** línea con `/api/visita'`
   (la vieja termina en `api/visita` sin `metricas`). Si todavía sale `/api/visita`, el sitio nuevo no está publicado o la
   caché no se actualizó: no apagar nada.
   Revisa también la portada, el acceso, el panel y los avisos legales, que cargan ese mismo `visitas.js`.
2. Esperar un día o dos (por si alguien tiene la página vieja abierta en el navegador).
3. Apagar la ruta con **un solo cambio**, el que prefieras:
   - Variable de entorno en Railway: `ZOORIGEN_VISITA_LEGADO=off` (se apaga sin publicar código), o
   - Cambiar `const RUTA_VISITA_LEGADO_ACTIVA = true;` a `false` en `services/rutas-admin-extra.js`.
   Apagada responde 204 sin contar.
4. Pasadas unas semanas sin problemas, retirar del todo: borrar el bloque `app.post('/api/visita', ...)` y las constantes
   `RUTA_VISITA_LEGADO_ACTIVA` / `rutaVisitaLegadoActiva` de `services/rutas-admin-extra.js`, y quitar de `test/admin-metricas.test.js`
   las pruebas «ruta vieja /api/visita». Las cifras viejas (`visitasDiarias`) se conservan; el panel ya no las usa.

## Recordatorio
No hacer `git add .` en la raíz de `C:\TECCAPITAL\ZOORIGEN`: arrastraría `.claude/worktrees` y archivos sueltos.
