'use strict';

// ══ DIRECTORIO DE LA COMUNIDAD (reglas puras) ══
// Cada miembro puede tener UNA tarjeta profesional (directorio/{uid}, solo del servidor). Todo lo que
// llega del navegador se valida (tipo, largo, forma) y se limpia de caracteres de control.
//
// Los textos se guardan TAL CUAL (sin convertir < > & a entidades): quien los muestre es el responsable de
// ESCAPARLOS al dibujarlos (el sitio lo hace). Así un nombre como "D'Angelo & Hijos" se ve bien y no depende
// de que nadie recuerde "no volver a escapar". Los enlaces y el correo se validan con una forma estricta.

const LIMITES = Object.freeze({ nombre: 80, profesion: 80, institucion: 80, sector: 60, ciudad: 80, bio: 400, estado: 20, cedula: 20, email: 120, url: 200 });

// Estado profesional opcional (igual que en Alintec Food): lo que la persona quiere que sepan de su disponibilidad.
const ESTADOS = Object.freeze({ proyectos: 'Disponible para proyectos', empleo: 'Busco empleo' });
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
  for (const [campo, etiqueta, opciones] of [
    ['profesion', 'La profesión', {}], ['institucion', 'La institución', {}], ['sector', 'El sector', {}], ['ciudad', 'La ciudad', {}],
    ['bio', 'La descripción', { saltos: true }], ['estado', 'El estado profesional', {}], ['cedula', 'La cédula profesional', {}]
  ]) {
    const r = textoOpcional(cuerpo[campo], LIMITES[campo], etiqueta, opciones);
    if (r.error) return r;
    campos[campo] = r.valor;
  }
  if (campos.estado && !Object.prototype.hasOwnProperty.call(ESTADOS, campos.estado)) return { error: 'El estado profesional no es válido' };
  if (campos.cedula && !/^[A-Za-z0-9-]{4,20}$/.test(campos.cedula)) return { error: 'La cédula profesional no es válida (de 4 a 20 letras o números)' };
  // Banderas: solo verdadero o falso. Sin "publicado" la tarjeta queda PRIVADA (solo la ve su dueña o dueño).
  const banderas = {};
  for (const [campo, etiqueta] of [['cedulaVisible', 'Mostrar la cédula'], ['publicado', 'Publicar la tarjeta']]) {
    const v = cuerpo[campo];
    if (v !== undefined && v !== null && typeof v !== 'boolean') return { error: `${etiqueta} no es válido` };
    banderas[campo] = v === true;
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
      nombre: nombre.valor, profesion: campos.profesion, institucion: campos.institucion, sector: campos.sector,
      ciudad: campos.ciudad, bio: campos.bio, estado: campos.estado, cedula: campos.cedula,
      cedulaVisible: banderas.cedulaVisible, publicado: banderas.publicado, contacto
    }
  };
}

// ── Perfil profesional de bienvenida (POST /api/perfil-profesional) ──
// Cualquier cuenta (con o sin membresía) puede guardar su ficha PRIVADA: nombre, puesto, institución, ciudad, WhatsApp y
// correo de contacto. Se mezcla con la tarjeta que ya exista (no borra sector, descripción, estado, cédula ni el
// "publicado"): publicar la tarjeta sigue siendo POST /api/directorio y es solo para miembros.
const CAMPOS_PERFIL = Object.freeze(['nombre', 'profesion', 'institucion', 'ciudad', 'whatsapp', 'email']);

// existente: documento directorio/{uid} (o null). entrada: cuerpo recibido (solo se leen los campos de CAMPOS_PERFIL
// que vienen como texto). Devuelve { error } o { tarjeta } lista para guardar (misma validación que la tarjeta).
function fusionarPerfil(existente, entrada) {
  const e = existente && typeof existente === 'object' ? existente : {};
  const x = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : null;
  if (!x) return { error: 'Faltan los datos de tu perfil' };
  for (const k of CAMPOS_PERFIL) {
    if (x[k] !== undefined && x[k] !== null && typeof x[k] !== 'string') return { error: 'Los datos de tu perfil no son válidos' };
  }
  const pon = (k, previo) => (typeof x[k] === 'string' ? x[k] : previo);
  const c = e.contacto && typeof e.contacto === 'object' ? e.contacto : {};
  const contacto = { ...c };
  for (const k of ['whatsapp', 'email']) {
    if (typeof x[k] !== 'string') continue;
    if (x[k].trim() === '') delete contacto[k]; else contacto[k] = x[k];
  }
  const cuerpo = {
    nombre: pon('nombre', e.nombre), profesion: pon('profesion', e.profesion), institucion: pon('institucion', e.institucion),
    sector: e.sector, ciudad: pon('ciudad', e.ciudad), bio: e.bio, estado: e.estado, cedula: e.cedula,
    cedulaVisible: e.cedulaVisible === true, publicado: e.publicado === true, contacto
  };
  return validarTarjeta(cuerpo);
}

