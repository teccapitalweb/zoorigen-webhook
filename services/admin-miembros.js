'use strict';

// ══ PANEL DE ADMINISTRACIÓN · acciones sobre un miembro (reglas puras, sin red ni Firebase) ══
// Regalar tiempo, eliminar con respaldo y restaurar. Las rutas están en services/rutas-admin-extra.js y estas
// reglas se prueban en test/admin-miembros.test.js.
//
// Qué se hace al ELIMINAR a una persona (decisión de diseño, pensada para 160 miembros reales):
//   SE COPIA primero (adminEliminados/{uid}, colección solo del servidor): su documento de miembro, el espejo
//     `usuarios`, su tarjeta del directorio, sus retos y XP, sus premios, su actividad, el avance de cada curso
//     (miembros/{uid}/progresoCursos/*), la lista de folios de certificados y los datos básicos de su cuenta de acceso.
//   SE BORRA: la cuenta de acceso (Firebase Auth), miembros/{uid}, usuarios/{uid}, directorio/{uid} y retosUsuario/{uid}
//     (así deja de salir en la comunidad y en las clasificaciones).
//   SE CONSERVA donde está: los certificados (el folio sigue verificándose para terceros), el avance por curso
//     (miembros/{uid}/progresoCursos), premiosUsuario, actividadUsuario, referidos y sus publicaciones del foro.
//   NO se toca Stripe: si tiene una suscripción activa hay que cancelarla en Stripe.
// Restaurar vuelve a crear la cuenta de acceso con el mismo uid y correo y reescribe lo respaldado. La contraseña no se
// guarda (es un secreto): la persona la define con «Olvidé mi contraseña».

const { aFecha, aIso, stripeActiva } = require('./admin-panel');

const DIA_MS = 86400000;
const DIAS_REGALO_VALIDOS = Object.freeze([30, 365]);
const DIAS_PARA_RESTAURAR = 30;
const TAMANO_MAXIMO_RESPALDO = 700000; // caracteres de JSON; el límite de Firestore es 1 MiB por documento

const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const limpiarNota = t => String(t).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// Cuerpo de POST /api/admin/miembros/:uid/regalar → { error } | { dias, nota }
function validarRegalo(cuerpo) {
  if (!esObjeto(cuerpo)) return { error: 'Faltan los datos del regalo' };
  let dias = cuerpo.dias;
  if (typeof dias === 'string' && /^[0-9]{1,4}$/.test(dias.trim())) dias = Number(dias);
  if (!DIAS_REGALO_VALIDOS.includes(dias)) return { error: 'El regalo debe ser de 30 días (un mes) o de 365 días (un año)' };
  let nota = '';
  if (cuerpo.nota !== undefined && cuerpo.nota !== null && cuerpo.nota !== '') {
    if (typeof cuerpo.nota !== 'string') return { error: 'La nota no es válida' };
    nota = limpiarNota(cuerpo.nota);
  }
  return { dias, nota };
}

// Suma los días desde el vencimiento vigente (si todavía no pasa) o desde hoy.
function calcularRegalo(miembro, dias, ahora = new Date()) {
  const m = miembro || {};
  const actual = aFecha(m.planVence || m.fechaExpiracion);
  const desdeVigente = Boolean(actual && actual.getTime() > ahora.getTime());
  const base = desdeVigente ? actual : ahora;
  return { desdeVigente, base, vence: new Date(base.getTime() + dias * DIA_MS) };
}

// ── Eliminación ──
function normalizarCorreo(c) { return String(c === undefined || c === null ? '' : c).trim().toLowerCase(); }

// Valida el cuerpo de DELETE /api/admin/miembros/:uid → { error } | { confirmarCorreo, confirmarStripe }
function validarEliminacion(cuerpo) {
  if (!esObjeto(cuerpo)) return { error: 'Escribe el correo de la persona para confirmar' };
  if (typeof cuerpo.confirmarCorreo !== 'string' || !cuerpo.confirmarCorreo.trim()) return { error: 'Escribe el correo de la persona para confirmar' };
  if (cuerpo.confirmarStripe !== undefined && typeof cuerpo.confirmarStripe !== 'boolean') return { error: 'Los datos enviados no son válidos' };
  return { confirmarCorreo: normalizarCorreo(cuerpo.confirmarCorreo), confirmarStripe: cuerpo.confirmarStripe === true };
}

