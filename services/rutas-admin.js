'use strict';

// ══ RUTAS DEL PANEL DE ADMINISTRACIÓN (solo administradores) ══
//
//   GET  /api/admin/yo                         ¿esta sesión es administradora? (200 solo a administradores)
//   GET  /api/admin/resumen                    KPIs, altas semanales, ingresos estimados, vencimientos y actividad
//   GET  /api/admin/miembros                   lista mínima de miembros (nombre, correo, estado del plan, vencimiento)
//   GET  /api/admin/miembros/:uid              ficha: plan, progreso por curso, certificados, referidos y retos
//   POST /api/admin/miembros/:uid/activar      activa o amplía el plan a mano (transferencia, efectivo, cortesía)
//   POST /api/admin/miembros/:uid/cancelar     marca la membresía como cancelada (con acceso hasta su fecha)
//   GET  /api/admin/progreso-legado            ensayo SIN escribir: qué importaría el avance anterior de cada miembro (paginado)
//   POST /api/admin/progreso-legado/:uid/importar   la misma importación única e idempotente para una persona (se anota)
//   GET  /api/admin/comunidad                  tarjetas del directorio y discusiones recientes del foro
//   GET  /api/admin/referidos                  invitaciones por estado y quiénes invitan más
//   GET  /api/admin/retos                      retos superados y XP de toda la comunidad
//   GET  /api/admin/estado                     salud del servidor, servicios configurados, errores y acciones recientes
//
// Seguridad:
//  - TODAS pasan por autenticarAdmin (sesión de Firebase + ADMIN_EMAILS o marca de administrador). Un miembro o una
//    persona sin sesión recibe 403 / 401 sin ningún dato. Nada de lo que decide el permiso viene del navegador.
//  - Se lee con el Admin SDK y se devuelve el MÍNIMO (services/admin-panel.js): nunca ids de Stripe, firmas ni tokens.
//  - Los correos y uids van en la ruta o en el cuerpo de una petición HTTPS, nunca en el enlace del panel.
//  - Las acciones que cambian datos (activar, cancelar) quedan en la colección adminAcciones (solo del servidor).
//  - Lecturas en memoria con vigencia corta y tope de documentos, y límite de peticiones por administrador.

const { permitirSolicitud } = require('./rutas-club');
const panel = require('./admin-panel');
const bitacora = require('./bitacora-memoria');

const LECTURAS_POR_MINUTO = 90;
const ESCRITURAS_POR_MINUTO = 20;
const TOPE_DOCUMENTOS = 5000;
const CACHE_MS = 45 * 1000;
const UID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;

