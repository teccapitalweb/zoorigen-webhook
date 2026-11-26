# Clases en vivo — qué falta configurar a mano

El código ya está en la rama `feature/clases-en-vivo` de los dos repos (`ZOORIGEN` y `zoorigen-webhook`), probado
(1488 pruebas en el backend, 1882 en el frontend) y sin publicar. Antes de desplegarlo necesitas hacer estos
pasos — ninguno los puedo hacer yo (son cuentas, paneles externos y secretos que no debo ver).

## 1. Google Cloud — YA HECHO ✅ (25 nov 2026)

`bioterramexico1@gmail.com` había llegado al límite de proyectos de Google Cloud de su cuenta, así que en vez
de crear uno nuevo reusamos **`club-zoorigen`** (el mismo proyecto de Firebase que ya usa el sitio), que es
propiedad de `teccapitalweb@gmail.com`. Esto no afecta nada: el proyecto que guarda las credenciales OAuth no
tiene que ser el mismo que la cuenta que autoriza el acceso a su Calendar/Drive.

Lo que ya se hizo ahí, por si hay que repetirlo algún día:
1. Con `teccapitalweb@gmail.com`: **APIs y servicios → Biblioteca** → se habilitaron **Google Calendar API** y
   **Google Drive API** en `club-zoorigen`.
2. **Google Auth Platform → Público**: ya estaba "En producción" / Usuarios externos (no hubo que tocarlo; lo
   usa el login con Google del sitio).
3. **Acceso a los datos**: se agregaron los permisos `calendar.events` y `drive.readonly` (Google avisa que
   `drive.readonly` es "restringido" y pide verificación — no hace falta verificar: solo lo autoriza 1 cuenta,
   muy por debajo del límite de 100 usuarios sin verificar).
4. **Clientes → Crear cliente → App de escritorio** ("Zoorigen - Clases en vivo (grabación)") → de ahí salieron
   el **ID de cliente** y el **secreto de cliente** (ya pegados en Railway, paso 3).
5. Con la cuenta `bioterramexico1@gmail.com`, se corrió el script de abajo y se autorizó Calendar+Drive → el
   **GOOGLE_REFRESH_TOKEN** ya está pegado en Railway también.

Cómo se obtuvo el refresh token (ya hecho, queda documentado para la próxima vez que haga falta, por ejemplo si
se revoca el permiso): en la carpeta `zoorigen-webhook`, con `npm install` ya corrido:

   ```bash
   GOOGLE_CLIENT_ID=tu-id GOOGLE_CLIENT_SECRET=tu-secreto node scripts/google-token.js
   ```

   Sigue las instrucciones que imprime (abre el enlace **con la cuenta `bioterramexico1@gmail.com`**, acepta
   los permisos de Calendar y Drive). Al final te da un **GOOGLE_REFRESH_TOKEN**. Cópialo — no lo compartas por
   chat ni lo subas al repo.

## 2. Bunny Stream — YA HECHO ✅ (26 nov 2026)

La colección "clases en vivo" vive **dentro de la misma librería de los cursos** (731751, "ZOORIGEN"), no en
una librería aparte — así que las clases en vivo reusan `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_API_KEY` y
`BUNNY_TOKEN_AUTH_KEY`, que ya están en Railway. El único dato nuevo, el id de esa colección, ya se obtuvo
(Stream → Manage library → Collections → ⋯ en la tarjeta "clases en vivo" → Copy ID) y falta pegarlo como
`BUNNY_WEBINARS_COLLECTION_ID` (ver tu propio apunte de hoy — no se repite aquí por ser un identificador que
conviene tratar como dato semi-sensible).

## 3. Variables en Railway (servicio `zoorigen-webhook`)

Estado al 26 de noviembre, según lo visto en el panel de Railway:

- ✅ `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — ya pegadas
- ⏳ `BUNNY_WEBINARS_COLLECTION_ID` — falta pegar (valor del paso 2 de arriba)
- ⏳ `SUPERADMIN_EMAILS=teccapitalweb@gmail.com,bioterramexico1@gmail.com` — falta pegar

(`BUNNY_STREAM_LIBRARY_ID`, `BUNNY_API_KEY` y `BUNNY_TOKEN_AUTH_KEY` ya existían de antes; no hay que tocarlos.)

Opcional (ya tienen un valor por omisión razonable, no hace falta tocarlos):
`WEBINARS_TAREA=off` (si alguna vez quieres apagar la automatización sin quitar el código).

## 4. Índices de Firestore (la primera vez que corra el servidor)

El cron nuevo hace dos consultas con un filtro de igualdad + uno de rango (`tieneGrabacion == false` y
`inicioISO <=`, y por separado `estado == 'programada'` y `inicioISO <=`). Firestore pedirá un índice
compuesto la primera vez que corran — cuando eso pase, Railway lo va a mostrar en los logs como un error con un
enlace tipo `https://console.firebase.google.com/.../indexes?create_composite=...`. Solo hay que abrir ese
enlace y tocar "Crear índice" (una vez por cada uno de los 2 filtros; tarda unos minutos en quedar listo).

## 5. Reglas de Firestore

Pega el contenido de [`ZOORIGEN/FIRESTORE-REGLAS-v7.txt`](../ZOORIGEN/FIRESTORE-REGLAS-v7.txt) en
**Firebase Console → Firestore Database → Reglas → Publicar**. Hazlo **solo después** de que el servidor
nuevo y el sitio nuevo ya estén desplegados (el archivo lo explica arriba): si se publica antes, el panel de
administración viejo (que todavía no habrás reemplazado) se quedaría sin poder escribir webinars.

## 6. Orden de despliegue recomendado

1. Fusionar/desplegar la rama `feature/clases-en-vivo` de `zoorigen-webhook` en Railway, con las variables del
   paso 3 ya puestas.
2. Confirmar en los logs de Railway: `🎬 Clases en vivo: automatización activa · Google configurado · Bunny configurado`.
3. Fusionar/publicar la rama `feature/clases-en-vivo` de `ZOORIGEN` (GitHub Pages).
4. Crear una **clase de prueba** desde el panel (Clases en vivo → "+ Agregar clase de prueba") y confirmar que:
   - se genera el Meet,
   - "Ver como usuario" (o entrar con la cuenta superadmin) la deja entrar y ver la cuenta regresiva,
   - al terminar la reunión grabada, en máximo 3 minutos el panel la marca "Grabación disponible".
5. Si todo funciona, publicar las reglas del paso 5.
6. Cuando quieras activar la sección para todos los miembros: en `ZOORIGEN/assets/js/club-config.js` cambia
   `clasesEnVivoPronto: true` a `false` y publica.

## Lo que quedó fuera de esta fase

- **Push real del navegador** (notificaciones aunque el sitio esté cerrado): por ahora solo la campana interna
  del sitio avisa (como el resto de avisos). Si más adelante lo quieres, es un trabajo aparte (VAPID + service
  worker).
