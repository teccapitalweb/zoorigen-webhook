'use strict';

// ══ MÉTRICAS DE VISITAS (contador anónimo y sin cookies) ══
// Cuenta cuánta gente entra a Zoorigen (portada, acceso y panel de miembros), de dónde llega y en qué aparato, SIN cookies y SIN guardar nada que
// identifique a quien visita:
//   · La dirección IP y el navegador se usan solo en memoria (país, tipo de aparato y un identificador del día). Nunca se escriben.
//   · «Personas distintas por día»: un identificador anónimo = HMAC-SHA256(clave secreta + fecha, IP | navegador), recortado a 24 letras. Cambia cada día
//     y no se puede revertir sin la clave: sirve para no contar dos veces a la misma persona el mismo día, no para seguirla de un día a otro.
//     Esos identificadores se borran a los 45 días (quedan solo los totales).
//   · Respeta «No rastrear» (DNT) y «Control global de privacidad» (GPC). No cuenta bots, ni administradores, ni el interruptor apagado.
//   · Los miembros con sesión SÍ quedan identificados (nombre, correo, días de actividad) y solo los ve el administrador en «Quiénes entraron al panel»;
//     es la única colección con datos personales (metricasMiembros).
//   · Todo se escribe desde el servidor (Admin SDK). Las reglas de Firestore niegan todo lo demás: el navegador nunca toca estas colecciones.
//
// Colecciones (día = AAAA-MM-DD en hora de Ciudad de México):
//   metricasVisitas/{día}                 agregado del día: total, unicos, miembros, dispositivos, paises, paginas, fuentes, horas   (no se borra: ~1 doc/día)
//   metricasVisitas/{día}/visitantes/{h}  identificador anónimo del día (se borra a los 45 días)
//   metricasLog/{día}                     visitas del día una por una (hora, página, origen, país, aparato; hasta 1,500) (se borra a los 400 días)
//   metricasMiembros/{uid}                miembros con sesión: nombre, correo, origen de su cuenta, días de actividad (400 días)
//
// Costo por visita: 3 lecturas + 3 escrituras (anónima) o 5 + 4 (miembro). Abrir el panel: ~N lecturas (N días pedidos) + los miembros ya cacheados.

const crypto = require('crypto');
const net = require('net');

const ZONA = 'America/Mexico_City';
const PAGINAS = Object.freeze(['landing', 'acceso', 'panel', 'legal']);
const DISPOSITIVOS = Object.freeze(['movil', 'tablet', 'computadora']);
const FUENTES = Object.freeze(['directo', 'interno', 'google', 'bing', 'duckduckgo', 'yahoo', 'facebook', 'instagram', 'meta', 'whatsapp', 'linkedin', 'x', 'youtube', 'tiktok', 'correo', 'otros']);
const REDES_SOCIALES = Object.freeze(['facebook', 'instagram', 'meta', 'whatsapp', 'tiktok', 'youtube', 'linkedin', 'x']);

const MAX_LOG_DIA = 1500;        // visitas guardadas una por una en cada día (cada documento de Firestore admite 1 MiB)
const DIAS_LOG = 400;            // cuánto se conserva el registro una por una
const DIAS_VISITANTES = 45;      // cuánto se conservan los identificadores anónimos del día
const DIAS_BARRIDO = 20;         // cuántos días hacia atrás revisa la limpieza cada noche (los viejos ya quedaron vacíos)
const DIAS_ACTIVIDAD_MIEMBRO = 400;
const DIAS_MAX = 730;
const DIAS_PREDETERMINADOS = 190;
const MAX_MIEMBROS_PANEL = 300;
const MAX_ORIGENES = 5000;
const LIMITE_REGISTRO = 600;
const PERIODOS_LOG = Object.freeze({ hoy: 1, ayer: 1, 7: 7, 30: 30 });
const VENTANA_ORIGEN_MS = 30 * 24 * 60 * 60 * 1000;

// Dominios propios: venir de otra página del mismo sitio no es un origen («Dentro del sitio»)
const DOMINIOS_PROPIOS = Object.freeze(['zoorigen.com']);
const HOSTS_LOCALES = Object.freeze(['localhost', '127.0.0.1']);

/* ───────────────────────── Zona horaria (México) ───────────────────────── */

