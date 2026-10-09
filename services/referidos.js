'use strict';

// ══ REFERIDOS (reglas puras: sin red ni Firebase) ══
// Un invitado es VÁLIDO solo si confirmó su correo (lo verifica el servidor con el Admin SDK) y pasó
// el control de dispositivos. Los endpoints viven en services/rutas-club.js.
//
// Límite honesto del control anti-fraude: compara el identificador que guarda el navegador
// (localStorage), una "huella" ligera (idioma, zona horaria, pantalla...) y la IP. Una persona que
// borra los datos del navegador, usa modo incógnito, otro navegador u otro teléfono NO se detecta.
// Dos familiares en la misma casa pueden compartir IP y modelo de teléfono: por eso la huella solo
// cuenta junto con la IP y nunca la IP sola.

const ESTADOS = Object.freeze({ VALIDO: 'valido', PENDIENTE: 'pendiente-correo', RECHAZADO: 'rechazado' });

// Hitos del invitado: el anfitrión gana XP UNA sola vez por hito (pequeñas recompensas).
const HITOS = Object.freeze([
  { clave: 'pago', texto: 'Tu invitado pagó una suscripción', puntos: 120 },
  { clave: 'retos5', texto: 'Tu invitado superó 5 retos', puntos: 40 },
  { clave: 'retos15', texto: 'Tu invitado superó 15 retos', puntos: 80 }
]);
const RETOS_PARA_HITO = Object.freeze({ retos5: 5, retos15: 15 });

// Solo los primeros invitados válidos suman XP: son los que hacen falta para los dos premios de
// referidos (3 y 6). Así el XP total de referidos tiene techo y el balance de niveles no se rompe.
const MAX_INVITADOS_CON_XP = 6;
const XP_POR_INVITADO = HITOS.reduce((t, h) => t + h.puntos, 0);
const XP_MAXIMO_REFERIDOS = MAX_INVITADOS_CON_XP * XP_POR_INVITADO;

// Una cuenta creada hace más de esto no puede ser "invitado nuevo" (evita invitar a quien ya era miembro).
const DIAS_MAXIMOS_CUENTA_NUEVA = 14;
const MAX_DISPOSITIVOS_ANFITRION = 20;

const MOTIVOS = Object.freeze({
  'codigo-inexistente': 'Ese código de invitación no existe',
  'mismo-usuario': 'No puedes usar tu propio código de invitación',
  'dispositivo-anfitrion': 'Se registró desde el mismo dispositivo de quien lo invitó',
  'dispositivo-invitado': 'Ya hay otra persona invitada desde ese mismo dispositivo',
  'cuenta-antigua': 'Esa cuenta ya existía antes de la invitación'
});

// ── Código y enlace ──
const URL_REGISTRO = 'https://www.zoorigen.com/pages/club-registro.html';
const CODIGO_REGEX = /^ZOO-[A-Z0-9_-]{6}$/;

function codigoDeUid(uid) { return 'ZOO-' + String(uid).substring(0, 6).toUpperCase(); }
function enlaceDeCodigo(codigo) { return `${URL_REGISTRO}?ref=${encodeURIComponent(codigo)}`; }
function normalizarCodigo(codigo) {
  if (typeof codigo !== 'string') return null;
  const limpio = codigo.trim().toUpperCase();
  return CODIGO_REGEX.test(limpio) ? limpio : null;
}

// Un código sale de las 6 primeras letras del uid en mayúsculas; el uid real mezcla mayúsculas y
// minúsculas. Devuelve todas las formas posibles de esas 6 letras (como mucho 64) para buscarlas.
function variantesDePrefijo(codigo) {
  const base = codigo.slice(4);
  let variantes = [''];
  for (const c of base) {
    const opciones = c.toLowerCase() === c.toUpperCase() ? [c] : [c.toUpperCase(), c.toLowerCase()];
    variantes = variantes.flatMap(v => opciones.map(o => v + o));
  }
  return variantes;
}

// ── Datos del dispositivo (vienen del navegador: se validan tipo, forma y largo) ──
const ID_DISPOSITIVO = /^[A-Za-z0-9_-]{8,64}$/;
const HUELLA = /^[A-Za-z0-9+/=_-]{6,128}$/;

