'use strict';

// ══ PANEL DE ADMINISTRACIÓN · Métricas y Pruebas gratuitas (reglas puras, sin red ni Firebase) ══
// Con los datos que YA existen en Firestore (miembros, certificados, retosUsuario, pruebasGratuitas, progresoCursos y,
// si el contador está encendido, visitasDiarias). Nada se inventa: lo que no se puede saber se devuelve como null o 0
// y el panel lo rotula. Se prueba en test/admin-metricas.test.js.
//
// Notas de honestidad sobre los datos:
//  - No hay libro de cobros: los "pagos" son el ÚLTIMO pago de cada miembro (ultimoPago), no cada cobro.
//  - "Retención" = de quienes alguna vez tuvieron plan, cuántos tienen acceso hoy.
//  - Los días se cuentan en hora de México (UTC-6), igual que el resto del panel.

const { aFecha, aIso, diaMexico, clasificarMiembro, ESTADOS } = require('./admin-panel');
const pruebaGratuita = require('./prueba-gratuita');

const DIA_MS = 86400000;
const MAX_DIAS = 731;
const PATRON_DIA = /^\d{4}-\d{2}-\d{2}$/;

const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const hoyMx = ahora => diaMexico(ahora);

function sumarDias(clave, n) {
  const [a, m, d] = clave.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
function diasEntre(desde, hasta) {
  const [a1, m1, d1] = desde.split('-').map(Number);
  const [a2, m2, d2] = hasta.split('-').map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / DIA_MS);
}
function listaDeDias(desde, hasta) {
  const lista = [];
  for (let c = desde; c <= hasta && lista.length < MAX_DIAS; c = sumarDias(c, 1)) lista.push(c);
  return lista;
}
const esDiaValido = t => typeof t === 'string' && PATRON_DIA.test(t) && !Number.isNaN(Date.parse(t + 'T00:00:00Z')) &&
  new Date(t + 'T00:00:00Z').toISOString().slice(0, 10) === t;

// Rango pedido (?desde=&hasta=) → { desde, hasta, dias } siempre válido: hasta ≤ hoy, desde ≤ hasta y a lo más 731 días.
// Sin parámetros: los últimos 30 días. `primerDia` (opcional) sirve para el rango «todo».
function resolverRango({ desde, hasta, ahora = new Date(), primerDia = null } = {}) {
  const hoy = hoyMx(ahora);
  let fin = esDiaValido(hasta) ? hasta : hoy;
  if (fin > hoy) fin = hoy;
  let ini;
  if (esDiaValido(desde)) ini = desde;
  else if (desde === 'todo') ini = primerDia && esDiaValido(primerDia) ? primerDia : sumarDias(fin, -364);
  else ini = sumarDias(fin, -29);
  if (ini > fin) ini = fin;
  if (diasEntre(ini, fin) + 1 > MAX_DIAS) ini = sumarDias(fin, -(MAX_DIAS - 1));
  return { desde: ini, hasta: fin, dias: diasEntre(ini, fin) + 1 };
}

// Serie diaria con ceros: fechas = lista de Date (o null); devuelve [{ dia, n }]
function serieDiaria(fechas, desde, hasta) {
  const cuenta = new Map(listaDeDias(desde, hasta).map(d => [d, 0]));
  let total = 0;
  for (const f of fechas) {
    if (!f) continue;
    const d = diaMexico(f);
    if (cuenta.has(d)) { cuenta.set(d, cuenta.get(d) + 1); total += 1; }
  }
  return { serie: [...cuenta].map(([dia, n]) => ({ dia, n })), total };
}

function contarEnRango(fechas, desde, hasta) {
  let n = 0;
  for (const f of fechas) { if (f) { const d = diaMexico(f); if (d >= desde && d <= hasta) n += 1; } }
  return n;
}

const tituloDe = (cursos, id) => (cursos instanceof Map ? cursos.get(id) : null) || String(id).slice(0, 80);

function topCursos(mapaConteo, cursos, limite = 8) {
  return [...mapaConteo].map(([cursoId, n]) => ({ cursoId, curso: tituloDe(cursos, cursoId), n }))
    .sort((a, b) => b.n - a.n || a.curso.localeCompare(b.curso, 'es')).slice(0, limite);
}