// Lo que se le devuelve a su dueña o dueño para precargar el formulario (solo sus propios datos)
function perfilPropio(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const c = d.contacto && typeof d.contacto === 'object' ? d.contacto : {};
  const t = v => (typeof v === 'string' ? v : '');
  return { existe: Boolean(doc), nombre: t(d.nombre), profesion: t(d.profesion), institucion: t(d.institucion), ciudad: t(d.ciudad), whatsapp: t(c.whatsapp), email: t(c.email), publicado: d.publicado === true };
}

// Vista previa para quien no tiene membresía: seis tarjetas ficticias, sin datos de contacto reales.
// Los sectores son los de la lista del sitio (SECTORES de assets/js/club-directorio.js); el sitio trae las mismas
// tarjetas por su cuenta, así que si cambias estas, cambia también EJEMPLOS allí.
const EJEMPLOS = Object.freeze([
  { uid: 'ejemplo-1', nombre: 'Mariana Ejemplo', profesion: 'Bióloga de campo (tarjeta de ejemplo)', institucion: 'Instituto de ejemplo', sector: 'Conservación', ciudad: 'Ciudad de México',
    bio: 'Tarjeta ficticia para que veas cómo se ve el directorio. Con tu membresía ves los perfiles reales de la comunidad.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-2', nombre: 'Ricardo Muestra', profesion: 'Médico veterinario de fauna silvestre (tarjeta de ejemplo)', institucion: 'Clínica veterinaria de ejemplo', sector: 'Veterinaria', ciudad: 'Guadalajara',
    bio: 'Tarjeta ficticia. Aquí aparecería la presentación de una persona de la comunidad.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-3', nombre: 'Valeria Demo', profesion: 'Educadora ambiental (tarjeta de ejemplo)', institucion: 'Centro de educación ambiental de ejemplo', sector: 'Educación', ciudad: 'Mérida',
    bio: 'Tarjeta ficticia. Con la membresía puedes crear la tuya y conocer a otras personas del sector.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-4', nombre: 'Camila Modelo', profesion: 'Responsable de una UMA (tarjeta de ejemplo)', institucion: 'UMA de ejemplo', sector: 'Zoológicos/UMA', ciudad: 'Xalapa',
    bio: 'Tarjeta ficticia. Así se vería la presentación de alguien que trabaja en una UMA o en un zoológico.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-5', nombre: 'Andrés Prueba', profesion: 'Investigador en ecología de fauna (tarjeta de ejemplo)', institucion: 'Universidad de ejemplo', sector: 'Investigación', ciudad: 'Morelia',
    bio: 'Tarjeta ficticia. Aquí una persona de la comunidad contaría en qué línea de investigación trabaja.', contacto: {}, actualizado: null },
  { uid: 'ejemplo-6', nombre: 'Lucía Muestra', profesion: 'Zoóloga (tarjeta de ejemplo)', institucion: 'Museo de historia natural de ejemplo', sector: 'Biología', ciudad: 'Monterrey',
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
    return [t.nombre, t.profesion, t.institucion, t.sector, t.ciudad, t.bio].some(v => plano(v).includes(texto));
  });
}

// Documento guardado -> lo que ve el sitio.
//  · esMia: quien mira es su dueña o dueño (ve su cédula aunque no la muestre al público)
//  · verificado: la membresía de su dueña o dueño está vigente (lo calcula el servidor, nunca viene del navegador)
function tarjetaPublica(uid, doc, { esMia = false, verificado = false } = {}) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const fecha = d.actualizado && typeof d.actualizado.toDate === 'function' ? d.actualizado.toDate().toISOString() : null;
  const c = d.contacto && typeof d.contacto === 'object' ? d.contacto : {};
  const contacto = {};
  for (const k of ['whatsapp', 'email', 'linkedin', 'web', 'instagram']) if (typeof c[k] === 'string' && c[k]) contacto[k] = c[k];
  const t = (k) => (typeof d[k] === 'string' ? d[k] : '');
  const cedulaVisible = d.cedulaVisible === true;
  return {
    uid, nombre: t('nombre'), profesion: t('profesion'), institucion: t('institucion'), sector: t('sector'), ciudad: t('ciudad'), bio: t('bio'),
    estado: Object.prototype.hasOwnProperty.call(ESTADOS, d.estado) ? d.estado : '',
    cedula: cedulaVisible || esMia ? t('cedula') : '', cedulaVisible,
    publicado: d.publicado === true, verificado: verificado === true,
    contacto, actualizado: fecha
  };
}

module.exports = { LIMITES, ESTADOS, MAX_TARJETAS, EJEMPLOS, CAMPOS_PERFIL, fusionarPerfil, perfilPropio, escaparHtml, validarTarjeta, filtrar, tarjetaPublica, normalizarUrl };
