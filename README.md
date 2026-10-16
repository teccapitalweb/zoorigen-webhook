# zoorigen-webhook20 |30 |30 ||80 |100 |80 ||250 |

Backend del Club VIP de Zoorigen. Corre en Railway y conecta **Stripe → Firebase (Firestore) → Bunny Stream**.

El frontend vive en el repo `teccapitalweb/ZOORIGEN` (GitHub Pages, www.zoorigen.com).

## Endpoints

| Ruta | Para qué | Autenticación |
|---|---|---|
| `POST /webhook` | Eventos de Stripe (pago, renovación, fallo, cancelación) | Firma de Stripe |
| `POST /create-checkout-session` | Crea el pago (mensual / anual) | Token de Firebase |
| `POST /verify-membership` | Revalida la membresía contra Stripe | Token de Firebase |
| `POST /cancel-subscription` | Cancela al final del periodo | Token de Firebase |
| `POST /reactivate-subscription` | Quita la cancelación programada | Token de Firebase |
| `POST /api/bunny/embed-token` | Enlace firmado de video (5 min) | Token de Firebase + membresía |
| `GET /api/prueba-gratuita` | Si la persona puede elegir su prueba gratuita y qué cursos puede elegir | Token de Firebase |
| `POST /api/prueba-gratuita` | Elige UN curso como prueba (`{ cursoId }`); no se puede cambiar | Token de Firebase |
| `GET /api/premios` | Nivel, XP, logros y premios (vista previa sin membresía) | Token de Firebase |
| `POST /api/premios/usar` | Canjea UN premio por UN curso adelantado (`{ cursoId }`) | Token de Firebase + membresía |
| `POST /api/premios/bienvenida` | +100 XP una sola vez, solo cuentas nuevas (14 días) | Token de Firebase (sin membresía también) |
| `GET /api/retos` | Progreso de retos, camino y nivel (vista previa sin membresía) | Token de Firebase |
| `POST /api/retos/resultado` | Resultado de un reto de práctica (`{ retoId, puntaje, total }`) | Token de Firebase + membresía |
| `POST /api/retos/camino` | Resultado de un reto del camino (`{ modo, indice, puntaje, total }`); cualquier reto, en cualquier orden, XP una sola vez por reto | Token de Firebase + membresía |
| `GET /api/retos/clasificacion` | Top 20 por XP total (solo alias) y mi posición | Token de Firebase + membresía |
| `POST /api/referidos/registrar` | El invitado se registra con el código (`{ codigo, deviceId, huella }`), idempotente | Token de Firebase |
| `GET /api/referidos/estado` | Código, enlace, invitados (solo alias), hitos y premios por invitar | Token de Firebase |
| `GET/POST/DELETE /api/directorio` | Directorio de la comunidad (tarjeta propia) | Token de Firebase (+ membresía para ver y crear) |
| `GET /api/admin/bunny-catalogo` | Colecciones y videos listos de Bunny, en vivo (solo lectura) | Token de Firebase + administrador |
| `GET /api/noticias?limit=7` | Últimas noticias del sector (máx. 30) | Token de Firebase (sin membresía también) |
| `GET /api/avisos` | La campana: avisos personales (30) + globales (15), máx. 40 | Token de Firebase (sin membresía también) |
| `GET/POST /api/admin/noticias`, `POST /api/admin/noticias/sync`, `POST /api/admin/noticias/:id/eliminar` | Noticias del equipo, sincronizar ahora, borrar | Token de Firebase + administrador |
| `GET/POST /api/admin/datos-curiosos`, `POST .../:id/actualizar`, `.../eliminar`, `.../enviar` | Banco de datos curiosos | Token de Firebase + administrador |
| `GET/POST /api/admin/avisos`, `POST /api/admin/avisos/:id/eliminar` | Avisos globales de la campana | Token de Firebase + administrador |
| `GET /api/libros` | Libros de lectura (SIN páginas) con `desbloqueado`/`faltan`; avisa en la campana los ya ganados | Token de Firebase (sin membresía: se listan cerrados) |
| `GET /api/libros/:id` | El libro completo (meta + páginas); 403 `{ error, requiere, superados, faltan }` si sigue bloqueado | Token de Firebase + membresía + retos |
| `GET /api/materiales` | Catálogo de PDF con su estado (`desbloqueado`, `faltan`, `soloMiembros`) | Token de Firebase (sin membresía: se listan cerrados) |
| `GET /api/materiales/:id/archivo` | El PDF (`application/pdf`, `inline`, `private, no-store`); 403 igual que los libros | Token de Firebase + membresía (+ retos si el material lo pide) |
| `GET /api/admin/libros`, `GET /api/admin/materiales` | Qué se cargó del disco y qué se descartó (con el motivo), solo lectura | Token de Firebase + administrador |
| `GET /api/registro` | Libro de registro de ejemplares: ejemplares (con estado), eventos, resumen por especie y límites | Token de Firebase + membresía |
| `POST /api/registro/ejemplares`, `PATCH/DELETE /api/registro/ejemplares/:id` | Alta o nacimiento de un ejemplar, corregirlo, borrarlo (con sus eventos) | Token de Firebase + membresía |
| `POST /api/registro/ejemplares/:id/eventos`, `DELETE /api/registro/eventos/:id` | Baja, muerte, traslado o nota; deshacer un evento | Token de Firebase + membresía |
| `GET /api/registro/informe?anio=AAAA` | Informe anual: existencias al 1 de enero, altas, nacimientos, bajas, muertes, traslados y existencias al 31 de diciembre, por especie y total | Token de Firebase + membresía |
| `GET /api/cursos/progreso` | Avance de la persona en todos sus cursos (`sesionesVistas`, `quizzesAprobados`, `completado`, `certificadoFolio`, `completadoEn`); importa una sola vez el progreso viejo, firma en su lugar los certificados anteriores de la persona y marca completados los cursos que ya tienen certificado | Token de Firebase |
| `POST /api/cursos/:cursoId/progreso` | Marca una clase como vista (`{ sessionIndex }`); al completar el curso emite el certificado firmado, el aviso, el correo con PDF y el XP | Token de Firebase + membresía (o clase gratis / prueba) |
| `POST /api/cursos/:cursoId/quiz` | Califica las preguntas de una clase (`{ sessionIndex, respuestas }`); es de práctica | Token de Firebase + membresía (o clase gratis / prueba) |
| `POST /api/certificados/nombre` | Confirma o corrige UNA vez el nombre del primer certificado (`{ folio, nombre }`); lo deja en el certificado, el perfil y la cuenta | Token de Firebase |
| `GET /api/certificados/:folio` | Verificación PÚBLICA de un certificado, firmado o anterior aceptable (`anterior: true`); 30 consultas cada 10 minutos por IP | — |
| `POST /api/admin/certificados` | El administrador emite (o recupera) un certificado (`{ uid, cursoId, nombre?, horas?, sesiones? }`) | Token de Firebase + administrador |
| `GET /api/admin/certificados/pendientes` | Certificados sin firma válida con su diagnóstico y un resumen de conteos (solo lectura) | Token de Firebase + administrador |
| `GET /api/cursos/demo` | Catálogo PÚBLICO de cursos para la portada (`{ cursos:[{ id, titulo, area, descripcion, clases, proximamente, elegiblePrueba }] }`); nunca videos, urls ni preguntas; `Cache-Control: public, max-age=300` | — |
| `POST /api/encuesta` | Guarda la copia parcial o completa de la encuesta de la portada (`{ sessionId, respuestas, completada, contacto? }`); 20 envíos cada 10 minutos por IP | — |
| `POST /api/chatbot/sin-respuesta` | Registra una pregunta que la guía no supo contestar (`{ texto, tipo: 'animal'\|'otro' }`), ya sin correos, teléfonos ni URLs; 30 envíos cada 10 minutos por IP | — |
| `GET /api/admin/encuesta?limite=1000` | Respuestas de la encuesta, más recientes primero (máx. 2000) | Token de Firebase + administrador |
| `GET /api/admin/chatbot/sin-respuesta?limite=200` | Preguntas sin respuesta de la guía, ordenadas por `veces` (máx. 1000) | Token de Firebase + administrador |
| `GET /cron/noticias?key=CRON_KEY` | Corre la tarea diaria a mano (también cabecera `x-cron-key`) | `CRON_KEY` |
| `GET /` | Health check | — |

### Videos y clases gratis desde Firestore

`POST /api/bunny/embed-token` reconoce un `videoId` (debe tener forma de UUID) si está en el catálogo
estático (`data/zoorigen-bunny-catalog.json`) o en alguna lección (`lecciones[].videoId`) de la colección
`cursos` de Firestore. Es gratis para quien no es miembro el video gratis fijo de siempre o una lección con
`gratis: true` dentro de un curso con `cursoMuestraGratis: true` (sin ese campo en el curso, la marca de la
lección no cuenta). El índice se guarda en memoria 60 s; si un video no aparece y el caché tiene más de 10 s se
refresca una vez (nunca más de una lectura cada 10 s). Solo lee Firestore; si la lectura falla se registra el
error y siguen funcionando el catálogo estático y el video gratis fijo.

### Prueba gratuita de un curso a elección

Aplica a quien **nunca ha tenido un plan** (miembros que jamás pagaron y miembros nuevos). No aplica a quien ya
pagó alguna vez (activo, cancelado o vencido) ni a administradores. La persona elige UN curso, confirma y no
puede cambiarlo. En ese curso **todas las clases son gratis menos la última** (la última del arreglo `lecciones`,
sean 3 o 5); la última se desbloquea con la membresía.

