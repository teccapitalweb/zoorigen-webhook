'use strict';

// ══ PANEL DE ADMINISTRACIÓN · CONFIGURACIÓN (precios, contacto, estado de servicios e historial del servidor) ══
// rutas-admin.js llama a montarRutasAdminServidor(app, deps, ayudas). Todas son SOLO administrador (mismo conAdmin: sesión de
// Firebase + ADMIN_EMAILS o marca, límite de peticiones y sin caché) salvo la lectura pública del contacto.
//
//   GET  /api/admin/precios                     precios VIGENTES de la membresía (solo lectura: ver nota abajo)
//   GET  /api/admin/contacto                    WhatsApp, Instagram y correo guardados (y los de siempre)
//   POST /api/admin/contacto                    los guarda (validados) y anota quién, cuándo y antes/después
//   GET  /api/config/contacto                   (PÚBLICO, con caché) lo que el Club usa en sus enlaces de ayuda
//   GET  /api/admin/servicios                   semáforo: servidor, base de datos, Stripe, avisos de pago, pagos contra membresías...
//   GET  /api/admin/servidor/historial          reinicios, caídas y errores agrupados de los últimos días (bitácora persistente)
//   POST /api/admin/servidor/reconocer-reinicios  marca los reinicios inesperados ya revisados como «publicaciones normales»
//
// PRECIOS: solo lectura a propósito. La cuenta de Stripe es COMPARTIDA con otras marcas y no se puede probar contra Stripe real
// desde aquí; cambiar un precio implica crear un Price nuevo, así que el panel muestra lo vigente y el cambio se hace en Stripe.
// Nunca devuelve claves ni ids completos de Stripe (solo los últimos 4 caracteres).

const panel = require('./admin-panel');
const contactoSvc = require('./contacto');

const PRECIOS_CACHE_MS = 10 * 60 * 1000;
const CONTACTO_CACHE_MS = 60 * 1000;
const DIAS_HISTORIAL = [7, 30, 90];

// «45 s», «12 min», «3 h 5 min», «4 d 17 h»
function duracion(segundos) {
  const s = Math.max(0, Math.round(Number(segundos) || 0));
  if (s < 90) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 90) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h ' + (m % 60) + ' min';
  return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
}

