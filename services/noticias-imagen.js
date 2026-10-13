'use strict';

// ══ IMAGEN DE LAS NOTICIAS (enriquecimiento) ══
// Muchos feeds RSS no traen la foto de la nota. Al sincronizar (tarea diaria y botón del panel, NUNCA en la petición de
// una persona) se descarga la propia página de la nota y se toma su `og:image` (o `twitter:image` / `<link rel="image_src">`).
//
// Seguridad (la dirección de la nota la entrega un tercero, así que se trata como no confiable):
//   · solo https, sin usuario/contraseña y solo el puerto 443;
//   · el nombre se resuelve por DNS y se rechaza si CUALQUIER dirección es privada, de bucle local, link-local,
//     de metadatos de la nube (169.254.169.254), multicast o reservada (IPv4 e IPv6, incluidas las "mapeadas");
//   · con el transporte real, la conexión se hace a la dirección ya validada (no se vuelve a resolver: sin DNS rebinding);
//   · máximo 2 redirecciones, y cada una pasa por las mismas reglas;
//   · 4 s en total por página, 400 KB leídos como máximo, solo text/html, 3 páginas a la vez;
//   · jamás lanza: ante cualquier problema la nota simplemente queda sin imagen.

const dns = require('dns');
const net = require('net');
const https = require('https');
const { Readable } = require('stream');
const { urlHttps } = require('./texto');

const TIMEOUT_PAGINA_MS = 4000;
const MAX_BYTES_PAGINA = 400 * 1024;
const MAX_REDIRECCIONES = 2;
const CONCURRENCIA = 3;
const MAX_URL_IMAGEN = 400;
const USER_AGENT = 'Mozilla/5.0 (compatible; ZoorigenNoticias/1.0; +https://www.zoorigen.com)';

// ── Direcciones IP ──
function esIpv4NoPublica(p) {
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||        // CGNAT
    (a === 169 && b === 254) ||                  // link-local y metadatos de la nube
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||         // IETF
    (a === 192 && b === 0 && c === 2) ||         // documentación
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||     // pruebas de red
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;                                    // multicast, reservadas y difusión
}

function hextetos(ip) {
  let s = String(ip).split('%')[0].toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + (((p[0] << 8) | p[1]).toString(16)) + ':' + (((p[2] << 8) | p[3]).toString(16));
  }
  const doble = s.indexOf('::');
  const separar = t => (t ? t.split(':') : []);
  let partes;
  if (doble === -1) partes = separar(s);
  else {
    const izq = separar(s.slice(0, doble));
    const der = separar(s.slice(doble + 2));
    partes = [...izq, ...Array(Math.max(0, 8 - izq.length - der.length)).fill('0'), ...der];
  }
  return partes.map(x => parseInt(x, 16));
}

const v4DeHextetos = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

// true si la dirección NO es un destino público de internet (o si ni siquiera es una IP válida)
function esIpNoPublica(ip) {
  const tipo = net.isIP(String(ip));
  if (tipo === 4) return esIpv4NoPublica(String(ip).split('.').map(Number));
  if (tipo !== 6) return true;
  const h = hextetos(ip);
  if (h.length !== 8 || h.some(n => !Number.isInteger(n))) return true;
  const ceros = (desde, hasta) => h.slice(desde, hasta).every(n => n === 0);
  if (ceros(0, 5) && h[5] === 0xffff) return esIpv4NoPublica(v4DeHextetos(h[6], h[7]));   // ::ffff:a.b.c.d
  if (ceros(0, 6)) return true;                                                           // ::, ::1 y ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && ceros(2, 6)) return esIpv4NoPublica(v4DeHextetos(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return esIpv4NoPublica(v4DeHextetos(h[1], h[2]));                  // 6to4
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0x0db8)) return true;                    // Teredo y documentación
  return (h[0] & 0xe000) !== 0x2000;                                                      // solo 2000::/3 es unicast global
}

