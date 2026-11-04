'use strict';

// ══ MOTIVOS DE RECHAZO DE UN COBRO ═══════════════════════════════
// Módulo PURO (sin red, sin Firestore): toma lo que Stripe dice de un cobro rechazado, se queda SOLO con lo que sirve para explicarlo y lo
// traduce a español claro, con «Qué significa», «Qué hacer» y una categoría para agrupar.
//
// Lo que se guarda de Stripe (extraerMotivo): código del error, código de rechazo del banco, tipo, mensaje (recortado a 200 letras y sin
// números largos), razón del resultado del cargo, estado en la red y cuándo vuelve a intentar Stripe. NUNCA se guarda nada de la tarjeta:
// ni número, ni últimos 4, ni vencimiento, ni nombre del banco, ni nombre del titular, ni dirección. Lo demás del objeto de Stripe se tira.
// Lo que se muestra (traducir): solo texto en español de esta tabla; el mensaje en inglés de Stripe nunca sale del servidor.

const CATEGORIAS = Object.freeze({
  fondos: 'Fondos insuficientes',
  tarjeta: 'Problema con la tarjeta',
  seguridad: 'Seguridad o posible fraude',
  banco: 'Decisión del banco',
  verificacion: 'Verificación del banco',
  otro: 'Otro motivo'
});

const ORDEN_CATEGORIAS = Object.freeze(['fondos', 'tarjeta', 'banco', 'verificacion', 'seguridad', 'otro']);

const m = (categoria, texto, significa, queHacer) => Object.freeze({ categoria, texto, significa, queHacer });

const BANCO_SIN_DETALLE = m('banco', 'El banco rechazó el cobro sin dar detalle',
  'El banco de la tarjeta dijo que no, pero no explicó el motivo.',
  'Pídele que pruebe con otra tarjeta o que contacte a su banco para autorizar el cobro.');
const BANCO_NO_AUTORIZO = m('banco', 'El banco no autorizó el cobro',
  'El banco decidió no aprobar este cobro, sin decir por qué.',
  'Pídele que llame a su banco para autorizar el cobro o que pruebe con otra tarjeta.');
const BLOQUEO = m('seguridad', 'El banco bloqueó la tarjeta por seguridad',
  'La tarjeta está bloqueada, reportada o restringida por el banco, así que no acepta cobros.',
  'Pídele que contacte a su banco para desbloquearla o que use otra tarjeta.');
const FRAUDE = m('seguridad', 'Marcado como posible fraude por el banco o Stripe',
  'El banco o el sistema de seguridad de Stripe consideró que el cobro podía ser sospechoso y lo frenó.',
  'Confirma que la persona es real y pídele que pruebe con otra tarjeta o que hable con su banco. Si la conoces, revisa el pago en Stripe.');
const VERIFICACION = m('verificacion', 'No se completó la verificación del banco',
  'El banco pidió confirmar el cobro (3D Secure) y la persona no lo completó o no pudo.',
  'Escríbele para que repita el pago y apruebe la verificación en la app de su banco.');
const FALLA_TEMPORAL = m('banco', 'Falla temporal del banco o de la red',
  'El banco o la red no pudieron procesar el cobro en ese momento; no es un problema de la persona.',
  'No hace falta hacer nada todavía: Stripe vuelve a intentar el cobro. Si se repite, pídele que pruebe con otra tarjeta.');

