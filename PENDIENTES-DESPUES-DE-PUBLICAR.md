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

## Materiales conservados (escalera nueva de retos)

Al publicar el servidor con la escalera nueva, los materiales que cada persona ya había desbloqueado con retos (con los umbrales de antes)
siguen abiertos. Cómo funciona y qué revisar:

- **Migración única al arrancar** (`services/materiales-conservados.js`): unos 8 segundos después de arrancar, en segundo plano, recorre
  `retosUsuario` de 200 en 200 y guarda en `materialesConservados/{uid}` lo que cada persona ya cumplía. Al terminar marca
  `config/migraciones.materialesConservadosV1 = true` y anota en el historial de administración «Conservó los desbloqueos de materiales de N miembros».
  Si falla o se corta, no marca la bandera y se reintenta sola en el siguiente arranque (lo ya guardado no se repite).
- **Costo en Firestore (una sola vez):** una lectura por persona con retos (más una por página), una lectura y una escritura por cada persona
  que tenga algo que conservar, y 2 escrituras finales. Con 1,000 personas con retos: unas 3,000 lecturas y 1,000 escrituras, una sola vez.
- **Después, por uso normal:** una lectura extra (`materialesConservados/{uid}`) cuando alguien abre materiales o créditos, y una lectura extra al guardar un reto
  (solo mientras la migración no haya terminado).
- **Comprobar que ya terminó:** en Firestore, documento `config/migraciones`, campo `materialesConservadosV1` = true (y `...Miembros` con el total).
- **No se debe editar** `services/materiales-umbrales-previos.js` (es la fotografía de los umbrales publicados antes de la escalera nueva).

## Libros: umbrales nuevos (25 / 35 / 45) y libros conservados

`ley-fauna-mx` pasa de 5 a 25 retos, `bienestar-cautiverio` de 15 a 35 y `conservacion-mx` de 30 a 45. Quien YA había desbloqueado un libro con los
umbrales de antes lo conserva. Es el mismo patrón de los materiales pero SEPARADO (otra colección, otra tabla, otra bandera): la migración de
materiales (`materialesConservadosV1`) ya corrió y no se reabre.

- **Qué se guarda:** `librosConservados/{uid}` = `{ ids, creadoEn, actualizadoEn, version }` (solo el servidor; solo se agrega). Tabla congelada de umbrales
  anteriores: `services/libros-umbrales-previos.js` (5 / 15 / 30; no se edita).
- **Migración única al arrancar** (`services/libros-conservados.js`): unos 20 segundos después de arrancar (después de la de materiales), en segundo plano,
  con `try/catch`. Recorre `retosUsuario` de 200 en 200 y guarda lo que cada persona cumplía con 5 / 15 / 30 (solo si no está vacío). Al terminar marca
  `config/migraciones.librosConservadosV1 = true` y anota en el historial de administración «Conservó los desbloqueos de libros de N miembros».
  Si falla o se corta, no marca la bandera y se reintenta en el siguiente arranque (lo ya guardado no se repite).
- **Mientras la migración no termine:** respaldo perezoso. Quien abre libros o créditos sin documento lo recibe con sus retos actuales, y al sumar un reto
  se calcula ANTES de sumarlo, en la misma transacción. Una vez marcada la bandera ya no se hace (quien no tiene documento no tenía nada que conservar).
- **Costo en Firestore (una sola vez):** una lectura por persona con retos (más una por página), una lectura + una escritura por cada persona con algún libro
  que conservar, y 2 escrituras finales. Con 1,000 personas con retos: unas 3,000 lecturas y 1,000 escrituras, una sola vez. En el uso normal, una lectura extra
  (`librosConservados/{uid}`) al abrir libros o créditos, y una más al guardar un reto solo mientras la migración no haya terminado.
- **Avisos de «libro desbloqueado»:** no se disparan por el cambio de umbral. Quien conserva un libro no recibe aviso al cruzar el umbral nuevo (ya no es un
  libro nuevo) y los avisos usan un id fijo (`libro_<id>`), así que nunca salen dos veces.
- **Cómo verificar después de publicar:**
  1. En Firestore, `config/migraciones` debe tener `librosConservadosV1 = true` (y `librosConservadosV1Miembros` con el total) unos minutos después de arrancar.
  2. En el panel de administración, Configuración > Historial de movimientos debe mostrar «Conservó los desbloqueos de libros de N miembros» (acción del sistema).
  3. Entrar como una cuenta que tenga entre 5 y 24 retos: «Fauna silvestre y ley en México» sigue abierto y «Bienestar» y «Conservación» muestran «faltan N retos».
     Entrar como una cuenta con 0 retos: los tres libros cerrados con «faltan 25 / 35 / 45».
- **No se debe editar** `services/libros-umbrales-previos.js` (es la fotografía de los umbrales publicados antes de la subida).