- `GET /api/prueba-gratuita` devuelve `{ elegible, elegida: null | { cursoId }, motivo, cursosElegibles, cursoPorDefectoId }`.
- `POST /api/prueba-gratuita` con `{ cursoId }`: 200 `{ ok, cursoId }`; 400 curso inválido o no elegible;
  403 la persona no es elegible (el `error` trae el motivo); 409 `Ya elegiste tu prueba gratuita y no se puede cambiar`
  (la elección se guarda en una transacción, así que dos solicitudes a la vez guardan solo una).
- Un curso es elegible si existe en `cursos`, tiene 2 o más lecciones, **todas** con `videoId` UUID de Bunny (los de
  Drive no se pueden proteger), y no es `disponibleSiempre` ni el curso de muestra del panel (`cursoMuestraGratis`). El curso por defecto (el que trae el video gratis fijo `befd1641…`)
  también se puede elegir: quien ya lo conocía puede volver a tomarlo como su prueba.
- "Nunca ha tenido plan" es `nuncaHaTenidoPlan` en `services/prueba-gratuita.js`: ninguna señal de plan en
  `miembros` ni en `usuarios` (`planVence`/`fechaExpiracion`, `planInicio`, `ultimoPago`, `stripeSubscriptionId`,
  `planTipo`, `activadoManualmente`, `shopifyOrderId`, `planActivo`, un `planStatus` real, cancelación...). `stripeCustomerId`
  **no** cuenta: Stripe lo crea al abrir el pago aunque nunca se complete.
- `/api/bunny/embed-token`: quien no es admin ni tiene plan y eligió un curso abre solo las clases 1..n-1 de ese
  curso (`freePreview: true`); la última y los demás cursos responden 403 como siempre. Mientras la persona sea
  elegible (nunca pagó y hay cursos que elegir) o ya haya elegido, el video gratis fijo deja de ser gratis para ella;
  para quien pagó antes y no tiene plan sigue gratis como hoy. Las clases marcadas gratis en el panel
  (`cursoMuestraGratis` + `gratis`) no cambian para nadie. Miembros con plan vigente y administradores no pasan por
  esta lógica (ni siquiera se lee la colección nueva).
- Si Firestore falla, la prueba no concede nada extra y lo demás queda como antes.
- **Colección `pruebasGratuitas/{uid}`** = `{ uid, cursoId, elegidoEn }`. La escribe solo este servidor (Admin SDK).
  Las reglas de Firestore niegan todo lo que no listan (catch-all `match /{document=**} { allow read, write: if false }`),
  así que el navegador no puede leerla ni crearla; por eso la elección **no** se guarda en `miembros`, donde el dueño
  de la cuenta sí puede escribir campos. No hace falta tocar las reglas para publicar esto.

## Retos, logros, niveles, premios, referidos y directorio

Todo el código está en `services/` (reglas puras: `logros.js`, `retos.js`, `premios.js`, `referidos.js`,
`directorio.js`) y `services/rutas-club.js` (las rutas; `server.js` solo las monta y le pasa `autenticarFirebase`,
`esAdminPorDocumentos`, `tienePlanVigente`, `obtenerIndiceVideos`...). **Nada de la lógica de premios vive en el navegador**:
el sitio pregunta y pinta; el servidor decide. No se tocan `/api/bunny/embed-token` ni las rutas de pago, así que
quien ya paga conserva exactamente el mismo acceso a los videos (el "adelanto" de un curso es solo del calendario del sitio).

Todas responden con `Cache-Control: no-store` y errores `{ error }` en español. Sin membresía vigente (administradores cuentan como
con membresía), `GET /api/premios`, `GET /api/retos` y `GET /api/directorio` devuelven una **vista previa** (`membresia: false`, nivel 1 / 0 XP,
logros sin XP ni "ganado", 3 tarjetas ficticias) y no escriben nada; las rutas que cambian algo responden
`403 { codigo: 'membresia-requerida' }`. Un administrador no canjea premios (400).

### Colecciones nuevas (solo las escribe el servidor; NO se cambian las reglas de Firestore)

Las reglas ya niegan todo lo que no listan (`match /{document=**} { allow read, write: if false }`), así que el navegador no puede
leerlas ni escribirlas. Hay que publicar el servidor, no las reglas.

| Colección | Contenido |
|---|---|
| `retosUsuario/{uid}` | XP de retos, retos superados, `porReto`, días con retos, `retosHoy`, `camino` |
| `premiosUsuario/{uid}` | `ganados:[clave]`, `usados:[{clave, cursoId, fecha}]` y `xpTotal` (para la clasificación) |
| `actividadUsuario/{uid}` | `dias`: fechas de México (últimos 120) en que la persona con membresía abrió logros o retos |
| `referidos/{uidInvitado}` | `anfitrionUid, codigo, deviceId, huella, ip, ua, creadoEn, estado, motivo, hitos` |
| `dispositivosAnfitrion/{uid}` | `ids, huellas, combos` (huella\|ip) de los dispositivos del anfitrión (últimos 20) |
| `codigosReferido/{CODIGO}` | `{ uid }`: para encontrar al anfitrión por su código sin recorrer `miembros` |
| `directorio/{uid}` | La tarjeta profesional (validada; el texto va tal cual y el sitio lo escapa al mostrarlo) |

Consultas que usa y que Firestore resuelve sin índices compuestos: `certificados where memberUid==`, `foroPosts where authorUid==`,
`referidos where anfitrionUid==`, `premiosUsuario where xpTotal> orderBy xpTotal` (+ `count()`), `directorio orderBy actualizado`
y `miembros` por rango de id (solo para códigos viejos que nadie ha abierto). Requiere `firebase-admin` 12 (ya instalado).

### Niveles

XP total = logros (l1..l26) + insignias de retos (r1..r10) + XP de los retos + XP por referidos + XP por cursos terminados + premio de bienvenida. **El nivel no se guarda: se recalcula en cada consulta.**

**Los umbrales se recalibraron** al agregar las fuentes nuevas de XP (cursos y bienvenida): Profesional queda en ~25 % del XP máximo posible y Maestro en ~75 % (y Maestro sigue siendo alcanzable: pide menos del 90 %). El sitio no copia esta tabla: la lee de `niveles` en `GET /api/premios`.

| Nivel | Desde | Hasta |
|---|---|---|
| Nivel | Desde | Hasta | % del XP máximo (6,850) |
|---|---|---|---|
| 1 Aprendiz | 0 | 500 | 0 % |
| 2 Técnico | 500 | 1,700 | 7 % |
| 3 Profesional | 1,700 | 3,500 | 25 % |
| 4 Líder | 3,500 | 5,100 | 51 % |
| 5 Maestro | 5,100 | — | 74.5 % |

(Antes: 300 / 1,200 / 2,500 / 4,500 con un máximo de 6,860 XP.)

### Tabla de logros (fuente: `services/logros.js` y `services/retos.js`)

| Id | Categoría | Nombre | Se gana al... | XP |
|---|---|---|---|---|
| l1 | Inicio | Bienvenido a la manada | tener la membresía vigente | 20 |
| l2 | Inicio | Primeros pasos | entrar al club en 3 días distintos | 30 |
| l3 | Inicio | Tarjeta de presentación | crear tu tarjeta en el directorio | 60 |
| l4 | Cursos | Primer curso | terminar 1 curso | 60 |
| l5 | Cursos | Curiosidad en marcha | terminar 2 cursos | 80 |
| l6 | Cursos | Estudiante constante | terminar 4 cursos | 140 |
| l7 | Cursos | Biblioteca viva | terminar 6 cursos | 200 |
| l8 | Cursos | Mirada amplia | terminar cursos de 2 áreas | 50 |
| l9 | Constancia | Rastro fresco | racha de 3 días | 30 |
| l10 | Constancia | Semana de campo | racha de 7 días | 70 |
| l11 | Constancia | Quincena firme | racha de 14 días | 150 |
| l12 | Constancia | Mes de expedición | racha de 30 días | 250 |
| l13 | Constancia | Temporada completa | racha de 60 días | 350 |
| l14 | Constancia | Treinta días en la manada | sumar 30 días distintos | 150 |
| l15 | Comunidad | Primera discusión | 1 discusión en el foro | 50 |
| l16 | Comunidad | Voz propia | 3 discusiones | 100 |
| l17 | Comunidad | Líder de opinión | 6 discusiones | 150 |
| l18 | Comunidad | Conversación viva | 5 respuestas recibidas en tus discusiones | 100 |
| l19 | Comunidad | Querido por la manada | 10 me gusta recibidos | 100 |
| l20 | Comunidad | Referente del foro | 25 me gusta recibidos | 150 |
| l21 | Comunidad | Embajador | 1 invitado válido | 60 |
| l22 | Comunidad | La manada crece | 4 invitados válidos | 150 |
| l23 | Maestría | Medio camino | terminar 8 cursos | 260 |
| l24 | Maestría | Experto en fauna | terminar 12 cursos | 380 |
| l25 | Maestría | Naturalista completo | cursos de 4 áreas | 150 |
| l26 | Maestría | Maestro de la fauna | terminar los 15 cursos | 500 |
| r1 | Retos | Primer reto | superar 1 reto | 20 |
| r2 | Retos | Repaso constante | superar 10 retos | 40 |
| r3 | Retos | Ojo de naturalista | 100 % en el Detective de campo | 40 |
| r4 | Retos | Mente afilada | 100 % en 3 quizzes | 50 |
| r5 | Retos | Racha de retos | retos superados en 5 días distintos | 50 |
| r6 | Retos | Maestro de retos | superar 50 retos | 80 |
| r7 | Retos | Todoterreno | superar quiz, detective y ordena | 50 |
| r8 | Retos | Explorador de mundos | superar 3 casos del modo historia | 40 |
| r9 | Retos | Constancia de campo | retos superados en 15 días distintos | 60 |
| r10 | Retos | Leyenda de los retos | superar 100 retos | 70 |