// Cada código de Stripe (error de pago, rechazo del banco o falla del cargo) -> su explicación
const TABLA = Object.freeze({
  insufficient_funds: m('fondos', 'Fondos insuficientes',
    'La tarjeta no tenía saldo o crédito disponible para este cobro.',
    'Escríbele para que revise su saldo o use otra tarjeta; Stripe vuelve a intentar el cobro en los días siguientes.'),
  card_declined: BANCO_SIN_DETALLE,
  generic_decline: BANCO_SIN_DETALLE,
  do_not_honor: BANCO_NO_AUTORIZO,
  no_action_taken: BANCO_NO_AUTORIZO,
  expired_card: m('tarjeta', 'Tarjeta vencida',
    'La fecha de vencimiento de la tarjeta ya pasó.',
    'Pídele que actualice su tarjeta en el portal de pago o que use otra vigente.'),
  incorrect_cvc: m('tarjeta', 'CVC incorrecto',
    'El código de seguridad de la tarjeta (los 3 o 4 dígitos de atrás) no coincide.',
    'Pídele que vuelva a escribir los datos de su tarjeta con cuidado.'),
  invalid_cvc: m('tarjeta', 'CVC incorrecto',
    'El código de seguridad de la tarjeta (los 3 o 4 dígitos de atrás) no es válido.',
    'Pídele que vuelva a escribir los datos de su tarjeta con cuidado.'),
  incorrect_number: m('tarjeta', 'Número de tarjeta incorrecto',
    'El número de la tarjeta no es correcto.',
    'Pídele que vuelva a escribir el número de su tarjeta o que pruebe con otra.'),
  invalid_number: m('tarjeta', 'Número de tarjeta incorrecto',
    'El número de la tarjeta no es válido.',
    'Pídele que vuelva a escribir el número de su tarjeta o que pruebe con otra.'),
  invalid_expiry_month: m('tarjeta', 'Fecha de vencimiento incorrecta',
    'El mes de vencimiento de la tarjeta no es válido.',
    'Pídele que revise la fecha de vencimiento de su tarjeta y la escriba otra vez.'),
  invalid_expiry_year: m('tarjeta', 'Fecha de vencimiento incorrecta',
    'El año de vencimiento de la tarjeta no es válido.',
    'Pídele que revise la fecha de vencimiento de su tarjeta y la escriba otra vez.'),
  incorrect_zip: m('tarjeta', 'Código postal incorrecto',
    'El código postal no coincide con el que tiene el banco.',
    'Pídele que revise el código postal de su tarjeta o que pruebe con otra.'),
  card_not_supported: m('tarjeta', 'Tarjeta no compatible',
    'Este tipo de tarjeta no sirve para pagos de suscripción.',
    'Pídele que use otra tarjeta de crédito o débito.'),
  lost_card: BLOQUEO,
  stolen_card: BLOQUEO,
  pickup_card: BLOQUEO,
  restricted_card: BLOQUEO,
  security_violation: BLOQUEO,
  fraudulent: FRAUDE,
  merchant_blacklist: FRAUDE,
  highest_risk_level: FRAUDE,
  elevated_risk_level: FRAUDE,
  authentication_required: VERIFICACION,
  authentication_not_handled: VERIFICACION,
  authentication_failure: VERIFICACION,
  payment_intent_authentication_failure: VERIFICACION,
  card_velocity_exceeded: m('banco', 'La tarjeta superó su límite de uso',
    'Se alcanzó el límite de compras o de dinero que el banco permite en cierto tiempo.',
    'Pídele que contacte a su banco para subir el límite o que pruebe con otra tarjeta.'),
  withdrawal_count_limit_exceeded: m('banco', 'La tarjeta superó su límite de uso',
    'Se alcanzó el límite de operaciones que el banco permite en cierto tiempo.',
    'Pídele que contacte a su banco para subir el límite o que pruebe con otra tarjeta.'),
  transaction_not_allowed: m('banco', 'El banco no permite este tipo de cobro',
    'La tarjeta no está habilitada para pagos en línea o recurrentes.',
    'Pídele que active los pagos en línea con su banco o que use otra tarjeta.'),
  service_not_allowed: m('banco', 'El banco no permite este tipo de cobro',
    'La tarjeta no está habilitada para este servicio.',
    'Pídele que consulte a su banco o que use otra tarjeta.'),
  currency_not_supported: m('banco', 'La tarjeta no acepta cobros en pesos mexicanos',
    'El banco no permite cobros en esta moneda con esta tarjeta.',
    'Pídele que use otra tarjeta o que pregunte a su banco por los pagos en pesos mexicanos.'),
  call_issuer: m('banco', 'El banco pide que el titular lo llame',
    'El banco no aprobó el cobro por una razón que solo puede explicar a la persona dueña de la tarjeta.',
    'Pídele que llame a su banco para autorizar el cobro y después que lo intente de nuevo.'),
  try_again_later: FALLA_TEMPORAL,
  issuer_not_available: FALLA_TEMPORAL,
  processing_error: FALLA_TEMPORAL,
  reenter_transaction: FALLA_TEMPORAL,
  testmode_decline: m('otro', 'Tarjeta de prueba rechazada',
    'Se usó una tarjeta de prueba de Stripe que siempre es rechazada.',
    'Si es un cobro real, avisa al equipo técnico; si es una prueba, no hay nada que hacer.')
});

// Códigos que dicen poco: si hay uno más específico, gana el específico
const GENERICOS = new Set(['card_declined', 'generic_decline', 'do_not_honor', 'no_action_taken']);

const SEGURO = /^[a-z0-9_.:-]{1,80}$/i;
const codigoSeguro = v => (typeof v === 'string' && SEGURO.test(v.trim()) ? v.trim().toLowerCase() : '');

// Quita de un mensaje de Stripe cualquier cosa que parezca un dato de tarjeta (números largos, «terminada en ...», fechas de vencimiento)
// y lo recorta. Solo se guarda como apoyo para el equipo técnico; el panel nunca lo muestra.
function limpiarMensaje(texto) {
  if (typeof texto !== 'string') return '';
  return texto
    .replace(/\b(?:ending|terminad[ao]|que termina)\s+(?:in|en)?\s*\d{2,}\b/gi, 'terminada en ···')
    .replace(/\d[\d\s-]{2,}\d/g, '···')
    .replace(/\b\d{3,}\b/g, '···')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

const entero = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);