// Copia profunda que conserva Timestamps/Date y descarta `undefined` (Firestore no lo acepta).
function copiaLimpia(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || typeof valor !== 'object') return valor;
  if (valor instanceof Date || typeof valor.toDate === 'function') return valor;
  if (Array.isArray(valor)) return valor.map(v => { const c = copiaLimpia(v); return c === undefined ? null : c; });
  const salida = {};
  for (const [k, v] of Object.entries(valor)) {
    const c = copiaLimpia(v);
    if (c !== undefined) salida[k] = c;
  }
  return salida;
}

function tamanoAproximado(valor) {
  try {
    return JSON.stringify(valor, (clave, v) => (v && typeof v.toDate === 'function' ? String(v.toDate().toISOString()) : v)).length;
  } catch (_) { return Infinity; }
}

// Arma el documento de adminEliminados/{uid}. Todo lo que se pasa viene ya leído de Firestore.
function construirRespaldo({ uid, miembro, usuario = null, directorio = null, retos = null, premios = null, actividad = null, progreso = {}, certificados = [], cuenta = null, por, porCorreo, ahora = new Date() }) {
  const m = miembro || {};
  const certificadosResumen = (Array.isArray(certificados) ? certificados : []).slice(0, 100).map(c => ({
    folio: String(c.folio || c.id || '').slice(0, 60), curso: String(c.curso || c.courseTitle || '').slice(0, 120)
  }));
  const respaldo = {
    uid,
    estado: 'eliminado',
    completado: false,
    nombre: String(m.name || m.displayName || '').slice(0, 120),
    correo: String(m.email || '').slice(0, 160),
    eliminadoEn: ahora,
    eliminadoPor: String(por || ''),
    eliminadoPorCorreo: normalizarCorreo(porCorreo).slice(0, 160),
    restaurableHasta: new Date(ahora.getTime() + DIAS_PARA_RESTAURAR * DIA_MS),
    miembro: copiaLimpia(m),
    usuario: copiaLimpia(usuario),
    directorio: copiaLimpia(directorio),
    retos: copiaLimpia(retos),
    premios: copiaLimpia(premios),
    actividad: copiaLimpia(actividad),
    progreso: copiaLimpia(progreso) || {},
    certificados: certificadosResumen,
    cuenta: cuenta ? copiaLimpia({
      email: cuenta.email, displayName: cuenta.displayName, emailVerified: cuenta.emailVerified === true,
      proveedores: Array.isArray(cuenta.proveedores) ? cuenta.proveedores : undefined, creada: cuenta.creada
    }) : null
  };
  return respaldo;
}

function respaldoCabe(respaldo) { return tamanoAproximado(respaldo) <= TAMANO_MAXIMO_RESPALDO; }

// ¿Se puede restaurar todavía? → { ok: true } | { ok: false, motivo }
function evaluarRestauracion(respaldo, ahora = new Date()) {
  if (!esObjeto(respaldo)) return { ok: false, motivo: 'no-existe' };
  if (respaldo.estado === 'restaurado') return { ok: false, motivo: 'ya-restaurado' };
  if (respaldo.estado !== 'eliminado' || respaldo.completado !== true) return { ok: false, motivo: 'incompleto' };
  const limite = aFecha(respaldo.restaurableHasta);
  if (!limite || limite.getTime() < ahora.getTime()) return { ok: false, motivo: 'vencido' };
  return { ok: true };
}

// Fila de la lista «Eliminados recientemente» (sin el contenido del respaldo)
function vistaEliminado(id, r, ahora = new Date()) {
  const e = evaluarRestauracion(r, ahora);
  return {
    uid: id,
    nombre: String((r && r.nombre) || '').slice(0, 120),
    correo: String((r && r.correo) || '').slice(0, 160),
    estado: r && r.estado === 'restaurado' ? 'restaurado' : (r && r.completado === true ? 'eliminado' : 'incompleto'),
    eliminadoEn: aIso(r && r.eliminadoEn),
    eliminadoPorCorreo: String((r && r.eliminadoPorCorreo) || '').slice(0, 160),
    restaurableHasta: aIso(r && r.restaurableHasta),
    restaurable: e.ok,
    motivo: e.ok ? null : e.motivo,
    restauradoEn: aIso(r && r.restauradoEn),
    cursosConAvance: r && esObjeto(r.progreso) ? Object.keys(r.progreso).length : 0,
    certificados: r && Array.isArray(r.certificados) ? r.certificados.length : 0
  };
}

module.exports = {
  DIAS_REGALO_VALIDOS, DIAS_PARA_RESTAURAR, TAMANO_MAXIMO_RESPALDO,
  validarRegalo, calcularRegalo, stripeActiva, normalizarCorreo, validarEliminacion,
  copiaLimpia, tamanoAproximado, construirRespaldo, respaldoCabe, evaluarRestauracion, vistaEliminado
};