Otras fuentes de XP: **XP de retos** (6 si se aprueba con 60 %, 10 si es perfecto; práctica una vez por reto por día de México, flashcards no da;
techo de por vida de 600 XP en práctica + el camino: 22 quiz + 13 detective + 18 orden = 53 retos × 10 = 530) y **XP por referidos**
(por invitado válido y una sola vez cada hito: pagó una suscripción +120, superó 5 retos +40, superó 15 retos +80; solo suman los primeros 6 invitados válidos = máximo 1,440).

| Fuente | XP máximo |
|---|---|
| Logros l1..l26 (los 9 de cursos suman solo 790) | 2,760 |
| Insignias r1..r10 | 500 |
| XP de retos (práctica 600 + camino 530) | 1,130 |
| XP por referidos (6 invitados × 240) | 1,440 |
| XP por cursos terminados (los 15 cursos: 20 a 100, el décimo 180) | 920 |
| Premio de bienvenida | 100 |
| **Total alcanzable en toda la vida** | **6,850** (dentro de 6,000 a 7,500) |

**Por qué se bajó el XP de los logros de cursos (l4-l8, l23-l26).** Cada curso terminado ya paga con la fórmula (920 XP por los 15), así que esos 9 logros pasaron de 1,820 a 790 XP: ahora son un bono por hito y no se paga dos veces lo mismo.
Sus valores nuevos: l4 20, l5 30, l6 50, l7 80, l8 30, l23 100, l24 150, l25 80, l26 250. Los demás logros no cambiaron.

### Cuánto cuesta llegar a cada nivel (rutas típicas, calculadas con las reglas reales)

Todas incluyen la bienvenida (+100) y membresía vigente. "Racha" = días seguidos hasta hoy. Una prueba (`test/calibracion.test.js`, con el simulador `test/helpers/rutas-xp.js`) verifica estas rutas.

| Ruta | XP | Nivel |
|---|---|---|
| Casual: 1 curso, 8 retos, 8 días en el club | 410 | Aprendiz |
| **Típica del contrato**: 4 cursos de 2 áreas, 20 retos, 30 días (14 seguidos), tarjeta en el directorio, 1 discusión | 1,420 | Técnico (no llega a Profesional) |
| Lo mismo con 4 áreas y 3 discusiones | 1,600 | Técnico |
| **Profesional**: 6 cursos de 4 áreas, 20 retos, 30 días (14 seguidos), tarjeta, 3 discusiones | 1,810 | Profesional |
| Profesional por otro camino: 4 cursos, 40 retos, 60 días (30 seguidos), tarjeta, 1 discusión | 1,870 | Profesional |
| Solo estudiar: los 15 cursos, 10 días, tarjeta | 1,950 | Profesional |
| Solo retos: camino completo, práctica al tope, 60 días seguidos | 2,780 | Profesional |
| Solo invitar: 6 invitados que pagan y juegan | 1,830 | Profesional |
| Muy completa: 12 cursos, 60 días seguidos, todos los retos, 6 discusiones, tarjeta (sin invitados) | 4,800 | Líder |
| Los 15 cursos, 60 días seguidos, todos los retos, tarjeta (sin foro ni invitados) | 4,550 | Líder |
| **Maestro** = lo mismo que "muy completa" + 4 invitados que pagan | 5,970 | Maestro |
| Todo menos invitados (los 15 cursos, 60 días seguidos, 9 discusiones, 99 me gusta, todos los retos) | 5,200 | Maestro, apenas |
| Todo | 6,850 | Maestro |

* **Profesional (1,700 XP)** cuesta más que antes: la ruta típica (4 cursos + 20 retos + 30 días) se queda en ~1,400-1,600; hacen falta unos 2 cursos más, o más discusiones, o 60 días en el club (la racha de 30 días vale 250 y la de 60, 350).
* **Maestro (5,100 XP)** es el 74.5 % del máximo: sin invitados hay que hacer prácticamente todo (el margen sobre Maestro es de ~100 XP: los 15 cursos, las rachas de 30 y 60 días, el foro y todos los retos). Se puede saltar UNA de las dos grandes fuentes
  (los cursos o los invitados), nunca las dos: sin cursos ni invitados el techo es ~3,500. Solo estudiar, solo jugar retos o solo invitar no alcanza ni Líder (3,500).

### Premios

Hay solo tres premios (`profesional`, `maestro`, `referidos-1`); cada uno abre UN curso antes de su fecha. Todos exigen membresía vigente para canjearse.

| Clave | Condición |
|---|---|
| `profesional` | nivel ≥ 3 (1,700 XP) |
| `maestro` | nivel ≥ 5 (5,100 XP) |
| `referidos-1` | 4 invitados válidos (es el único premio por invitar; ya no existe `referidos-2`) |

Un premio ganado **no se pierde** aunque el XP baje (solo se agregan claves a `ganados`, dentro de una transacción). `POST /api/premios/usar` gasta un solo
premio por llamada (el primero ganado sin usar), en una transacción: 400 sin `cursoId` o administrador · 403 sin membresía o sin premio libre · 404 el curso no existe en `cursos` ·
409 el curso ya se adelantó, es `disponibleSiempre`/de muestra o es la prueba gratuita elegida. El sitio considera ABIERTOS los cursos que estén en `usados[].cursoId`.

### Retos

* `GET /api/retos` → `{ ok, membresia, nivel:{id,nombre,xp,desde,hasta,faltan}, xp (número: XP total), superados, porReto:{id:{veces,mejor,total,superados,perfectos,mejorPct}}, camino:{quiz,detective,orden} (cuántos retos lleva superados cada uno), caminoHechos:{quiz:[0,5],detective:[],orden:[]} (cuáles), retosHoy, totales:{quiz:22,detective:13,orden:18} }`.
* `POST /api/retos/resultado` → `{ ok, aprobado, xpGanado, xp (total), nivel, insigniasNuevas:[{id,nombre}] }`. `retoId` ∈ quiz|detective|orden|flashcards|historia, `total` entero 1-30, `puntaje` entero 0..total.
* `POST /api/retos/camino` → `{ ok, aceptado, aprobado, xpGanado, camino, caminoHechos }` (y `xp`, `nivel`, `insigniasNuevas` si se aceptó). Todos los retos del camino están abiertos: se acepta cualquier `indice` menor que `totales[modo]` (si no, 400) que se apruebe con 60 % y que aún no esté en `caminoHechos[modo]`; solo da XP la primera vez. Las cuentas que solo guardaban el contador `camino` conservan su avance como los primeros N retos.
  Si el sitio agrega retos, hay que subir `TOTALES_CAMINO` en `services/retos.js` (y se mueve el XP máximo).
* `GET /api/retos/clasificacion` → `{ ok, top:[{posicion,nombre,xp,nivel:{id,nombre}}], yo:{posicion,xp}|null }`. Ordena por XP total (guardado en `premiosUsuario.xpTotal` cada vez que la persona abre logros o retos o juega);
  los administradores no se clasifican; mismo XP = misma posición; `nombre` es primer nombre + inicial.
* Límite de **60 solicitudes por minuto por usuario** entre `resultado` y `camino` (429). Cada GET de logros/retos: 60 por minuto.
* Cada GET de `/api/premios` y `/api/retos` (y cada resultado) registra el día en `actividadUsuario` (fecha de México, UTC-6); la racha son días consecutivos que terminan hoy.

### Referidos

* El código es `ZOO-` + las 6 primeras letras del UID en mayúsculas; el enlace es `https://www.zoorigen.com/pages/club-registro.html?ref=CODIGO`.
* **El viejo `POST /api/referidos` se quitó** (contaba invitados por `miembros.referredBy`, que el navegador escribe). El sitio nuevo ya no lo usa: **publica servidor y sitio juntos**,
  porque la pantalla de referidos del sitio viejo dejará de cargar. Lo que se escriba en `referredBy` ya no cuenta para nada.
* `POST /api/referidos/registrar` (`{ codigo, deviceId, huella }`, ambos de dispositivo obligatorios; 10 por minuto) → `{ ok, estado, motivo? }`. **Idempotente**: cada invitado se registra una sola vez (el documento se llama como su uid y se crea en una transacción);
  repetir devuelve su estado actual y, si seguía pendiente, revisa si ya confirmó. Un código que no existe o el propio código responden `rechazado` sin consumir el registro (puede usar otro código).
* Estados: `pendiente-correo` (aún no confirma; el servidor lo pregunta a Firebase Auth con `emailVerified`; Google cuenta como confirmado), `valido`, `rechazado` (con `motivo`). Solo los `valido` cuentan para premios y XP.
* **Control de dispositivos.** Queda `rechazado` si: es el mismo uid; su `deviceId` está entre los dispositivos del anfitrión (los que mandó en el header `X-Device-Id`, opcionalmente `X-Huella`, al abrir `GET /api/referidos/estado`, y el
  dispositivo con el que el propio anfitrión se registró); su huella **y** su IP coinciden con las del anfitrión; comparte `deviceId` o huella+IP con otro invitado ya válido del mismo anfitrión (el primero que se registra o confirma se queda; dos registros simultáneos se resuelven por orden de llegada);
  o su cuenta de Firebase tiene más de 14 días de creada (no se puede "invitar" a quien ya era miembro). La IP es el primer valor de `x-forwarded-for`.
