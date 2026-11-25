# Clases en vivo — qué falta configurar a mano

El código ya está en la rama `feature/clases-en-vivo` de los dos repos (`ZOORIGEN` y `zoorigen-webhook`), probado
(1488 pruebas en el backend, 1882 en el frontend) y sin publicar. Antes de desplegarlo necesitas hacer estos
pasos — ninguno los puedo hacer yo (son cuentas, paneles externos y secretos que no debo ver).

## 1. Google Cloud (cuenta `bioterramexico1@gmail.com`)

1. Entra a [console.cloud.google.com](https://console.cloud.google.com) **con esa cuenta**.
2. Crea un proyecto nuevo (ej. "Zoorigen Clases en Vivo"). No actives la prueba gratuita de pago.
3. **APIs y servicios → Biblioteca**: activa **Google Calendar API** y **Google Drive API**.
4. **APIs y servicios → Pantalla de consentimiento OAuth**:
   - Tipo: **Externo**.
   - Llena nombre de la app, correo de soporte, etc.
   - En **Publicar la app**, pásala a **"En producción"** (así el permiso no caduca a los 7 días).
5. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación de escritorio**.
   - Guarda el **ID de cliente** y el **secreto de cliente** (los vas a pegar en Railway, paso 3).
6. En tu computadora, en la carpeta `zoorigen-webhook`, instala dependencias si no lo has hecho (`npm install`) y corre:

   ```bash
   GOOGLE_CLIENT_ID=tu-id GOOGLE_CLIENT_SECRET=tu-secreto node scripts/google-token.js
   ```

   Sigue las instrucciones que imprime (abre el enlace **con la cuenta `bioterramexico1@gmail.com`**, acepta
   los permisos de Calendar y Drive). Al final te da un **GOOGLE_REFRESH_TOKEN**. Cópialo — no lo compartas por
   chat ni lo subas al repo.

## 2. Bunny Stream (librería de clases en vivo)

Ya creaste la librería y la colección "clases en vivo" a mano. Necesitas, del panel de Bunny:

- **Library ID** de esa librería (no la de los cursos, `731751`) → `BUNNY_WEBINARS_LIBRARY_ID`
- **API Key de gestión** de esa librería (Library → API) → `BUNNY_WEBINARS_API_KEY`
- **Token Authentication Key** de esa librería (Library → Security → Token Authentication) → `BUNNY_WEBINARS_TOKEN_AUTH_KEY`
- **Id de la colección** "clases en vivo" dentro de esa librería → `BUNNY_WEBINARS_COLLECTION_ID`

## 3. Variables en Railway (servicio `zoorigen-webhook`)

En **Variables**, agrega (o confirma) estas — recuerda que ya agregaste `ADMIN_EMAILS` con
`bioterramexico1@gmail.com` hace unos días; esto es aparte:

```
GOOGLE_CLIENT_ID=<del paso 1.5>
GOOGLE_CLIENT_SECRET=<del paso 1.5>
GOOGLE_REFRESH_TOKEN=<del paso 1.6>
SUPERADMIN_EMAILS=teccapitalweb@gmail.com,bioterramexico1@gmail.com
BUNNY_WEBINARS_LIBRARY_ID=<del paso 2>
BUNNY_WEBINARS_API_KEY=<del paso 2>
BUNNY_WEBINARS_TOKEN_AUTH_KEY=<del paso 2>
BUNNY_WEBINARS_COLLECTION_ID=<del paso 2>
```

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