const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });
const formatoHora = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hourCycle: 'h23' });
const claveDia = (fecha = new Date()) => formatoDia.format(fecha);
const horaMexico = (fecha = new Date()) => formatoHora.format(fecha).padStart(2, '0').slice(-2);
function restarDias(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d - n)).toISOString().slice(0, 10);
}
function listaDeDias(hasta, cuantos) {
  const out = [];
  for (let i = cuantos - 1; i >= 0; i--) out.push(restarDias(hasta, i));
  return out;
}

/* ───────────────────────── Bots, aparato, origen ───────────────────────── */

const RE_BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp\/|telegram|curl|wget|python|java\/|go-http|axios|node-fetch|monitor|uptime|pingdom|gtmetrix/i;
function esBot(userAgent) {
  const ua = String(userAgent || '');
  return ua.length < 10 || RE_BOT.test(ua);
}

function dispositivoDe(userAgent) {
  const ua = String(userAgent || '');
  if (/ipad|tablet|playbook|silk|kindle/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return 'movil';
  return 'computadora';
}

// Referrer "android-app://com.instagram.android" o "ios-app://389801252/": el host es el id de la aplicación
const APPS = {
  'com.instagram.android': 'instagram', 'com.instagram.lite': 'instagram', 389801252: 'instagram',
  'com.facebook.katana': 'facebook', 'com.facebook.lite': 'facebook', 'com.facebook.orca': 'facebook', 284882215: 'facebook', 454638411: 'facebook',
  'com.whatsapp': 'whatsapp', 'com.whatsapp.w4b': 'whatsapp', 310633997: 'whatsapp',
  'com.zhiliaoapp.musically': 'tiktok', 'com.ss.android.ugc.trill': 'tiktok', 835599320: 'tiktok',
  'com.google.android.youtube': 'youtube', 544007664: 'youtube',
  'com.linkedin.android': 'linkedin', 288429040: 'linkedin',
  'com.twitter.android': 'x', 333903271: 'x',
  'com.google.android.gm': 'correo', 422689480: 'correo',
  'com.google.android.googlequicksearchbox': 'google'
};
const ALIAS_UTM = {
  ig: 'instagram', insta: 'instagram', fb: 'facebook', face: 'facebook', msg: 'facebook', messenger: 'facebook', wa: 'whatsapp', wsp: 'whatsapp', whats: 'whatsapp',
  yt: 'youtube', tt: 'tiktok', tw: 'x', twitter: 'x', li: 'linkedin', gmail: 'correo', email: 'correo', mail: 'correo', newsletter: 'correo'
};
const REDES = [   // por nombre del sitio de donde viene, en este orden (gana la primera que coincide)
  [/google\./i, 'google'], [/bing\./i, 'bing'], [/duckduckgo\./i, 'duckduckgo'], [/yahoo\./i, 'yahoo'],
  [/(^|\.)(facebook|fb)\.(com|me)|l\.facebook|lm\.facebook/i, 'facebook'], [/instagram\./i, 'instagram'],
  [/whatsapp\.|wa\.me/i, 'whatsapp'], [/linkedin\.|lnkd\.in/i, 'linkedin'],
  [/(^|\.)(twitter|x)\.com|(^|\.)t\.co$/i, 'x'], [/youtube\.|youtu\.be/i, 'youtube'], [/tiktok\./i, 'tiktok'],
  [/mail\.|outlook\.|gmail\./i, 'correo']
];
// Facebook, Instagram y TikTok abren los enlaces en su propio navegador y casi nunca mandan referrer: se reconocen por el navegador
const REDES_APP = [
  [/Instagram/i, 'instagram'], [/FBAN|FBAV|FB_IAB|FBIOS/i, 'facebook'], [/musical_ly|TikTok|Bytedance/i, 'tiktok'],
  [/LinkedInApp/i, 'linkedin'], [/Twitter/i, 'x']
];

function esHostPropio(host) {
  return DOMINIOS_PROPIOS.some(d => host === d || host.endsWith('.' + d)) || HOSTS_LOCALES.includes(host);
}

// Origen de la visita: ?utm_source= -> página que enlazó (referrer) -> app de red social desde la que se abrió -> marcas de Meta
function fuenteDe(referrer, utm, userAgent, pistas) {
  const etiqueta = String(utm || '').trim().toLowerCase().slice(0, 40);
  if (etiqueta) {
    if (ALIAS_UTM[etiqueta]) return ALIAS_UTM[etiqueta];
    // Los nombres cortos (como "x") solo valen si son exactos; los largos valen si aparecen dentro ("facebook_ads")
    const hallada = FUENTES.find(f => etiqueta === f || (f.length > 3 && etiqueta.includes(f)));
    return hallada || 'otros';
  }
  const ref = String(referrer || '').trim();
  let host = '';
  if (ref) {
    try { host = new URL(ref).hostname.toLowerCase(); } catch (_) { host = ''; }
    if (/^(android|ios)-app:/i.test(ref) && APPS[host]) return APPS[host];
    if (host && esHostPropio(host)) return 'interno';
    for (const [patron, nombre] of REDES) if (patron.test(host)) return nombre;
  }
  const ua = String(userAgent || '');
  for (const [patron, nombre] of REDES_APP) if (patron.test(ua)) return nombre;
  // Instagram agrega "igshid" o "igsh" a los enlaces que se comparten desde la app
  if (pistas && pistas.igshid === true && (!ref || !host)) return 'instagram';
  // Meta agrega "fbclid" a los enlaces de Facebook Y de Instagram: sin otra pista no se sabe de cuál viene
  if (pistas && pistas.fbclid === true && (!ref || !host)) return 'meta';
  if (!ref) return 'directo';
  return 'otros';
}

// Origen de una CUENTA nueva: el primer contacto debe ser anterior a crearla (con 10 min de tolerancia) y de hasta 30 días antes
function origenDeCuenta(origen, creadaMs) {
  if (!origen || typeof origen !== 'object') return 'sin_dato';
  const t = Number(origen.t);
  const creada = Number(creadaMs);
  if (!Number.isFinite(t) || !Number.isFinite(creada) || t <= 0 || creada <= 0) return 'sin_dato';
  if (t > creada + 10 * 60 * 1000 || creada - t > VENTANA_ORIGEN_MS) return 'sin_dato';
  return fuenteDe(String(origen.ref || '').slice(0, 300), String(origen.utm || '').slice(0, 40), String(origen.ua || '').slice(0, 300), { fbclid: origen.fb === true, igshid: origen.ig === true });
}

// Lo que se guarda de «por dónde llegó» en cada visita: nunca la dirección completa, solo el nombre del sitio y marcas
function pistasDe({ referrer, utm, userAgent, fbclid, igshid }) {
  let ref = '';
  try { ref = new URL(String(referrer || '')).hostname.toLowerCase().slice(0, 40); } catch (_) { ref = ''; }
  let app = '';
  for (const [patron, nombre] of REDES_APP) if (patron.test(String(userAgent || ''))) { app = nombre; break; }
  return { ref, utm: String(utm || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20), app, fbclid: fbclid === true, igshid: igshid === true };
}

/* ───────────────────────── País (sin servicios de pago ni de terceros) ───────────────────────── */

function esIpPublica(ip) {
  const v = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (net.isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // red interna del proveedor
    return true;
  }
  if (net.isIP(v) === 6) {
    const m = v.toLowerCase();
    return !(m === '::1' || m === '::' || m.startsWith('fc') || m.startsWith('fd') || m.startsWith('fe80'));
  }
  return false;
}

// Detrás del proxy del proveedor, req.ip puede ser el de un servidor intermedio: se leen primero las cabeceras con la IP original
const ENCABEZADOS_IP = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];
function candidatasIp(headers, ipExpress) {
  const h = headers || {};
  const lista = [];
  for (const nombre of ENCABEZADOS_IP) {
    const partes = String(h[nombre] || '').split(',').map(x => x.trim()).filter(Boolean);
    partes.forEach((ip, i) => lista.push({ cabecera: nombre + (partes.length > 1 ? '[' + i + ']' : ''), ip }));
  }
  if (ipExpress) lista.push({ cabecera: 'req.ip', ip: String(ipExpress) });
  return lista;
}
function ipDeSolicitud(headers, ipExpress) {
  const elegida = candidatasIp(headers, ipExpress).find(c => esIpPublica(c.ip));
  return elegida ? elegida.ip.replace(/^::ffff:/i, '') : String(ipExpress || '');
}