function validarDispositivo({ deviceId, huella } = {}) {
  if (typeof deviceId !== 'string' || !ID_DISPOSITIVO.test(deviceId.trim())) return null;
  if (typeof huella !== 'string' || !HUELLA.test(huella.trim())) return null;
  return { deviceId: deviceId.trim(), huella: huella.trim() };
}

// Primer valor de x-forwarded-for (contrato); si no hay, la IP del socket. Solo se usa para comparar.
function ipDeSolicitud(headers = {}, ipSocket = '') {
  const cabecera = headers['x-forwarded-for'];
  const primero = String(Array.isArray(cabecera) ? cabecera[0] : (cabecera || '')).split(',')[0].trim();
  const ip = primero || String(ipSocket || '').trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : '';
}

const combo = (huella, ip) => (huella && ip ? `${huella}|${ip}` : null);

// Dispositivos de un anfitrión (colección dispositivosAnfitrion + el dispositivo con que se registró)
function normalizarDispositivosAnfitrion(guardado) {
  const g = guardado && typeof guardado === 'object' ? guardado : {};
  const lista = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return { ids: lista(g.ids), huellas: lista(g.huellas), combos: lista(g.combos) };
}

// Agrega un dispositivo a la lista (sin repetir, solo los últimos MAX_DISPOSITIVOS_ANFITRION)
function agregarDispositivo(guardado, { deviceId, huella, ip }) {
  const d = normalizarDispositivosAnfitrion(guardado);
  const mete = (lista, valor) => (valor && !lista.includes(valor) ? [...lista, valor].slice(-MAX_DISPOSITIVOS_ANFITRION) : lista);
  return { ids: mete(d.ids, deviceId), huellas: mete(d.huellas, huella), combos: mete(d.combos, combo(huella, ip)) };
}

// ¿Dos dispositivos son el mismo? Mismo identificador, o misma huella Y misma IP.
function mismoDispositivo(a, b) {
  if (a.deviceId && b.deviceId && a.deviceId === b.deviceId) return true;
  const ca = combo(a.huella, a.ip); const cb = combo(b.huella, b.ip);
  return Boolean(ca && cb && ca === cb);
}

const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : 0));
// Orden estable de invitados: primero el que se registró antes; con el mismo instante, por uid
const antesQue = (a, b) => (ms(a.creadoEn) - ms(b.creadoEn)) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

// Control de dispositivos de UN invitado. Devuelve null si pasa, o la clave del motivo si se rechaza.
//   invitado: { uid, anfitrionUid, deviceId, huella, ip, creadoEn }
//   anfitrion: { ids, huellas, combos } (dispositivosAnfitrion + el dispositivo de su propio registro)
//   otros: los demás invitados del mismo anfitrión ({ uid, estado, deviceId, huella, ip, creadoEn })
// Contra otros invitados solo choca con los que ya son VÁLIDOS: el primero que confirma su correo se
// queda con el dispositivo y el siguiente se rechaza. Con `soloAnteriores` (revisión posterior a un
// registro simultáneo) únicamente cuentan los que se registraron antes, para que dos registros a la
// vez no se rechacen entre sí.
function evaluarDispositivo(invitado, anfitrion, otros = [], { soloAnteriores = false } = {}) {
  if (invitado.uid === invitado.anfitrionUid) return 'mismo-usuario';
  const host = normalizarDispositivosAnfitrion(anfitrion);
  const cInv = combo(invitado.huella, invitado.ip);
  if ((invitado.deviceId && host.ids.includes(invitado.deviceId)) || (cInv && host.combos.includes(cInv))) return 'dispositivo-anfitrion';
  const choca = otros.some(o => o.uid !== invitado.uid && o.estado === ESTADOS.VALIDO &&
    (!soloAnteriores || antesQue(o, invitado) < 0) && mismoDispositivo(o, invitado));
  return choca ? 'dispositivo-invitado' : null;
}

const tieneValor = v => v !== undefined && v !== null && v !== '' && v !== false;