* `GET /api/referidos/estado` → `{ ok, codigo, enlace, validos, pendientes, rechazados, invitados:[{alias,fecha,estado,motivo?,hitos:[{clave,texto,puntos,logrado}],puntos,sinPuntos?}], puntosTotales, premios:[{clave,requisito,faltan,ganado,usado}] }`.
  **Nunca** devuelve correos, teléfonos, uids ni dispositivos de los invitados: solo `alias` (primer nombre + inicial; si el nombre guardado parece correo o teléfono sale "Miembro").
* Hitos: "pagó" se acepta con `ultimoPago` o con plan vigente de Stripe/Shopify que no sea un alta manual (campos que las reglas de Firestore no dejan escribir al navegador). Un hito logrado no se pierde.

**Límites honestos del control anti-fraude.** No es infalible: compara el identificador guardado en el navegador (`localStorage`), una huella ligera y la IP. Quien borre los datos del navegador, use modo incógnito, otro navegador, otro teléfono o una VPN
no se detecta (aunque necesita una cuenta distinta con correo confirmado). La IP y el `x-forwarded-for` pueden ser falseados por quien arme las peticiones a mano. Dos personas de una misma casa con el mismo modelo de teléfono comparten huella e IP y se rechazarían entre sí
(por eso la IP sola nunca basta). El techo de 6 invitados con XP y el que los premios solo dan un adelanto de calendario limitan el daño.

### Directorio

`GET /api/directorio?sector=&q=` → `{ ok, membresia, tarjetas:[{uid,nombre,profesion,sector,ciudad,bio,contacto:{whatsapp,email,linkedin,web,instagram},actualizado}], mia }` (hasta 300, la más reciente primero; filtros sin importar acentos).
Sin membresía: `membresia:false` y 3 tarjetas ficticias. `POST /api/directorio` (crea o reemplaza la tarjeta propia; requiere membresía; 20 cambios por minuto) y `DELETE /api/directorio` (borra la propia, también sin membresía).
Límites: nombre 2-80, profesión 80, sector 60, ciudad 80, bio 400, correo 120, enlaces 200 (http/https, sin usuario:clave; LinkedIn solo de linkedin.com), WhatsApp 8-15 dígitos, Instagram usuario. Los campos extra se ignoran.
**Los textos se guardan tal cual** (sin convertir a entidades): quien los muestre debe ESCAPARLOS al dibujarlos (el sitio de Zoorigen lo hace). Nunca los pongas con innerHTML sin escapar.

### Qué tan confiable es cada fuente de XP

* **Retos**: el servidor no ve las respuestas, solo el puntaje que informa el navegador; alguien que arme las peticiones a mano puede declarar 100 %. Por eso hay techos duros (práctica 600, camino solo hasta `totales`, una vez por reto por día) y las insignias piden días distintos.
  Solo con retos se llega a unos 1,630 XP como máximo (Técnico).
* **Cursos** (l4-l8, l23-l26 y el XP por curso terminado): salen de `certificados` (por `memberUid`, `courseId` e `issuedAt`). Los certificados nuevos los escribe y firma el servidor (clases en orden, con acceso a cada video y su quiz contestado), así que son tan confiables como los retos. Los certificados viejos, escritos por el navegador, siguen contando igual que antes hasta que las reglas de Firestore dejen de permitir que el navegador escriba `certificados`. Cada certificado solo cuenta si su curso existe en `cursos`, un curso cuenta una vez y las áreas salen de `cursos`, no del certificado.
* **Foro**: discusiones, me gusta recibidos (sin los propios) y respuestas recibidas (`repliesCount`, con tope de 50 por discusión). No se cuentan las respuestas ESCRITAS por la persona: requeriría un índice de grupo de colecciones que no existe.
* **Constancia**: días en que la persona abrió logros o retos; lo registra el servidor.

## Noticias del sector, datos curiosos y avisos (campana)

Código en `services/`: `avisos.js`, `noticias.js`, `datos-curiosos.js`, `tarea-diaria.js` (reglas) y `rutas-noticias.js` (rutas).
Las colecciones son **solo del servidor** (Admin SDK; las reglas de Firestore ya niegan lo que no listan, así que **no hay cambios de reglas**):
el sitio usa los endpoints con `Authorization: Bearer <idToken>`. Los textos se guardan tal cual (recortados y sin caracteres de control);
**el sitio los escapa al mostrarlos**.

| Colección | Qué guarda |
|---|---|
| `noticiasSector/{id}` | `titulo, extracto (≤280), link, fuente, imagen (https o ''), categoria, categoriaNombre, color, fecha, origen 'auto'/'admin', plantilla?, resumen?[], idioma, creadoEn` |
| `avisos/{uid}/items/{id}` | Avisos personales: `tipo, titulo (≤120), texto (≤240), enlace (≤40), creadoEn` |
| `notificacionesGlobales/{id}` | Avisos para todos: `tipo, icono, color, titulo, descripcion (≤320), enlace, origen, creadoEn` |
| `datosCuriosos/{id}` | `texto (20..300), tema, fuente, fuenteUrl, activo, veces, ultimoEnvio, origen 'base'/'admin', creadoEn` |
| `config/noticiasSector`, `config/datosCuriosos` | `ultimaSync` y `ultimoEnvioFecha` (para no repetir el envío del día) |

Tipos personales: `certificado, logro, premio, libro, xp, bienvenida`. Globales: `noticia, dato, sistema, clase, curso, general`.
Categorías de noticias: `fauna, conservacion, veterinaria, normativa, apicultura, ciencia` (nombre y color en `services/noticias.js`).

### Noticias automáticas
`data/noticias-fuentes.json` (`[{ id, nombre, url (https), categoria }]`) lista los RSS/Atom en español. `syncNoticias` los lee **en paralelo** (12 s
de tiempo máximo cada uno; si uno falla se reporta y los demás siguen), se queda con lo que está en español, es relevante (fauna silvestre, conservación,
veterinaria, CITES, SEMARNAT, PROFEPA, apicultura…) y no es ruido (deportes, farándula, política partidista…), y guarda **como máximo 4 nuevas por corrida
repartidas entre categorías**. Solo se guarda titular + extracto corto + enlace a la nota original + la imagen que entregue la fuente (solo https), nunca el
artículo. El id es un hash del enlace (sin parámetros de seguimiento), así que no se duplica. Las `auto` de más de 21 días se borran (lotes de 400);
las `admin` nunca. Si existe `NEWSDATA_API_KEY` también se consulta NewsData.io (`language=es`).

#### Imagen de la nota (enriquecimiento)
La imagen se toma del feed (`media:content`, `media:thumbnail`, `enclosure`, primera `<img>`) o de NewsData (`image_url`). Cuando el feed **no** la
trae, `services/noticias-imagen.js` descarga la página de la nota (`link`) y toma, en este orden, `og:image`, `og:image:secure_url`, `twitter:image` o
`<link rel="image_src">`. Se guarda en `imagen` (https, ≤400 caracteres); si la página tampoco tiene, queda `''` y el sitio muestra su foto de respaldo.
- **Cuándo**: solo durante la sincronización (tarea diaria, `GET /cron/noticias` y el botón "Buscar noticias ahora"), nunca en la petición de una persona.
  Se busca para las notas nuevas sin imagen y, de paso, para hasta 8 notas `auto` anteriores que quedaron sin imagen (dos intentos como máximo por nota,
  anotados en `imagenIntentos`). Si ya hay imagen no se vuelve a pedir nada.
- **Seguridad (SSRF)**: solo https y puerto 443, sin usuario/contraseña; el nombre se resuelve por DNS y se rechaza si cualquier dirección es privada, de
  bucle local, link-local, de metadatos (169.254.169.254), CGNAT, multicast o reservada (IPv4 e IPv6, incluidas `::ffff:` y NAT64); la conexión real se hace a la
  dirección ya validada (sin DNS rebinding); máximo 2 redirecciones y cada una pasa por las mismas reglas (no se sigue a `http`).
- **Límites**: 4 s en total por página, 400 KB leídos como máximo, solo `text/html` o `application/xhtml+xml`, 3 páginas a la vez,
  `User-Agent: Mozilla/5.0 (compatible; ZoorigenNoticias/1.0; +https://www.zoorigen.com)`.
- **Descartes**: `favicon`, `sprite`, `logo`, `icon`, `avatar`, `placeholder`, `default` en la ruta, `.svg`/`.ico`, medidas de menos de 200 px en el nombre
  (`-150x150`) o en `?w=`/`?h=`, y direcciones de más de 400 caracteres. Pasa al siguiente candidato.
- **Pruebas sin red**: `fetchPagina` y `resolver` se inyectan (`test/noticias-imagen.test.js`). Si el llamador pasa su propio `fetch` para los feeds sin
  `fetchPagina`, o el `fetch` global fue reemplazado, no se busca nada o se usa ese reemplazo: ninguna prueba sale a internet. `buscarImagenes: false`
  en las opciones o `NOTICIAS_IMAGENES=off` en el entorno apagan la búsqueda. La respuesta de `POST /api/admin/noticias/sync` incluye
  `imagenes: { buscadas, encontradas, rellenadas }`.