const NOMBRE_INTERNO = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion)$/;

// ── Resolución de nombres ──
// Devuelve [{ address, family }]. Las pruebas inyectan la suya: nunca hacen DNS real.
async function resolverDns(nombre) {
  return dns.promises.lookup(nombre, { all: true, verbatim: true });
}
async function resolverSimulado() {
  return [{ address: '93.184.216.34', family: 4 }];
}
const comoLista = lista => (Array.isArray(lista) ? lista : [lista]).filter(Boolean)
  .map(a => (typeof a === 'string' ? { address: a, family: net.isIP(a) || 4 } : a));

// ¿Se puede conectar a este nombre? (todas sus direcciones deben ser públicas)
async function hostEsPublico(nombre, resolver) {
  const h = String(nombre).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!h) return false;
  if (net.isIP(h)) return !esIpNoPublica(h);
  if (!h.includes('.') || NOMBRE_INTERNO.test(h)) return false;
  let lista;
  try { lista = comoLista(await resolver(h)); } catch (_) { return false; }
  return lista.length > 0 && lista.every(a => !esIpNoPublica(a.address));
}

// ── Transporte real: HTTPS con la conexión fijada a la dirección validada ──
function transporteFijado(url, { signal, headers, resolver = resolverDns } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (error) { reject(error); return; }
    const req = https.request({
      protocol: 'https:', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: 443, path: `${u.pathname}${u.search}`,
      method: 'GET', headers, signal,
      // Se valida DENTRO de la conexión: la dirección usada es la que se revisó (no se vuelve a resolver)
      lookup(nombre, opciones, devolver) {
        Promise.resolve().then(() => resolver(nombre)).then(crudo => {
          const lista = comoLista(crudo);
          if (!lista.length || lista.some(a => esIpNoPublica(a.address))) {
            devolver(Object.assign(new Error('Destino no permitido'), { code: 'EDESTINO' }));
            return;
          }
          if (opciones && opciones.all) devolver(null, lista.map(a => ({ address: a.address, family: a.family })));
          else devolver(null, lista[0].address, lista[0].family);
        }, error => devolver(error));
      }
    }, res => {
      const cabeceras = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach(x => cabeceras.append(k, x));
        else if (v !== undefined) cabeceras.set(k, String(v));
      }
      const estado = res.statusCode;
      if (estado < 200 || estado === 204 || estado === 205 || (estado >= 300 && estado < 400)) {
        res.resume();
        resolve(new Response(null, { status: Math.max(200, estado), headers: cabeceras }));
        return;
      }
      resolve(new Response(Readable.toWeb(res), { status: estado, headers: cabeceras }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Lectura limitada ──
async function leerLimitado(respuesta, maxBytes) {
  if (!respuesta.body || typeof respuesta.body.getReader !== 'function') {
    return Buffer.from(await respuesta.arrayBuffer()).subarray(0, maxBytes);
  }
  const lector = respuesta.body.getReader();
  const partes = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await lector.read();
      if (done) break;
      const trozo = Buffer.from(value);
      partes.push(trozo);
      total += trozo.length;
    }
  } finally {
    try { await lector.cancel(); } catch (_) { /* ya estaba cerrado */ }
  }
  return Buffer.concat(partes).subarray(0, maxBytes);
}

// ── Extracción de la imagen ──
function decodificarAtributo(t) {
  return String(t).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (todo, e) => {
    const m = e.toLowerCase();
    if (m[0] === '#') {
      const n = m[1] === 'x' ? parseInt(m.slice(2), 16) : parseInt(m.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[m];
  });
}

function atributosDe(etiqueta) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(etiqueta)) !== null) {
    const nombre = m[1].toLowerCase();
    if (!(nombre in attrs)) attrs[nombre] = decodificarAtributo(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]).trim();
  }
  return attrs;
}

