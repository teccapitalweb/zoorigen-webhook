'use strict';

// ══ CALENDARIO DE CURSOS DEL MIEMBRO · reglas puras (sin Firebase, sin red) ══
//
// Hasta ahora el calendario de desbloqueo (un curso nuevo cada 8 días desde que la persona es miembro) lo calculaba
// SOLO el navegador (assets/js/club-acceso.js). Aquí vive la misma regla en el servidor para que:
//   · el sitio pinte lo que el servidor dice (Cursos, Inicio, "Restan N días para su desbloqueo"),
//   · /api/bunny/embed-token y el progreso de clases respeten el calendario,
//   · el primer curso de la fila se pueda abrir antes resolviendo 15 retos (services/retos.js · progresoPrimerCurso).
// Las reglas de lectura/escritura en Firestore están en services/rutas-calendario.js. Se prueba en test/calendario.test.js.
//
// COMPATIBILIDAD (nadie pierde un curso que hoy tiene abierto):
//   · Miembros de siempre ("legado"): se reproduce la cuenta del navegador (1 curso cada 8 días desde que se creó la
//     cuenta, o desde que empezó su plan si eso fue antes). Es lo mismo o más generoso que lo que ya veían.
//   · Quien empieza su membresía DESPUÉS de activar el calendario del servidor ("nuevo"): cuenta desde el inicio de su plan.
//   · Con prueba gratuita elegida ("prueba"): el curso de prueba es el primero (abierto); los demás se abren cada 8 días
//     contados desde el inicio del plan, aunque la prueba todavía no esté terminada. Antes el conteo esperaba a que la
//     persona terminara la prueba; ahora cuenta desde que se hace miembro (nunca más tarde que antes).

const DIA_MS = 24 * 60 * 60 * 1000;
const DIAS_POR_CURSO = 8;
// Única clase gratis que existía antes de las marcas del panel (el sitio y el servidor de videos también la conocen).
const VIDEO_GRATIS_FIJO = 'befd1641-850a-4099-88a8-047a1badc703';

// Fecha (ms) de cualquier valor de fecha que pueda traer Firestore o el navegador. null si no es una fecha.
function aMs(valor) {
  if (valor === null || valor === undefined || valor === '' || typeof valor === 'boolean') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor.toMillis === 'function') { const t = valor.toMillis(); return Number.isFinite(t) ? t : null; }
  if (typeof valor.toDate === 'function') { const t = valor.toDate().getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof valor._seconds === 'number') return valor._seconds * 1000;
  if (typeof valor === 'string') { const t = Date.parse(valor); return Number.isNaN(t) ? null : t; }
  return null;
}

const iso = ms => new Date(ms).toISOString();

/* ───────────────────────── Orden de los cursos ───────────────────────── */

const tieneOrdenVip = c => Boolean(c) && typeof c.ordenVip === 'number' && Number.isFinite(c.ordenVip);

// Lo que hace falta saber de cada curso de Firestore para el calendario. `doc` es el documento tal cual.
function resumirCursoCalendario(id, doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const lecciones = Array.isArray(d.lecciones) ? d.lecciones : [];
  const videoIds = lecciones.map(l => (l && typeof l.videoId === 'string' ? l.videoId.trim() : '')).filter(Boolean);
  const muestra = d.cursoMuestraGratis === true;
  return {
    id,
    titulo: typeof d.title === 'string' && d.title.trim() ? d.title.trim().slice(0, 160) : (typeof d.titulo === 'string' ? d.titulo.trim().slice(0, 160) : ''),
    ordenVip: tieneOrdenVip(d) ? d.ordenVip : null,
    disponibleSiempre: d.disponibleSiempre === true,
    cursoMuestraGratis: muestra,
    // el curso que contiene la clase gratis de siempre (o clases marcadas gratis en un curso de muestra)
    gratisDeSiempre: lecciones.some(l => l && (String(l.videoId || '') === VIDEO_GRATIS_FIJO || (muestra && l.gratis === true))),
    clases: lecciones.length || (d.driveId ? 1 : 0),
    videoIds,
    creadoMs: aMs(d.createdAt),
    tieneCreadoEn: Object.prototype.hasOwnProperty.call(d, 'createdAt'),
    creadoRango: d.createdAt === null || d.createdAt === undefined ? 0 : (typeof d.createdAt === 'number' ? 1 : (typeof d.createdAt === 'string' ? 3 : 2))
  };
}

