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
| `POST /api/referidos` | Invitados del miembro (solo nombre de pila) | Token de Firebase |
| `GET /api/prueba-gratuita` | Si la persona puede elegir su prueba gratuita y qué cursos puede elegir | Token de Firebase |
| `POST /api/prueba-gratuita` | Elige UN curso como prueba (`{ cursoId }`); no se puede cambiar | Token de Firebase |
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
  Drive no se pueden proteger), no es `disponibleSiempre` y no es el curso por defecto (el que trae el video gratis
  fijo `befd1641…` o tiene `cursoMuestraGratis: true`).
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