// ── Métricas ──
//  miembros / certificados / retos / pruebas: [{ id, data }] tal como salen de Firestore
//  progreso: [{ uid, cursoId, data }] (avance por curso) · cursos: Map(id → título)
//  visitas: null (contador apagado) o [{ id: 'AAAA-MM-DD', data: { total, paginas } }]
function construirMetricas({ miembros = [], certificados = [], retos = [], pruebas = [], progreso = [], cursos = new Map(), visitas = null, visitasActivo = false, rango, ahora = new Date(), tieneAcceso }) {
  const { desde, hasta } = rango;
  const dias = listaDeDias(desde, hasta).length;
  const previoHasta = sumarDias(desde, -1);
  const previoDesde = sumarDias(previoHasta, -(dias - 1));

  const vistas = miembros.map(({ id, data }) => {
    const m = data || {};
    return { id, m, ...clasificarMiembro(m, tieneAcceso), registro: aFecha(m.createdAt), esAdmin: m.role === 'admin' };
  });
  const personas = vistas.filter(v => !v.esAdmin);

  // Altas
  const fechasAltas = personas.map(v => v.registro);
  const altas = serieDiaria(fechasAltas, desde, hasta);
  // Pruebas elegidas
  const fechasPruebas = pruebas.map(({ data }) => aFecha(data && data.elegidoEn));
  const pruebasSerie = serieDiaria(fechasPruebas, desde, hasta);
  // Certificados emitidos (solo los que el servidor firmó o el equipo emitió; los marcados no verificados no cuentan)
  const certsValidos = certificados.filter(({ data }) => data && data.verificado !== false);
  const fechasCerts = certsValidos.map(({ data }) => aFecha(data.emitido || data.issuedAt));
  const certsSerie = serieDiaria(fechasCerts, desde, hasta);
  // Pagos (último pago de cada miembro)
  const fechasPagos = personas.map(v => aFecha(v.m.ultimoPago));
  const pagosSerie = serieDiaria(fechasPagos, desde, hasta);

  const anterior = {
    desde: previoDesde, hasta: previoHasta,
    altas: contarEnRango(fechasAltas, previoDesde, previoHasta),
    pruebas: contarEnRango(fechasPruebas, previoDesde, previoHasta),
    certificados: contarEnRango(fechasCerts, previoDesde, previoHasta),
    pagos: contarEnRango(fechasPagos, previoDesde, previoHasta)
  };

  // Cuentas hoy
  const porEstado = Object.fromEntries(Object.values(ESTADOS).map(e => [e, 0]));
  for (const v of personas) porEstado[v.estado] += 1;
  const huboPlan = v => !pruebaGratuita.nuncaHaTenidoPlan(v.m, null);
  const conPlanAlgunaVez = personas.filter(huboPlan).length;
  const conAccesoHoy = personas.filter(v => v.conAcceso).length;
  const sinAccesoConPlan = personas.filter(v => huboPlan(v) && !v.conAcceso).length;
  const cuentas = {
    total: personas.length,
    activos: porEstado[ESTADOS.ACTIVO], cancelados: porEstado[ESTADOS.CANCELADO_VIGENTE],
    pagoPendiente: porEstado[ESTADOS.PAGO_PENDIENTE], vencidos: porEstado[ESTADOS.VENCIDO], sinMembresia: porEstado[ESTADOS.SIN_PLAN],
    conAccesoHoy, conPlanAlgunaVez, sinAccesoConPlan,
    retencion: conPlanAlgunaVez ? Math.round((conAccesoHoy / conPlanAlgunaVez) * 100) : null
  };

  // Cohortes por mes de registro (últimos 12 meses con registros)
  const porMes = new Map();
  for (const v of personas) {
    if (!v.registro) continue;
    const mes = diaMexico(v.registro).slice(0, 7);
    const fila = porMes.get(mes) || { mes, registrados: 0, conPlanAlgunaVez: 0, conAccesoHoy: 0 };
    fila.registrados += 1;
    if (huboPlan(v)) fila.conPlanAlgunaVez += 1;
    if (v.conAcceso) fila.conAccesoHoy += 1;
    porMes.set(mes, fila);
  }
  const cohortes = [...porMes.values()].sort((a, b) => (a.mes < b.mes ? 1 : -1)).slice(0, 12).reverse()
    .map(f => ({ ...f, conversion: f.registrados ? Math.round((f.conPlanAlgunaVez / f.registrados) * 100) : null,
      retencion: f.conPlanAlgunaVez ? Math.round((f.conAccesoHoy / f.conPlanAlgunaVez) * 100) : null }));

  // Prueba gratuita → miembro
  const porUid = new Map(vistas.map(v => [v.id, v]));
  const eleccionesRango = pruebas.filter(({ data }) => {
    const f = aFecha(data && data.elegidoEn);
    if (!f) return false;
    const d = diaMexico(f);
    return d >= desde && d <= hasta;
  });
  const convertidosRango = eleccionesRango.filter(({ id, data }) => {
    const v = porUid.get(String((data && data.uid) || id));
    return v && huboPlan(v);
  }).length;
  const eleccionesTotal = pruebas.length;
  const convertidosTotal = pruebas.filter(({ id, data }) => {
    const v = porUid.get(String((data && data.uid) || id));
    return v && huboPlan(v);
  }).length;
  const conversion = {
    eligieronRango: eleccionesRango.length, seHicieronMiembroRango: convertidosRango,
    tasaRango: eleccionesRango.length ? Math.round((convertidosRango / eleccionesRango.length) * 100) : null,
    eligieronTotal: eleccionesTotal, seHicieronMiembroTotal: convertidosTotal,
    tasaTotal: eleccionesTotal ? Math.round((convertidosTotal / eleccionesTotal) * 100) : null
  };

  // Cursos
  const elegidos = new Map();
  for (const { data } of pruebas) { const c = String((data && data.cursoId) || ''); if (c) elegidos.set(c, (elegidos.get(c) || 0) + 1); }
  const completadosCert = new Map();
  for (const { data } of certsValidos) { const c = String(data.courseId || data.cursoId || ''); if (c) completadosCert.set(c, (completadosCert.get(c) || 0) + 1); }
  const empezados = new Map(); const completadosProg = new Map();
  for (const p of progreso) {
    const d = p.data || {};
    const vistasN = Array.isArray(d.sesionesVistas) ? d.sesionesVistas.length : 0;
    if (vistasN > 0 || d.completado === true) empezados.set(p.cursoId, (empezados.get(p.cursoId) || 0) + 1);
    if (d.completado === true) completadosProg.set(p.cursoId, (completadosProg.get(p.cursoId) || 0) + 1);
  }
  // Los completados salen de los certificados firmados; si un curso solo tiene el avance, se toma el avance
  const completados = new Map(completadosCert);
  for (const [c, n] of completadosProg) if (!completados.has(c) || completados.get(c) < n) completados.set(c, n);

  // Retos y XP
  let xpTotal = 0; let superados = 0; let conActividad = 0;
  const bandas = { '0': 0, '1 a 99': 0, '100 a 499': 0, '500 o más': 0 };
  const actividadSemanal = new Map();
  for (const { data } of retos) {
    const d = data || {};
    const x = Number.isFinite(d.xp) ? d.xp : 0; const s = Number.isFinite(d.superados) ? d.superados : 0;
    xpTotal += x; superados += s;
    if (x > 0 || s > 0) conActividad += 1;
    bandas[x <= 0 ? '0' : x < 100 ? '1 a 99' : x < 500 ? '100 a 499' : '500 o más'] += 1;
    const f = aFecha(d.actualizadoEn);
    if (f) { const dia = diaMexico(f); if (dia >= desde && dia <= hasta) actividadSemanal.set(dia, (actividadSemanal.get(dia) || 0) + 1); }
  }
  const actividadRetos = listaDeDias(desde, hasta).map(dia => ({ dia, n: actividadSemanal.get(dia) || 0 }));

  // Visitas (solo si el contador está encendido)
  let visitasBloque = { activo: Boolean(visitasActivo), total: 0, porDia: [], porPagina: [] };
  if (visitas) {
    const porDia = new Map(listaDeDias(desde, hasta).map(d => [d, 0]));
    const porPagina = new Map();
    let total = 0;
    for (const { id, data } of visitas) {
      if (!porDia.has(id)) continue;
      const n = Number(data && data.total) || 0;
      porDia.set(id, n); total += n;
      if (esObjeto(data && data.paginas)) for (const [p, c] of Object.entries(data.paginas)) porPagina.set(p, (porPagina.get(p) || 0) + (Number(c) || 0));
    }
    visitasBloque = {
      activo: Boolean(visitasActivo), total,
      porDia: [...porDia].map(([dia, n]) => ({ dia, n })),
      porPagina: [...porPagina].map(([pagina, n]) => ({ pagina, n })).sort((a, b) => b.n - a.n).slice(0, 10)
    };
  }

  return {
    rango: { desde, hasta, dias },
    totales: { altas: altas.total, pruebas: pruebasSerie.total, certificados: certsSerie.total, pagos: pagosSerie.total },
    anterior,
    series: { altas: altas.serie, pruebas: pruebasSerie.serie, certificados: certsSerie.serie, pagos: pagosSerie.serie },
    cuentas, cohortes, conversion,
    cursos: {
      masElegidos: topCursos(elegidos, cursos), masCompletados: topCursos(completados, cursos), masEmpezados: topCursos(empezados, cursos)
    },
    retos: {
      personas: retos.length, conActividad, retosSuperados: superados, xpTotal,
      xpPromedio: conActividad ? Math.round(xpTotal / conActividad) : 0,
      bandas: Object.entries(bandas).map(([banda, n]) => ({ banda, n })),
      actividadPorDia: actividadRetos
    },
    visitas: visitasBloque,
    notas: {
      pagos: 'Cuenta el último pago de cada miembro, no cada cobro: no hay libro de cobros.',
      retencion: 'De quienes alguna vez tuvieron plan, cuántos tienen acceso hoy.',
      retos: 'Los retos no guardan una fecha por intento: la actividad por día usa la última vez que cada persona jugó.'
    }
  };
}