// El mismo orden con el que el sitio lee los cursos: db.collection('cursos').orderBy('createdAt', 'desc').
// (Firestore deja fuera los documentos que no tienen el campo y, a igual fecha, ordena por id en la misma dirección.)
function ordenPorCreacion(cursos) {
  return (Array.isArray(cursos) ? cursos : []).filter(c => c && c.tieneCreadoEn).slice().sort((a, b) => {
    if (a.creadoRango !== b.creadoRango) return b.creadoRango - a.creadoRango;
    const ta = a.creadoMs === null ? -Infinity : a.creadoMs, tb = b.creadoMs === null ? -Infinity : b.creadoMs;
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
  });
}

// Orden de la fila de desbloqueo (igual que club-acceso.js · ordenParaDesbloqueo):
// los cursos de siempre (sin ordenVip) conservan el orden que traen; los nuevos (con ordenVip) van DESPUÉS, por su número;
// y el curso con la clase gratis de siempre va arriba (orden estable).
function ordenParaDesbloqueo(cursosOrdenadosPorCreacion) {
  const lista = Array.isArray(cursosOrdenadosPorCreacion) ? cursosOrdenadosPorCreacion.filter(c => c && c.id) : [];
  const antiguos = lista.filter(c => !tieneOrdenVip(c));
  const nuevos = lista.filter(tieneOrdenVip).map((c, i) => ({ c, i })).sort((a, b) => (a.c.ordenVip - b.c.ordenVip) || (a.i - b.i)).map(x => x.c);
  const cursos = antiguos.concat(nuevos);
  cursos.sort((a, b) => (b.gratisDeSiempre ? 1 : 0) - (a.gratisDeSiempre ? 1 : 0));
  return cursos;
}

/* ───────────────────────── Desde cuándo cuenta el reloj ───────────────────────── */

// Inicio del plan según lo que el servidor escribe (Stripe, activación a mano, regalo).
function inicioDePlanMs(miembro, usuario) {
  const m = miembro && typeof miembro === 'object' ? miembro : {};
  const u = usuario && typeof usuario === 'object' ? usuario : {};
  for (const valor of [m.planInicio, m.planActivadoEn, u.fechaActivacion, m.fechaActivacion]) {
    const t = aMs(valor);
    if (t !== null) return t;
  }
  return null;
}

// Decide desde cuándo cuenta el calendario y con qué regla.
//   miembro / usuario : documentos de miembros/{uid} y usuarios/{uid}
//   tieneEleccion     : ya eligió su curso de prueba gratuita
//   nuevoDesdeMs      : desde esta fecha, quien empieza su plan cuenta desde el inicio de su plan (antes: regla de siempre)
//   cuentaCreadaMs    : fecha de creación de la cuenta en Firebase Auth (solo como último respaldo)
// Devuelve { inicioMs, modo: 'legado' | 'nuevo' | 'prueba', fuente }
function inicioDelCalendario({ miembro, usuario, tieneEleccion, nuevoDesdeMs, cuentaCreadaMs, ahoraMs }) {
  const ahora = Number.isFinite(ahoraMs) ? ahoraMs : Date.now();
  const m = miembro && typeof miembro === 'object' ? miembro : {};
  const plan = inicioDePlanMs(m, usuario);
  const registro = aMs(m.createdAt);
  if (tieneEleccion) {
    // Con prueba elegida cuenta desde que empezó el plan; si no se sabe, desde el último pago y, en último caso, desde hoy
    const t = plan !== null ? plan : aMs(m.ultimoPago);
    return t !== null ? { inicioMs: t, modo: 'prueba', fuente: plan !== null ? 'plan' : 'pago' } : { inicioMs: ahora, modo: 'prueba', fuente: 'hoy' };
  }
  const nuevo = plan !== null && Number.isFinite(nuevoDesdeMs) && plan >= nuevoDesdeMs;
  if (nuevo) return { inicioMs: plan, modo: 'nuevo', fuente: 'plan' };
  // Regla de siempre: desde que se creó la cuenta (o el plan, si empezó antes). Nunca más tarde que lo que ya veían.
  const propios = [registro, plan].filter(t => t !== null);
  if (propios.length) return { inicioMs: Math.min(...propios), modo: 'legado', fuente: registro !== null ? 'registro' : 'plan' };
  if (Number.isFinite(cuentaCreadaMs)) return { inicioMs: cuentaCreadaMs, modo: 'legado', fuente: 'cuenta' };
  return { inicioMs: ahora, modo: 'legado', fuente: 'hoy' };
}

