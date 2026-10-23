'use strict';

// ══ REGISTRO DE PAGOS DE SUSCRIPCIÓN ═════════════════════════════
// Cada cobro de Stripe de Zoorigen queda como un documento en `pagos/{idDeLaFactura}`: monto, fecha, quién pagó, plan y si fue el primer pago,
// una renovación o un cobro rechazado. El administrador los lee en «Suscripciones y pagos». Reglas:
//  · Un cobro se guarda una sola vez: el mismo cobro que llega por el aviso de Stripe o por «Traer pagos desde Stripe» cae en el mismo documento
//    (el id es el de la factura). Un cobro pagado reemplaza a un rechazado de la misma factura (Stripe reintentó y cobró); nunca al revés.
//  · La cuenta de Stripe se comparte con otras marcas: solo se guardan las suscripciones de Zoorigen (esSuscripcionPropia).
//  · Registrar un pago NUNCA debe romper el aviso de Stripe: el webhook llama a registrarSeguro(), que atrapa cualquier error.
//  · La colección es solo del servidor (las reglas de Firestore no la listan): el panel la lee por GET /api/admin/pagos.

const COL_PAGOS = 'pagos';
const TOPE_LECTURA = 3000;
const MAX_SUSCRIPCIONES = 300;

const aMs = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return null; } }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const idDe = v => (typeof v === 'string' ? v : (v && v.id) || null);

// Datos de un cobro a partir de la factura de Stripe (montos en pesos; fecha real del cobro)
function datosPago(invoice, { estado, plan = 'otro', uid = '', nombre = '', ahora = Date.now(), subscriptionId = null }) {
  const pagado = estado === 'pagado';
  const pagadoEn = invoice.status_transitions && invoice.status_transitions.paid_at;
  const fechaMs = pagado
    ? (pagadoEn ? pagadoEn * 1000 : (Number(invoice.created) ? invoice.created * 1000 : ahora))
    : (Number(invoice.created) ? invoice.created * 1000 : ahora);
  return {
    invoiceId: invoice.id,
    subscriptionId: subscriptionId || idDe(invoice.subscription) || null,
    customerId: idDe(invoice.customer),
    uid: String(uid || ''),
    nombre: String(nombre || '').slice(0, 120),
    email: String(invoice.customer_email || '').toLowerCase().slice(0, 160),
    plan: plan === 'anual' || plan === 'mensual' ? plan : 'otro',
    tipo: invoice.billing_reason === 'subscription_create' ? 'primer' : 'renov',
    estado: pagado ? 'pagado' : 'fallido',
    monto: ((pagado ? invoice.amount_paid : invoice.amount_due) || 0) / 100,
    moneda: String(invoice.currency || 'mxn').toUpperCase(),
    fechaMs,
    creadoMs: ahora
  };
}

function filaPublica(id, d) {
  const ms = aMs(d.fechaMs);
  return {
    id, fecha: ms === null ? null : new Date(ms).toISOString(), uid: d.uid || '', nombre: d.nombre || '', correo: d.email || '',
    plan: d.plan || 'otro', tipo: d.tipo === 'primer' ? 'primer' : 'renov', estado: d.estado === 'fallido' ? 'fallido' : 'pagado',
    monto: Number.isFinite(Number(d.monto)) ? Number(d.monto) : null, moneda: d.moneda || 'MXN'
  };
}

// deps: db, stripe, esSuscripcionPropia(subscriptionId, invoice) → Promise<boolean>, planDeFactura(invoice) → 'mensual'|'anual'|'otro',
//       subscriptionIdDe(invoice) → id | null
function crearServicio({ db, stripe, esSuscripcionPropia, planDeFactura, subscriptionIdDe, ahora = () => Date.now() }) {
  async function miembroDe(subscriptionId, email) {
    if (subscriptionId) {
      const s = await db.collection('miembros').where('stripeSubscriptionId', '==', subscriptionId).limit(1).get();
      if (!s.empty) { const d = s.docs[0].data() || {}; return { uid: s.docs[0].id, nombre: d.name || d.displayName || '', email: d.email || '' }; }
    }
    return { uid: '', nombre: '', email: email || '' };
  }

  // Guarda un cobro. Devuelve 'creado', 'actualizado' (un pagado que reemplaza a un rechazado), 'existia' u 'omitido' (de otra marca o en ceros)
  async function registrarCobro(invoice, estado) {
    if (!invoice || !invoice.id || (estado !== 'pagado' && estado !== 'fallido')) return 'omitido';
    const subscriptionId = subscriptionIdDe ? subscriptionIdDe(invoice) : idDe(invoice.subscription);
    if (!subscriptionId) return 'omitido';
    if (estado === 'pagado' && !invoice.amount_paid) return 'omitido';       // facturas en cero (cupón del 100 %) no son dinero cobrado
    if (!(await esSuscripcionPropia(subscriptionId, invoice))) return 'omitido';
    const m = await miembroDe(subscriptionId, invoice.customer_email);
    const datos = datosPago({ ...invoice, customer_email: invoice.customer_email || m.email }, { estado, plan: planDeFactura(invoice), uid: m.uid, nombre: m.nombre, ahora: ahora(), subscriptionId });
    const ref = db.collection(COL_PAGOS).doc(invoice.id);
    const previo = await ref.get();
    if (previo.exists) {
      const antes = previo.data() || {};
      if (antes.estado === 'pagado' || estado === 'fallido') return 'existia';   // nunca se pisa un pago ya guardado, ni un pago con un rechazo
      await ref.set({ ...datos, creadoMs: antes.creadoMs || datos.creadoMs });
      return 'actualizado';
    }
    await ref.set(datos);
    return 'creado';
  }

  // Para el webhook: nunca lanza
  async function registrarSeguro(invoice, estado) {
    try { return await registrarCobro(invoice, estado); } catch (e) { console.warn('⚠️ No se pudo registrar el cobro', invoice && invoice.id, '·', e && e.message); return 'error'; }
  }

  // Trae de Stripe los cobros pagados de todos los miembros y guarda los que faltan (los anteriores al registro o los que se perdieron)
  async function sincronizar() {
    const snap = await db.collection('miembros').get();
    const suscripciones = [...new Set(snap.docs.map(d => (d.data() || {}).stripeSubscriptionId).filter(Boolean))].slice(0, MAX_SUSCRIPCIONES);
    const r = { suscripciones: suscripciones.length, revisados: 0, nuevos: 0, errores: 0 };
    for (const subId of suscripciones) {
      try {
        const lista = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 100 });
        for (const factura of (lista && lista.data) || []) {
          r.revisados++;
          const q = await registrarCobro(factura, 'pagado');
          if (q === 'creado' || q === 'actualizado') r.nuevos++;
        }
      } catch (e) {
        r.errores++;
        console.warn('⚠️ Sincronización de pagos · suscripción', subId, '·', e && e.message);
      }
    }
    return r;
  }

  async function listar({ limite = TOPE_LECTURA } = {}) {
    const tope = Math.min(Math.max(Math.floor(Number(limite)) || TOPE_LECTURA, 1), TOPE_LECTURA);
    const snap = await db.collection(COL_PAGOS).orderBy('fechaMs', 'desc').limit(tope).get();
    return snap.docs.map(d => filaPublica(d.id, d.data() || {}));
  }

  return { registrarCobro, registrarSeguro, sincronizar, listar };
}

module.exports = { COL_PAGOS, TOPE_LECTURA, datosPago, filaPublica, crearServicio };