// Candidatas en orden de preferencia: og:image, og:image:secure_url, twitter:image, <link rel="image_src">
const ORDEN_META = ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'];

function candidatasDeHtml(html) {
  const fin = html.search(/<\/head\s*>/i);
  const cabecera = fin > 0 ? html.slice(0, fin) : html;
  const meta = new Map();
  for (const et of cabecera.match(/<meta\b[^>]*>/gi) || []) {
    const a = atributosDe(et);
    const clave = (a.property || a.name || '').toLowerCase();
    if (clave && a.content && ORDEN_META.includes(clave)) {
      if (!meta.has(clave)) meta.set(clave, []);
      meta.get(clave).push(a.content);
    }
  }
  const salida = [];
  for (const clave of ORDEN_META) salida.push(...(meta.get(clave) || []));
  for (const et of cabecera.match(/<link\b[^>]*>/gi) || []) {
    const a = atributosDe(et);
    if (a.href && /(^|\s)image_src(\s|$)/i.test(a.rel || '')) salida.push(a.href);
  }
  return salida;
}

const TOKEN_DESCARTADO = /(?:^|[^a-z0-9])(?:favicon|sprite|logo|logotipo|icon|icono|iconos|avatar|placeholder|default|blank|pixel|spacer)(?:[^a-z0-9]|$)/;

// ¿Sirve como portada? Descarta íconos y logos evidentes, vectores y miniaturas de menos de 200 px.
function esImagenUtil(u) {
  let ruta = u.pathname;
  try { ruta = decodeURIComponent(ruta); } catch (_) { /* se usa tal cual */ }
  ruta = ruta.toLowerCase();
  if (/\.(?:svgz?|ico|cur)$/.test(ruta)) return false;
  if (TOKEN_DESCARTADO.test(ruta)) return false;
  const medidas = ruta.match(/(?:^|[^0-9])(\d{2,4})x(\d{2,4})(?:[^0-9]|$)/);
  if (medidas && (Number(medidas[1]) < 200 || Number(medidas[2]) < 200)) return false;
  for (const m of u.search.matchAll(/[?&](?:w|h|width|height)=(\d{1,4})(?=&|$)/gi)) {
    if (Number(m[1]) < 200) return false;
  }
  return true;
}

// html + dirección final de la página -> https de la imagen o ''
function extraerImagen(html, base) {
  for (const crudo of candidatasDeHtml(String(html || ''))) {
    let u;
    try { u = new URL(crudo, base); } catch (_) { continue; }
    if (u.protocol !== 'https:' || !esImagenUtil(u)) continue;
    const limpia = urlHttps(u.href, MAX_URL_IMAGEN);
    if (limpia) return limpia;
  }
  return '';
}

// ── Descarga de una página ──
const ESTADOS_REDIRECCION = new Set([301, 302, 303, 307, 308]);

function conLimiteDeTiempo(promesa, ms, controlador) {
  let reloj;
  const tiempo = new Promise((_, rechazar) => {
    reloj = setTimeout(() => {
      controlador.abort();
      rechazar(Object.assign(new Error('Tiempo agotado'), { motivo: 'tiempo' }));
    }, ms);
  });
  return Promise.race([promesa, tiempo]).finally(() => clearTimeout(reloj));
}