/* ───────────────────────── Fila de desbloqueo ───────────────────────── */

// Cursos que entran a la fila de 8 días: todos menos los "disponibles siempre" y el curso de prueba elegido.
function colaDeDesbloqueo(lista, eleccion) {
  return (Array.isArray(lista) ? lista : []).filter(c => c && !c.disponibleSiempre && c.id !== eleccion);
}

// Fechas de desbloqueo de una fila nueva. Con prueba elegida el primero se abre a los 8 días (el curso de prueba es el primero).
function construirEntradas({ lista, eleccion, inicioMs }) {
  const salto = eleccion ? 1 : 0;
  return colaDeDesbloqueo(lista, eleccion).map((c, k) => ({ cursoId: c.id, desbloqueoEn: iso(inicioMs + (k + salto) * DIAS_POR_CURSO * DIA_MS) }));
}

// Cursos que aparecieron después de armar el calendario van al final de la fila, 8 días después del último.
// Lo ya guardado NO se mueve. Devuelve { entradas, cambio }.
function completarEntradas({ entradas, lista, eleccion, inicioMs }) {
  const previas = (Array.isArray(entradas) ? entradas : []).filter(e => e && typeof e.cursoId === 'string' && aMs(e.desbloqueoEn) !== null)
    .map(e => ({ ...e, desbloqueoEn: iso(aMs(e.desbloqueoEn)) }));
  const ya = new Set(previas.map(e => e.cursoId));
  const salto = eleccion ? 1 : 0;
  let ultimo = previas.length ? Math.max(...previas.map(e => aMs(e.desbloqueoEn))) : inicioMs + (salto - 1) * DIAS_POR_CURSO * DIA_MS;
  let cambio = previas.length !== (Array.isArray(entradas) ? entradas.length : 0);
  for (const c of colaDeDesbloqueo(lista, eleccion)) {
    if (ya.has(c.id)) continue;
    ultimo += DIAS_POR_CURSO * DIA_MS;
    previas.push({ cursoId: c.id, desbloqueoEn: iso(ultimo) });
    ya.add(c.id);
    cambio = true;
  }
  return { entradas: previas, cambio };
}

// Al volver a pagar después de que la membresía venció, el calendario se retoma: lo que ya estaba abierto al vencer se
// conserva y lo que seguía cerrado se vuelve a fechar (el primero a 8 días de la reactivación y los demás cada 8 días).
function reanudarEntradas(entradas, vencioMs, reanudoMs) {
  const lista = (Array.isArray(entradas) ? entradas : []).filter(e => e && aMs(e.desbloqueoEn) !== null).map(e => ({ ...e }));
  if (!Number.isFinite(vencioMs) || !Number.isFinite(reanudoMs) || reanudoMs <= vencioMs) return { entradas: lista, cambio: false };
  const cerradas = lista.filter(e => aMs(e.desbloqueoEn) > vencioMs).sort((a, b) => aMs(a.desbloqueoEn) - aMs(b.desbloqueoEn));
  cerradas.forEach((e, i) => { e.desbloqueoEn = iso(reanudoMs + (i + 1) * DIAS_POR_CURSO * DIA_MS); e.reanudadoEn = iso(reanudoMs); });
  return { entradas: lista, cambio: cerradas.length > 0 };
}