// País de 2 letras. 1) Si el proveedor (CDN) ya lo manda en una cabecera, se usa; 2) si no, se busca la IP en la base local del paquete
// geoip-country (sin llamadas a Internet; la IP no sale del servidor). Sin dato: 'ZZ' («No identificado»), sin inventar.
const CABECERAS_PAIS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code', 'cloudfront-viewer-country'];
let buscadorPais;
function paisDeIp(ip, buscador) {
  const limpia = String(ip || '').replace(/^::ffff:/i, '');
  try {
    if (!buscador && buscador !== null && buscadorPais === undefined) {
      try { buscadorPais = require('geoip-country'); } catch (_) { buscadorPais = null; }
    }
    const motor = buscador === null ? null : (buscador || buscadorPais);
    const r = motor && limpia && esIpPublica(limpia) ? motor.lookup(limpia) : null;
    return r && /^[A-Z]{2}$/.test(r.country) ? r.country : 'ZZ';
  } catch (_) { return 'ZZ'; }
}
function paisDeSolicitud(headers, ip, buscador) {
  const h = headers || {};
  for (const nombre of CABECERAS_PAIS) {
    const v = String(h[nombre] || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1') return v;
  }
  return paisDeIp(ip, buscador);
}

/* ───────────────────────── Identificador anónimo del día ───────────────────────── */

function hashVisitante(ip, userAgent, dia, secreto) {
  return crypto.createHmac('sha256', String(secreto) + '|' + dia)
    .update(String(ip || '') + '|' + String(userAgent || ''))
    .digest('hex').slice(0, 24);
}

/* ───────────────────────── Estado del contador (en memoria) ───────────────────────── */

const estadoContador = { ultimoOk: null, errores: 0, ultimoError: null };
function marcarVisitaOk(fecha = new Date()) { estadoContador.ultimoOk = fecha.toISOString(); }
function marcarVisitaError(error, fecha = new Date()) {
  estadoContador.errores += 1;
  estadoContador.ultimoError = { mensaje: String((error && error.message) || error || 'error').slice(0, 200), fecha: fecha.toISOString() };
}
const estado = () => ({ ultimoOk: estadoContador.ultimoOk, errores: estadoContador.errores, ultimoError: estadoContador.ultimoError });
function reiniciarEstado() { estadoContador.ultimoOk = null; estadoContador.errores = 0; estadoContador.ultimoError = null; }

/* ───────────────────────── Normalización de lo que llega ───────────────────────── */

const texto = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);

