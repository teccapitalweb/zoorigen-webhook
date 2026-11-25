#!/usr/bin/env node
'use strict';

// ══ Obtener el GOOGLE_REFRESH_TOKEN una sola vez ══
// Uso:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-token.js
// Abre el navegador, pide iniciar sesión con la cuenta dedicada a grabar (hoy bioterramexico1@gmail.com),
// autoriza Calendar + Drive de solo lectura, y este script captura el código en http://localhost:4321
// para imprimir el refresh token en la consola. NO lo guarda en ningún archivo ni lo manda a ningún lado:
// cópialo tú mismo a la variable GOOGLE_REFRESH_TOKEN de Railway y cierra esta terminal.

const http = require('http');
const { google } = require('googleapis');

const PORT = 4321;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.readonly'];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Faltan GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET. Pásalos como variables de entorno al correr este script.');
    process.exit(1);
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('\n1) Abre esta dirección con la cuenta de Google dedicada a grabar (inicia sesión con ESA cuenta, no con la tuya):\n');
  console.log(url + '\n');
  console.log('2) Si Google avisa "La app no está verificada", usa "Configuración avanzada" → "Ir a (nombre del proyecto), no seguro".');
  console.log('3) Esperando el permiso en ' + REDIRECT_URI + ' ...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/oauth2callback')) { res.writeHead(404); return res.end(); }
      const params = new URL(req.url, REDIRECT_URI).searchParams;
      const err = params.get('error');
      const c = params.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err ? '<h1>Hubo un error</h1><p>Puedes cerrar esta pestaña.</p>' : '<h1>Listo ✅</h1><p>Puedes cerrar esta pestaña y volver a la terminal.</p>');
      server.close();
      if (err) reject(new Error(err)); else resolve(c);
    }).listen(PORT);
  });

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.error('\nGoogle no devolvió un refresh_token. Repite el proceso y asegúrate de ver la pantalla de consentimiento completa (a veces hay que quitar primero el acceso de la app en https://myaccount.google.com/permissions y volver a intentarlo).');
    process.exit(1);
  }
  console.log('\n✅ Listo. Pega este valor en Railway como GOOGLE_REFRESH_TOKEN (y NO lo compartas por chat ni lo subas al repo):\n');
  console.log(tokens.refresh_token + '\n');
}

main().catch(error => { console.error('Error:', error && error.message); process.exit(1); });