function conTiempo(promesa, ms) {
  let reloj;
  const limite = new Promise((_, rechazar) => { reloj = setTimeout(() => rechazar(new Error('tiempo agotado')), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}

function montarRutasAdminServidor(app, deps, a) {
  const { db, admin, errorHttp, bitacoraServidor } = deps;
  const { conAdmin, anotarAccion, miembros, refrescar, tieneAcceso, analizadorJson } = a;
  const stripe = deps.precios && deps.precios.stripe;
  const STRIPE_PRICES = (deps.precios && deps.precios.STRIPE_PRICES) || {};
  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;

  /* ════════════ Precios (solo lectura) ════════════ */
  let preciosCache = null;
  async function leerPrecios(forzar) {
    if (!forzar && preciosCache && Date.now() - preciosCache.en < PRECIOS_CACHE_MS) return preciosCache.valor;
    const clave = String(process.env.STRIPE_SECRET_KEY || '').trim();
    const planes = [['mensual', 'cada mes'], ['anual', 'cada año']];
    const lista = [];
    for (const [plan, cobro] of planes) {
      const id = String(STRIPE_PRICES[plan] || '');
      let monto = null; let moneda = 'mxn'; let origen = 'lista'; let activo = null;
      if (clave && id && stripe && stripe.prices && typeof stripe.prices.retrieve === 'function') {
        try {
          const p = await conTiempo(stripe.prices.retrieve(id), 4000);
          if (p && Number.isFinite(p.unit_amount)) { monto = p.unit_amount / 100; moneda = String(p.currency || 'mxn'); origen = 'stripe'; activo = p.active !== false; }
        } catch (_) { /* se usa el precio de lista */ }
      }
      if (monto === null) monto = panel.PRECIOS_LISTA_MXN[plan];
      lista.push({ plan, monto, moneda, cobro, origen, activo, idCorto: id ? '…' + id.slice(-4) : null });
    }
    const valor = { planes: lista, modo: clave.startsWith('sk_live') ? 'real' : (clave ? 'prueba' : null) };
    preciosCache = { en: Date.now(), valor };
    return valor;
  }

  app.get('/api/admin/precios', conAdmin('No se pudieron leer los precios', 'precios', async (req, res) => {
    const v = await leerPrecios(refrescar(req));
    return res.json({
      ok: true, generado: new Date().toISOString(), ...v, soloLectura: true,
      nota: 'Los precios se definen en Stripe y en el servidor. Cambiarlos desde el panel implicaría tocar los cobros de una cuenta compartida con otras marcas, y por seguridad no se hace aquí.'
    });
  }));

  /* ════════════ Contacto ════════════ */
  let contactoCache = null;
  async function leerContacto(forzar) {
    if (!forzar && contactoCache && Date.now() - contactoCache.en < CONTACTO_CACHE_MS) return contactoCache.valor;
    let doc = null;
    try { const s = await conTiempo(db.collection('config').doc('contacto').get(), 4000); doc = s.exists ? (s.data() || {}) : null; } catch (_) { doc = null; }
    const valor = { ...contactoSvc.contactoVigente(doc), actualizado: doc ? panel.aIso(doc.actualizadoEn) : null };
    contactoCache = { en: Date.now(), valor };
    return valor;
  }

  // Público: sin sesión, solo lo que el Club necesita para sus enlaces (nada más). Con caché del navegador y de la CDN.
  app.get('/api/config/contacto', async (req, res) => {
    const v = await leerContacto(false);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    return res.json({ ok: true, whatsapp: v.whatsapp, whatsappNumero: v.whatsappNumero, instagram: v.instagram, correo: v.correo });
  });

  app.get('/api/admin/contacto', conAdmin('No se pudo leer el contacto', 'contacto', async (req, res) => {
    const v = await leerContacto(true);
    return res.json({ ok: true, contacto: v, porDefecto: contactoSvc.CONTACTO_POR_DEFECTO });
  }));

  app.post('/api/admin/contacto', analizadorJson, conAdmin('No se pudo guardar el contacto', 'contacto-guardar', async (req, res, decoded) => {
    const r = contactoSvc.validarContacto(req.body);
    if (r.error) throw errorHttp(400, r.error);
    const antes = await leerContacto(true);
    await db.collection('config').doc('contacto').set({ ...r.datos, actualizadoEn: FieldValue.serverTimestamp(), actualizadoPor: decoded.uid }, { merge: true });
    contactoCache = null;
    const despues = await leerContacto(true);
    // Quién, cuándo (en) y antes/después: el contacto no es secreto, así que se guarda tal cual
    await anotarAccion(decoded, 'contacto-guardar', null, 'Cambió los datos de contacto del sitio (WhatsApp, Instagram y correo)', {
      antes: { whatsapp: antes.whatsapp, instagram: antes.instagram, correo: antes.correo },
      despues: { whatsapp: despues.whatsapp, instagram: despues.instagram, correo: despues.correo }
    });
    return res.json({ ok: true, contacto: despues });
  }, { escritura: true }));

  /* ════════════ Estado de servicios ════════════ */
  function haceTexto(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? `hace ${duracion(Math.max(0, (Date.now() - t) / 1000))}` : null;
  }

  // ¿Lo que dice Stripe en cada ficha coincide con el acceso real? Solo lee lo guardado: NO llama a Stripe.
  function pagosContraMembresias(lista) {
    let conStripe = 0; let coinciden = 0; const noCoinciden = [];
    for (const { id, data } of lista) {
      if (!data || !data.stripeSubscriptionId) continue;
      conStripe += 1;
      const estado = String(data.stripeSubscriptionStatus || '');
      const acceso = tieneAcceso(data);
      const cobrando = ['active', 'trialing'].includes(estado);
      const cancelada = ['canceled', 'unpaid', 'incomplete_expired'].includes(estado);
      let motivo = null;
      if (cobrando && !acceso) motivo = 'Stripe la da por activa y no tiene acceso';
      else if (cancelada && acceso && data.planCancelado !== true && data.planStatus !== 'cancelled_active') motivo = 'Tiene acceso pero Stripe la da por cancelada';
      if (motivo) noCoinciden.push({ uid: id, nombre: String(data.name || '').slice(0, 80) || 'Sin nombre', motivo }); else coinciden += 1;
    }
    return { conStripe, coinciden, noCoinciden };
  }

  app.get('/api/admin/servicios', conAdmin('No se pudo revisar el estado de los servicios', 'servicios', async (req, res) => {
    const env = process.env;
    const inicio = Date.now();
    let bd = { ok: true, ms: 0, error: null };
    try { await conTiempo(db.collection('config').doc('estado-panel').get(), 4000); bd = { ok: true, ms: Date.now() - inicio, error: null }; }
    catch (e) { bd = { ok: false, ms: Date.now() - inicio, error: panel.limpiarTexto(e.message, 120) }; }
    const [mi, hist] = await Promise.all([
      miembros(refrescar(req)).catch(() => ({ docs: [] })),
      bitacoraServidor ? bitacoraServidor.leerHistorial({ dias: 30 }).catch(() => null) : Promise.resolve(null)
    ]);
    const llave = String(env.STRIPE_SECRET_KEY || '').trim();
    const pagos = pagosContraMembresias(mi.docs);
    const stripeInfo = hist && hist.stripe;
    const comprobaciones = [];
    const agrega = (clave, nombre, nivel, detalle, extra = {}) => comprobaciones.push({ clave, nombre, nivel, detalle, ...extra });

    agrega('servidor', 'Servidor', 'ok', `Encendido desde hace ${duracion(process.uptime())}`);
    agrega('base', 'Base de datos', bd.ok ? 'ok' : 'error', bd.ok ? `Responde en ${bd.ms} ms` : (bd.error || 'No responde'));
    agrega('stripe', 'Cobros con Stripe', !llave ? 'error' : llave.startsWith('sk_live') ? 'ok' : 'aviso',
      !llave ? 'Falta la clave de Stripe en el servidor' : llave.startsWith('sk_live') ? 'Conectado en modo real' : 'Conectado en modo de prueba: no cobra de verdad');
    if (!stripeInfo || !stripeInfo.ultimoZoorigenEn) {
      agrega('avisos', 'Avisos de pago de Stripe', pagos.conStripe ? 'aviso' : 'ok',
        'Todavía no se registra ningún aviso de pago de Zoorigen (el registro empieza con esta versión). Se vuelve verde con el siguiente pago o renovación.');
    } else {
      agrega('avisos', 'Avisos de pago de Stripe', 'ok', `Último aviso de Zoorigen: ${haceTexto(stripeInfo.ultimoZoorigenEn)}` +
        (hist && hist.resumen.stripeIgnorados ? ` · ${hist.resumen.stripeIgnorados} avisos de otras marcas ignorados en 30 días (normal: la cuenta de Stripe es compartida)` : ''));
    }
    agrega('pagos', 'Pagos contra membresías activas', !pagos.conStripe ? 'ok' : pagos.noCoinciden.length ? 'aviso' : 'ok',
      !pagos.conStripe ? 'Aún no hay miembros que paguen con Stripe' : pagos.noCoinciden.length
        ? `${pagos.noCoinciden.length} de ${pagos.conStripe} no coinciden (lo guardado de Stripe y el acceso difieren). Revisa su ficha.`
        : `Coinciden las ${pagos.conStripe} suscripciones con su acceso (se compara lo guardado, sin llamar a Stripe)`,
      { casos: pagos.noCoinciden.slice(0, 8) });
    agrega('correo', 'Correos (Resend)', String(env.RESEND_API_KEY || '').trim() ? 'ok' : 'aviso', String(env.RESEND_API_KEY || '').trim() ? 'Envío configurado' : 'Falta la clave de correo: no se envían certificados ni confirmaciones propias');
    agrega('videos', 'Videos (Bunny)', String(env.BUNNY_TOKEN_AUTH_KEY || '').trim() ? 'ok' : 'error',
      String(env.BUNNY_TOKEN_AUTH_KEY || '').trim() ? (String(env.BUNNY_API_KEY || '').trim() ? 'Reproducción y catálogo' : 'Reproducción lista (sin sincronizar el catálogo)') : 'Falta la clave de los videos');
    agrega('certificados', 'Firma de certificados', String(env.CERTIFICATE_SIGNING_KEY || '').trim() ? 'ok' : 'error',
      String(env.CERTIFICATE_SIGNING_KEY || '').trim() ? 'Lista: se pueden emitir y verificar certificados' : 'Falta la llave: no se emiten ni verifican certificados');
    const nivel = comprobaciones.some(c => c.nivel === 'error') ? 'error' : comprobaciones.some(c => c.nivel === 'aviso') ? 'aviso' : 'ok';
    return res.json({
      ok: true, generado: new Date().toISOString(), nivel,
      resumen: nivel === 'ok' ? 'Todo en orden' : nivel === 'aviso' ? 'Hay avisos por revisar' : 'Hay algo que corregir',
      comprobaciones
    });
  }));

  /* ════════════ Historial del servidor ════════════ */
  app.get('/api/admin/servidor/historial', conAdmin('No se pudo leer el historial del servidor', 'historial', async (req, res) => {
    const dias = DIAS_HISTORIAL.includes(parseInt(req.query.dias, 10)) ? parseInt(req.query.dias, 10) : 30;
    if (!bitacoraServidor) return res.json({ ok: true, disponible: false });
    const h = await bitacoraServidor.leerHistorial({ dias });
    return res.json({ ok: true, disponible: true, generado: new Date().toISOString(), ...h });
  }));

  app.post('/api/admin/servidor/reconocer-reinicios', analizadorJson, conAdmin('No se pudieron marcar los reinicios', 'reconocer', async (req, res, decoded) => {
    if (!bitacoraServidor) throw errorHttp(503, 'La bitácora del servidor no está disponible');
    const n = await bitacoraServidor.reconocerReinicios();
    await anotarAccion(decoded, 'reinicios-normales', null, `Marcó ${n} reinicios del servidor como publicaciones normales`, { cantidad: n });
    return res.json({ ok: true, marcados: n });
  }, { escritura: true }));

  void Timestamp;
  return { leerContacto, leerPrecios };
}

module.exports = { montarRutasAdminServidor, DIAS_HISTORIAL };