// Alias de páginas (el contador anterior mandaba «portada»)
const ALIAS_PAGINA = { portada: 'landing', inicio: 'landing', index: 'landing', login: 'acceso', registro: 'acceso', aviso: 'legal', terminos: 'legal', 'aviso-privacidad': 'legal' };
function normalizarPagina(valor) {
  const t = String(valor === undefined || valor === null ? '' : valor).toLowerCase().trim();
  const p = ALIAS_PAGINA[t] || t;
  return PAGINAS.includes(p) ? p : null;
}

function visitaNoRastreable(headers = {}) {
  return String(headers.dnt || '').trim() === '1' || String(headers['sec-gpc'] || '').trim() === '1';
}

// Cuerpo de la petición pública → datos limpios (o null). Lo que no está en la lista cerrada se ignora.
function limpiarCuerpo(b) {
  const c = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const pagina = normalizarPagina(c.pagina);
  if (!pagina) return null;
  const o = c.origen && typeof c.origen === 'object' && !Array.isArray(c.origen) ? c.origen : null;
  return {
    pagina,
    referrer: texto(c.ref, 300), utm: texto(c.utm, 40), fbclid: c.fbclid === true, igshid: c.igshid === true,
    origen: o ? { ref: texto(o.ref, 300), utm: texto(o.utm, 40), ua: texto(o.ua, 300), t: Number(o.t) || 0, fb: o.fb === true, ig: o.ig === true } : null
  };
}

/* ───────────────────────── Registrar una visita ───────────────────────── */

