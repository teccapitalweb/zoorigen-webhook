'use strict';

// ══ REFERIDOS (reglas puras) ══
// Un invitado es VÁLIDO solo si confirmó su correo y pasó el control de dispositivos.
// El bloque de endpoints vive en server.js; aquí solo hay reglas sin red ni Firebase.

// Hitos del invitado: el anfitrión gana XP UNA sola vez por hito (pequeñas recompensas).
const HITOS = Object.freeze([
  { clave: 'pago', texto: 'Tu invitado pagó una suscripción', puntos: 120 },
  { clave: 'retos5', texto: 'Tu invitado superó 5 retos', puntos: 40 },
  { clave: 'retos15', texto: 'Tu invitado superó 15 retos', puntos: 80 }
]);

// Solo los primeros invitados válidos suman XP: son los que hacen falta para los dos premios de
// referidos (3 y 6). Así el XP total de referidos tiene techo y el balance de niveles no se rompe.
const MAX_INVITADOS_CON_XP = 6;
const XP_POR_INVITADO = HITOS.reduce((t, h) => t + h.puntos, 0);
const XP_MAXIMO_REFERIDOS = MAX_INVITADOS_CON_XP * XP_POR_INVITADO;

// Nombre público de una persona: primer nombre + inicial del apellido ("María G."). Nunca un correo,
// un teléfono ni nada con "@" o números: si el nombre guardado no sirve, queda "Miembro".
function aliasDeNombre(nombre) {
  const palabras = String(nombre == null ? '' : nombre)
    .replace(/\s+/g, ' ').trim().split(' ')
    .filter(p => p && !/[@\d]/.test(p) && /^[\p{L}][\p{L}'.-]*$/u.test(p));
  if (!palabras.length) return 'Miembro';
  const primero = palabras[0].slice(0, 20);
  if (palabras.length === 1) return primero;
  // Con 3 o más palabras el apellido paterno es el penúltimo ("Luis Gómez Ruiz" -> "Luis G.")
  const apellido = palabras.length >= 3 ? palabras[palabras.length - 2] : palabras[1];
  return primero + ' ' + apellido[0].toLocaleUpperCase('es-MX') + '.';
}

module.exports = { HITOS, MAX_INVITADOS_CON_XP, XP_POR_INVITADO, XP_MAXIMO_REFERIDOS, aliasDeNombre };