// Devuelve { imagen, motivo }. `motivo` solo orienta (registros y pruebas). Nunca lanza.
async function analizarPagina(enlace, opciones = {}) {
  const {
    fetch: fetchFn = transporteFijado, resolver = resolverSimulado,
    timeoutMs = TIMEOUT_PAGINA_MS, maxBytes = MAX_BYTES_PAGINA, maxRedirecciones = MAX_REDIRECCIONES
  } = opciones;
  const controlador = new AbortController();

  const trabajo = (async () => {
    let actual = urlHttps(String(enlace || '').trim(), 500);
    if (!actual) return { imagen: '', motivo: 'enlace-no-https' };
    for (let salto = 0; salto <= maxRedirecciones; salto++) {
      const u = new URL(actual);
      if (u.port && u.port !== '443') return { imagen: '', motivo: 'puerto' };
      if (!(await hostEsPublico(u.hostname, resolver))) return { imagen: '', motivo: salto ? 'redireccion-interna' : 'ip-privada' };

      const r = await fetchFn(actual, {
        signal: controlador.signal, redirect: 'manual', resolver,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'es' }
      });
      if (ESTADOS_REDIRECCION.has(r.status)) {
        const destino = r.headers && r.headers.get && r.headers.get('location');
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) { /* nada */ }
        if (!destino) return { imagen: '', motivo: 'redireccion-vacia' };
        if (salto >= maxRedirecciones) return { imagen: '', motivo: 'demasiadas-redirecciones' };
        let siguiente;
        try { siguiente = new URL(destino, actual); } catch (_) { return { imagen: '', motivo: 'redireccion-invalida' }; }
        if (siguiente.protocol !== 'https:') return { imagen: '', motivo: 'redireccion-http' };
        actual = siguiente.href;
        continue;
      }
      if (!r.ok) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) { /* nada */ } return { imagen: '', motivo: `http-${r.status}` }; }
      const tipo = String((r.headers && r.headers.get && r.headers.get('content-type')) || '').toLowerCase();
      if (!/^(?:text\/html|application\/xhtml\+xml)\b/.test(tipo)) {
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) { /* nada */ }
        return { imagen: '', motivo: 'no-es-html' };
      }
      const largo = Number(r.headers.get('content-length'));
      const buf = await leerLimitado(r, maxBytes);
      const charset = (tipo.match(/charset=["']?([\w-]+)/) || [])[1];
      let html;
      try { html = new TextDecoder(charset || 'utf-8').decode(buf); } catch (_) { html = buf.toString('utf8'); }
      const imagen = extraerImagen(html, actual);
      return { imagen, motivo: imagen ? 'ok' : (Number.isFinite(largo) && largo > maxBytes ? 'sin-imagen-truncada' : 'sin-imagen') };
    }
    return { imagen: '', motivo: 'demasiadas-redirecciones' };
  })();

  try {
    return await conLimiteDeTiempo(trabajo, timeoutMs, controlador);
  } catch (error) {
    trabajo.catch(() => {});
    if (error && error.motivo === 'tiempo') return { imagen: '', motivo: 'tiempo' };
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { imagen: '', motivo: 'tiempo' };
    return { imagen: '', motivo: 'error' };
  }
}

async function buscarImagenPagina(enlace, opciones) {
  return (await analizarPagina(enlace, opciones)).imagen;
}

// ── Lote: completa `imagen` en las notas que no la traen (3 a la vez) ──
// notas: [{ link, imagen }] (se modifican en sitio). Devuelve { buscadas, encontradas }.
async function completarImagenes(notas, opciones = {}) {
  const pendientes = notas.filter(n => n && !n.imagen && n.link);
  let siguiente = 0;
  let encontradas = 0;
  const obrero = async () => {
    while (siguiente < pendientes.length) {
      const nota = pendientes[siguiente++];
      const imagen = await buscarImagenPagina(nota.link, opciones);
      if (imagen) { nota.imagen = imagen; encontradas++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opciones.concurrencia || CONCURRENCIA, pendientes.length) }, obrero));
  return { buscadas: pendientes.length, encontradas };
}

module.exports = {
  TIMEOUT_PAGINA_MS, MAX_BYTES_PAGINA, MAX_REDIRECCIONES, CONCURRENCIA, USER_AGENT,
  esIpNoPublica, hostEsPublico, esImagenUtil, candidatasDeHtml, extraerImagen,
  resolverDns, resolverSimulado, transporteFijado, analizarPagina, buscarImagenPagina, completarImagenes
};