const enteroSeguro = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Una transacción por visita. Devuelve { contada, motivo?, dia, fuente, nueva }.
async function registrarVisita(db, { pagina, referrer, utm, fbclid, igshid, ip, pais, userAgent, secreto, miembro, origen, ahora = new Date(), obtenerCreada }) {
  const pag = normalizarPagina(pagina);
  if (!pag) return { contada: false, motivo: 'pagina' };
  if (esBot(userAgent)) return { contada: false, motivo: 'bot' };
  const dia = claveDia(ahora);
  const hora = horaMexico(ahora);
  const disp = dispositivoDe(userAgent);
  const codigoPais = /^[A-Z]{2}$/.test(String(pais || '')) ? pais : 'ZZ';
  const fuente = fuenteDe(referrer, utm, userAgent, { fbclid, igshid });
  const id = hashVisitante(ip, userAgent, dia, secreto);
  const pistas = pistasDe({ referrer, utm, userAgent, fbclid, igshid });
  const refDia = db.collection('metricasVisitas').doc(dia);
  const refVisitante = refDia.collection('visitantes').doc(id);
  const refLog = db.collection('metricasLog').doc(dia);
  const refMiembro = miembro ? db.collection('metricasMiembros').doc(miembro.uid) : null;

  // Origen de la cuenta: solo la primera vez que un miembro llega sin origen resuelto y trae su primer contacto
  let creada = null;
  if (miembro && origen && typeof obtenerCreada === 'function') {
    try {
      const previo = await refMiembro.get();
      const d = previo.exists ? objeto(previo.data()) : {};
      if (!d.origen) creada = await obtenerCreada();
    } catch (_) { creada = null; }
  }

  let nueva = false;
  await db.runTransaction(async tx => {
    const sDia = await tx.get(refDia);
    const sVisitante = await tx.get(refVisitante);
    const sLog = await tx.get(refLog);
    const sMiembro = refMiembro ? await tx.get(refMiembro) : null;

    const agg = sDia.exists ? objeto(sDia.data()) : {};
    const visitante = sVisitante.exists ? objeto(sVisitante.data()) : null;
    nueva = !visitante;
    const fuentesVisitante = visitante ? { ...objeto(visitante.fuentes) } : {};
    // Una persona suma a cada origen del día (si entra «directo» y luego llega desde Facebook, suma a los dos); «Dentro del sitio» solo en su primera visita
    const sumaFuente = nueva || (fuente !== 'interno' && !fuentesVisitante[fuente]);
    fuentesVisitante[fuente] = true;

    const horas = { ...objeto(agg.horas) };
    horas[hora] = enteroSeguro(horas[hora]) + 1;
    const paginas = { ...objeto(agg.paginas) };
    paginas[pag] = enteroSeguro(paginas[pag]) + 1;
    const dispositivos = { ...objeto(agg.dispositivos) };
    const paises = { ...objeto(agg.paises) };
    const fuentes = { ...objeto(agg.fuentes) };
    if (nueva) {
      dispositivos[disp] = enteroSeguro(dispositivos[disp]) + 1;
      paises[codigoPais] = enteroSeguro(paises[codigoPais]) + 1;
    }
    if (sumaFuente) fuentes[fuente] = enteroSeguro(fuentes[fuente]) + 1;

    // Miembro con sesión: su primera actividad del día suma a «miembros»
    let miembrosDia = enteroSeguro(agg.miembros);
    let docMiembro = null;
    if (miembro) {
      const m = sMiembro && sMiembro.exists ? objeto(sMiembro.data()) : {};
      const diasM = { ...objeto(m.dias) };
      if (!diasM[dia]) miembrosDia += 1;
      diasM[dia] = enteroSeguro(diasM[dia]) + 1;
      const claves = Object.keys(diasM).sort();
      while (claves.length > DIAS_ACTIVIDAD_MIEMBRO) delete diasM[claves.shift()];
      docMiembro = {
        uid: miembro.uid, nombre: texto(miembro.nombre, 80), email: texto(miembro.email, 120),
        ultima: ahora.toISOString(), visitas: enteroSeguro(m.visitas) + 1, dias: diasM
      };
      if (m.origen) docMiembro.origen = m.origen;
      else if (origen) {
        const o = origenDeCuenta(origen, creada);
        if (o !== 'sin_dato') { docMiembro.origen = o; docMiembro.creada = creada ? new Date(creada).toISOString() : null; }
      }
      if (m.creada && !docMiembro.creada) docMiembro.creada = m.creada;
    }

    const items = sLog.exists && Array.isArray(objeto(sLog.data()).items) ? objeto(sLog.data()).items.slice() : [];
    const totalLog = enteroSeguro(objeto(sLog.exists ? sLog.data() : {}).total) + 1;
    if (items.length < MAX_LOG_DIA) items.push({ t: ahora.toISOString(), pagina: pag, fuente, pais: codigoPais, dispositivo: disp, nuevo: nueva, pistas });

    tx.set(refDia, {
      dia, total: enteroSeguro(agg.total) + 1, unicos: enteroSeguro(agg.unicos) + (nueva ? 1 : 0), miembros: miembrosDia,
      dispositivos, paises, paginas, fuentes, horas, actualizado: ahora.toISOString()
    });
    tx.set(refVisitante, {
      primera: visitante && visitante.primera ? visitante.primera : ahora.toISOString(), ultima: ahora.toISOString(),
      visitas: visitante ? enteroSeguro(visitante.visitas) + 1 : 1, dispositivo: disp, pais: codigoPais, fuentes: fuentesVisitante
    });
    tx.set(refLog, { dia, total: totalLog, items, actualizado: ahora.toISOString() });
    if (refMiembro) tx.set(refMiembro, docMiembro);
  });
  return { contada: true, dia, fuente, nueva };
}

