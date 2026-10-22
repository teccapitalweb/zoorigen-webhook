'use strict';

// ══ DATOS DE CONTACTO DEL SITIO (WhatsApp, Instagram y correo) ══
// Viven en Firestore (config/contacto). Solo el servidor los escribe (POST /api/admin/contacto, solo administración) y el Club los
// lee por GET /api/config/contacto (público, con caché) para pintar sus enlaces de ayuda. Si el documento no existe o falla la
// lectura, se usan estos valores de siempre: el Club nunca se queda sin enlace.

const CONTACTO_POR_DEFECTO = Object.freeze({
  whatsapp: '+52 1 236 111 3237',
  instagram: 'https://www.instagram.com/zoorigen.mexico1/',
  correo: 'zooorigen@gmail.com'
});

const REGEX_CORREO = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const REGEX_USUARIO_IG = /^[A-Za-z0-9._]{1,30}$/;

const sinControl = t => String(t === undefined || t === null ? '' : t).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim();

// «+52 1 236 111 3237», «(236) 111-3237» → { display, numero }. numero = solo dígitos, listo para https://wa.me/<numero>
function validarWhatsapp(valor) {
  const t = sinControl(valor);
  if (!t) return { error: 'Escribe el número de WhatsApp' };
  if (t.length > 30 || !/^[+()\d\s.-]+$/.test(t)) return { error: 'El WhatsApp solo puede llevar números, espacios, guiones y el signo +' };
  let digitos = t.replace(/\D/g, '');
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  if (digitos.length < 10 || digitos.length > 15) return { error: 'El WhatsApp debe tener entre 10 y 15 dígitos, con el código de país (por ejemplo +52 1 236 111 3237)' };
  return { display: t, numero: digitos };
}

// «@usuario», «usuario» o la dirección completa → https://www.instagram.com/usuario/
function validarInstagram(valor) {
  const t = sinControl(valor);
  if (!t) return { error: 'Escribe el Instagram' };
  let usuario = t;
  const m = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/i.exec(t);
  if (m) usuario = m[1];
  else if (/^https?:\/\//i.test(t) || /\//.test(t)) return { error: 'El Instagram debe ser un usuario o una dirección de instagram.com' };
  usuario = usuario.replace(/^@/, '');
  if (!REGEX_USUARIO_IG.test(usuario)) return { error: 'El usuario de Instagram no es válido (letras, números, punto y guion bajo)' };
  return { url: `https://www.instagram.com/${usuario}/`, usuario };
}

function validarCorreo(valor) {
  const t = sinControl(valor).toLowerCase();
  if (!t) return { error: 'Escribe el correo de contacto' };
  if (t.length > 120 || !REGEX_CORREO.test(t)) return { error: 'El correo de contacto no es válido' };
  return { correo: t };
}

// Valida el cuerpo de POST /api/admin/contacto. Devuelve { error } o { datos: { whatsapp, whatsappNumero, instagram, correo } }.
function validarContacto(cuerpo) {
  const c = cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : null;
  if (!c) return { error: 'Faltan los datos de contacto' };
  for (const k of ['whatsapp', 'instagram', 'correo']) if (typeof c[k] !== 'string') return { error: 'Faltan los datos de contacto' };
  const w = validarWhatsapp(c.whatsapp); if (w.error) return { error: w.error };
  const i = validarInstagram(c.instagram); if (i.error) return { error: i.error };
  const e = validarCorreo(c.correo); if (e.error) return { error: e.error };
  return { datos: { whatsapp: w.display, whatsappNumero: w.numero, instagram: i.url, correo: e.correo } };
}

// Lo que se guarda en config/contacto → lo que se entrega; cualquier campo malo cae al valor de siempre
function contactoVigente(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const w = validarWhatsapp(d.whatsapp); const i = validarInstagram(d.instagram); const e = validarCorreo(d.correo);
  const pw = validarWhatsapp(CONTACTO_POR_DEFECTO.whatsapp);
  return {
    whatsapp: w.error ? pw.display : w.display,
    whatsappNumero: w.error ? pw.numero : w.numero,
    instagram: i.error ? CONTACTO_POR_DEFECTO.instagram : i.url,
    correo: e.error ? CONTACTO_POR_DEFECTO.correo : e.correo,
    personalizado: !(w.error || i.error || e.error)
  };
}

module.exports = { CONTACTO_POR_DEFECTO, validarWhatsapp, validarInstagram, validarCorreo, validarContacto, contactoVigente };