// ── Pruebas gratuitas ──
//  pruebas: [{ id, data }] de pruebasGratuitas · miembros: Map(uid → { data }) · progreso: Map("uid|cursoId" → data)
//  cursos: Map(id → { titulo, clases }) · sinElegir: lista ya calculada de miembros elegibles sin elegir
function construirPruebas({ pruebas = [], miembros = new Map(), progreso = new Map(), cursos = new Map(), tieneAcceso, ahora = new Date() }) {
  const filas = [];
  for (const { id, data } of pruebas) {
    const d = data || {};
    const uid = String(d.uid || id);
    const cursoId = String(d.cursoId || '');
    const m = miembros.get(uid) || null;
    const curso = cursos.get(cursoId) || null;
    const clases = curso ? curso.clases : 0;
    const p = progreso.get(`${uid}|${cursoId}`) || null;
    const vistas = p && Array.isArray(p.sesionesVistas) ? new Set(p.sesionesVistas).size : 0;
    const gratis = clases > 1 ? clases - 1 : 0; // la prueba abre todas las clases menos la última
    const vistaM = m ? clasificarMiembro(m, tieneAcceso) : null;
    const huboPlan = m ? !pruebaGratuita.nuncaHaTenidoPlan(m, null) : false;
    filas.push({
      uid,
      nombre: m ? String(m.name || m.displayName || '').slice(0, 120) : '',
      correo: m ? String(m.email || '').slice(0, 160) : '',
      cursoId, curso: curso ? curso.titulo : (cursoId || 'Curso que ya no existe'),
      elegidoEn: aIso(d.elegidoEn),
      clases, clasesGratis: gratis, clasesVistas: vistas,
      avance: gratis ? Math.min(100, Math.round((Math.min(vistas, gratis) / gratis) * 100)) : null,
      terminoGratis: gratis > 0 && vistas >= gratis,
      completo: Boolean(p && p.completado === true),
      yaMiembro: huboPlan,
      conAcceso: Boolean(vistaM && vistaM.conAcceso),
      cuentaExiste: Boolean(m)
    });
  }
  filas.sort((a, b) => (a.elegidoEn && b.elegidoEn ? (a.elegidoEn < b.elegidoEn ? 1 : -1) : (a.elegidoEn ? -1 : 1)));

  const porCurso = new Map();
  for (const f of filas) {
    const fila = porCurso.get(f.cursoId) || { cursoId: f.cursoId, curso: f.curso, elegidas: 0, terminaronGratis: 0, seHicieronMiembro: 0 };
    fila.elegidas += 1;
    if (f.terminoGratis) fila.terminaronGratis += 1;
    if (f.yaMiembro) fila.seHicieronMiembro += 1;
    porCurso.set(f.cursoId, fila);
  }
  const totales = {
    elegidas: filas.length,
    terminaronGratis: filas.filter(f => f.terminoGratis).length,
    seHicieronMiembro: filas.filter(f => f.yaMiembro).length,
    conAcceso: filas.filter(f => f.conAcceso).length
  };
  totales.tasaMiembro = totales.elegidas ? Math.round((totales.seHicieronMiembro / totales.elegidas) * 100) : null;
  totales.tasaTerminaron = totales.elegidas ? Math.round((totales.terminaronGratis / totales.elegidas) * 100) : null;
  return {
    filas, totales,
    porCurso: [...porCurso.values()].sort((a, b) => b.elegidas - a.elegidas || a.curso.localeCompare(b.curso, 'es')),
    generado: ahora.toISOString()
  };
}

// Miembros que todavía pueden elegir y no lo han hecho: sin plan nunca, sin elección, no administradores.
function calcularSinElegir({ miembros = [], eleccionesUids = new Set(), limite = 100 }) {
  const lista = [];
  for (const { id, data } of miembros) {
    const m = data || {};
    if (m.role === 'admin' || eleccionesUids.has(id)) continue;
    if (!pruebaGratuita.nuncaHaTenidoPlan(m, null)) continue;
    const registro = aFecha(m.createdAt);
    lista.push({ uid: id, nombre: String(m.name || m.displayName || '').slice(0, 120), correo: String(m.email || '').slice(0, 160), registro: registro ? registro.toISOString() : null });
  }
  lista.sort((a, b) => (a.registro && b.registro ? (a.registro < b.registro ? 1 : -1) : (a.registro ? -1 : 1)));
  return { total: lista.length, lista: lista.slice(0, limite) };
}

module.exports = {
  MAX_DIAS, esDiaValido, sumarDias, diasEntre, listaDeDias, resolverRango, serieDiaria,
  construirMetricas, construirPruebas, calcularSinElegir
};