/* ───────────────────────── Lectura para el panel ───────────────────────── */

const claveDe = (obj, claves) => Object.fromEntries(claves.map(k => [k, enteroSeguro(objeto(obj)[k])]));
function normalizarDia(dia, d) {
  const x = objeto(d);
  const horas = {};
  for (let h = 0; h < 24; h++) { const k = String(h).padStart(2, '0'); horas[k] = enteroSeguro(objeto(x.horas)[k]); }
  const paises = {};
  for (const [k, v] of Object.entries(objeto(x.paises))) if (/^[A-Z]{2}$/.test(k) && enteroSeguro(v) > 0) paises[k] = enteroSeguro(v);
  return {
    dia, total: enteroSeguro(x.total), unicos: enteroSeguro(x.unicos), miembros: enteroSeguro(x.miembros),
    dispositivos: claveDe(x.dispositivos, DISPOSITIVOS), paises, paginas: claveDe(x.paginas, PAGINAS), fuentes: claveDe(x.fuentes, FUENTES), horas,
    actualizado: texto(x.actualizado, 30) || null
  };
}

function itemSeguro(it) {
  const x = objeto(it);
  const p = objeto(x.pistas);
  return {
    t: texto(x.t, 30), pagina: PAGINAS.includes(x.pagina) ? x.pagina : '',
    fuente: FUENTES.includes(x.fuente) ? x.fuente : 'otros', pais: /^[A-Z]{2}$/.test(String(x.pais)) ? x.pais : 'ZZ',
    dispositivo: DISPOSITIVOS.includes(x.dispositivo) ? x.dispositivo : 'computadora', nuevo: x.nuevo === true,
    pistas: { ref: texto(p.ref, 40), utm: texto(p.utm, 20), app: texto(p.app, 20), fbclid: p.fbclid === true, igshid: p.igshid === true }
  };
}

// Agregados de los últimos N días (con ceros), miembros con sesión del periodo, cuentas con origen y VIP.
// esVip(uid) → true/false (lo decide la membresía vigente; lo da quien llama). Lecturas: N + miembros con origen/actividad.
async function leerMetricas(db, { dias = DIAS_PREDETERMINADOS, ahora = new Date(), esVip = () => false } = {}) {
  const n = Math.min(Math.max(Number(dias) || DIAS_PREDETERMINADOS, 7), DIAS_MAX);
  const hoy = claveDia(ahora);
  const lista = listaDeDias(hoy, n);
  const filas = await Promise.all(lista.map(async d => {
    try { const s = await db.collection('metricasVisitas').doc(d).get(); return normalizarDia(d, s.exists ? s.data() : {}); } catch (_) { return normalizarDia(d, {}); }
  }));
  let docsMiembros = [];
  try { const s = await db.collection('metricasMiembros').get(); docsMiembros = s.docs.map(x => ({ id: x.id, data: objeto(x.data()) })); } catch (_) { docsMiembros = []; }
  const primero = lista[0];
  const miembros = docsMiembros
    .map(({ id, data }) => ({ id, data, dia: data.ultima ? claveDia(new Date(data.ultima)) : '' }))
    .filter(m => m.dia && m.dia >= primero)
    .sort((a, b) => String(b.data.ultima).localeCompare(String(a.data.ultima)))
    .slice(0, MAX_MIEMBROS_PANEL)
    .map(({ id, data }) => ({
      uid: id, nombre: texto(data.nombre, 80), email: texto(data.email, 120), ultima: texto(data.ultima, 30), visitas: enteroSeguro(data.visitas),
      dias: Object.fromEntries(Object.entries(objeto(data.dias)).filter(([k]) => k >= primero).map(([k, v]) => [k, enteroSeguro(v)]))
    }));
  const conOrigen = docsMiembros.filter(m => FUENTES.includes(m.data.origen)).slice(0, MAX_ORIGENES);
  const origenes = conOrigen.map(({ id, data }) => ({ uid: id, origen: data.origen, creada: texto(data.creada, 30) || null, vip: Boolean(esVip(id)) }));
  return { zona: ZONA, hoy, dias: filas, miembros, origenes, sinOrigen: Math.max(0, docsMiembros.length - origenes.length), estado: estado() };
}