### Tarea diaria (dentro del propio proceso, sin dependencias)
13:00 UTC (7:00 a.m. de Ciudad de México) y a los 20 s de arrancar (solo si la última sincronización tiene más de 6 horas, para que un reinicio no
traiga noticias de más): **1)** `syncNoticias` y, si guardó alguna, aviso global `noticias_<fecha>` "📰 Nuevas noticias del sector" (uno por día);
**2)** `enviarDatoCuriosoSiToca`: **martes y viernes** (fecha de México, UTC-6 fijo) envía un dato curioso como aviso global `dato_<fecha>_<id>`,
idempotente por día. Elección: activo con menos `veces`, luego `ultimoEnvio` más antiguo, luego id. Cada paso es independiente: si uno falla, el otro corre.
Los temporizadores no mantienen vivo el proceso. Se apaga con `NOTICIAS_TAREA=off`; las pruebas nunca la arrancan (solo se inicia al ejecutar `node server.js`).
Para correrla a mano: `GET /cron/noticias?key=<CRON_KEY>` (o cabecera `x-cron-key`); sin `CRON_KEY` configurada responde 401. La llave se compara con
`timingSafeEqual`.

### Banco de datos curiosos
`data/datos-curiosos-banco.json` = `[{ id, tema, texto, fuente, fuenteUrl }]`. Se siembra en `datosCuriosos` **solo si la colección está vacía**.
Las entradas marcadas `"prueba": true` (las 6 que trae hoy) **no se siembran**: así el banco real no queda bloqueado por datos de ejemplo. Al entregar el banco
real se reemplaza el archivo (sin `prueba`) y se siembra solo.

### Avisos personales (los crea el servidor cuando ya sabe del evento)
| Evento | Id del aviso | Título |
|---|---|---|
| Insignia o logro nuevo | `logro_<id>` | 🏅 ¡Nueva insignia! |
| Premio disponible (nivel o 4 invitados) | `premio_<clave>` | 🎁 ¡Ganaste un premio! |
| +100 XP de bienvenida | `bono_bienvenida` | 👋 ¡Bienvenido al club! |
| +XP por curso terminado | `bonoxp_<cursoId>` | ⭐ ¡Curso terminado! |

Son idempotentes (id fijo; si existe no se sobrescribe) y nunca rompen la respuesta si fallan. Para no avisar dos veces lo mismo, `premiosUsuario/{uid}` guarda
`logrosAvisados` y `cursosAvisados`; una cuenta que ya tenía XP calculado antes de esta función toma lo que ya tiene como punto de partida **sin avisar**
(para no llenarle la campana de cosas viejas). Los administradores y quien no tiene membresía no reciben avisos de insignias.
Los certificados los emite el servidor al completar el curso (ver «Certificados y progreso de cursos»): el aviso `cert_<folio>` (tipo `certificado`, enlace `certificados`, título «¡Certificado listo!») se crea una sola vez, al emitirse.

## Libros y materiales que se desbloquean con retos

Dos catálogos que se leen del disco **una vez al arrancar** (cambiarlos requiere un nuevo despliegue). Lo que no pasa la
validación se descarta con un aviso en consola y queda en `errores` de `GET /api/admin/libros` / `/api/admin/materiales`
(nunca con rutas del disco). Módulos: `services/libros.js`, `services/materiales.js`, `services/rutas-materiales.js`.

**Regla de acceso (la misma para libros y materiales):** administrador, todo abierto · sin membresía vigente, todo se lista
pero cerrado (`desbloqueado: false`, `soloMiembros: true`) · con membresía, un libro (o un material de `acceso: "retos"`)
se abre al llegar a `requiereRetos` retos superados; un material de `acceso: "miembros"` abre con la membresía. Los retos
superados salen de `retosUsuario/{uid}` (el mismo contador `superados` de `services/retos.js` que usa `GET /api/retos`).

### Libros (`data/libros/<id>.json`)

`{ id, titulo, subtitulo, autor, categoria, color, icono, resumen, requiereRetos, actualizado, fuentes:[{nombre,url}], paginas:[{titulo, parrafos:[], lista?:[]}], revision?:[...], prueba? }`

Validación estricta: `id` `[a-z0-9-]` e igual al nombre del archivo, `requiereRetos` entero de 1 a 200, de 3 a 40 páginas, `color`
`#RRGGBB`, `actualizado` AAAA-MM-DD, fuentes solo `https`, **ningún texto puede llevar etiquetas HTML**, archivos de hasta 1 MB.
`GET /api/libros` **nunca** devuelve páginas, fuentes ni revisión; `GET /api/libros/:id` entrega el libro solo si está desbloqueado.

- `GET /api/libros` → `{ ok, membresia, superados, libros:[{ id, titulo, subtitulo, autor, categoria, color, icono, resumen, paginasTotal, requiereRetos, desbloqueado, faltan, soloMiembros }] }`.
  En la misma llamada se crean los **avisos de la campana** de los libros ya ganados (`libro_<id>`, tipo `libro`, enlace
  `club-pdfs.html`; «¡Desbloqueaste tu primer libro!» el primero, «¡Desbloqueaste un nuevo libro!» los demás). El id es fijo:
  no se duplican aunque se llame muchas veces, y avisa también a quien ganó sus retos antes de que existiera el libro. Los
  administradores y quien no tiene membresía no reciben avisos.
- `POST /api/retos/resultado` y `POST /api/retos/camino` (este último solo cuando el reto se acepta) agregan a su respuesta
  `libros` (el mismo resumen, sin páginas) y `librosNuevos` (ids de los libros que se cruzaron justo con ese avance, del menor al
  mayor; `[]` para administradores). El resto del contrato de esos endpoints no cambia.

### Materiales (`data/materiales/catalogo.json` + `data/materiales/<archivo>.pdf`)

`[{ id, titulo, tipo: guia|plantilla|checklist|glosario|infografia|presentacion, area, descripcion, archivo: "<id>.pdf", paginas, acceso: miembros|retos, requiereRetos?, licencia, fuentes? }]`

El `archivo` solo puede ser `<nombre>.pdf` en minúsculas (sin carpetas, sin `..`); debe existir **dentro** de `data/materiales`
(también tras resolver enlaces simbólicos), empezar con `%PDF-` y pesar hasta 30 MB. `GET /api/materiales/:id/archivo` busca el
`:id` **exacto** en el catálogo validado y lee únicamente la ruta que se comprobó al arrancar: no existe forma de pedir otra
ruta (`../`, `%2e%2e`, ids raros o nombres de archivo dan 404). El navegador lo pide con `fetch` + `Authorization: Bearer` y lo
muestra con una URL de blob.

Respuestas: `GET /api/materiales` → `{ ok, membresia, superados, materiales:[{ id, titulo, tipo, area, descripcion, paginas, acceso, requiereRetos, licencia, desbloqueado, faltan, soloMiembros }] }`
(sin nombre de archivo ni ruta). Bloqueado → 403 `{ error, codigo: 'membresia-requerida' | 'retos-insuficientes', requiere, superados, faltan }`;
no existe → 404.

**Vista previa para quien no es miembro:** `GET /api/libros` y `GET /api/materiales` responden **200** a cualquier persona con
sesión (también sin membresía o con la membresía vencida) con el catálogo COMPLETO y solo sus metadatos (título, subtítulo,
autor, categoría, tipo, área, descripción, resumen, color, ícono, cantidad de páginas, `requiereRetos`), todos con
`desbloqueado: false` y `soloMiembros: true`, para que el sitio pueda mostrar portadas y tarjetas y la persona explore. Ese
listado **jamás** lleva el contenido: ni `paginas` (en un libro no existe; en un material `paginas` es solo la cantidad),
ni `fuentes`, ni `revision`, ni `ruta` / `archivo` / `driveId` / tamaño. El contenido sigue protegido: `GET /api/libros/:id` y
`GET /api/materiales/:id/archivo` dan 403 `membresia-requerida` a quien no es miembro, sin una sola página ni byte de PDF.
Las portadas son archivos del sitio (`assets/img/materiales/<id>`), no salen del servidor. Pruebas:
`test/vista-previa-catalogo.test.js`.

Límites por persona: 60 solicitudes por minuto en las lecturas y 20 por minuto en la descarga de PDF (429 «Demasiadas solicitudes»).
`LIBROS_DIR` y `MATERIALES_DIR` (opcionales) cambian las carpetas; se usan en las pruebas, en producción no hacen falta.

## Libro de registro de ejemplares (UMA / PIMVS)

Herramienta para miembros: cada persona lleva SU inventario de ejemplares y una bitácora de eventos; de ahí salen el
inventario actual y el borrador del informe anual. **No decide nada legal**: solo ordena lo que la persona escribe y no
guarda plazos ni valores de ninguna norma (los recordatorios los pone el sitio). Reglas puras en `services/registro-ejemplares.js`,
rutas en `services/rutas-registro.js`.

- **Colecciones (solo las escribe el servidor; reglas de Firestore sin cambios):** `registrosUma/{uid}/ejemplares/{id}` y
  `registrosUma/{uid}/eventos/{id}`. Cada documento lleva el `uid` del token; el uid jamás se toma del cuerpo ni de la URL.
- **Ejemplar:** `{ uid, nombreComun*, nombreCientifico, nombre, marca, sexo: macho|hembra|indeterminado, origen*, tipoIngreso*: alta|nacimiento, fechaIngreso*, notas, creado, actualizado }`
  (`*` obligatorios). Un ingreso o nacimiento SIEMPRE crea un ejemplar nuevo con su origen y su fecha.
