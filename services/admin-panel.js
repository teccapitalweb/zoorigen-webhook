'use strict';

// ══ PANEL DE ADMINISTRACIÓN · reglas puras (sin red ni Firebase) ══
// Aquí vive todo lo que el panel calcula con los datos que lee rutas-admin.js: estado de cada miembro, resumen,
// series semanales y mensuales, y el recorte de datos personales. Se prueba en test/admin-panel.test.js.
//
// Principios:
//  - Lo que sale hacia el navegador es lo MÍNIMO para administrar (nombre, correo, estado del plan). Nunca ids de
//    Stripe, tokens, firmas ni datos de pago completos.
//  - Ninguna cifra se inventa: si no hay datos, se devuelve 0 o null y el panel lo muestra como vacío.
//  - Los ingresos son una ESTIMACIÓN (último pago de cada miembro x precio de lista) y así se rotulan.

const DIA_MS = 86400000;
const OFFSET_MEXICO_MS = 6 * 3600 * 1000; // México sin horario de verano (UTC-6), igual que logros.js

// Precios de lista del Club (los mismos que muestra club-suscripcion.html). Sirven solo para la estimación.
const PRECIOS_LISTA_MXN = Object.freeze({ mensual: 199, anual: 1899 });

const ESTADOS = Object.freeze({
  ACTIVO: 'activo',
  CANCELADO_VIGENTE: 'cancelado-vigente',
  PAGO_PENDIENTE: 'pago-pendiente',
  VENCIDO: 'vencido',
  SIN_PLAN: 'sin-plan'
});

const ETIQUETAS_ESTADO = Object.freeze({
  [ESTADOS.ACTIVO]: 'Activo',
  [ESTADOS.CANCELADO_VIGENTE]: 'Cancelado con acceso vigente',
  [ESTADOS.PAGO_PENDIENTE]: 'Pago pendiente',
  [ESTADOS.VENCIDO]: 'Vencido',
  [ESTADOS.SIN_PLAN]: 'Sin membresía'
});

