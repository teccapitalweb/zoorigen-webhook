'use strict';

// ══ DIRECTORIO DE LA COMUNIDAD (reglas puras) ══
// Cada miembro puede tener UNA tarjeta profesional (directorio/{uid}, solo del servidor). Todo lo que
// llega del navegador se valida (tipo, largo, forma) y se limpia de caracteres de control.
//
// Los textos se guardan TAL CUAL (sin convertir < > & a entidades): quien los muestre es el responsable de
// ESCAPARLOS al dibujarlos (el sitio lo hace). Así un nombre como "D'Angelo & Hijos" se ve bien y no depende
// de que nadie recuerde "no volver a escapar". Los enlaces y el correo se validan con una forma estricta.

const LIMITES = Object.freeze({ nombre: 80, profesion: 80, sector: 60, ciudad: 80, bio: 400, email: 120, url: 200 });
const MAX_TARJETAS = 300;

function escaparHtml(valor) {
  return String(valor == null ? '' : valor).replace(/[&<>"'`]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

// Caracteres de control, invisibles y de dirección de texto (salvo tabulador y salto de línea)
const CONTROL = new RegExp('[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]', 'g');

// Quita caracteres de control (menos el salto de línea) y normaliza espacios
function limpiarTexto(valor, { saltos = false } = {}) {
  let t = String(valor).normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (saltos) t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  else t = t.replace(/\s+/g, ' ');
  return t.trim();
}

// Campo de texto: undefined/null/'' = vacío; si viene otra cosa que texto, es un error
function textoOpcional(valor, max, etiqueta, opciones) {
  if (valor === undefined || valor === null) return { valor: '' };
  if (typeof valor !== 'string') return { error: `${etiqueta} no es válido` };
  const t = limpiarTexto(valor, opciones);
  if (t.length > max) return { error: `${etiqueta} no puede pasar de ${max} caracteres` };
  return { valor: t };
}

function normalizarUrl(valor, { dominio } = {}) {
  const crudo = String(valor).trim();
  if (!crudo || crudo.length > LIMITES.url || /[\s<>"'`\\]/.test(crudo)) return null;
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(crudo) ? crudo : `https://${crudo}`;
  let u;
  try { u = new URL(conEsquema); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || !u.hostname.includes('.')) return null;
  if (dominio && !(u.hostname === dominio || u.hostname.endsWith('.' + dominio))) return null;
  const href = u.href;
  return /['"<>`]/.test(href) || href.length > LIMITES.url ? null : href;
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;

// Valida y normaliza el cuerpo de POST /api/directorio. Devuelve { error } o { tarjeta }.
function validarTarjeta(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return { error: 'Faltan los datos de tu tarjeta' };

  const nombre = textoOpcional(cuerpo.nombre, LIMITES.nombre, 'El nombre');
  if (nombre.error) return nombre;
  if (nombre.valor.length < 2) return { error: 'El nombre es obligatorio (de 2 a 80 caracteres)' };
  const campos = {};
  for (const [campo, etiqueta, opciones] of [['profesion', 'La profesión', {}], ['sector', 'El sector', {}], ['ciudad', 'La ciudad', {}], ['bio', 'La descripción', { saltos: true }]]) {
    const r = textoOpcional(cuerpo[campo], LIMITES[campo], etiqueta, opciones);
    if (r.error) return r;
    campos[campo] = r.valor;
  }

  const crudo = cuerpo.contacto;
  if (crudo !== undefined && crudo !== null && (typeof crudo !== 'object' || Array.isArray(crudo))) return { error: 'Los datos de contacto no son válidos' };
  const c = crudo || {};
  const contacto = {};
  const vacio = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

  if (!vacio(c.whatsapp)) {
    if (typeof c.whatsapp !== 'string') return { error: 'El WhatsApp no es válido' };
    const digitos = c.whatsapp.replace(/[\s().+-]/g, '');
    if (!/^\d{8,15}$/.test(digitos)) return { error: 'El WhatsApp debe tener entre 8 y 15 dígitos' };
    contacto.whatsapp = digitos;
  }
  if (!vacio(c.email)) {
    if (typeof c.email !== 'string' || c.email.trim().length > LIMITES.email || !EMAIL.test(c.email.trim())) return { error: 'El correo de contacto no es válido' };
    contacto.email = c.email.trim();
  }
  for (const [campo, etiqueta, opciones] of [['linkedin', 'El enlace de LinkedIn', { dominio: 'linkedin.com' }], ['web', 'El sitio web', {}]]) {
    if (vacio(c[campo])) continue;
    const url = typeof c[campo] === 'string' ? normalizarUrl(c[campo], opciones) : null;
    if (!url) return { error: `${etiqueta} no es válido` };
    contacto[campo] = url;
  }
  if (!vacio(c.instagram)) {
    const usuario = typeof c.instagram === 'string' ? c.instagram.trim().replace(/^@/, '') : '';
    if (!/^[A-Za-z0-9._]{1,30}$/.test(usuario)) return { error: 'El usuario de Instagram no es válido' };
    contacto.instagram = usuario;
  }

  return {
    tarjeta: {
      nombre: nombre.valor, profesion: campos.profesion, sector: campos.sector,
      ciudad: campos.ciudad, bio: campos.bio, contacto
    }
  };
}

// Vista previa para quien no tiene membresía: seis tarjetas ficticias, sin datos de contacto reales.
// Los sectores son los de la lista del sitio (SECTORES de assets/js/club-directorio.js); el sitio trae las mismas
// tarjetas por su cuenta, así que si cambias estas, cambia también EJEMPLOS allí.
const EJEMPLOS = Object.freeze([
  { uid: 'ejemplo-1', nombre: 'Mariana Ejemplo', profesion: 'Bióloga de campo (tarjeta de ejemplo)', sector: 'Conservación', ciudad: 'Ciudad de México',
    bio: 'Tarjeta ficticia para que veas cómo se ve el directorio. Con tu membresía ves los perfiles reales de la comunidad.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-2', nombre: 'Ricardo Muestra', profesion: 'Médico veterinario de fauna silvestre (tarjeta de ejemplo)', sector: 'Veterinaria', ciudad: 'Guadalajara',
    bio: 'Tarjeta ficticia. Aquí aparecería la presentación de una persona de la comunidad.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-3', nombre: 'Valeria Demo', profesion: 'Educadora ambiental (tarjeta de ejemplo)', sector: 'Educación', ciudad: 'Mérida',
    bio: 'Tarjeta ficticia. Con la membresía puedes crear la tuya y conocer a otras personas del sector.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-4', nombre: 'Camila Modelo', profesion: 'Responsable de una UMA (tarjeta de ejemplo)', sector: 'Zoológicos/UMA', ciudad: 'Xalapa',
    bio: 'Tarjeta ficticia. Así se vería la presentación de alguien que trabaja en una UMA o en un zoológico.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-5', nombre: 'Andrés Prueba', profesion: 'Investigador en ecología de fauna (tarjeta de ejemplo)', sector: 'Investigación', ciudad: 'Morelia',
    bio: 'Tarjeta ficticia. Aquí una persona de la comunidad contaría en qué línea de investigación trabaja.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-6', nombre: 'Lucía Muestra', profesion: 'Zoóloga (tarjeta de ejemplo)', sector: 'Biología', ciudad: 'Monterrey',
    bio: 'Tarjeta ficticia. Con tu membresía buscas por sector o por ciudad y contactas a quien quieras.', contacto: {}, actualizado: null }
]);

// Sin tildes y en minúsculas, para buscar sin importar acentos ni mayúsculas
const plano = t => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Filtra por sector (igual, sin importar mayúsculas ni acentos) y por texto libre
function filtrar(tarjetas, { sector = '', q = '' } = {}) {
  const sec = plano(String(sector).trim());
  const texto = plano(String(q).trim());
  return tarjetas.filter(t => {
    if (sec && plano(t.sector) !== sec) return false;
    if (!texto) return true;
    return [t.nombre, t.profesion, t.sector, t.ciudad, t.bio].some(v => plano(v).includes(texto));
  });
}

// Documento guardado -> lo que ve el sitio
function tarjetaPublica(uid, doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const fecha = d.actualizado && typeof d.actualizado.toDate === 'function' ? d.actualizado.toDate().toISOString() : null;
  const c = d.contacto && typeof d.contacto === 'object' ? d.contacto : {};
  const contacto = {};
  for (const k of ['whatsapp', 'email', 'linkedin', 'web', 'instagram']) if (typeof c[k] === 'string' && c[k]) contacto[k] = c[k];
  const t = (k) => (typeof d[k] === 'string' ? d[k] : '');
  return { uid, nombre: t('nombre'), profesion: t('profesion'), sector: t('sector'), ciudad: t('ciudad'), bio: t('bio'), contacto, actualizado: fecha };
}

module.exports = { LIMITES, MAX_TARJETAS, EJEMPLOS, escaparHtml, validarTarjeta, filtrar, tarjetaPublica, normalizarUrl };
