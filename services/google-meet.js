'use strict';

// ══ GOOGLE MEET Y DRIVE (clases en vivo) ══
// Cliente OAuth2 de la cuenta dedicada a grabar (hoy bioterramexico1@gmail.com). Con GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN arma un evento de Google Calendar con conferenceData
// (genera el Meet solo), lo edita o lo borra, y busca en el Drive de esa cuenta la grabación de una clase
// ya terminada. Sin esas 3 variables el servidor arranca igual: `configurado()` devuelve false y todas
// las funciones lanzan un error claro en vez de fallar raro más adelante.

function crearCliente({ clientId, clientSecret, refreshToken, googleapis } = {}) {
  const listo = Boolean(clientId && clientSecret && refreshToken);
  let lib = googleapis || null;
  let oauth2Client = null;
  // `googleapis` (la librería) solo se carga si de verdad hay credenciales: así el servidor arranca
  // igual de ligero cuando Google todavía no está configurado, y las pruebas no necesitan tenerla instalada.
  function libreria() {
    if (!lib) lib = require('googleapis').google;
    return lib;
  }
  function cliente() {
    if (!listo) throw Object.assign(new Error('Google Calendar/Drive no está configurado en Railway (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN)'), { status: 503 });
    if (!oauth2Client) {
      oauth2Client = new (libreria()).auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
    }
    return oauth2Client;
  }
  const calendar = () => libreria().calendar({ version: 'v3', auth: cliente() });
  const drive = () => libreria().drive({ version: 'v3', auth: cliente() });

  // Crea el evento en el calendario «primary» de la cuenta dedicada, con conferenceData para que
  // Calendar genere el Meet solo. Devuelve { eventId, meetUrl }.
  async function crearEvento({ titulo, descripcion = '', inicioISO, finISO }) {
    const requestId = 'zoo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const { data } = await calendar().events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: titulo,
        description: descripcion,
        start: { dateTime: inicioISO },
        end: { dateTime: finISO },
        conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
      }
    });
    const meetUrl = data.hangoutLink || '';
    if (!meetUrl) throw Object.assign(new Error('Google Calendar no devolvió un enlace de Meet'), { status: 502 });
    return { eventId: data.id, meetUrl };
  }

  async function editarEvento(eventId, { titulo, descripcion, inicioISO, finISO }) {
    const requestBody = {};
    if (titulo !== undefined) requestBody.summary = titulo;
    if (descripcion !== undefined) requestBody.description = descripcion;
    if (inicioISO) requestBody.start = { dateTime: inicioISO };
    if (finISO) requestBody.end = { dateTime: finISO };
    await calendar().events.patch({ calendarId: 'primary', eventId, requestBody });
  }

  async function eliminarEvento(eventId) {
    try {
      await calendar().events.delete({ calendarId: 'primary', eventId });
    } catch (error) {
      // Ya borrado a mano en Calendar: no es un error para nosotros.
      if (error && (error.code === 404 || error.code === 410)) return;
      throw error;
    }
  }

  // Quita acentos y caracteres raros para comparar nombres de archivo con el título de la clase.
  function normalizar(t) {
    return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Busca un MP4 en el Drive de la cuenta dedicada, creado dentro de la ventana [desdeISO, hastaISO],
  // cuyo nombre contenga el `codigo` (id de la clase) o, si no, se parezca al título. null si no hay match.
  async function buscarGrabacionEnDrive({ codigo, titulo, desdeISO, hastaISO }) {
    const q = [
      "mimeType contains 'video/'",
      `createdTime >= '${desdeISO}'`,
      `createdTime <= '${hastaISO}'`,
      'trashed = false'
    ].join(' and ');
    const { data } = await drive().files.list({
      q, fields: 'files(id,name,createdTime,size)', orderBy: 'createdTime desc', pageSize: 50
    });
    const archivos = data.files || [];
    if (!archivos.length) return null;
    const porCodigo = codigo ? archivos.find(f => f.name.includes(codigo)) : null;
    if (porCodigo) return porCodigo;
    const tituloNorm = normalizar(titulo);
    if (!tituloNorm) return null;
    return archivos.find(f => normalizar(f.name).includes(tituloNorm)) || null;
  }

  // Descarga el binario del archivo de Drive como Buffer (para volver a subirlo a Bunny).
  async function descargarArchivo(fileId) {
    const { data } = await drive().files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(data);
  }

  return { configurado: () => listo, crearEvento, editarEvento, eliminarEvento, buscarGrabacionEnDrive, descargarArchivo, normalizar };
}

module.exports = { crearCliente };