function montarRutasAdmin(app, deps) {
  const { db, admin, auth, errorHttp, autenticarAdmin, tieneAccesoVigente, esAdminPorCorreo, correosAdministrador } = deps;
  const FieldValue = admin.firestore.FieldValue;
  const limites = { lecturas: new Map(), escrituras: new Map() };
  const express = deps.express;
  const analizadorJson = express.json({ limit: '4kb' });

  const limitar = (mapa, uid, maximo) => {
    if (!permitirSolicitud(mapa, uid, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error(`[Admin ${etiqueta || 'api'}]`, err && err.message);
    return res.status(500).json({ error: mensajeGenerico });
  }

  // Envoltura común: sin caché, administrador verificado en el servidor y límite por persona.
  const conAdmin = (mensajeGenerico, etiqueta, fn, { escritura = false } = {}) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitar(escritura ? limites.escrituras : limites.lecturas, decoded.uid, escritura ? ESCRITURAS_POR_MINUTO : LECTURAS_POR_MINUTO);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };

  const uidDe = req => {
    const uid = String(req.params.uid || '');
    if (!UID_VALIDO.test(uid)) throw errorHttp(400, 'El identificador no es válido');
    return uid;
  };

  // ── Lecturas con caché corto (el panel pide varias secciones seguidas) ──
  const cache = new Map();
  async function conCache(clave, leer, refrescar) {
    const previo = cache.get(clave);
    if (!refrescar && previo && Date.now() - previo.en < CACHE_MS) return previo.valor;
    const valor = await leer();
    cache.set(clave, { en: Date.now(), valor });
    return valor;
  }

  async function leerColeccion(nombre) {
    const snap = await db.collection(nombre).limit(TOPE_DOCUMENTOS + 1).get();
    const docs = snap.docs.slice(0, TOPE_DOCUMENTOS).map(d => ({ id: d.id, data: d.data() || {} }));
    return { docs, truncado: snap.docs.length > TOPE_DOCUMENTOS };
  }
  const miembros = refrescar => conCache('miembros', () => leerColeccion('miembros'), refrescar);
  const certificados = refrescar => conCache('certificados', () => leerColeccion('certificados'), refrescar);
  const cursos = refrescar => conCache('cursos', async () => {
    const snap = await db.collection('cursos').get();
    return new Map(snap.docs.map(d => [d.id, String((d.data() || {}).title || (d.data() || {}).titulo || d.id).slice(0, 140)]));
  }, refrescar);

  const refrescar = req => req.query.refrescar === '1';
  const tieneAcceso = m => tieneAccesoVigente(m);
  const nombreDe = m => String((m && (m.name || m.displayName)) || '').slice(0, 120) || 'Sin nombre';

  const contarCertificados = lista => {
    let total = 0; let completados = 0;
    for (const { data } of lista) {
      if (data.verificado === false) continue;
      total += 1;
      if (data.origen === 'backend') completados += 1;
    }
    return { total, completados };
  };

  // ════════════════════════════════════════════════════════════
  // ¿Soy administrador? Solo responde 200 a administradores; para el resto es 401 / 403 sin datos.
  // ════════════════════════════════════════════════════════════
  // Variante suave (?suave=1): la usa el Club de miembros para saber, sin ruido de errores 403 en el navegador, si la cuenta
  // que abrió una página es administradora y debe ir al panel. Misma regla de acceso (autenticarAdmin); la diferencia es que
  // "no eres administrador" responde 200 { admin: false } en lugar de 403. Sin sesión sigue siendo 401. Nunca devuelve datos.
  app.get('/api/admin/yo', async (req, res, next) => {
    if (req.query.suave !== '1') return next();
    res.set('Cache-Control', 'no-store');
    const respuesta = {
      codigo: 200, cuerpo: null,
      status(c) { this.codigo = c; return this; },
      json(b) { this.cuerpo = b; return this; }
    };
    try {
      const decoded = await autenticarAdmin(req, respuesta);
      if (decoded) {
        limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
        const via = esAdminPorCorreo(decoded) ? 'correo' : 'documento';
        return res.json({ ok: true, admin: true, uid: decoded.uid, via, nombre: String(decoded.name || '').slice(0, 120) });
      }
      if (respuesta.codigo === 403) return res.json({ ok: true, admin: false });
      return res.status(respuesta.codigo).json(respuesta.cuerpo || { error: 'No se pudo verificar el acceso de administrador' });
    } catch (error) {
      return responderError(res, error, 'No se pudo verificar el acceso de administrador', 'yo-suave');
    }
  });

  app.get('/api/admin/yo', conAdmin('No se pudo verificar el acceso de administrador', 'yo', async (req, res, decoded) => {
    const via = esAdminPorCorreo(decoded) ? 'correo' : 'documento';
    return res.json({ ok: true, admin: true, uid: decoded.uid, via, nombre: String(decoded.name || '').slice(0, 120) });
  }));

  // ════════════════════════════════════════════════════════════
  // Resumen
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/resumen', conAdmin('No se pudo cargar el resumen', 'resumen', async (req, res) => {
    const [mi, ce, acciones] = await Promise.all([
      miembros(refrescar(req)), certificados(refrescar(req)),
      db.collection('adminAcciones').orderBy('en', 'desc').limit(5).get().catch(() => ({ docs: [] }))
    ]);
    const ahora = new Date();
    const resumen = panel.construirResumen({
      miembros: mi.docs, certificados: contarCertificados(ce.docs), ahora, tieneAcceso
    });

    // Actividad reciente: altas, pagos, certificados y acciones del equipo, de lo más nuevo a lo más viejo.
    const eventos = [];
    for (const { id, data } of mi.docs) {
      const reg = panel.aFecha(data.createdAt); const pago = panel.aFecha(data.ultimoPago);
      if (reg) eventos.push({ tipo: 'registro', en: reg.toISOString(), texto: `${nombreDe(data)} se registró`, uid: id });
      if (pago) eventos.push({ tipo: 'pago', en: pago.toISOString(), texto: `${nombreDe(data)} tuvo un pago de ${data.planTipo === 'anual' ? 'plan anual' : 'plan mensual'}`, uid: id });
    }
    for (const { data } of ce.docs) {
      const f = panel.aFecha(data.emitido || data.issuedAt);
      if (f) eventos.push({ tipo: 'certificado', en: f.toISOString(), texto: `Certificado de «${String(data.curso || data.courseTitle || 'curso').slice(0, 80)}»` });
    }
    for (const d of acciones.docs) {
      const a = d.data() || {};
      const f = panel.aFecha(a.en);
      if (f) eventos.push({ tipo: 'accion', en: f.toISOString(), texto: String(a.resumen || a.accion || 'Acción del equipo').slice(0, 140) });
    }
    eventos.sort((a, b) => (a.en < b.en ? 1 : -1));

    return res.json({
      ok: true, generado: ahora.toISOString(), truncado: mi.truncado,
      ...resumen, actividadReciente: eventos.slice(0, 12)
    });
  }));

  // ════════════════════════════════════════════════════════════
  // Miembros
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/miembros', conAdmin('No se pudieron cargar los miembros', 'miembros', async (req, res) => {
    const mi = await miembros(refrescar(req));
    const lista = mi.docs.map(({ id, data }) => panel.vistaMiembro(id, data, tieneAcceso));
    return res.json({ ok: true, generado: new Date().toISOString(), total: lista.length, truncado: mi.truncado, miembros: lista });
  }));

  app.get('/api/admin/miembros/:uid', conAdmin('No se pudo cargar la ficha del miembro', 'ficha', async (req, res) => {
    const uid = uidDe(req);
    const snap = await db.collection('miembros').doc(uid).get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos a esa persona');
    const m = snap.data() || {};
    const [progresoSnap, certSnap, refSnap, retosSnap, nombresCursos] = await Promise.all([
      db.collection('miembros').doc(uid).collection('progresoCursos').get().catch(() => ({ docs: [] })),
      db.collection('certificados').where('uid', '==', uid).limit(50).get().catch(() => ({ docs: [] })),
      db.collection('referidos').where('anfitrionUid', '==', uid).limit(100).get().catch(() => ({ docs: [] })),
      db.collection('retosUsuario').doc(uid).get().catch(() => ({ exists: false })),
      cursos()
    ]);
    const progreso = progresoSnap.docs.map(d => {
      const p = d.data() || {};
      return {
        cursoId: d.id, curso: nombresCursos.get(d.id) || d.id,
        clasesVistas: Array.isArray(p.sesionesVistas) ? p.sesionesVistas.length : 0,
        completado: p.completado === true, certificadoFolio: typeof p.certificadoFolio === 'string' ? p.certificadoFolio : null
      };
    });
    const certs = certSnap.docs.map(d => d.data() || {}).filter(c => c.verificado !== false).map(c => ({
      folio: String(c.folio || '').slice(0, 60), curso: String(c.curso || c.courseTitle || '').slice(0, 120),
      emitido: panel.aIso(c.emitido || c.issuedAt), origen: String(c.origen || 'backend').slice(0, 20)
    }));
    const referidos = { total: 0, validos: 0, pendientes: 0, rechazados: 0 };
    for (const d of refSnap.docs) {
      const e = (d.data() || {}).estado;
      referidos.total += 1;
      if (e === 'valido') referidos.validos += 1; else if (e === 'pendiente-correo') referidos.pendientes += 1; else if (e === 'rechazado') referidos.rechazados += 1;
    }
    const r = retosSnap.exists ? (retosSnap.data() || {}) : {};
    return res.json({
      ok: true,
      miembro: panel.fichaMiembro(uid, m, tieneAcceso),
      progreso, certificados: certs, referidos,
      retos: { xp: Number.isFinite(r.xp) ? r.xp : 0, superados: Number.isFinite(r.superados) ? r.superados : 0 }
    });
  }));

  async function anotarAccion(decoded, accion, uidDestino, resumen, extra = {}) {
    try {
      const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      await db.collection('adminAcciones').doc(id).set({
        accion, uidDestino, por: decoded.uid, porCorreo: String(decoded.email || '').toLowerCase().slice(0, 160),
        resumen: panel.limpiarTexto(resumen, 200), en: FieldValue.serverTimestamp(), ...extra
      });
    } catch (e) {
      console.error('[Admin acciones] No se pudo anotar la acción:', e.message);
    }
  }

  // Activar o ampliar el plan a mano. Mismos campos que escribía el panel anterior desde el navegador, pero ahora
  // con validación y con el administrador verificado en el servidor. Escribe también el espejo en `usuarios`.
  app.post('/api/admin/miembros/:uid/activar', analizadorJson, conAdmin('No se pudo activar la membresía', 'activar', async (req, res, decoded) => {
    const uid = uidDe(req);
    const v = panel.validarActivacion(req.body);
    if (v.error) throw errorHttp(400, v.error);
    const { planTipo, dias, metodo, monto } = v.datos;
    const ref = db.collection('miembros').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos a esa persona');
    const ahora = new Date();
    const vence = new Date(ahora.getTime() + dias * 86400000);
    const cambios = {
      planActivo: true, planCancelado: false, planTipo, planStatus: 'active',
      planInicio: admin.firestore.Timestamp.fromDate(ahora), planVence: admin.firestore.Timestamp.fromDate(vence),
      ultimoPago: admin.firestore.Timestamp.fromDate(ahora), planActivadoEn: admin.firestore.Timestamp.fromDate(ahora),
      activadoManualmente: true, activadoPor: 'admin', metodoPago: metodo, montoPagado: monto,
      needsLinkToAuth: typeof FieldValue.delete === 'function' ? FieldValue.delete() : null
    };
    await ref.set(cambios, { merge: true });
    await db.collection('usuarios').doc(uid).set({
      planActivo: true, tipoPlan: planTipo, planStatus: 'active',
      fechaActivacion: admin.firestore.Timestamp.fromDate(ahora), fechaExpiracion: admin.firestore.Timestamp.fromDate(vence)
    }, { merge: true });
    cache.delete('miembros');
    await anotarAccion(decoded, 'activar-plan', uid, `Activó el plan ${planTipo} por ${dias} días a ${nombreDe(snap.data())}`, { dias, planTipo });
    return res.json({ ok: true, planTipo, dias, vence: vence.toISOString() });
  }, { escritura: true }));

  // Cancelar: marca la membresía como cancelada; conserva el acceso hasta su fecha de vencimiento.
  app.post('/api/admin/miembros/:uid/cancelar', conAdmin('No se pudo cancelar la membresía', 'cancelar', async (req, res, decoded) => {
    const uid = uidDe(req);
    const ref = db.collection('miembros').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos a esa persona');
    await ref.set({ planCancelado: true, planStatus: 'cancelled_active', canceladoEn: FieldValue.serverTimestamp() }, { merge: true });
    cache.delete('miembros');
    await anotarAccion(decoded, 'cancelar-plan', uid, `Canceló la membresía de ${nombreDe(snap.data())}`);
    return res.json({ ok: true, nota: 'La suscripción de Stripe, si existe, se cancela desde el panel de Stripe.' });
  }, { escritura: true }));

  // ════════════════════════════════════════════════════════════
  // Comunidad: directorio y foro
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/comunidad', conAdmin('No se pudo cargar la comunidad', 'comunidad', async (req, res) => {
    const [dir, foro] = await Promise.all([
      conCache('directorio', () => leerColeccion('directorio'), refrescar(req)),
      db.collection('foroPosts').orderBy('createdAt', 'desc').limit(30).get().catch(() => ({ docs: [] }))
    ]);
    let publicadas = 0; let verificadas = 0;
    const porSector = {};
    for (const { data } of dir.docs) {
      if (data.publicado === true) publicadas += 1;
      if (data.cedulaVisible === true && data.cedula) verificadas += 1;
      const s = String(data.sector || 'Sin sector').slice(0, 60);
      porSector[s] = (porSector[s] || 0) + 1;
    }
    const sectores = Object.entries(porSector).map(([sector, n]) => ({ sector, n })).sort((a, b) => b.n - a.n).slice(0, 12);
    const discusiones = foro.docs.map(d => {
      const p = d.data() || {};
      return {
        id: d.id, titulo: String(p.title || '').slice(0, 140), autor: String(p.authorName || '').slice(0, 80),
        creado: panel.aIso(p.createdAt), respuestas: Number.isFinite(p.repliesCount) ? p.repliesCount : 0,
        me_gusta: Array.isArray(p.likes) ? p.likes.length : 0, vistas: Number.isFinite(p.views) ? p.views : 0,
        extracto: String(p.content || '').replace(/\s+/g, ' ').slice(0, 160)
      };
    });
    return res.json({
      ok: true, truncado: dir.truncado,
      directorio: { total: dir.docs.length, publicadas, privadas: dir.docs.length - publicadas, conCedulaVisible: verificadas, porSector: sectores },
      discusiones
    });
  }));

  // ════════════════════════════════════════════════════════════
  // Referidos
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/referidos', conAdmin('No se pudieron cargar los referidos', 'referidos', async (req, res) => {
    const [ref, mi] = await Promise.all([conCache('referidos', () => leerColeccion('referidos'), refrescar(req)), miembros(false)]);
    const nombres = new Map(mi.docs.map(({ id, data }) => [id, nombreDe(data)]));
    const totales = { total: 0, validos: 0, pendientes: 0, rechazados: 0, conPago: 0 };
    const porAnfitrion = new Map();
    for (const { data } of ref.docs) {
      totales.total += 1;
      if (data.estado === 'valido') totales.validos += 1;
      else if (data.estado === 'pendiente-correo') totales.pendientes += 1;
      else if (data.estado === 'rechazado') totales.rechazados += 1;
      const hitos = data.hitos && typeof data.hitos === 'object' ? data.hitos : {};
      if (hitos.pago) totales.conPago += 1;
      const a = String(data.anfitrionUid || '');
      if (!a) continue;
      const fila = porAnfitrion.get(a) || { uid: a, nombre: nombres.get(a) || 'Sin nombre', invitados: 0, validos: 0 };
      fila.invitados += 1;
      if (data.estado === 'valido') fila.validos += 1;
      porAnfitrion.set(a, fila);
    }
    const anfitriones = [...porAnfitrion.values()].sort((a, b) => b.validos - a.validos || b.invitados - a.invitados).slice(0, 10);
    const motivos = {};
    for (const { data } of ref.docs) if (data.estado === 'rechazado' && data.motivo) { const k = String(data.motivo).slice(0, 100); motivos[k] = (motivos[k] || 0) + 1; }
    return res.json({
      ok: true, truncado: ref.truncado, totales, anfitriones,
      motivosRechazo: Object.entries(motivos).map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n).slice(0, 6)
    });
  }));

  // ════════════════════════════════════════════════════════════
  // Retos y XP
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/retos', conAdmin('No se pudieron cargar los retos', 'retos', async (req, res) => {
    const [rt, mi] = await Promise.all([conCache('retosUsuario', () => leerColeccion('retosUsuario'), refrescar(req)), miembros(false)]);
    const nombres = new Map(mi.docs.map(({ id, data }) => [id, nombreDe(data)]));
    let xp = 0; let superados = 0; let conActividad = 0;
    const filas = [];
    for (const { id, data } of rt.docs) {
      const x = Number.isFinite(data.xp) ? data.xp : 0;
      const s = Number.isFinite(data.superados) ? data.superados : 0;
      xp += x; superados += s;
      if (x > 0 || s > 0) conActividad += 1;
      filas.push({ uid: id, nombre: nombres.get(id) || 'Sin nombre', xp: x, superados: s });
    }
    filas.sort((a, b) => b.xp - a.xp);
    return res.json({
      ok: true, truncado: rt.truncado,
      totales: { personas: rt.docs.length, conActividad, retosSuperados: superados, xpTotal: xp, xpPromedio: conActividad ? Math.round(xp / conActividad) : 0 },
      top: filas.slice(0, 10)
    });
  }));

  // ════════════════════════════════════════════════════════════
  // Avance de miembros: ensayo (sin escribir nada) de la importación del progreso anterior, e importación por persona
  // ════════════════════════════════════════════════════════════
  // GET lee miembros, cursos, certificados y progreso, y calcula con services/certificados.js (diagnosticarLegado, que usa la
  // MISMA planearImportacionLegado que la importación real) qué contendría la importación. NO escribe nada.
  // POST ejecuta la misma importación única (idempotente, solo une, nunca quita ni borra courseProgress) y la anota.
  const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const certRegla = require('./certificados');
  const POR_PAGINA_LEGADO = 25;
  const MAX_POR_PAGINA_LEGADO = 50;
  const TOPE_MIEMBROS_LEGADO = 400;
  const corteMs = certRegla.corteLegado(deps.corteLegado);
  const limiteTextoLegado = String(deps.limiteAnteriores || '').trim().replace(/^["']|["']$/g, '').trim();
  const limiteAnteriores = certRegla.limiteEnMs(limiteTextoLegado);
  const firmaClave = String(deps.firmaClave || '').trim();
  const importarLegado = typeof deps.importarLegado === 'function' ? deps.importarLegado : null;

  const cursosCompletos = refrescarLectura => conCache('cursos-completos', async () => {
    const snap = await db.collection('cursos').get();
    return new Map(snap.docs.map(d => [d.id, d.data() || {}]));
  }, refrescarLectura);

  async function creacionesDeAuth(uids) {
    const salida = new Map();
    if (!auth) return salida;
    for (let i = 0; i < uids.length; i += 100) {
      const trozo = uids.slice(i, i + 100);
      try {
        const r = await auth.getUsers(trozo.map(uid => ({ uid })));
        for (const u of (r && r.users) || []) salida.set(u.uid, (u.metadata && u.metadata.creationTime) || null);
      } catch (error) {
        console.warn('[Admin avance] No se pudo leer la fecha de creación de las cuentas:', error && error.message);
      }
    }
    return salida;
  }

  async function progresosDe(uids) {
    const salida = new Map();
    for (let i = 0; i < uids.length; i += 10) {
      await Promise.all(uids.slice(i, i + 10).map(async uid => {
        try {
          const snap = await db.collection('miembros').doc(uid).collection('progresoCursos').get();
          salida.set(uid, new Map(snap.docs.map(d => [d.id, d.data() || {}])));
        } catch (_) { salida.set(uid, null); }
      }));
    }
    return salida;
  }

  // Una fila del panel. certificadosDeUid: [{ id, ...datos }] · creacion: texto de fecha o null/undefined
  function filaLegado(uid, data, { creacion, cursosMapa, certificadosDeUid, progresoActual, ahora }) {
    const diag = certRegla.diagnosticarLegado({
      uid, miembro: data, creacion, corte: corteMs, cursos: cursosMapa, certificados: certificadosDeUid,
      progresoActual, llave: firmaClave, contexto: { ahora, limite: limiteAnteriores }
    });
    const v = panel.vistaMiembro(uid, data, tieneAcceso);
    return {
      uid, nombre: nombreDe(data), correo: panel.enmascararCorreo(data.email),
      estadoPlan: v.estado, planTipo: v.planTipo, conAcceso: v.conAcceso,
      veredicto: diag.veredicto, elegible: diag.elegible, motivoNoElegible: diag.motivoNoElegible,
      importado: diag.importado, importadoEn: panel.aIso(data.progresoLegadoImportadoEn),
      verificado: diag.verificado, formatoInvalido: diag.formatoInvalido,
      cursosConAvance: diag.cursosConAvance, clasesViejas: diag.clasesViejas, clasesImportables: diag.clasesImportables,
      clasesPerdidas: diag.clasesPerdidas, clasesFaltantes: diag.clasesFaltantes,
      cursosCompletadosViejos: diag.cursosCompletadosViejos, listosParaCertificado: diag.listosParaCertificado,
      entradasInvalidas: diag.entradasInvalidas, certificados: diag.certificados,
      detalleRecortado: diag.detalleRecortado, cursos: diag.cursos
    };
  }

  // Orden de la tabla: primero lo que pide atención
  const ORDEN_VEREDICTO = { parcial: 0, 'no-elegible': 1, 'ya-importado': 2, completo: 3, 'sin-progreso-viejo': 4 };
  function severidad(f) {
    if (f.veredicto === 'ya-importado') return f.clasesFaltantes > 0 ? 0.5 : (f.clasesPerdidas > 0 ? 0.6 : 2);
    return ORDEN_VEREDICTO[f.veredicto];
  }

  const tieneCampoViejo = d => {
    const v = d.courseProgress;
    if (v === undefined || v === null) return false;
    return !(esObjeto(v) && !Object.keys(v).length);
  };

  async function revisarLegado(refrescarLectura) {
    const [mi, ce, cursosMapa] = await Promise.all([miembros(refrescarLectura), certificados(refrescarLectura), cursosCompletos(refrescarLectura)]);
    const candidatos = mi.docs.filter(({ data }) => tieneCampoViejo(data));
    const analizados = candidatos.slice(0, TOPE_MIEMBROS_LEGADO);
    const uids = analizados.map(d => d.id);
    const porUid = new Map();
    for (const { id, data } of ce.docs) {
      for (const dueno of new Set([String(data.uid || ''), String(data.memberUid || '')])) {
        if (!dueno) continue;
        if (!porUid.has(dueno)) porUid.set(dueno, []);
        porUid.get(dueno).push({ ...data, id });
      }
    }
    const importadosUids = analizados.filter(({ data }) => data.progresoLegadoImportado === true).map(d => d.id);
    const [creaciones, progresos] = await Promise.all([creacionesDeAuth(uids), progresosDe(importadosUids)]);
    const ahora = new Date();
    const filas = analizados.map(({ id, data }) => filaLegado(id, data, {
      creacion: creaciones.get(id), cursosMapa, certificadosDeUid: porUid.get(id) || [],
      progresoActual: progresos.get(id) || (data.progresoLegadoImportado === true ? new Map() : null), ahora
    }));
    filas.sort((a, b) => severidad(a) - severidad(b) || b.clasesViejas - a.clasesViejas || a.nombre.localeCompare(b.nombre, 'es'));

    const cuenta = f => filas.filter(f).length;
    const resumen = {
      miembros: mi.docs.length,
      conAvanceViejo: cuenta(f => f.veredicto !== 'sin-progreso-viejo'),
      completos: cuenta(f => f.veredicto === 'completo'),
      parciales: cuenta(f => f.veredicto === 'parcial'),
      noElegibles: cuenta(f => f.veredicto === 'no-elegible'),
      yaImportadosVerificados: cuenta(f => f.veredicto === 'ya-importado' && f.clasesFaltantes === 0 && f.clasesPerdidas === 0),
      yaImportadosConFaltantes: cuenta(f => f.veredicto === 'ya-importado' && f.clasesFaltantes > 0),
      yaImportadosConPerdidas: cuenta(f => f.veredicto === 'ya-importado' && f.clasesFaltantes === 0 && f.clasesPerdidas > 0),
      clasesViejas: filas.reduce((n, f) => n + f.clasesViejas, 0),
      clasesImportables: filas.reduce((n, f) => n + f.clasesImportables, 0),
      clasesPerdidas: filas.reduce((n, f) => n + f.clasesPerdidas, 0),
      listosParaCertificado: filas.reduce((n, f) => n + f.listosParaCertificado, 0)
    };
    resumen.sinProgresoViejo = mi.docs.length - resumen.conAvanceViejo;
    resumen.verificados = resumen.completos + resumen.yaImportadosVerificados;
    resumen.requierenRevision = resumen.parciales + resumen.noElegibles + resumen.yaImportadosConFaltantes + resumen.yaImportadosConPerdidas;
    return { filas, resumen, truncado: mi.truncado || candidatos.length > TOPE_MIEMBROS_LEGADO, generado: ahora.toISOString() };
  }

  const enteroEnRango = (valor, porDefecto, min, max) => {
    const n = Number.parseInt(valor, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : porDefecto;
  };

  app.get('/api/admin/progreso-legado', conAdmin('No se pudo revisar el avance de los miembros', 'avance', async (req, res) => {
    const r = await conCache('legado', () => revisarLegado(refrescar(req)), refrescar(req));
    const limite = enteroEnRango(req.query.limite, POR_PAGINA_LEGADO, 1, MAX_POR_PAGINA_LEGADO);
    const paginas = Math.max(1, Math.ceil(r.filas.length / limite));
    const pagina = enteroEnRango(req.query.pagina, 1, 1, paginas);
    return res.json({
      ok: true, generado: r.generado, truncado: r.truncado,
      configuracion: {
        importacionActiva: Number.isFinite(corteMs), corte: Number.isFinite(corteMs) ? new Date(corteMs).toISOString() : null,
        certificados: limiteTextoLegado === '' ? 'transicion' : (Number.isNaN(limiteAnteriores) ? 'limite-invalido' : 'con-limite'),
        firmaConfigurada: firmaClave !== ''
      },
      resumen: r.resumen, pagina, paginas, limite, total: r.filas.length,
      miembros: r.filas.slice((pagina - 1) * limite, pagina * limite)
    });
  }));

  app.post('/api/admin/progreso-legado/:uid/importar', analizadorJson, conAdmin('No se pudo importar el avance', 'importar-avance', async (req, res, decoded) => {
    if (!importarLegado) throw errorHttp(503, 'La importación del avance no está disponible');
    const uid = uidDe(req);
    const cuerpo = esObjeto(req.body) ? req.body : {};
    for (const campo of ['reintentar', 'aceptarCuentaPosterior']) {
      if (cuerpo[campo] !== undefined && typeof cuerpo[campo] !== 'boolean') throw errorHttp(400, 'Los datos enviados no son válidos');
    }
    const opciones = { reintentar: cuerpo.reintentar === true, aceptarCuentaPosterior: cuerpo.aceptarCuentaPosterior === true };
    const snap = await db.collection('miembros').doc(uid).get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos a esa persona');

    const resultado = await importarLegado(uid, opciones);
    cache.delete('miembros'); cache.delete('legado');
    if (resultado.estado === 'importado') {
      await anotarAccion(decoded, 'importar-avance', uid,
        `Importó el avance anterior de ${nombreDe(snap.data())}: ${resultado.clasesImportadas} clases en ${resultado.cursosImportados} cursos`,
        { clases: resultado.clasesImportadas, cursos: resultado.cursosImportados, reintento: opciones.reintentar, cuentaPosterior: opciones.aceptarCuentaPosterior });
    }

    // Lectura fresca de esta persona para que el panel actualice su fila
    const [miembroSnap, cursosMapa, porMiembro, porUid, progresoSnap, creaciones] = await Promise.all([
      db.collection('miembros').doc(uid).get(), cursosCompletos(true),
      db.collection('certificados').where('memberUid', '==', uid).limit(200).get(),
      db.collection('certificados').where('uid', '==', uid).limit(200).get(),
      db.collection('miembros').doc(uid).collection('progresoCursos').get(),
      creacionesDeAuth([uid])
    ]);
    const certs = new Map();
    for (const d of [...porMiembro.docs, ...porUid.docs]) certs.set(d.id, { ...(d.data() || {}), id: d.id });
    const fila = filaLegado(uid, miembroSnap.data() || {}, {
      creacion: creaciones.get(uid), cursosMapa, certificadosDeUid: [...certs.values()],
      progresoActual: new Map(progresoSnap.docs.map(d => [d.id, d.data() || {}])), ahora: new Date()
    });
    const cuerpoRespuesta = { ok: resultado.estado !== 'no-elegible', resultado, miembro: fila };
    if (resultado.estado === 'no-elegible') {
      return res.status(409).json({ ...cuerpoRespuesta, error: 'Esta cuenta no cumple la regla de fecha para importar el avance automáticamente' });
    }
    return res.json(cuerpoRespuesta);
  }, { escritura: true }));

  // ════════════════════════════════════════════════════════════
  // Estado del sistema (solo nombres de variables y si están definidas; nunca sus valores)
  // ════════════════════════════════════════════════════════════
  const VARIABLES = Object.freeze([
    { nombre: 'FIREBASE_SERVICE_ACCOUNT', para: 'Base de datos y sesiones (Firebase)', critica: true },
    { nombre: 'STRIPE_SECRET_KEY', para: 'Cobros con Stripe', critica: true },
    { nombre: 'STRIPE_WEBHOOK_SECRET', para: 'Avisos de pago de Stripe', critica: true },
    { nombre: 'BUNNY_TOKEN_AUTH_KEY', para: 'Reproducción de videos', critica: true },
    { nombre: 'CERTIFICATE_SIGNING_KEY', para: 'Firma y verificación de certificados', critica: true },
    { nombre: 'ADMIN_EMAILS', para: 'Correos que administran el sitio', critica: true },
    { nombre: 'BUNNY_API_KEY', para: 'Sincronizar el catálogo de Bunny', critica: false },
    { nombre: 'RESEND_API_KEY', para: 'Envío de correos', critica: false },
    { nombre: 'CRON_KEY', para: 'Tarea externa de noticias', critica: false },
    { nombre: 'NEWSDATA_API_KEY', para: 'Noticias del sector', critica: false },
    { nombre: 'PANEL_URL', para: 'Enlaces de correos y certificados', critica: false }
  ]);

  function conTiempo(promesa, ms) {
    let reloj;
    const limite = new Promise((_, rechazar) => { reloj = setTimeout(() => rechazar(new Error('tiempo agotado')), ms); });
    return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
  }

  app.get('/api/admin/estado', conAdmin('No se pudo revisar el estado del sistema', 'estado', async (req, res) => {
    const inicio = Date.now();
    let baseDeDatos = { ok: true, ms: 0 };
    try {
      await conTiempo(db.collection('config').doc('estado-panel').get(), 4000);
      baseDeDatos = { ok: true, ms: Date.now() - inicio };
    } catch (e) {
      baseDeDatos = { ok: false, ms: Date.now() - inicio, error: panel.limpiarTexto(e.message, 120) };
    }
    const env = process.env;
    const llaveStripe = String(env.STRIPE_SECRET_KEY || '').trim();
    const variables = VARIABLES.map(v => ({ ...v, definida: String(env[v.nombre] || '').trim() !== '' }));
    const acciones = await db.collection('adminAcciones').orderBy('en', 'desc').limit(15).get().catch(() => ({ docs: [] }));
    let version = null;
    try { version = require('../package.json').version; } catch (_) { version = null; }
    const administradores = [...correosAdministrador()].map(panel.enmascararCorreo).filter(Boolean);
    return res.json({
      ok: true, generado: new Date().toISOString(),
      servidor: {
        version, node: process.version, segundosActivo: Math.round(process.uptime()),
        iniciado: bitacora.arranque().toISOString(),
        commit: String(env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
        entorno: String(env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || '').slice(0, 40) || null,
        memoriaMb: Math.round(process.memoryUsage().rss / 1048576)
      },
      servicios: {
        baseDeDatos,
        stripe: { configurado: llaveStripe !== '', modo: llaveStripe.startsWith('sk_live') ? 'real' : (llaveStripe !== '' ? 'prueba' : null) },
        videos: { configurado: String(env.BUNNY_TOKEN_AUTH_KEY || '').trim() !== '', catalogoApi: String(env.BUNNY_API_KEY || '').trim() !== '' },
        correo: { configurado: String(env.RESEND_API_KEY || '').trim() !== '' },
        certificados: { configurado: String(env.CERTIFICATE_SIGNING_KEY || '').trim() !== '' },
        tareaNoticias: { activa: String(env.NOTICIAS_TAREA || '').trim().toLowerCase() !== 'off' }
      },
      variables,
      administradores,
      errores: {
        nota: 'Se guardan en la memoria del servidor: al publicar o reiniciar empiezan de cero.',
        total: bitacora.total(),
        recientes: bitacora.recientes(30)
      },
      acciones: acciones.docs.map(d => {
        const a = d.data() || {};
        return { accion: String(a.accion || '').slice(0, 40), resumen: String(a.resumen || '').slice(0, 160), en: panel.aIso(a.en) };
      })
    });
  }));

  return { limpiarCache: () => cache.clear() };
}

module.exports = { montarRutasAdmin, UID_VALIDO };