// invoice: la factura de Stripe · pi: su PaymentIntent (con last_payment_error) · cargo: el último cargo del intento (con failure_code y outcome).
// Devuelve el objeto que se guarda en el documento (o null si Stripe no dio ningún dato útil).
function extraerMotivo(invoice, pi, cargo) {
  const err = (pi && pi.last_payment_error) || {};
  const salida = (cargo && cargo.outcome) || {};
  const motivo = {
    codigo: codigoSeguro(err.code) || codigoSeguro(cargo && cargo.failure_code),
    declineCodigo: codigoSeguro(err.decline_code),
    tipo: codigoSeguro(err.type),
    razonStripe: codigoSeguro(salida.reason),
    redEstado: codigoSeguro(salida.network_status),
    mensajeStripe: limpiarMensaje(err.message || (cargo && cargo.failure_message) || salida.seller_message || ''),
    reintentoMs: invoice && Number(invoice.next_payment_attempt) > 0 ? Number(invoice.next_payment_attempt) * 1000 : null
  };
  const hayAlgo = motivo.codigo || motivo.declineCodigo || motivo.tipo || motivo.razonStripe || motivo.mensajeStripe;
  return hayAlgo ? motivo : null;
}

// Lo que Stripe dijo del último intento: cuántos intentos van y cuándo fue el último (si lo sabe)
function datosIntento(invoice, cargo, ahoraMs) {
  const creado = cargo && Number(cargo.created) > 0 ? Number(cargo.created) * 1000 : null;
  return { intentos: entero(invoice && invoice.attempt_count), ultimoIntentoMs: creado || ahoraMs || null };
}

// Elige el código que mejor explica el rechazo: el del banco (decline_code), la razón del resultado, el del cargo y el del error; el específico gana al genérico
function codigoPrincipal(motivo) {
  const candidatos = [motivo.declineCodigo, motivo.razonStripe, motivo.codigo].filter(Boolean);
  const conocidos = candidatos.filter(c => TABLA[c]);
  const especifico = conocidos.find(c => !GENERICOS.has(c));
  return especifico || conocidos[0] || candidatos[0] || '';
}

// motivo guardado -> { texto, significa, queHacer, categoria, codigo } (solo español) o null si no hay motivo guardado
function traducir(motivo) {
  if (!motivo || typeof motivo !== 'object') return null;
  const codigo = codigoPrincipal({
    declineCodigo: codigoSeguro(motivo.declineCodigo), razonStripe: codigoSeguro(motivo.razonStripe), codigo: codigoSeguro(motivo.codigo)
  });
  if (!codigo && !motivo.tipo && !motivo.mensajeStripe) return null;
  const fila = TABLA[codigo];
  if (fila) return { texto: fila.texto, significa: fila.significa, queHacer: fila.queHacer, categoria: fila.categoria, codigo };
  // Un código que no está en la tabla (o ninguno): se dice con claridad y se deja el código para el equipo técnico
  if (motivo.tipo === 'authentication_error') return { ...VERIFICACION, codigo: codigo || 'authentication_error' };
  const cod = codigo || codigoSeguro(motivo.tipo) || 'sin_codigo';
  return {
    texto: 'El banco rechazó el cobro (código: ' + cod + ')',
    significa: 'Stripe informó un motivo que todavía no tenemos traducido.',
    queHacer: 'Pídele que pruebe con otra tarjeta o que contacte a su banco; si se repite, revisa este cobro en Stripe.',
    categoria: 'otro', codigo: cod
  };
}

// Agrupa los cobros rechazados (filas públicas) por categoría y por motivo, para la gráfica «Por qué se rechazan los cobros».
// Devuelve { total, conMotivo, sinMotivo, categorias: [{ clave, nombre, n, pct, motivos: [{ texto, n }] }] } (de más a menos)
function agruparPorMotivo(filas) {
  const rechazados = (Array.isArray(filas) ? filas : []).filter(f => f && f.estado === 'fallido');
  const grupos = new Map();
  let conMotivo = 0;
  for (const f of rechazados) {
    if (!f.motivo || !f.motivo.categoria) continue;
    conMotivo++;
    const g = grupos.get(f.motivo.categoria) || { clave: f.motivo.categoria, nombre: CATEGORIAS[f.motivo.categoria] || CATEGORIAS.otro, n: 0, motivos: new Map() };
    g.n++; g.motivos.set(f.motivo.texto, (g.motivos.get(f.motivo.texto) || 0) + 1);
    grupos.set(f.motivo.categoria, g);
  }
  const categorias = [...grupos.values()].map(g => ({
    clave: g.clave, nombre: g.nombre, n: g.n, pct: conMotivo ? Math.round(g.n / conMotivo * 100) : 0,
    motivos: [...g.motivos.entries()].map(([texto, n]) => ({ texto, n })).sort((a, b) => b.n - a.n || a.texto.localeCompare(b.texto, 'es'))
  })).sort((a, b) => b.n - a.n || ORDEN_CATEGORIAS.indexOf(a.clave) - ORDEN_CATEGORIAS.indexOf(b.clave));
  return { total: rechazados.length, conMotivo, sinMotivo: rechazados.length - conMotivo, categorias };
}

module.exports = { CATEGORIAS, ORDEN_CATEGORIAS, TABLA, GENERICOS, limpiarMensaje, extraerMotivo, datosIntento, codigoPrincipal, traducir, agruparPorMotivo };
