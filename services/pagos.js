'use strict';

// ══ REGISTRO DE PAGOS DE SUSCRIPCIÓN ═════════════════════════════
// Cada cobro de Stripe de Zoorigen queda como un documento en `pagos/{idDeLaFactura}`: monto, fecha, quién pagó, plan y si fue el primer pago,
// una renovación o un cobro rechazado. El administrador los lee en «Suscripciones y pagos». Reglas:
//  · Un cobro se guarda una sola vez: el mismo cobro que llega por el aviso de Stripe o por «Traer pagos desde Stripe» cae en el mismo documento
//    (el id es el de la factura). Un cobro pagado reemplaza a un rechazado de la misma factura (Stripe reintentó y cobró); nunca al revés.
//  · La cuenta de Stripe se comparte con otras marcas: solo se guardan las suscripciones de Zoorigen (esSuscripcionPropia).
//  · Registrar un pago NUNCA debe romper el aviso de Stripe: el webhook llama a registrarSeguro(), que atrapa cualquier error.
//  · La colección es solo del servidor (las reglas de Firestore no la listan): el panel la lee por GET /api/admin/pagos.
//  · Un cobro rechazado guarda además POR QUÉ falló (motivo) y cuántos intentos van, tal como lo informa Stripe (services/motivos-rechazo.js):
//    solo códigos y un mensaje recortado, NUNCA datos de la tarjeta. Pedirle el motivo a Stripe tiene tiempo límite y nunca rompe el aviso.
//    Si el rechazo se repite (Stripe reintenta), se actualizan el motivo y los intentos; un cobro pagado jamás se toca.

const motivos = require('./motivos-rechazo');

const COL_PAGOS = 'pagos';
const TOPE_LECTURA = 3000;
const MAX_SUSCRIPCIONES = 300;
const TIEMPO_STRIPE_MS = 6000;        // tiempo límite de cada consulta a Stripe para completar un motivo
const TOPE_MOTIVOS_POR_PASADA = 100;  // cuántos rechazos sin motivo se completan en cada «Traer pagos desde Stripe»
const PAGINAS_FACTURAS_ABIERTAS = 5;  // hasta 500 facturas abiertas por pasada (de 100 en 100)

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
    creadoMs: ahora,
    ...(pagado ? {} : { intentos: Math.max(0, Math.floor(Number(invoice.attempt_count)) || 0) })
  };
}

function filaPublica(id, d) {
  const ms = aMs(d.fechaMs);
  const fallido = d.estado === 'fallido';
  const ultimo = aMs(d.ultimoIntentoMs);
  const proximo = d.motivo ? aMs(d.motivo.reintentoMs) : null;
  return {
    id, fecha: ms === null ? null : new Date(ms).toISOString(), uid: d.uid || '', nombre: d.nombre || '', correo: d.email || '',
    plan: d.plan || 'otro', tipo: d.tipo === 'primer' ? 'primer' : 'renov', estado: d.estado === 'fallido' ? 'fallido' : 'pagado',
    monto: Number.isFinite(Number(d.monto)) ? Number(d.monto) : null, moneda: d.moneda || 'MXN',
    // Solo en los rechazados: por qué falló (en español, ya traducido; nunca el mensaje de Stripe ni datos de la tarjeta), intentos y fechas
    motivo: fallido ? motivos.traducir(d.motivo) : null,
    intentos: fallido ? Math.max(0, Math.floor(Number(d.intentos)) || 0) : 0,
    ultimoIntento: fallido && ultimo !== null ? new Date(ultimo).toISOString() : null,
    proximoIntento: fallido && proximo !== null ? new Date(proximo).toISOString() : null
  };
}