// ¿El invitado ya pagó una suscripción? Solo con señales que el navegador NO puede escribir (las reglas
// de Firestore bloquean estos campos): un cobro confirmado, o plan vigente de Stripe/Shopify que no
// sea un alta manual del administrador.
function invitadoPago(miembro, usuario, tienePlan) {
  const m = miembro && typeof miembro === 'object' ? miembro : {};
  const u = usuario && typeof usuario === 'object' ? usuario : {};
  if (tieneValor(m.ultimoPago) || tieneValor(u.ultimoPago)) return true;
  if (!tienePlan || m.activadoManualmente || u.activadoManualmente) return false;
  return [m.stripeSubscriptionId, u.stripeSubscriptionId, m.shopifyOrderId].some(tieneValor);
}

// Del más antiguo al más nuevo
const ordenarInvitados = lista => [...lista].sort(antesQue);

// ¿Una cuenta de Auth es "nueva"? creationTime viene como texto de fecha. Sin dato, se acepta.
function cuentaNueva(creationTime, ahora = Date.now()) {
  const t = Date.parse(creationTime);
  if (Number.isNaN(t)) return true;
  return ahora - t <= DIAS_MAXIMOS_CUENTA_NUEVA * 86400000;
}

// ── Hitos ──
function normalizarHitos(guardado) {
  const g = guardado && typeof guardado === 'object' ? guardado : {};
  return { pago: g.pago === true, retos5: g.retos5 === true, retos15: g.retos15 === true };
}

// Un hito logrado no se pierde (aunque el invitado cancele o se vaya). Devuelve los hitos nuevos.
//   señales: { pago: bool, retosSuperados: n }
function actualizarHitos(guardado, { pago = false, retosSuperados = 0 } = {}) {
  const antes = normalizarHitos(guardado);
  const despues = {
    pago: antes.pago || pago === true,
    retos5: antes.retos5 || retosSuperados >= RETOS_PARA_HITO.retos5,
    retos15: antes.retos15 || retosSuperados >= RETOS_PARA_HITO.retos15
  };
  const nuevos = HITOS.filter(h => despues[h.clave] && !antes[h.clave]).map(h => h.clave);
  return { hitos: despues, nuevos };
}

// Lista de hitos como la pinta el sitio. Solo un invitado válido puede tener hitos logrados.
function listaDeHitos(hitos, valido) {
  const h = normalizarHitos(hitos);
  return HITOS.map(x => ({ clave: x.clave, texto: x.texto, puntos: x.puntos, logrado: Boolean(valido && h[x.clave]) }));
}
const puntosDeHitos = hitos => {
  const h = normalizarHitos(hitos);
  return HITOS.reduce((t, x) => t + (h[x.clave] ? x.puntos : 0), 0);
};

// Resumen de todos los invitados de un anfitrión (ya ordenados del más antiguo al más nuevo).
//   XP: solo los primeros MAX_INVITADOS_CON_XP válidos suman.
function resumirInvitados(invitados) {
  let conXp = 0; let validos = 0; let pendientes = 0; let rechazados = 0; let xp = 0;
  const detalle = invitados.map(i => {
    let puntos = 0; let cuenta = false;
    if (i.estado === ESTADOS.VALIDO) {
      validos += 1;
      if (conXp < MAX_INVITADOS_CON_XP) { conXp += 1; cuenta = true; puntos = puntosDeHitos(i.hitos); xp += puntos; }
    } else if (i.estado === ESTADOS.PENDIENTE) pendientes += 1;
    else rechazados += 1;
    return { uid: i.uid, puntos, conPuntos: cuenta };
  });
  return { validos, pendientes, rechazados, xp, detalle };
}

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

module.exports = {
  ESTADOS, HITOS, MAX_INVITADOS_CON_XP, XP_POR_INVITADO, XP_MAXIMO_REFERIDOS, DIAS_MAXIMOS_CUENTA_NUEVA, MOTIVOS,
  codigoDeUid, enlaceDeCodigo, normalizarCodigo, variantesDePrefijo,
  validarDispositivo, ipDeSolicitud, normalizarDispositivosAnfitrion, agregarDispositivo, mismoDispositivo,
  evaluarDispositivo, invitadoPago, ordenarInvitados, cuentaNueva, normalizarHitos, actualizarHitos, listaDeHitos, puntosDeHitos, resumirInvitados, aliasDeNombre
};