// ── Fechas ──
// Acepta Timestamp de Firestore, { seconds }, Date, número (ms) y texto ISO. Devuelve Date o null.
function aFecha(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  let d = null;
  if (valor instanceof Date) d = valor;
  else if (typeof valor.toDate === 'function') { try { d = valor.toDate(); } catch (_) { d = null; } }
  else if (typeof valor === 'object' && typeof valor.seconds === 'number') d = new Date(valor.seconds * 1000);
  else if (typeof valor === 'number' && Number.isFinite(valor)) d = new Date(valor);
  else if (typeof valor === 'string') d = new Date(valor);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

const aIso = valor => { const d = aFecha(valor); return d ? d.toISOString() : null; };
const diaMexico = (fecha) => new Date(fecha.getTime() - OFFSET_MEXICO_MS).toISOString().slice(0, 10);
const mesMexico = (fecha) => diaMexico(fecha).slice(0, 7);

// ── Clasificación de un miembro ──
function origenPlan(m = {}) {
  if (m.stripeSubscriptionId) return 'stripe';
  if (m.activadoManualmente) return 'manual';
  if (m.shopifyOrderId || m.viaShopify) return 'heredado';
  return (m.planVence || m.ultimoPago) ? 'otro' : 'ninguno';
}

const COBRO_FALLIDO = ['past_due', 'unpaid', 'incomplete'];

// tieneAcceso: la MISMA regla del servidor (tieneAccesoVigente en server.js), inyectada para no duplicarla.
function clasificarMiembro(m = {}, tieneAcceso) {
  const conAcceso = Boolean(tieneAcceso(m));
  const cancelado = m.planCancelado === true || m.planStatus === 'cancelled_active' || m.planStatus === 'cancelled';
  if (conAcceso) return { estado: cancelado ? ESTADOS.CANCELADO_VIGENTE : ESTADOS.ACTIVO, conAcceso: true };
  if (COBRO_FALLIDO.includes(m.stripeSubscriptionStatus) || COBRO_FALLIDO.includes(m.planStatus) || m.planStatus === 'pending_payment') {
    return { estado: ESTADOS.PAGO_PENDIENTE, conAcceso: false };
  }
  if (m.planTipo || m.planVence || m.ultimoPago || m.planStatus === 'expired') return { estado: ESTADOS.VENCIDO, conAcceso: false };
  return { estado: ESTADOS.SIN_PLAN, conAcceso: false };
}

function numeroMonto(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) return valor;
  if (typeof valor === 'string') {
    const n = Number(valor.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Vista MÍNIMA para la tabla de miembros. No lleva teléfono, ids de Stripe ni datos de pago.
function vistaMiembro(id, m = {}, tieneAcceso) {
  const { estado, conAcceso } = clasificarMiembro(m, tieneAcceso);
  const registro = aFecha(m.createdAt);
  return {
    uid: id,
    nombre: String(m.name || m.displayName || '').slice(0, 120),
    correo: String(m.email || '').slice(0, 160),
    esAdmin: m.role === 'admin',
    estado,
    conAcceso,
    planTipo: m.planTipo === 'anual' ? 'anual' : (m.planTipo === 'mensual' ? 'mensual' : null),
    origen: origenPlan(m),
    vence: aIso(m.planVence || m.fechaExpiracion),
    ultimoPago: aIso(m.ultimoPago),
    registro: registro ? registro.toISOString() : null
  };
}

// Ficha completa de una persona (solo para el detalle). Aun aquí: sin ids de Stripe ni firmas.
function fichaMiembro(id, m = {}, tieneAcceso) {
  const base = vistaMiembro(id, m, tieneAcceso);
  return {
    ...base,
    telefono: String(m.phone || '').slice(0, 40),
    inicioPlan: aIso(m.planInicio),
    cancelacion: aIso(m.canceladoEn),
    metodoPago: m.activadoManualmente ? String(m.metodoPago || 'Administración').slice(0, 60) : (m.stripeSubscriptionId ? 'Stripe' : null),
    montoManual: m.activadoManualmente ? numeroMonto(m.montoPagado) : null,
    activadoPor: m.activadoManualmente ? 'administración' : null,
    racha: Number.isFinite(m.streak) ? m.streak : 0
  };
}

// ── Resumen ──
function inicioDeSemana(ahora) { return new Date(ahora.getTime() - 7 * DIA_MS); }

// Última aparición del pago de un miembro valorada con el precio de lista (o el monto manual si lo hay).
function valorPago(m, tipoDeVista) {
  const monto = m.activadoManualmente ? numeroMonto(m.montoPagado) : null;
  if (monto !== null) return monto;
  return PRECIOS_LISTA_MXN[tipoDeVista] || 0;
}

// miembros: lista de { id, data } tal como salen de Firestore. Devuelve KPIs y series.
function construirResumen({ miembros, certificados = { total: 0, completados: 0 }, ahora = new Date(), tieneAcceso, diasVencePronto = 7, semanas = 12, meses = 6 }) {
  const vistas = miembros.map(({ id, data }) => ({ vista: vistaMiembro(id, data, tieneAcceso), data: data || {} }));
  const hoyMs = ahora.getTime();
  const haceSemana = inicioDeSemana(ahora).getTime();
  const k = {
    miembros: vistas.length, activos: 0, nuevosSemana: 0, vencenPronto: 0, sinMembresia: 0, pagoPendiente: 0,
    cancelados: 0, vencidos: 0, administradores: 0
  };
  const porEstado = Object.fromEntries(Object.values(ESTADOS).map(e => [e, 0]));
  const porOrigen = { stripe: 0, manual: 0, heredado: 0, otro: 0 };
  const porPlan = { mensual: 0, anual: 0, otro: 0 };
  const proximosVencimientos = [];

  for (const { vista } of vistas) {
    porEstado[vista.estado] += 1;
    if (vista.esAdmin) k.administradores += 1;
    if (vista.registro && new Date(vista.registro).getTime() >= haceSemana) k.nuevosSemana += 1;
    if (vista.conAcceso) {
      k.activos += 1;
      if (porOrigen[vista.origen] !== undefined) porOrigen[vista.origen] += 1;
      porPlan[vista.planTipo || 'otro'] += 1;
      if (vista.vence) {
        const dias = Math.ceil((new Date(vista.vence).getTime() - hoyMs) / DIA_MS);
        if (dias >= 0 && dias <= diasVencePronto) {
          k.vencenPronto += 1;
          proximosVencimientos.push({ uid: vista.uid, nombre: vista.nombre, correo: vista.correo, vence: vista.vence, dias, planTipo: vista.planTipo });
        }
      }
    }
  }
  proximosVencimientos.sort((a, b) => a.dias - b.dias);
  k.sinMembresia = porEstado[ESTADOS.SIN_PLAN];
  k.pagoPendiente = porEstado[ESTADOS.PAGO_PENDIENTE];
  k.cancelados = porEstado[ESTADOS.CANCELADO_VIGENTE];
  k.vencidos = porEstado[ESTADOS.VENCIDO];

  // Altas por semana: ventanas de 7 días que terminan hoy (la última es "esta semana").
  const altas = [];
  for (let i = semanas - 1; i >= 0; i--) {
    const hasta = hoyMs - i * 7 * DIA_MS;
    const desde = hasta - 7 * DIA_MS;
    let n = 0;
    for (const { vista } of vistas) {
      if (!vista.registro) continue;
      const t = new Date(vista.registro).getTime();
      if (t > desde && t <= hasta) n += 1;
    }
    altas.push({ desde: diaMexico(new Date(desde + 1)), n });
  }

  // Pagos por mes (último pago de cada miembro): estimación, no un libro contable.
  const mesesLista = [];
  for (let i = meses - 1; i >= 0; i--) {
    const f = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - i, 1));
    mesesLista.push(f.toISOString().slice(0, 7));
  }
  const porMes = new Map(mesesLista.map(m => [m, { mes: m, pagos: 0, estimado: 0 }]));
  for (const { vista, data } of vistas) {
    const f = aFecha(data.ultimoPago);
    if (!f) continue;
    const slot = porMes.get(mesMexico(f));
    if (!slot) continue;
    slot.pagos += 1;
    slot.estimado += valorPago(data, vista.planTipo);
  }
  const ingresosPorMes = mesesLista.map(m => porMes.get(m));
  const mesActual = ingresosPorMes[ingresosPorMes.length - 1];

  const hayDatosDePago = vistas.some(({ data }) => aFecha(data.ultimoPago));
  return {
    kpis: {
      ...k,
      certificadosEmitidos: certificados.total,
      cursosCompletados: certificados.completados,
      ingresosMesEstimado: hayDatosDePago ? mesActual.estimado : null,
      pagosMes: mesActual.pagos
    },
    porEstado, porOrigen, porPlan,
    altasSemanales: altas,
    ingresosMensuales: ingresosPorMes,
    proximosVencimientos: proximosVencimientos.slice(0, 10),
    notas: {
      ingresos: 'Estimación: último pago de cada miembro por el precio de lista (o el monto anotado en una activación manual). No es contabilidad.'
    }
  };
}

// ── Texto de apoyo ──
// Enmascara un correo para mostrarlo en la lista de administradores (nunca el correo completo).
function enmascararCorreo(correo) {
  const t = String(correo || '').trim().toLowerCase();
  const i = t.indexOf('@');
  if (i < 1) return '';
  const local = t.slice(0, i);
  return `${local[0]}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}${t.slice(i)}`;
}

// Quita correos, llaves y tokens de un texto antes de guardarlo o mostrarlo en la bitácora.
function limpiarTexto(texto, max = 300) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[correo]')
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]{6,}/g, '[clave]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ── Activación manual (mismos campos que escribía el panel anterior desde el navegador) ──
const TIPOS_ACTIVACION = Object.freeze(['mensual', 'anual', 'custom']);