// Registro una por una: hoy, ayer, últimos 7 o 30 días (hasta 600, la más reciente primero)
async function leerRegistro(db, { periodo = 'hoy', ahora = new Date() } = {}) {
  const clave = Object.prototype.hasOwnProperty.call(PERIODOS_LOG, periodo) ? String(periodo) : 'hoy';
  const hoy = claveDia(ahora);
  const dias = clave === 'ayer' ? [restarDias(hoy, 1)] : listaDeDias(hoy, PERIODOS_LOG[clave]);
  let total = 0;
  let items = [];
  for (const d of dias) {
    try {
      const s = await db.collection('metricasLog').doc(d).get();
      if (!s.exists) continue;
      const x = objeto(s.data());
      total += enteroSeguro(x.total);
      if (Array.isArray(x.items)) items = items.concat(x.items.map(itemSeguro));
    } catch (_) { /* un día que falle no tumba la lista */ }
  }
  items.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  const truncado = items.length > LIMITE_REGISTRO;
  return { periodo: clave, desde: dias[0], hasta: dias[dias.length - 1], total, items: items.slice(0, LIMITE_REGISTRO), truncado };
}

/* ───────────────────────── Limpieza (para que no crezca sin límite) ───────────────────────── */

// Borra los identificadores anónimos de más de 45 días y el registro una por una de más de 400. Los totales por día no se borran.
async function limpiarAntiguos(db, { ahora = new Date(), diasVisitantes = DIAS_VISITANTES, diasLog = DIAS_LOG } = {}) {
  const hoy = claveDia(ahora);
  let visitantes = 0;
  let logs = 0;
  for (let i = diasVisitantes + 1; i <= diasVisitantes + DIAS_BARRIDO; i++) {
    const dia = restarDias(hoy, i);
    for (;;) {
      const snap = await db.collection('metricasVisitas').doc(dia).collection('visitantes').limit(400).get();
      if (!snap.docs.length) break;
      const lote = db.batch();
      snap.docs.forEach(d => lote.delete(d.ref));
      await lote.commit();
      visitantes += snap.docs.length;
      if (snap.docs.length < 400) break;
    }
  }
  const corte = restarDias(hoy, diasLog);
  try {
    const snap = await db.collection('metricasLog').where('dia', '<', corte).limit(200).get();
    for (const d of snap.docs) { await d.ref.delete(); logs += 1; }
  } catch (_) { /* sin consulta disponible: se reintenta mañana */ }
  return { visitantes, logs };
}

module.exports = {
  ZONA, PAGINAS, DISPOSITIVOS, FUENTES, REDES_SOCIALES, MAX_LOG_DIA, DIAS_LOG, DIAS_VISITANTES, DIAS_MAX, DIAS_PREDETERMINADOS, LIMITE_REGISTRO, PERIODOS_LOG,
  claveDia, horaMexico, restarDias, listaDeDias, esBot, dispositivoDe, fuenteDe, origenDeCuenta, pistasDe, esIpPublica, ipDeSolicitud, paisDeIp, paisDeSolicitud, hashVisitante,
  normalizarPagina, visitaNoRastreable, limpiarCuerpo, registrarVisita, leerMetricas, leerRegistro, limpiarAntiguos,
  estado, marcarVisitaOk, marcarVisitaError, reiniciarEstado
};