// deps: db, stripe, esSuscripcionPropia(subscriptionId, invoice) → Promise<boolean>, planDeFactura(invoice) → 'mensual'|'anual'|'otro',
//       subscriptionIdDe(invoice) → id | null
function crearServicio({ db, stripe, esSuscripcionPropia, planDeFactura, subscriptionIdDe, ahora = () => Date.now(), tiempoStripeMs = TIEMPO_STRIPE_MS }) {
  async function miembroDe(subscriptionId, email) {
    if (subscriptionId) {
      const s = await db.collection('miembros').where('stripeSubscriptionId', '==', subscriptionId).limit(1).get();
      if (!s.empty) { const d = s.docs[0].data() || {}; return { uid: s.docs[0].id, nombre: d.name || d.displayName || '', email: d.email || '' }; }
    }
    return { uid: '', nombre: '', email: email || '' };
  }

  // Una consulta a Stripe con tiempo límite (nunca se queda colgada)
  function conTiempo(promesa) {
    let reloj;
    const limite = new Promise((_, rechazar) => { reloj = setTimeout(() => rechazar(new Error('Stripe tardó demasiado')), tiempoStripeMs); });
    return Promise.race([Promise.resolve(promesa), limite]).finally(() => clearTimeout(reloj));
  }

  // Pregunta a Stripe por qué falló el cobro de esta factura. NUNCA lanza: devuelve { motivo, intentos, ultimoIntentoMs, reintentoMs } o { error } si Stripe no respondió.
  // Compatible con las dos formas de la API de Stripe: con la factura que trae `payment_intent` (se expande con su último cargo) y, si no viene
  // (versiones nuevas), con los intentos de pago de la persona (paymentIntents por cliente). Del objeto de Stripe solo se extraen códigos y un mensaje.
  async function leerMotivoSinLimite(invoice) {
    try {
      if (!stripe || !stripe.invoices || typeof stripe.invoices.retrieve !== 'function' || !invoice || !invoice.id) return { error: 'sin-stripe' };
      let factura = null;
      try { factura = await conTiempo(stripe.invoices.retrieve(invoice.id, { expand: ['payment_intent', 'payment_intent.latest_charge'] })); } catch (e) {
        // Solo si Stripe dijo que esa expansión no existe se reintenta sin ella; ante cualquier otro error no se insiste (no se hacen dos llamadas a un Stripe caído)
        if (!/expand|invalid_request/i.test(String(e && e.message) + String(e && e.type) + String(e && e.code))) throw e;
      }
      if (!factura) factura = await conTiempo(stripe.invoices.retrieve(invoice.id));
      let pi = factura && factura.payment_intent;
      let cargo = (pi && typeof pi === 'object' && pi.latest_charge && typeof pi.latest_charge === 'object') ? pi.latest_charge : (factura && typeof factura.charge === 'object' ? factura.charge : null);
      if (typeof pi === 'string' && stripe.paymentIntents && stripe.paymentIntents.retrieve) {
        try { pi = await conTiempo(stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge'] })); } catch (_) { pi = null; }
      }
      if (pi && typeof pi === 'object' && !cargo && pi.latest_charge) {
        cargo = typeof pi.latest_charge === 'object' ? pi.latest_charge
          : (stripe.charges && stripe.charges.retrieve ? await conTiempo(stripe.charges.retrieve(pi.latest_charge)).catch(() => null) : null);
      }
      if (!pi || typeof pi !== 'object') {
        // Respaldo: los intentos de pago de la persona; el de esta factura, o el rechazado más cercano a su fecha y monto
        const cliente = idDe(factura && factura.customer) || idDe(invoice.customer);
        if (cliente && stripe.paymentIntents && stripe.paymentIntents.list) {
          const lista = await conTiempo(stripe.paymentIntents.list({ customer: cliente, limit: 10, expand: ['data.latest_charge'] }));
          const base = (factura && factura.created) || invoice.created || 0;
          const monto = (factura && factura.amount_due) || invoice.amount_due || 0;
          const candidatos = ((lista && lista.data) || []).filter(p => p && p.status !== 'succeeded' && p.last_payment_error);
          pi = candidatos.find(p => idDe(p.invoice) === invoice.id)
            || candidatos.filter(p => p.amount === monto && Math.abs((p.created || 0) - base) < 3 * 86400).sort((a, b) => Math.abs(a.created - base) - Math.abs(b.created - base))[0] || null;
          if (pi && typeof pi.latest_charge === 'object') cargo = pi.latest_charge;
        }
      }
      const base = factura || invoice;
      const motivo = motivos.extraerMotivo(base, pi && typeof pi === 'object' ? pi : null, cargo);
      return { motivo, ...motivos.datosIntento(base, cargo, ahora()) };
    } catch (e) {
      return { error: (e && e.message) || 'error' };
    }
  }

  // Presupuesto total para completar un motivo (el webhook de Stripe no debe esperar mucho aunque haya varias consultas): el doble del límite de una consulta
  async function leerMotivo(invoice) {
    let reloj;
    const plazo = new Promise(resolver => { reloj = setTimeout(() => resolver({ error: 'Stripe tardó demasiado' }), tiempoStripeMs * 2); });
    try { return await Promise.race([leerMotivoSinLimite(invoice), plazo]); } finally { clearTimeout(reloj); }
  }

  // Actualiza un cobro que SIGUE rechazado (en una transacción: si mientras tanto se pagó, no se toca). true si se guardó algo
  async function actualizarRechazado(ref, cambios) {
    return db.runTransaction(async tx => {
      const actual = await tx.get(ref);
      if (!actual.exists || (actual.data() || {}).estado !== 'fallido') return false;
      tx.set(ref, { ...actual.data(), ...cambios });
      return true;
    });
  }

  // Pide el motivo a Stripe y lo guarda en el cobro rechazado. Devuelve 'completado', 'sin-dato' (Stripe no dio motivo) o 'error'
  async function completarMotivo(ref, invoice) {
    const l = await leerMotivo(invoice);
    if (l.error) return 'error';
    const cambios = { intentos: Math.max(l.intentos || 0, Math.floor(Number(invoice.attempt_count)) || 0), ultimoIntentoMs: l.ultimoIntentoMs };   // los intentos solo suben
    if (l.motivo) { cambios.motivo = l.motivo; cambios.motivoEn = ahora(); }
    if (!(await actualizarRechazado(ref, cambios))) return 'sin-dato';
    return l.motivo ? 'completado' : 'sin-dato';
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
      if (antes.estado === 'pagado') return 'existia';   // nunca se pisa un pago ya guardado, ni un pago con un rechazo
      if (estado === 'fallido') {
        await completarMotivo(ref, invoice);     // Stripe reintentó y volvió a fallar: se actualizan el motivo y los intentos
        return 'existia';
      }
      await ref.set({ ...datos, creadoMs: antes.creadoMs || datos.creadoMs });
      return 'actualizado';
    }
    await ref.set(estado === 'fallido' ? { ...datos, ultimoIntentoMs: ahora() } : datos);
    if (estado === 'fallido') await completarMotivo(ref, invoice);   // el motivo es un extra: si Stripe no responde, el rechazo ya quedó anotado
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
    const r = { suscripciones: suscripciones.length, revisados: 0, nuevos: 0, errores: 0, fallidosNuevos: 0, motivosCompletados: 0, motivosPendientes: 0, motivosErrores: 0 };
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
    await traerRechazadas(r);
    await completarMotivosPendientes(r);
    return r;
  }

  // Cobros rechazados que no se hubieran registrado: facturas abiertas con intentos fallidos de las suscripciones de Zoorigen.
  // Una sola consulta general (de 100 en 100) en lugar de una por suscripción; la cuenta de Stripe es compartida, así que cada una pasa por esSuscripcionPropia.
  async function traerRechazadas(r) {
    if (!stripe || !stripe.invoices || typeof stripe.invoices.list !== 'function') return;
    try {
      let despues = null;
      for (let p = 0; p < PAGINAS_FACTURAS_ABIERTAS; p++) {
        const consulta = { status: 'open', limit: 100, ...(despues ? { starting_after: despues } : {}) };
        const lista = await conTiempo(stripe.invoices.list(consulta));
        const datos = (lista && lista.data) || [];
        for (const f of datos) {
          if (!f || f.status !== 'open' || !(Number(f.attempt_count) > 0) || !(subscriptionIdDe ? subscriptionIdDe(f) : idDe(f.subscription))) continue;
          try {
            const q = await registrarCobro(f, 'fallido');
            if (q === 'creado') r.fallidosNuevos++;
          } catch (e) { r.errores++; console.warn('⚠️ Sincronización de pagos · factura abierta', f.id, '·', e && e.message); }
        }
        if (!lista || lista.has_more !== true || !datos.length) break;
        despues = datos[datos.length - 1].id;
      }
    } catch (e) {
      r.errores++;
      console.warn('⚠️ Sincronización de pagos · facturas abiertas ·', e && e.message);
    }
  }

  // Completa el motivo de los cobros rechazados que todavía no lo tienen (hasta TOPE_MOTIVOS_POR_PASADA por pasada; un error en una factura no frena las demás)
  async function completarMotivosPendientes(r) {
    try {
      const snap = await db.collection(COL_PAGOS).where('estado', '==', 'fallido').limit(TOPE_LECTURA).get();
      const sin = snap.docs.filter(d => !(d.data() || {}).motivo);
      r.motivosPendientes = sin.length;
      for (const d of sin.slice(0, TOPE_MOTIVOS_POR_PASADA)) {
        const datos = d.data() || {};
        const resultado = await completarMotivo(db.collection(COL_PAGOS).doc(d.id), { id: d.id, customer: datos.customerId, attempt_count: datos.intentos, created: Math.floor((aMs(datos.fechaMs) || 0) / 1000), amount_due: Math.round((Number(datos.monto) || 0) * 100) });
        if (resultado === 'completado') { r.motivosCompletados++; r.motivosPendientes--; } else if (resultado === 'error') r.motivosErrores++;
      }
    } catch (e) {
      r.errores++;
      console.warn('⚠️ Sincronización de pagos · motivos ·', e && e.message);
    }
  }

  async function listar({ limite = TOPE_LECTURA } = {}) {
    const tope = Math.min(Math.max(Math.floor(Number(limite)) || TOPE_LECTURA, 1), TOPE_LECTURA);
    const snap = await db.collection(COL_PAGOS).orderBy('fechaMs', 'desc').limit(tope).get();
    return snap.docs.map(d => filaPublica(d.id, d.data() || {}));
  }

  return { registrarCobro, registrarSeguro, sincronizar, listar, leerMotivo };
}

module.exports = { COL_PAGOS, TOPE_LECTURA, TOPE_MOTIVOS_POR_PASADA, datosPago, filaPublica, crearServicio };
