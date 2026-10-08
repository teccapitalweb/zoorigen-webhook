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
| `GET /` | Health check | — |

### Videos y clases gratis desde Firestore

`POST /api/bunny/embed-token` reconoce un `videoId` (debe tener forma de UUID) si está en el catálogo
estático (`data/zoorigen-bunny-catalog.json`) o en alguna lección (`lecciones[].videoId`) de la colección
`cursos` de Firestore. Es gratis para quien no es miembro el video gratis fijo de siempre o una lección con
`gratis: true` dentro de un curso con `cursoMuestraGratis: true` (sin ese campo en el curso, la marca de la
lección no cuenta). El índice se guarda en memoria 60 s; si un video no aparece y el caché tiene más de 10 s se
refresca una vez (nunca más de una lectura cada 10 s). Solo lee Firestore; si la lectura falla se registra el
error y siguen funcionando el catálogo estático y el video gratis fijo.

## Variables de entorno (Railway)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT` (JSON completo),
`BUNNY_STREAM_LIBRARY_ID`, `BUNNY_TOKEN_AUTH_KEY`, `BUNNY_TOKEN_TTL_SECONDS`.
Opcionales: `STRIPE_PRICE_MENSUAL`, `STRIPE_PRICE_ANUAL` (si faltan se usan los precios fijos de `server.js`).

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