- **Evento:** `{ uid, ejemplarId, tipo: baja|muerte|traslado|nota, fecha, causa, destino, notas, creado }`. La baja pide `causa`, el
  traslado `destino`, la nota `notas`. Un ejemplar solo puede tener UNA salida (baja, muerte o traslado): el id de esa salida es
  `sal_<ejemplarId>` y se guarda en una transacción, así dos solicitudes a la vez guardan una sola (409 `ya-tiene-salida`).
  Para corregir un error se borra el evento (`DELETE /api/registro/eventos/:id`).
- **Estado:** no se guarda; se calcula con los eventos (`activo`, `baja`, `muerte` o `traslado`) y la fecha de salida.
- **Fechas:** `AAAA-MM-DD` reales, desde 1900, no futuras (con la fecha de México) y un evento no puede ser anterior al ingreso.
- **Texto:** máximo 300 caracteres (notas 1000); sin caracteres de control; se guarda tal cual, quien lo muestre debe escaparlo.
- **Límites por persona:** 500 ejemplares y 5000 eventos (409 `limite-ejemplares` / `limite-eventos`); 30 lecturas y 40
  escrituras por minuto (429). Todas las respuestas llevan `Cache-Control: private, no-store`.
- **Informe:** por año calendario; `existenciasInicio` = ingresó antes del 1 de enero y no había salido; `existenciasFin` = ingresó
  hasta el 31 de diciembre y no había salido. Siempre cuadra: inicio + altas + nacimientos - bajas - muertes - traslados = fin.
  Si el año está en curso (`enCurso: true`), las existencias «al 31 de diciembre» son las de la fecha de hoy (`corte`).
  `movimientos` trae el detalle del año (ingresos y salidas) para el control de movimientos de inventario.
- Pruebas: `test/registro-ejemplares.test.js` (reglas) y `test/registro-api.test.js` (rutas).

## Certificados y progreso de cursos

Todo el código está en `services/certificados.js` (reglas puras, con pruebas), `services/rutas-certificados.js` (las rutas),
`services/certificado-pdf.js` (el PDF) y `scripts/auditar-certificados.js`. Funciona igual que en Alintec: el avance y los
certificados son **del servidor**; el navegador solo pregunta y avisa qué clase terminó. Respuestas con `Cache-Control: no-store`
y errores `{ error }` en español. La verificación pública admite peticiones desde cualquier origen (CORS abierto, como el resto).

### Colecciones (las escribe solo este servidor)

| Colección | Contenido |
|---|---|
| `miembros/{uid}/progresoCursos/{cursoId}` | `cursoId, uid, sesionesVistas:[int], quizzesAprobados:[int], completado, certificadoFolio, completadoEn, origenLegado?` |
| `certificados/{folio}` | Certificado firmado (ver abajo) |
| `miembros/{uid}.progresoLegadoImportado` | `true` cuando ya se importó el progreso viejo (una sola vez) |

El nombre del certificado lo decide el servidor: `miembros/{uid}.nombreCertificado`, si no `name`/`nombre`, si no el nombre de la sesión o el correo.

Un certificado (`ZOO-<AÑO UTC>-<8 hex de sha256(uid|cursoId)>`, determinista: no se duplica) guarda: `folio, uid, nombre, cursoId,
curso, area, horas, sesiones, instructor, emitido (ISO), year, verificado: true, origen, firmaBackend, createdAt` **y** los nombres que ya
usan el sitio y los logros: `memberUid, courseId, courseTitle, courseArea, courseDuration, memberName, memberEmail, issuedAt, totalClases`.
`origen` es `backend` (al completar el curso), `admin` (con `validadoBackend: true`, `emitidoPor: 'admin'`) o `legacy-validado`
(los viejos que aprobó la auditoría, con `validadoBackend: true`).

**Firma**: HMAC-SHA256 con `CERTIFICATE_SIGNING_KEY` sobre `folio\nuid\ncursoId\nemitido\nyear` (comparada con `timingSafeEqual`).
Un certificado vale solo si está `verificado`, la firma es correcta y el origen es conocido; por eso un documento escrito o alterado desde
el navegador no se muestra en la verificación pública.

### Rutas

- `GET /api/cursos/progreso` → `{ cursos: { [cursoId]: { sesionesVistas, quizzesAprobados, completado, certificadoFolio, completadoEn } }, legadoImportado }`.
  `completadoEn` es la fecha ISO de término del curso (la del progreso o, si no la trae, la de emisión de su certificado) y `null` si no está completo.
  Además (ver «Certificados anteriores»): todo curso con certificado vigente (firmado o anterior aceptable) aparece `completado: true` con su
  `certificadoFolio`, aunque no se haya importado el progreso viejo y aunque falte `LEGACY_PROGRESS_IMPORT_BEFORE`; los anteriores aceptables
  de esa persona se firman en su lugar (si hay `CERTIFICATE_SIGNING_KEY`). Máximo 50 certificados por consulta; un error de este paso
  solo se registra y nunca rompe la respuesta.
- `POST /api/cursos/:cursoId/progreso` con `{ sessionIndex }` → `{ ok, sesionesVistas, completado, certificado: null | { folio, nombre, curso, area, horas, sesiones, instructor, emitido }, bono? }`.
  - 404 si el curso o la clase no existen; 403 si no es administrador, no tiene plan vigente y la clase no es gratis ni de su prueba gratuita
    (las mismas reglas de `/api/bunny/embed-token`).
  - 409 `Aprueba el quiz de esta clase antes de completarla` (la clase tiene `preguntas` y no se han contestado) y 409
    `Completa primero la clase anterior` (orden secuencial). Repetir una clase ya vista no cambia nada.
  - Al ver la última clase, dentro de la misma transacción, se crea UNA sola vez `certificados/{folio}`. Repetir la última clase (o dos
    solicitudes a la vez) devuelve el mismo certificado sin duplicarlo ni reenviar el correo. Si la persona ya tenía un certificado válido
    de ese curso (por ejemplo, emitido por el administrador), se reutiliza. Si tiene un certificado **anterior** aceptable (escrito por el
    navegador) se reutiliza su folio: se firma en su lugar y no se crea otro documento, aviso ni correo. Si el anterior existe pero no es
    aceptable (firma alterada, sin nombre, etc.) responde `409` («El folio existente requiere auditoría antes de continuar») y no guarda la clase.
  - Solo al emitirse por primera vez: aviso en la campana, correo con el PDF adjunto (en segundo plano; un error solo se registra) y el XP
    del curso, calculado con la misma lógica de logros de siempre (`bono: { xp, ordinal }`; no se informa a administradores ni a quien no
    tiene plan).
  - **Sin `CERTIFICATE_SIGNING_KEY`** el servidor arranca igual y guarda las clases normales, pero la clase que completaría el curso
    responde `503 { error: 'Los certificados aún no están configurados' }` **sin guardarse**, así no se pierde nada y se reintenta después.
- `POST /api/cursos/:cursoId/quiz` con `{ sessionIndex, respuestas:[int] }` → `{ aprobado, correctas, total, detalle:[{ correcta, acertada }] }`.
  Las preguntas viven en `lecciones[i].preguntas` (`vof` o `multiple`, con `correcta`). Las respuestas van en el orden de las preguntas
  **válidas** (las incompletas se saltan igual que en el sitio) y `detalle` trae una fila por cada pregunta válida. Es de **práctica**: equivocarse muestra la
  correcta pero no frena; basta con haberlo contestado (queda en `quizzesAprobados`) para poder completar la clase.
- `POST /api/certificados/nombre` (con sesión) con `{ folio, nombre }` → `{ ok, nombre, folio, corregido }`. Al emitirse el PRIMER certificado de una cuenta,
  `POST /api/cursos/:cursoId/progreso` responde `confirmarNombre: true` y el sitio pregunta "¿Este es el nombre que quieres en tu certificado?". El servidor
  guarda el nombre (3 a 38 caracteres, nombre y al menos un apellido, solo letras) en el certificado (`nombre`, `memberName`, `nombreConfirmado`), en el perfil
  (`nombreCertificado`, `name`, `nombreCertificadoConfirmadoEn`) y en la cuenta de Firebase. El nombre NO forma parte de la firma, así que el certificado y su
  verificación pública siguen valiendo. Solo una vez por cuenta (409 después). No se pregunta a quien ya tiene certificados anteriores (escritos por el navegador o
  validados después) ni se modifican los emitidos por el administrador. Los certificados siguientes salen con el nombre del perfil de ese momento y fijos
  (`nombreConfirmado: true`). Si el nombre cambió, se manda otro correo con el PDF corregido (el primero salió con el nombre anterior). No se bloquea la emisión mientras no se confirme; si cerró la ventana, "Mis certificados" se lo vuelve a ofrecer.
- `GET /api/certificados/:folio` (pública): folio `^ZOO-[0-9]{4}-[A-Z0-9]{5,16}$` en mayúsculas (acepta el formato viejo `ZOO-2026-12345`)
  → `{ valido: true, certificado: { folio, nombre, curso, area, horas, sesiones, instructor, emitido } }`; para un certificado anterior
  aceptable la respuesta lleva además `anterior: true` en la raíz (no escribe nada en Firestore). 400 folio inválido, 404 si no existe, no
  está firmado y no es un anterior aceptable, 429 pasadas 30 consultas en 10 minutos por IP. Sin `CERTIFICATE_SIGNING_KEY` responde 503.
- `POST /api/admin/certificados` (solo administradores) con `{ uid, cursoId, nombre?, horas?, sesiones? }` → `{ ok, certificado }`. Busca
  primero un certificado válido del mismo uid y curso (en cualquier año) antes de emitir otro.
