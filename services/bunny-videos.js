'use strict';

// ══ BUNNY STREAM: firmar reproducción Y gestionar video (clases en vivo) ══
// `firmarToken` es el mismo cálculo HMAC que server.js ya usa para /api/bunny/embed-token (cursos),
// factorizado aquí para reutilizarlo también con la librería de webinars (cada una con su propia llave).
// `crearVideo`/`subirBinario`/`estadoVideo` son llamadas NUEVAS: hasta ahora el servidor solo LEÍA el
// catálogo de Bunny (listar colecciones/videos); aquí se agrega la escritura necesaria para que la
// grabación de una clase en vivo suba sola.

const crypto = require('crypto');

const API_BASE = 'https://video.bunnycdn.com/library';

function firmarToken({ libraryId, authKey, videoId, ttlSegundos = 300 }) {
  const expires = Math.floor(Date.now() / 1000) + ttlSegundos;
  const token = crypto.createHash('sha256').update(String(authKey) + videoId + expires).digest('hex');
  const embedUrl = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}?token=${token}&expires=${expires}`;
  return { embedUrl, expires };
}

function crearServicio({ libraryId, apiKey, collectionId, fetchImpl } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  const listo = Boolean(libraryId && apiKey);

  async function pedir(ruta, opciones = {}) {
    if (!listo) throw Object.assign(new Error('Bunny Stream (clases en vivo) no está configurado en Railway'), { status: 503 });
    const res = await fetcher(`${API_BASE}/${libraryId}${ruta}`, {
      ...opciones,
      headers: { AccessKey: apiKey, accept: 'application/json', ...(opciones.headers || {}) }
    });
    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw Object.assign(new Error(`Bunny respondió ${res.status} al ${opciones.method || 'GET'} ${ruta}`), { status: 502, detalle: texto });
    }
    return res;
  }

  // Crea el objeto de video (sin binario todavía) y devuelve su videoId.
  async function crearVideo({ titulo }) {
    const res = await pedir('/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: titulo, collectionId: collectionId || undefined })
    });
    const data = await res.json();
    if (!data || !data.guid) throw Object.assign(new Error('Bunny no devolvió el id del video'), { status: 502 });
    return data.guid;
  }

  // Sube el binario de la grabación (ya descargado de Drive) al video recién creado.
  async function subirBinario({ videoId, buffer }) {
    await pedir(`/videos/${videoId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buffer });
  }

  // Estado de Bunny: 0 Created, 1 Uploaded, 2 Processing, 3 Transcoding, 4 Finished, 5 Error, 6 UploadFailed.
  async function estadoVideo({ videoId }) {
    const res = await pedir(`/videos/${videoId}`, { method: 'GET' });
    const data = await res.json();
    return Number(data && data.status);
  }

  return { configurado: () => listo, crearVideo, subirBinario, estadoVideo };
}

module.exports = { firmarToken, crearServicio, ESTADO_LISTO: 4 };
