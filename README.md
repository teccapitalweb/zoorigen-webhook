# zoorigen-webhook

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
| `GET /api/retos` | Progreso de retos, camino y nivel (vista previa sin membresía) | Token de Firebase |
| `POST /api/retos/resultado` | Resultado de un reto de práctica (`{ retoId, puntaje, total }`) | Token de Firebase + membresía |
| `POST /api/retos/camino` | Resultado de un reto del camino (`{ modo, indice, puntaje, total }`) | Token de Firebase + membresía |
| `GET /api/retos/clasificacion` | Top 20 por XP total (solo alias) y mi posición | Token de Firebase + membresía |
| `POST /api/referidos/registrar` | El invitado se registra con el código (`{ codigo, deviceId, huella }`), idempotente | Token de Firebase |
| `GET /api/referidos/estado` | Código, enlace, invitados (solo alias), hitos y premios por invitar | Token de Firebase |
| `GET/POST/DELETE /api/directorio` | Directorio de la comunidad (tarjeta propia) | Token de Firebase (+ membresía para ver y crear) |
| `GET /api/admin/bunny-catalogo` | Colecciones y videos listos de Bunny, en vivo (solo lectura) | Token de Firebase + administrador |
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

XP total = logros (l1..l26) + insignias de retos (r1..r10) + XP de los retos + XP por referidos. **El nivel no se guarda: se recalcula en cada consulta.**

| Nivel | Desde | Hasta |
|---|---|---|
| 1 Aprendiz | 0 | 300 |
| 2 Técnico | 300 | 1,200 |
| 3 Profesional | 1,200 | 2,500 |
| 4 Líder | 2,500 | 4,500 |
| 5 Maestro | 4,500 | — |

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
| l22 | Comunidad | La manada crece | 3 invitados válidos | 150 |
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
| Logros l1..l26 | 3,790 |
| Insignias r1..r10 | 500 |
| XP de retos (práctica 600 + camino 530) | 1,130 |
| XP por referidos (6 invitados × 240) | 1,440 |
| **Total alcanzable en toda la vida** | **6,860** (dentro de 6,000 a 7,500) |

### Cuánto cuesta llegar a Profesional y a Maestro

* **Profesional (1,200 XP)**, el escenario del contrato: 4 cursos de 2 áreas (280 + 50), 20 retos (140 de XP + insignias r1, r2, r4, r5, r8 = 200), tarjeta
  en el directorio (60), una discusión (50), bienvenida (20) y unos 30 días en el club con 14 seguidos (400) da **1,230 XP**. Con la misma actividad pero solo 10 días en el club se
  queda en **930 XP (Técnico)**. Otra ruta: 8 cursos (740 + 200 por las áreas) + tarjeta + 20 retos. Otra: invitar a 6 personas que confirman y pagan suma 1,440 + 210 = 1,650.
* **Maestro (4,500 XP)** es el 66 % de todo el XP posible. Sin invitados el máximo es 5,210: hay que hacer casi todo (los 15 cursos = 1,820, 60 días seguidos y 30 más
  en total = 1,000, foro = 650, los 53 retos del camino y la práctica al tope + todas las insignias = 1,630, y lo básico = 110). Estudiar todo NO alcanza ni Líder (1,930), jugar todos los retos tampoco (1,630),
  y sin ningún curso ni invitado el techo es 3,390. Una prueba (`test/logros.test.js`) lo verifica con la tabla.

### Premios

Cada premio abre UN curso antes de su fecha. Todos exigen membresía vigente para canjearse.

| Clave | Condición |
|---|---|
| `profesional` | nivel ≥ 3 (1,200 XP) |
| `maestro` | nivel ≥ 5 (4,500 XP) |
| `referidos-1` | 3 invitados válidos |
| `referidos-2` | 6 invitados válidos |

Un premio ganado **no se pierde** aunque el XP baje (solo se agregan claves a `ganados`, dentro de una transacción). `POST /api/premios/usar` gasta un solo
premio por llamada (el primero ganado sin usar), en una transacción: 400 sin `cursoId` o administrador · 403 sin membresía o sin premio libre · 404 el curso no existe en `cursos` ·
409 el curso ya se adelantó, es `disponibleSiempre`/de muestra o es la prueba gratuita elegida. El sitio considera ABIERTOS los cursos que estén en `usados[].cursoId`.

### Retos

* `GET /api/retos` → `{ ok, membresia, nivel:{id,nombre,xp,desde,hasta,faltan}, xp (número: XP total), superados, porReto:{id:{veces,mejor,total,superados,perfectos,mejorPct}}, camino:{quiz,detective,orden}, retosHoy, totales:{quiz:22,detective:13,orden:18} }`.
* `POST /api/retos/resultado` → `{ ok, aprobado, xpGanado, xp (total), nivel, insigniasNuevas:[{id,nombre}] }`. `retoId` ∈ quiz|detective|orden|flashcards|historia, `total` entero 1-30, `puntaje` entero 0..total.
* `POST /api/retos/camino` → `{ ok, aceptado, aprobado, xpGanado, camino }` (y `xp`, `nivel`, `insigniasNuevas` si se aceptó). Solo se acepta si `indice === camino[modo]`, existe en el sitio (menor que `totales[modo]`) y se aprueba con 60 %.
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
* **Cursos** (l4-l8, l23-l26): dependen de `certificados` que escribe el navegador (reglas: lo puede crear cualquier miembro vigente). Cada certificado solo cuenta si su curso existe en `cursos`, un curso cuenta una vez y las áreas salen de `cursos`, no del certificado.
  Es menos confiable que retos o referidos; el daño máximo es adelantar un curso del calendario dentro de una membresía pagada.
* **Foro**: discusiones, me gusta recibidos (sin los propios) y respuestas recibidas (`repliesCount`, con tope de 50 por discusión). No se cuentan las respuestas ESCRITAS por la persona: requeriría un índice de grupo de colecciones que no existe.
* **Constancia**: días en que la persona abrió logros o retos; lo registra el servidor.

## Variables de entorno (Railway)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT` (JSON completo),
`BUNNY_STREAM_LIBRARY_ID`, `BUNNY_TOKEN_AUTH_KEY`, `BUNNY_TOKEN_TTL_SECONDS`.
Opcionales: `STRIPE_PRICE_MENSUAL`, `STRIPE_PRICE_ANUAL` (si faltan se usan los precios fijos de `server.js`).

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
- `npm run normalize:membership-dates`: pasa `planVence` de texto a Timestamp (agrega `--apply` para escribir).
- `npm run sync:memberships -- --subscription=sub_...`: repara suscripciones puntuales (agrega `--apply` para escribir).