- `GET /api/admin/certificados/pendientes` (solo administradores, solo lectura) → `{ modoTransicion, limiteAnteriores, truncado, resumen:
  { total, firmados, aceptables, noAceptables, porRazon }, certificados: [{ folio, aceptable, razones, uid, cursoId, nombre, curso, emitido }] }`.
  Lista los certificados sin firma válida con el mismo criterio que usa el servidor: `razones` vacío = aceptable; si no, por qué no
  (`curso-no-encontrado`, `miembro-no-encontrado`, `folio-inconsistente`, `firma-alterada`, `posterior-al-limite`...). Un duplicado (mismo uid y curso, otro folio) es aceptable y
  solo lleva la nota informativa `notas: ['duplicado-de:<folio>']` (`resumen.duplicados` los cuenta).
  Máximo 5000 certificados (`truncado: true` si hay más). 503 sin `CERTIFICATE_SIGNING_KEY`.

### Importación única del progreso viejo

Antes el navegador guardaba el avance en `miembros/{uid}.courseProgress` (`{ [cursoId]: { completedLessons, isCompleted, certificateFolio?,
completedAt? } }`). Sin importarlo, el orden secuencial dejaría a esas cuentas sin poder avanzar. `GET /api/cursos/progreso` lo hace solo,
**una vez por cuenta** (marca `progresoLegadoImportado`), si y solo si:

- existe `LEGACY_PROGRESS_IMPORT_BEFORE` (fecha ISO) y la cuenta de Firebase Auth se creó **antes** de esa fecha;
- el miembro tiene `courseProgress` y no se había importado;
- solo se importan clases que existen en el curso; **nunca** se emite un certificado: si el curso estaba completo y existe un certificado
  de esa persona y curso (`memberUid`/`courseId` o `uid`/`cursoId`), queda completado con ese folio; si estaba completo sin certificado,
  se deja la última clase pendiente para que el flujo normal emita el certificado firmado. El campo viejo no se borra.
Independientemente de esta importación, los cursos que tienen certificado vigente aparecen completados (ver «Certificados anteriores»).

**Formato real del sitio viejo** (recuperado de `pages/club-biblioteca.html` y `assets/js/club.js` de la etiqueta
`respaldo-sitio-antes-de-publicar-2026-10-15`): la clave es el id del documento de `cursos` y `completedLessons` guarda el **índice** de la
clase dentro de `lecciones` (enteros desde 0; el sitio viejo permitía quitar una clase ya marcada, así que puede haber huecos). Las claves
inválidas se descartan **antes** de aplicar el tope `MAX_CURSOS_LEGADO` (200). La importación es una unión: nunca quita avance ni toca
`courseProgress`, y también se ejecuta antes de marcar una clase (`POST /api/cursos/:cursoId/progreso`) por si el miembro llega sin haber
pedido su progreso.

**Ensayo y reparación desde el panel** (solo administradores): `GET /api/admin/progreso-legado?pagina=1&limite=25&refrescar=1` calcula, SIN
escribir nada y con las mismas reglas que la importación real (`diagnosticarLegado` usa `planearImportacionLegado`), qué importaría el avance
anterior de cada miembro: cursos y clases viejas, clases que se importarían, cursos completados, certificados anteriores, si ya se importó
(y si lo guardado contiene todo), si la cuenta es elegible por fecha y un veredicto: `completo`, `parcial`, `sin-progreso-viejo`,
`ya-importado` o `no-elegible`. Los correos salen enmascarados. `POST /api/admin/progreso-legado/:uid/importar` ejecuta la misma
importación única para una persona (cuerpo opcional `{ "reintentar": true }` para volver a unir el avance de alguien ya importado y
`{ "aceptarCuentaPosterior": true }` para una cuenta creada después del corte; ambos solo desde el panel). Se anota en `adminAcciones` y tiene
límite de 20 peticiones por minuto. Pruebas: `test/avance-legado.test.js`.

### PDF y correo

`services/certificado-pdf.js` genera el certificado en A4 horizontal (pdfkit + qrcode) con la identidad de Zoorigen (verde `#1F5F3A` y
dorado `#E8A317`, mismos textos y estructura que `pages/ver-certificado.html`); el QR lleva a
`https://www.zoorigen.com/pages/verificar.html?folio=<folio>`. El logo está en `assets/cert/logo.png` (si faltara, el encabezado
sale en texto). El correo (`enviarCorreoCertificado` en `services/correo.js`, por Resend) lleva la felicitación, el curso, el folio, el
botón a `/pages/club-certificados.html`, el enlace de verificación y el PDF adjunto; sin `RESEND_API_KEY` o `MAIL_FROM` no se envía nada.

### Certificados anteriores (escritos por el navegador): modo transición

Antes el navegador escribía `certificados/{folio}` sin firma, y esas personas ya los imprimieron o compartieron. **No hace falta ninguna
acción manual** para que sigan funcionando: el servidor acepta como *anterior* un certificado sin firma que cumple TODO esto
(`certificadoAnteriorAceptable`, en `services/certificados.js`):

- no trae `firmaBackend` (con una firma presente pero inválida es una alteración y NO se acepta);
- su campo `folio` es igual al id del documento y tiene el formato `ZOO-AAAA-XXXXX` (5 a 16 letras mayúsculas o dígitos);
- tiene titular (`memberUid` o `uid`), curso (`courseId` o `cursoId`), nombre, título del curso y una fecha de emisión válida
  (`issuedAt` o `emitido`; no futura), y los nombres viejos y nuevos, si vienen los dos, coinciden;
- el curso existe en `cursos` y el miembro existe en `miembros` (o en `usuarios`, el legado);
- su fecha de emisión es anterior o igual a `CERTIFICADOS_ANTERIORES_HASTA`, si está definida (sin ella no hay límite: *modo transición*);
- los duplicados (misma persona y curso, otro folio) NO se rechazan: casi siempre son legítimos y pueden estar impresos. Solo se elige un
  canónico para el progreso (el que ya guarda el progreso, si no el firmado y, si no, el más antiguo); los demás se reportan como aceptables
  con la nota `duplicado-de:<folio>`.

Qué pasa con un anterior aceptable:

1. **Verificación pública** (`GET /api/certificados/:folio`): responde 200 con `anterior: true`, sin escribir nada.
2. **Se firma solo cuando su titular abre el sitio**: `GET /api/cursos/progreso` lo normaliza y firma EN SU LUGAR (mismo folio, mismo documento):
   agrega `uid, cursoId, nombre, curso, area, horas, sesiones, instructor, emitido, year, verificado: true, origen: 'legacy-validado',
   validadoBackend: true, migradoAutomaticamente: true, validadoEn, firmaBackend` y no borra ni cambia ningún campo viejo. Es idempotente y,
   sin `CERTIFICATE_SIGNING_KEY`, no firma (pero tampoco falla). También firma los duplicados aceptables de esa persona, para que todos
   queden verificados; el canónico del progreso no cambia.
3. **El curso aparece completado** con su folio y su fecha de emisión, aunque no se haya importado el progreso viejo.
4. **Completar el curso no crea otro folio**: reutiliza el existente (ver `POST /api/cursos/:cursoId/progreso`).

Un anterior que NO es aceptable sigue sin verificarse (404) y bloquea con 409 al completar ese curso hasta que se revise; la ruta de
administrador `GET /api/admin/certificados/pendientes` y el script de auditoría dicen exactamente por qué (un solo criterio).

**`CERTIFICADOS_ANTERIORES_HASTA` (recomendación)**: mientras siga permitido que el navegador escriba `certificados`, un miembro podría crear
un certificado sin firma que el modo transición aceptaría. Después de publicar las reglas de Firestore v6 (que niegan esa escritura),
define `CERTIFICADOS_ANTERIORES_HASTA` en Railway con la fecha ISO de esa publicación (por ejemplo `2026-11-01T00:00:00Z`). Desde
entonces solo valen los anteriores emitidos hasta ese momento; los firmados por el servidor no dependen de la variable. Una fecha mal
escrita no abre la ventana: no se acepta ningún anterior (el servidor lo avisa en el registro al arrancar).

### Auditoría global (opcional)

El script ya no es necesario para que los anteriores funcionen: queda como **revisión global opcional** con el mismo criterio de
aceptación. `npm run audit:certificates` (requiere `FIREBASE_SERVICE_ACCOUNT` y `CERTIFICATE_SIGNING_KEY`; usa también
`CERTIFICADOS_ANTERIORES_HASTA` si la defines en tu terminal):

1. **Sin argumentos es solo lectura (dry-run)**: lista cada certificado con su estado (`ya-valido`, `revisar-manualmente` o `rechazar`) y
   sus problemas (`miembro-no-encontrado`, `curso-no-encontrado`, `folio-inconsistente`, `firma-alterada`,
   `posterior-al-limite`, `campos-obligatorios-incompletos`...); los duplicados salen como aceptables con `notas: ["duplicado-de:<folio>"]`.
   No imprime nombres ni correos.
2. Revisa el reporte y arma un archivo JSON con los folios que apruebes (por ejemplo `["ZOO-2026-12345"]`).
3. `npm run audit:certificates -- --apply --allowlist=folios.json` firma **solo** esos folios (y solo si pasaron la revisión): rellena
   `uid, cursoId, nombre, curso, area, sesiones, emitido, year` a partir de `memberUid, courseId, memberName, courseTitle, courseArea,
   totalClases, issuedAt`, marca `origen: 'legacy-validado'`, `validadoBackend: true`, `verificado: true` y no borra ningún campo viejo.