// Valida el cuerpo de POST /api/admin/miembros/:uid/activar. Devuelve { error } o { datos }.
function validarActivacion(cuerpo) {
  const c = cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : null;
  if (!c) return { error: 'Faltan los datos de la activación' };
  const tipo = typeof c.tipo === 'string' ? c.tipo : '';
  if (!TIPOS_ACTIVACION.includes(tipo)) return { error: 'El tipo de plan no es válido' };
  let dias = tipo === 'anual' ? 365 : 30;
  if (tipo === 'custom') {
    const n = typeof c.dias === 'number' ? c.dias : (typeof c.dias === 'string' && /^[0-9]{1,4}$/.test(c.dias.trim()) ? Number(c.dias) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: 'Los días deben ser un número entero de 1 a 3650' };
    dias = n;
  }
  let metodo = '';
  if (c.metodo !== undefined && c.metodo !== null && c.metodo !== '') {
    if (typeof c.metodo !== 'string') return { error: 'El método de pago no es válido' };
    metodo = c.metodo.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
  }
  let monto = null;
  if (c.monto !== undefined && c.monto !== null && c.monto !== '') {
    monto = numeroMonto(c.monto);
    if (monto === null || monto > 100000) return { error: 'El monto no es válido' };
  }
  return { datos: { tipo, planTipo: tipo === 'custom' ? 'mensual' : tipo, dias, metodo: metodo || 'Administración', monto } };
}

module.exports = {
  PRECIOS_LISTA_MXN, ESTADOS, ETIQUETAS_ESTADO, aFecha, aIso, diaMexico, mesMexico, origenPlan, clasificarMiembro,
  vistaMiembro, fichaMiembro, construirResumen, enmascararCorreo, limpiarTexto, validarActivacion, numeroMonto
};