// Primer curso de la fila que seguía cerrado cuando se armó el calendario: es el único que se puede abrir con 15 retos.
function primerCursoCerrado(entradas, ahoraMs) {
  const cerradas = (Array.isArray(entradas) ? entradas : []).filter(e => e && aMs(e.desbloqueoEn) !== null && aMs(e.desbloqueoEn) > ahoraMs)
    .sort((a, b) => aMs(a.desbloqueoEn) - aMs(b.desbloqueoEn));
  return cerradas.length ? cerradas[0].cursoId : null;
}

/* ───────────────────────── Estado de cada curso ───────────────────────── */

// Estado de TODOS los cursos para una persona. Entradas:
//   lista        : cursos en el orden de la fila (ordenParaDesbloqueo)
//   entradas     : calendario guardado [{ cursoId, desbloqueoEn }]
//   eleccion     : id del curso de prueba (o null)
//   premios      : ids de cursos abiertos con un premio
//   adelantado   : id del curso abierto con 15 retos (o null)
//   esAdmin      : el administrador lo tiene todo abierto
// Cada elemento: { cursoId, abierto, motivo, desbloqueoEn, msFalta, diasFalta, porPremio, porRetos, esPrueba, siempre }
//   motivo: null (abierto) | 'tiempo' (tiene fecha) | 'sin-fecha' (todavía no entra a la fila)
function estadoDeCursos({ lista, entradas, eleccion, premios, adelantado, esAdmin, ahoraMs }) {
  const ahora = Number.isFinite(ahoraMs) ? ahoraMs : Date.now();
  const porCurso = new Map((Array.isArray(entradas) ? entradas : []).filter(e => e && e.cursoId).map(e => [e.cursoId, e]));
  const conPremio = new Set(Array.isArray(premios) ? premios : []);
  return (Array.isArray(lista) ? lista : []).map(c => {
    const base = { cursoId: c.id, abierto: false, motivo: null, desbloqueoEn: null, msFalta: 0, diasFalta: 0, porPremio: false, porRetos: false, esPrueba: false, siempre: false };
    if (esAdmin) return { ...base, abierto: true };
    if (c.disponibleSiempre) return { ...base, abierto: true, siempre: true };
    if (eleccion && c.id === eleccion) return { ...base, abierto: true, esPrueba: true };
    const e = porCurso.get(c.id);
    const fecha = e ? aMs(e.desbloqueoEn) : null;
    if (adelantado && c.id === adelantado) return { ...base, abierto: true, porRetos: true, desbloqueoEn: fecha !== null ? iso(fecha) : null };
    if (conPremio.has(c.id)) return { ...base, abierto: true, porPremio: true, desbloqueoEn: fecha !== null ? iso(fecha) : null };
    if (fecha === null) return { ...base, motivo: 'sin-fecha', diasFalta: null, msFalta: null };
    if (fecha <= ahora) return { ...base, abierto: true, desbloqueoEn: iso(fecha) };
    const ms = fecha - ahora;
    return { ...base, motivo: 'tiempo', desbloqueoEn: iso(fecha), msFalta: ms, diasFalta: Math.ceil(ms / DIA_MS) };
  });
}

// El curso cerrado que se abre antes (para "Próximo desbloqueo")
function proximoDesbloqueo(estados) {
  const cerrados = (Array.isArray(estados) ? estados : []).filter(e => !e.abierto && e.motivo === 'tiempo');
  cerrados.sort((a, b) => a.msFalta - b.msFalta);
  return cerrados[0] || null;
}

function textoBloqueado(estado) {
  if (!estado || estado.abierto) return '';
  const n = Number(estado.diasFalta);
  if (!Number.isFinite(n)) return 'Este curso todavía no tiene fecha de apertura';
  return n === 1 ? 'Este curso se abre en 1 día' : `Este curso se abre en ${n} días`;
}

module.exports = {
  DIA_MS, DIAS_POR_CURSO, VIDEO_GRATIS_FIJO, aMs,
  resumirCursoCalendario, ordenPorCreacion, ordenParaDesbloqueo, inicioDePlanMs, inicioDelCalendario,
  colaDeDesbloqueo, construirEntradas, completarEntradas, reanudarEntradas, primerCursoCerrado,
  estadoDeCursos, proximoDesbloqueo, textoBloqueado
};