Nunca lo corras sin haber revisado el reporte. Las reglas de Firestore **no** se tocan desde este servidor: mientras sigan permitiendo que
el navegador escriba `certificados`, un miembro podría alterar los campos no firmados (nombre, curso) de su propio certificado anterior
antes de que se firme; conviene publicar las reglas que niegan esa escritura cuando el sitio nuevo ya esté en línea y entonces definir
`CERTIFICADOS_ANTERIORES_HASTA`.

## Catálogo público, encuesta de la portada y guía (chatbot)

Código en `services/encuesta.js` (reglas puras, con pruebas en `test/encuesta.test.js`) y `services/rutas-publico.js` (las rutas,
con pruebas en `test/publico-api.test.js`). Son las únicas rutas que **no piden sesión** y escriben datos, por eso validan con lista
blanca, limitan por IP y no guardan la IP de nadie (solo se usa en memoria para contar). Todas las respuestas llevan
`Cache-Control: no-store`, salvo el catálogo.

- **`GET /api/cursos/demo`**: lee `cursos` UNA vez cada 5 minutos (compartido por todas las visitas; si Firestore falla sirve lo último
  que tenía, o 503 si nunca cargó). Cada curso trae solo `id, titulo (title), area, descripcion (description), clases` (número de
  lecciones; en cursos viejos `totalClases` o 1 si solo tiene `driveId`), `proximamente` y `elegiblePrueba` (misma regla de
  `/api/prueba-gratuita`: el sitio ya sabe qué cursos puede ofrecer como prueba). No se muestran los cursos sin título, sin clases
  (salvo `proximamente: true`) ni los marcados `oculto`, `archivado`, `borrador`, `visible: false`, `publicado: false`, `activo: false`
  o con `estado` oculto/borrador/archivado/inactivo/retirado. Hoy el panel no crea esos campos: todos los cursos de la biblioteca
  se publican. Orden: como la biblioteca (los de siempre, el más nuevo primero; luego los de `ordenVip`). Límite: 300 por IP cada 10 min.
- **`POST /api/encuesta`**: `respuestas` solo admite las claves `meta, p1, origen, grupo, p2, p2b, tamano, experiencia, urgencia, freno`
  con texto de 1 a 80 caracteres; `completada` es booleano; `sessionId` de 1 a 100 caracteres. `contacto` es opcional:
  `{ numero (de 8 a 15 dígitos; se aceptan +, espacios, guiones y paréntesis y se guardan solo dígitos), avisoAceptado: true,
  avisoVersion (≤ 40) }`; sin aviso aceptado es 400. Sin respuestas ni contacto responde `{ ok: true }` y no guarda nada. Acepta
  `application/json` y `text/plain` (para `sendBeacon` al cerrar la página); cuerpo máximo 8 KB. Varias copias por `sessionId`
  son normales (parcial y completa): el panel las junta. Límite: 20 por IP cada 10 min, y un tope global de 600 cada 10 min.
- **`POST /api/chatbot/sin-respuesta`**: el texto se limpia (sin correos, @usuarios, URLs ni teléfonos de 7 o más dígitos, aunque
  vengan con espacios o guiones), se recorta a 120 y, si queda con menos de 3 caracteres, se ignora (responde `ok`). Se agrupa en
  `chatbotSinRespuesta/{clave}` dentro de una transacción. Límite: 30 por IP cada 10 min, y un tope global de 1200 cada 10 min.
- **Rutas de administrador**: mismo chequeo de siempre (`admins/{uid}` o `miembros/{uid}.role === 'admin'`; 401 sin sesión, 403 si no es
  administrador) y 30 solicitudes por minuto.

Detrás de Railway la IP sale de `X-Forwarded-For` (igual que la verificación de certificados). Los topes globales evitan que alguien
llene Firestore cambiando esa cabecera.

| Colección | Qué guarda |
|---|---|
| `encuestasProspectos/{id aleatorio}` | `sessionId, respuestas{...}, completada, creado (hora del servidor)` y, solo si la persona dejó su WhatsApp, `contacto` (solo dígitos), `avisoAceptado: true, avisoVersion` |
| `chatbotSinRespuesta/{clave}` | `ejemplo` (primer texto limpio), `tipo` ('animal'/'otro'), `veces`, `primeraVez`, `ultimaVez`. La `clave` es el texto en minúsculas, sin acentos ni signos y con espacios simples (máx. 80; si es más largo se corta y lleva un hash corto) |

**Reglas de Firestore (se publican aparte; este servidor no las cambia):** las dos colecciones son solo del servidor. Cuando se
publiquen las reglas del sitio (`FIRESTORE-REGLAS-v6.txt`) deben decir, para `encuestasProspectos/{id}` y `chatbotSinRespuesta/{id}`:
`allow read: if isAdmin(); allow write: if false;` (el Admin SDK ignora las reglas, así que el servidor sigue escribiendo).

## Variables de entorno (Railway)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT` (JSON completo),
`BUNNY_STREAM_LIBRARY_ID`, `BUNNY_TOKEN_AUTH_KEY`, `BUNNY_TOKEN_TTL_SECONDS`.
Opcionales: `STRIPE_PRICE_MENSUAL`, `STRIPE_PRICE_ANUAL` (si faltan se usan los precios fijos de `server.js`).

Noticias y avisos:
- `CRON_KEY`: llave para `GET /cron/noticias` (úsala larga y al azar). Sin ella esa ruta responde 401 a todos; el resto del servidor no la necesita.
- `NEWSDATA_API_KEY` (opcional): activa NewsData.io como fuente extra. Nunca sale en respuestas ni en registros.
- `NOTICIAS_TAREA=off` (opcional): apaga la tarea diaria dentro del proceso.
- `NOTICIAS_IMAGENES=off` (opcional): no busca la imagen en la página de cada nota (solo usa la que traiga el feed).

Correo de verificación de cuenta (opcional):
- `RESEND_API_KEY`: llave de Resend (resend.com). Con ella el servidor envía el correo de verificación con la plantilla de Zoorigen (ruta `POST /api/auth/send-verification`). Nunca sale en respuestas ni en registros. Solo la configura la persona dueña del proyecto, directamente en Railway.
- `MAIL_FROM`: remitente ya verificado en Resend, por ejemplo `Zoorigen <no-reply@zoorigen.com>`.
- `PANEL_URL` (opcional): dirección base del sitio para armar el enlace del correo; por defecto `https://www.zoorigen.com`.
- Sin `RESEND_API_KEY` o `MAIL_FROM` el servidor arranca igual: el envío responde 503 y el sitio usa el correo estándar de Firebase como respaldo.

Certificados y progreso de cursos:
- `CERTIFICATE_SIGNING_KEY`: secreto largo y al azar con el que el servidor firma y verifica los certificados. Debe ser **estable**: si
  cambia, los certificados ya emitidos dejan de validar. Nunca sale en respuestas ni en registros y solo la configura la persona dueña del
  proyecto, directamente en Railway. Si falta, el servidor arranca igual pero no emite ni verifica certificados (503).
- `LEGACY_PROGRESS_IMPORT_BEFORE` (opcional): fecha ISO (por ejemplo `2026-11-01T00:00:00Z`). Las cuentas creadas antes importan una sola vez
  su progreso viejo. Sin ella no se importa nada.
- `CERTIFICADOS_ANTERIORES_HASTA` (opcional): fecha ISO (por ejemplo `2026-11-01T00:00:00Z`). Los certificados anteriores sin firma solo se
  aceptan si se emitieron hasta esa fecha (inclusive). Sin ella: modo transición, sin límite. Recomendación: definirla con la fecha en que se
  publiquen las reglas de Firestore v6, para cerrar la ventana a certificados nuevos escritos por el navegador. Si no es una fecha válida,
  no se acepta ningún anterior. No afecta a los certificados firmados por el servidor.
- Reutiliza `RESEND_API_KEY`, `MAIL_FROM` y `PANEL_URL` (arriba) para el correo con el PDF del certificado.

### `BUNNY_API_KEY` (clave de gestión de Bunny)

Sirve solo para `GET /api/admin/bunny-catalogo`, que alimenta el botón "Sincronizar con Bunny" del panel
admin: el servidor consulta a Bunny en vivo y devuelve las colecciones con sus videos ya procesados
(`status` 4), ordenados por número de clase. Es distinta de `BUNNY_TOKEN_AUTH_KEY` (esa solo firma los
reproductores). Se obtiene en Bunny → Stream → tu librería → API → API Key. Solo la ven los administradores
(doc en `admins/{uid}` o `miembros/{uid}.role === 'admin'`) y nunca sale en ninguna respuesta. Es opcional:
si falta, el servidor arranca igual y ese endpoint responde 503 con `codigo: 'sin_api_key'`.

## Pruebas locales

```bash
npm install
npm test
```

Las pruebas usan Firestore, Stripe y Firebase Auth simulados (`test/helpers/`): no necesitan
credenciales ni tocan datos reales.

## Utilidades de mantenimiento (requieren credenciales)

- `npm run audit:memberships`: auditoría de solo lectura de Firestore contra Stripe.
- `npm run audit:certificates`: revisión global opcional de certificados sin firma (dry-run); con `--apply --allowlist=folios.json` firma solo los aprobados (ver «Certificados y progreso de cursos»).
- `npm run normalize:membership-dates`: pasa `planVence` de texto a Timestamp (agrega `--apply` para escribir).
- `npm run sync:memberships -- --subscription=sub_...`: repara suscripciones puntuales (agrega `--apply` para escribir).
