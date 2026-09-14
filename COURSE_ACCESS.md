# Acceso al curso inicial

El catálogo `data/zoorigen-bunny-catalog.json` es la fuente del orden de clases.
`course-preview.js` identifica de forma estable el curso **Biología, Ecología y Conservación de Tiburones y Rayas**, independientemente de su posición en Firestore. Ordena sus clases por `num` y libera todas menos la última. Con cero o una clase no libera videos.

`GET /api/course-preview` entrega los metadatos que usa el portal para ordenar el primer curso y mostrar las clases incluidas. No entrega tokens ni claves. El reproductor envía `courseKey` y `videoId` a `POST /api/bunny/embed-token`; el servidor exige sesión válida y comprueba la política antes de firmar un video. Las membresías vigentes y los administradores conservan el acceso existente. Los videos de otros cursos siempre requieren acceso de pago.

Para agregar clases, actualizar el catálogo canónico conservando números consecutivos y videos únicos. Un catálogo ambiguo o inválido no libera contenido. Si un video también está en otro curso, no se libera gratuitamente. Para sustituir el curso inicial, cambiar `INITIAL_COURSE_TITLE` y `INITIAL_COURSE_KEY` junto con el catálogo y verificar la correspondencia en Firestore.

Desplegar este backend y la versión correspondiente de ZOORIGEN de forma coordinada: el frontend anterior no envía `courseKey`; el nuevo frontend mantiene bloqueado el acceso gratuito si no puede obtener una política válida.

Validación sin credenciales: `npm test`. Comprueba tamaños 0, 1, 2 y 8, el catálogo real (2 de 3 clases gratuitas), cursos distintos, sesión inválida, pago vigente, cancelación vigente, vencimiento y administración. Los proveedores externos se sustituyen por dobles en las pruebas del controlador HTTP.
