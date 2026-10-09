'use strict';

// ══ Utilidades de texto compartidas por avisos, noticias y datos curiosos ══
// Los textos se guardan TAL CUAL (sin convertir < > & a entidades): el sitio los ESCAPA al mostrarlos,
// así que aquí solo se quitan caracteres de control, se normalizan espacios y se recorta el largo.

// Caracteres de control, invisibles y de dirección de texto (salvo tabulador y salto de línea)
const CONTROL = new RegExp('[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏ -‮⁦-⁩﻿]', 'g');

function limpiarTexto(valor, { saltos = false } = {}) {
  if (valor === undefined || valor === null) return '';
  let t = String(valor).normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (saltos) t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  else t = t.replace(/\s+/g, ' ');
  return t.trim();
}

// Recorta a `max` unidades sin partir un emoji (par sustituto) por la mitad
function recortar(texto, max) {
  const t = String(texto == null ? '' : texto);
  if (t.length <= max) return t;
  let corte = t.slice(0, max);
  const ultimo = corte.charCodeAt(corte.length - 1);
  if (ultimo >= 0xD800 && ultimo <= 0xDBFF) corte = corte.slice(0, -1);
  return corte.trimEnd();
}

// Limpia y recorta (texto de una línea por defecto)
function texto(valor, max, opciones) {
  return recortar(limpiarTexto(valor, opciones), max);
}

// Solo https, sin credenciales ni caracteres que rompan atributos. Devuelve la URL normalizada o ''.
function urlHttps(valor, max = 300) {
  if (typeof valor !== 'string') return '';
  const crudo = valor.trim();
  if (!crudo || crudo.length > max * 2 || /[\s<>"'`\\]/.test(crudo)) return '';
  let u;
  try { u = new URL(crudo); } catch (_) { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return '';
  const href = u.href;
  return href.length > max || /['"<>`]/.test(href) ? '' : href;
}

// Enlace interno del sitio (p. ej. "club-logros.html"): sin esquemas peligrosos, ≤ max caracteres.
function enlaceInterno(valor, max = 40) {
  const t = texto(valor, max);
  if (!t || /^\s*(javascript|data|vbscript|file):/i.test(t) || /[<>"'`\\\s]/.test(t)) return '';
  if (/^\/\//.test(t)) return '';
  return t;
}

// Fecha de Firestore (Timestamp, Date, texto o número) -> texto ISO; '' si no es válida
function aIso(valor) {
  let d = null;
  if (!valor) return '';
  if (typeof valor.toDate === 'function') d = valor.toDate();
  else if (valor instanceof Date) d = valor;
  else if (typeof valor._seconds === 'number') d = new Date(valor._seconds * 1000);
  else if (typeof valor === 'string' || typeof valor === 'number') d = new Date(valor);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

// Id seguro para un documento de Firestore (letras, números, guion y guion bajo)
function idSeguro(valor, max = 100) {
  const t = String(valor == null ? '' : valor).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max);
  return /[A-Za-z0-9]/.test(t) ? t : '';
}

const ID_VALIDO = /^[A-Za-z0-9_-]{1,100}$/;

module.exports = { limpiarTexto, recortar, texto, urlHttps, enlaceInterno, aIso, idSeguro, ID_VALIDO };
