'use strict';

// ══ RUTAS DEL PANEL DE ADMINISTRACIÓN (segunda parte) ══
// rutas-admin.js llama a montarRutasAdminExtra(app, deps, ayudas) al final. Aquí viven:
//
//   POST   /api/admin/miembros/:uid/regalar          regala 1 mes (30) o 1 año (365) sin tocar Stripe
//   DELETE /api/admin/miembros/:uid                  elimina con respaldo previo y confirmación escribiendo el correo
//   GET    /api/admin/eliminados                     miembros eliminados (últimos 30 días se pueden restaurar)
//   POST   /api/admin/eliminados/:uid/restaurar      vuelve a crear la cuenta y reescribe lo respaldado
//   GET    /api/admin/metricas?desde=&hasta=         altas, conversión, retención, cursos, certificados, retos y visitas
//   GET    /api/admin/pruebas                        quiénes eligieron su prueba gratuita, avance y si ya son miembros
//   GET    /api/admin/encuesta/detalle               respuestas con id, atendida y teléfono enmascarado
//   GET    /api/admin/encuesta/:id/contacto          el número completo de UNA respuesta (queda anotado)
//   POST   /api/admin/encuesta/atender|borrar        marcar como atendida / borrar (con copia en adminPapelera)
//   GET    /api/admin/chatbot/sin-respuesta/detalle  preguntas sin respuesta con clave y atendida
//   POST   /api/admin/chatbot/sin-respuesta/atender|borrar
//   GET    /api/admin/config · POST /api/admin/config    interruptores guardados en Firestore config/panel
//   GET    /api/config-publica                       (pública) lo que el Club podrá leer: clases en vivo y aviso global
//   POST   /api/visita                               (pública) contador agregado de visitas, APAGADO por defecto
//
// Todas las /api/admin/* exigen administrador verificado en el servidor. Las acciones que cambian datos se anotan en
// adminAcciones. Las colecciones adminEliminados, adminPapelera, visitasDiarias y config las escribe solo el servidor.

const express = require('express');
const { permitirSolicitud } = require('./rutas-club');
const panel = require('./admin-panel');
const miembrosAdm = require('./admin-miembros');
const metricas = require('./admin-metricas');
const visitas = require('./admin-visitas');
const configAdm = require('./admin-config');
const referidos = require('./referidos');
const enc = require('./encuesta');

const PROGRESO_TOPE_MIEMBROS = 400;
const PRUEBAS_TOPE = 1000;
const ELIMINADOS_TOPE = 200;
const LOTE_BORRAR = 25;
const ID_ENCUESTA = /^[A-Za-z0-9-]{8,64}$/;
const CLAVE_CHATBOT = /^[a-z0-9][a-z0-9 -]{0,89}$/;
const VISITAS_POR_IP = 120;
const VISITAS_GLOBAL = 5000;
const VENTANA_VISITAS_MS = 10 * 60 * 1000;
const CONFIG_CACHE_MS = 30 * 1000;

function montarRutasAdminExtra(app, deps, a) {
  const { db, admin, auth, errorHttp, correosAdministrador } = deps;
  const { conAdmin, uidDe, anotarAccion, cache, conCache, miembros, certificados, cursosCompletos, leerColeccion, refrescar, tieneAcceso, nombreDe, analizadorJson } = a;
  const FieldValue = admin.firestore.FieldValue;
  const Timestamp = admin.firestore.Timestamp;
  const aTs = fecha => (Timestamp && typeof Timestamp.fromDate === 'function' ? Timestamp.fromDate(fecha) : fecha);

  const limitesPublicos = { visitas: new Map(), visitasGlobal: new Map() };

  // ════════════════════════════════════════════════════════════
  // Configuración guardada (config/panel) con caché corto
  // ════════════════════════════════════════════════════════════
  let configCache = null;
  async function leerConfig(forzar) {
    if (!forzar && configCache && Date.now() - configCache.en < CONFIG_CACHE_MS) return configCache.valor;
    let data = {};
    try { const s = await db.collection('config').doc('panel').get(); data = s.exists ? (s.data() || {}) : {}; } catch (e) {
      if (configCache) return configCache.valor; // si Firestore falla se conserva lo último que se sabía
      console.error('[Admin config] No se pudo leer config/panel:', e && e.message);
    }
    const valor = configAdm.normalizarConfig(data);
    configCache = { en: Date.now(), valor };
    return valor;
  }

  // ════════════════════════════════════════════════════════════
  // REGALAR tiempo
  // ════════════════════════════════════════════════════════════
  app.post('/api/admin/miembros/:uid/regalar', analizadorJson, conAdmin('No se pudo regalar el acceso', 'regalar', async (req, res, decoded) => {
    const uid = uidDe(req);
    const v = miembrosAdm.validarRegalo(req.body);
    if (v.error) throw errorHttp(400, v.error);
    const ref = db.collection('miembros').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos a esa persona');
    const m = snap.data() || {};
    if (m.role === 'admin' || uid === decoded.uid) throw errorHttp(400, 'Las cuentas de administración ya tienen todo abierto: no necesitan un regalo');
    const ahora = new Date();
    const r = miembrosAdm.calcularRegalo(m, v.dias, ahora);
    const stripe = panel.stripeActiva(m);
    const tipo = m.planTipo === 'anual' || m.planTipo === 'mensual' ? m.planTipo : (v.dias === 365 ? 'anual' : 'mensual');
    const cambios = {
      planActivo: true, planCancelado: false, planStatus: 'active', planTipo: tipo,
      planVence: aTs(r.vence),
      esRegalo: true, regaloEn: aTs(ahora), regaloDias: v.dias, regaloPor: decoded.uid
    };
    if (!m.planInicio) cambios.planInicio = aTs(ahora);
    if (v.nota) cambios.regaloNota = v.nota;
    await ref.set(cambios, { merge: true });
    await db.collection('usuarios').doc(uid).set({
      planActivo: true, tipoPlan: tipo, planStatus: 'active', fechaExpiracion: aTs(r.vence)
    }, { merge: true });
    cache.delete('miembros');
    await anotarAccion(decoded, 'regalar-plan', uid,
      `Regaló ${v.dias === 365 ? 'un año' : 'un mes'} de acceso a ${nombreDe(m)}${stripe ? ' (tiene suscripción de Stripe activa)' : ''}`,
      { dias: v.dias, desdeVigente: r.desdeVigente, stripeActiva: stripe, nota: v.nota || null });
    return res.json({
      ok: true, dias: v.dias, vence: r.vence.toISOString(), desdeVigente: r.desdeVigente, stripeActiva: stripe,
      aviso: stripe ? 'Esta persona tiene una suscripción de Stripe activa: se le seguirá cobrando y en su próximo cobro Stripe vuelve a fijar la fecha de vencimiento.' : null
    });
  }, { escritura: true }));

  // ════════════════════════════════════════════════════════════
  // ELIMINAR miembro (con respaldo previo)
  // ════════════════════════════════════════════════════════════
  const refRespaldo = uid => db.collection('adminEliminados').doc(uid);
  const eliminando = new Set(); // una sola eliminación a la vez por persona (doble clic)

  async function esAdministrador(uid, m) {
    if (m && m.role === 'admin') return true;
    const correo = miembrosAdm.normalizarCorreo(m && m.email);
    if (correo && [...correosAdministrador()].map(miembrosAdm.normalizarCorreo).includes(correo)) return true;
    try { const d = await db.collection('admins').doc(uid).get(); if (d.exists) return true; } catch (_) { /* sin la colección */ }
    return false;
  }

  async function leerDoc(coleccion, uid) {
    try { const s = await db.collection(coleccion).doc(uid).get(); return s.exists ? (s.data() || {}) : null; } catch (_) { return null; }
  }

  app.delete('/api/admin/miembros/:uid', analizadorJson, conAdmin('No se pudo eliminar al miembro', 'eliminar', async (req, res, decoded) => {
    const uid = uidDe(req);
    const v = miembrosAdm.validarEliminacion(req.body);
    if (v.error) throw errorHttp(400, v.error);
    if (uid === decoded.uid) throw errorHttp(400, 'No puedes eliminar tu propia cuenta');
    if (eliminando.has(uid)) throw errorHttp(409, 'Esta eliminación ya está en curso');
    eliminando.add(uid);
    try {
    const ref = db.collection('miembros').doc(uid);
    const [snap, previoSnap] = await Promise.all([ref.get(), refRespaldo(uid).get()]);
    const previo = previoSnap.exists ? (previoSnap.data() || {}) : null;
    if (!snap.exists) {
      // Segunda petición igual (doble clic, reintento): ya está eliminado y respaldado, no se hace nada más
      if (previo && previo.estado === 'eliminado' && previo.completado === true) {
        return res.json({ ok: true, yaEliminado: true, restaurableHasta: panel.aIso(previo.restaurableHasta) });
      }
      throw errorHttp(404, 'No encontramos a esa persona');
    }
    const m = snap.data() || {};
    if (await esAdministrador(uid, m)) throw errorHttp(403, 'No se puede eliminar a una cuenta de administración. Quítale primero el permiso de administrador.');
    if (previo && previo.estado === 'eliminado' && previo.completado === true) {
      throw errorHttp(409, 'Esta cuenta ya tiene un respaldo de una eliminación anterior. Restáurala o revisa «Eliminados recientemente» antes de volver a eliminarla.');
    }
    // El correo escrito debe ser el de la persona (o su identificador si la cuenta no tiene correo)
    const esperado = miembrosAdm.normalizarCorreo(m.email) || uid.toLowerCase();
    if (v.confirmarCorreo !== esperado) throw errorHttp(400, 'El correo que escribiste no coincide con el de la persona');
    const stripe = panel.stripeActiva(m);
    if (stripe && !v.confirmarStripe) {
      const err = errorHttp(409, 'Esta persona tiene una suscripción de Stripe activa. Cancélala primero en Stripe (Clientes → Suscripciones) o confirma que lo harás tú: eliminar la cuenta NO detiene los cobros.');
      err.codigo = 'stripe-activa';
      throw err;
    }
    if (!auth || typeof auth.deleteUser !== 'function') throw errorHttp(503, 'La eliminación de cuentas no está disponible en este servidor');

    // 1) Leer todo lo que se va a respaldar
    const [usuario, directorio, retos, premios, actividad, progresoSnap, certPorUid, certPorMiembro, cuenta] = await Promise.all([
      leerDoc('usuarios', uid), leerDoc('directorio', uid), leerDoc('retosUsuario', uid), leerDoc('premiosUsuario', uid), leerDoc('actividadUsuario', uid),
      ref.collection('progresoCursos').get().catch(() => ({ docs: [] })),
      db.collection('certificados').where('uid', '==', uid).limit(200).get().catch(() => ({ docs: [] })),
      db.collection('certificados').where('memberUid', '==', uid).limit(200).get().catch(() => ({ docs: [] })),
      auth.getUser(uid).then(u => ({
        email: u.email, displayName: u.displayName, emailVerified: u.emailVerified === true,
        proveedores: Array.isArray(u.providerData) ? u.providerData.map(p => String(p.providerId || '')).filter(Boolean) : undefined,
        creada: u.metadata && u.metadata.creationTime
      })).catch(e => (e && e.code === 'auth/user-not-found' ? null : Promise.reject(e)))
    ]);
    const progreso = {};
    for (const d of progresoSnap.docs) progreso[d.id] = d.data() || {};
    const certs = new Map();
    for (const d of [...certPorUid.docs, ...certPorMiembro.docs]) certs.set(d.id, { ...(d.data() || {}), id: d.id });

    const ahora = new Date();
    const respaldo = miembrosAdm.construirRespaldo({
      uid, miembro: m, usuario, directorio, retos, premios, actividad, progreso, certificados: [...certs.values()], cuenta,
      por: decoded.uid, porCorreo: decoded.email, ahora
    });
    if (!miembrosAdm.respaldoCabe(respaldo)) throw errorHttp(413, 'No se pudo respaldar a esta persona porque tiene demasiados datos. No se borró nada.');
    respaldo.eliminadoEn = aTs(ahora);
    respaldo.restaurableHasta = aTs(respaldo.restaurableHasta);

    // 2) Guardar el respaldo ANTES de borrar nada; si esto falla, no se toca a la persona
    await refRespaldo(uid).set(respaldo);

    // 3) Cuenta de acceso primero: si falla aquí, la persona sigue intacta y se puede reintentar
    if (cuenta) {
      try { await auth.deleteUser(uid); } catch (e) {
        if (!(e && e.code === 'auth/user-not-found')) {
          console.error('[Admin eliminar] No se pudo borrar la cuenta de acceso:', e && e.message);
          throw errorHttp(502, 'No se pudo eliminar la cuenta de acceso. El respaldo quedó guardado y no se borró nada más; inténtalo de nuevo.');
        }
      }
    }
    // 4) Documentos (el avance y los certificados se conservan donde están)
    await Promise.all([
      ref.delete(), db.collection('usuarios').doc(uid).delete(), db.collection('directorio').doc(uid).delete(), db.collection('retosUsuario').doc(uid).delete()
    ]);
    await refRespaldo(uid).set({ completado: true, borradoEn: aTs(new Date()) }, { merge: true });
    cache.clear();
    await anotarAccion(decoded, 'eliminar-miembro', uid,
      `Eliminó a ${nombreDe(m)} (respaldo guardado por ${miembrosAdm.DIAS_PARA_RESTAURAR} días)${stripe ? '; tenía suscripción de Stripe activa' : ''}`,
      { stripeActiva: stripe, cursosConAvance: Object.keys(progreso).length, certificados: certs.size });
    return res.json({
      ok: true, restaurableHasta: respaldo.restaurableHasta instanceof Date ? respaldo.restaurableHasta.toISOString() : panel.aIso(respaldo.restaurableHasta),
      stripeActiva: stripe,
      aviso: stripe ? 'Su suscripción de Stripe sigue activa: cancélala en Stripe para que no se le cobre.' : null,
      conservado: ['certificados', 'avance por curso', 'invitaciones', 'publicaciones del foro']
    });
    } finally { eliminando.delete(uid); }
  }, { escritura: true, limite: 'eliminaciones' }));

  app.get('/api/admin/eliminados', conAdmin('No se pudo leer la lista de eliminados', 'eliminados', async (req, res) => {
    const snap = await db.collection('adminEliminados').orderBy('eliminadoEn', 'desc').limit(ELIMINADOS_TOPE).get().catch(() => ({ docs: [] }));
    const ahora = new Date();
    return res.json({
      ok: true, diasParaRestaurar: miembrosAdm.DIAS_PARA_RESTAURAR,
      eliminados: snap.docs.map(d => miembrosAdm.vistaEliminado(d.id, d.data() || {}, ahora))
    });
  }));

  app.post('/api/admin/eliminados/:uid/restaurar', analizadorJson, conAdmin('No se pudo restaurar al miembro', 'restaurar', async (req, res, decoded) => {
    const uid = uidDe(req);
    const rr = refRespaldo(uid);
    const snap = await rr.get();
    if (!snap.exists) throw errorHttp(404, 'No hay un respaldo de esa persona');
    const r = snap.data() || {};
    const ev = miembrosAdm.evaluarRestauracion(r, new Date());
    if (!ev.ok) {
      const textos = {
        'ya-restaurado': [409, 'Esta persona ya fue restaurada.'],
        vencido: [410, `Pasaron más de ${miembrosAdm.DIAS_PARA_RESTAURAR} días. El respaldo sigue guardado en la base de datos (adminEliminados); la restauración tendría que hacerse a mano.`],
        incompleto: [409, 'La eliminación de esta persona no terminó; no hay nada que restaurar.']
      };
      const [codigo, texto] = textos[ev.motivo] || [409, 'No se puede restaurar.'];
      throw errorHttp(codigo, texto);
    }
    const ref = db.collection('miembros').doc(uid);
    if ((await ref.get()).exists) throw errorHttp(409, 'Ya existe una cuenta con ese identificador: no se sobrescribe.');
    if (r.cuenta && (!auth || typeof auth.createUser !== 'function')) throw errorHttp(503, 'La restauración de cuentas no está disponible en este servidor');

    // 1) Cuenta de acceso con el mismo uid y correo (la contraseña no se guarda: se define con «Olvidé mi contraseña»)
    let cuentaCreada = false;
    if (r.cuenta && r.cuenta.email) {
      try {
        await auth.createUser({
          uid, email: r.cuenta.email, displayName: r.cuenta.displayName || undefined, emailVerified: r.cuenta.emailVerified === true, disabled: false
        });
        cuentaCreada = true;
      } catch (e) {
        const codigo = e && e.code;
        if (codigo === 'auth/email-already-exists') {
          throw errorHttp(409, 'Ese correo ya tiene otra cuenta (la persona se volvió a registrar). No se restauró nada; tendrías que revisarlo a mano.');
        }
        if (codigo !== 'auth/uid-already-exists') {
          console.error('[Admin restaurar] No se pudo crear la cuenta de acceso:', e && e.message);
          throw errorHttp(502, 'No se pudo volver a crear la cuenta de acceso. No se restauró nada; inténtalo de nuevo.');
        }
      }
    }
    // 2) Documentos respaldados
    const escribir = (coleccion, datos) => (datos ? db.collection(coleccion).doc(uid).set(datos) : null);
    await ref.set({ ...(r.miembro || {}), restauradoEn: aTs(new Date()) });
    await Promise.all([
      escribir('usuarios', r.usuario), escribir('directorio', r.directorio), escribir('retosUsuario', r.retos),
      escribir('premiosUsuario', r.premios), escribir('actividadUsuario', r.actividad),
      ...Object.entries(r.progreso || {}).map(([cursoId, d]) => ref.collection('progresoCursos').doc(cursoId).set(d))
    ].filter(Boolean));
    await rr.set({ estado: 'restaurado', restauradoEn: aTs(new Date()), restauradoPor: decoded.uid, restauradoPorCorreo: miembrosAdm.normalizarCorreo(decoded.email).slice(0, 160) }, { merge: true });
    cache.clear();
    await anotarAccion(decoded, 'restaurar-miembro', uid, `Restauró a ${nombreDe(r.miembro || {})} (eliminada el ${panel.aIso(r.eliminadoEn) ? panel.aIso(r.eliminadoEn).slice(0, 10) : 'antes'})`, { cuentaCreada });
    return res.json({ ok: true, cuentaCreada, aviso: 'La contraseña no se guarda: la persona debe usar «Olvidé mi contraseña» para entrar de nuevo.' });
  }, { escritura: true }));

  // ════════════════════════════════════════════════════════════
  // MÉTRICAS
  // ════════════════════════════════════════════════════════════
  const progresoTodos = refr => conCache('progresoTodos', async () => {
    const lista = [];
    if (typeof db.collectionGroup === 'function') {
      const snap = await db.collectionGroup('progresoCursos').limit(20000).get();
      for (const d of snap.docs) {
        const data = d.data() || {};
        const dueno = (d.ref && d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id) || data.uid;
        if (dueno) lista.push({ uid: String(dueno), cursoId: String(data.cursoId || d.id), data });
      }
      return lista;
    }
    const mi = await miembros(false);
    const uids = mi.docs.slice(0, PROGRESO_TOPE_MIEMBROS).map(d => d.id);
    for (let i = 0; i < uids.length; i += 10) {
      await Promise.all(uids.slice(i, i + 10).map(async uid => {
        try {
          const s = await db.collection('miembros').doc(uid).collection('progresoCursos').get();
          for (const d of s.docs) { const data = d.data() || {}; lista.push({ uid, cursoId: String(data.cursoId || d.id), data }); }
        } catch (_) { /* esa persona se omite */ }
      }));
    }
    return lista;
  }, refr);

  const pruebasLista = refr => conCache('pruebasGratuitas', () => leerColeccion('pruebasGratuitas'), refr);

  const titulosCursos = async () => {
    const mapa = await cursosCompletos(false);
    return new Map([...mapa].map(([id, c]) => [id, String((c && (c.title || c.titulo)) || id).slice(0, 140)]));
  };

  app.get('/api/admin/metricas', conAdmin('No se pudieron cargar las métricas', 'metricas', async (req, res) => {
    const r = refrescar(req);
    const [mi, ce, rt, pr, prog, cursos, config] = await Promise.all([
      miembros(r), certificados(r), conCache('retosUsuario', () => leerColeccion('retosUsuario'), r),
      pruebasLista(r), progresoTodos(r), titulosCursos(), leerConfig(r)
    ]);
    const ahora = new Date();
    let primerDia = null;
    for (const { data } of mi.docs) { const f = panel.aFecha(data && data.createdAt); if (f) { const d = panel.diaMexico(f); if (!primerDia || d < primerDia) primerDia = d; } }
    const rango = metricas.resolverRango({ desde: req.query.desde, hasta: req.query.hasta, ahora, primerDia });
    let filasVisitas = [];
    try {
      const snap = await db.collection('visitasDiarias').where('dia', '>=', rango.desde).where('dia', '<=', rango.hasta).limit(800).get();
      filasVisitas = snap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
    } catch (_) { filasVisitas = []; }
    const datos = metricas.construirMetricas({
      miembros: mi.docs, certificados: ce.docs, retos: rt.docs, pruebas: pr.docs, progreso: prog, cursos,
      visitas: filasVisitas, visitasActivo: config.contadorVisitas, rango, ahora, tieneAcceso
    });
    return res.json({ ok: true, generado: ahora.toISOString(), truncado: Boolean(mi.truncado || ce.truncado), ...datos });
  }));

  // ════════════════════════════════════════════════════════════
  // PRUEBAS GRATUITAS
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/pruebas', conAdmin('No se pudieron cargar las pruebas gratuitas', 'pruebas', async (req, res) => {
    const r = refrescar(req);
    const [mi, pr, cursosMapa] = await Promise.all([miembros(r), pruebasLista(r), cursosCompletos(r)]);
    const ahora = new Date();
    const porUid = new Map(mi.docs.map(d => [d.id, d.data]));
    const cursos = new Map([...cursosMapa].map(([id, c]) => {
      const clases = Array.isArray(c && c.lecciones) && c.lecciones.length ? c.lecciones.length : (Number(c && c.totalClases) > 0 ? Math.floor(Number(c.totalClases)) : 0);
      return [id, { titulo: String((c && (c.title || c.titulo)) || id).slice(0, 140), clases }];
    }));
    const docs = pr.docs.slice(0, PRUEBAS_TOPE);
    const progreso = new Map();
    for (let i = 0; i < docs.length; i += 10) {
      await Promise.all(docs.slice(i, i + 10).map(async ({ id, data }) => {
        const uid = String((data && data.uid) || id); const cursoId = String((data && data.cursoId) || '');
        if (!cursoId || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !/^[A-Za-z0-9_-]{1,128}$/.test(cursoId)) return;
        try {
          const s = await db.collection('miembros').doc(uid).collection('progresoCursos').doc(cursoId).get();
          if (s.exists) progreso.set(`${uid}|${cursoId}`, s.data() || {});
        } catch (_) { /* sin avance */ }
      }));
    }
    const resultado = metricas.construirPruebas({ pruebas: docs, miembros: porUid, todosMiembros: mi.docs, progreso, cursos, tieneAcceso, ahora });
    const sinElegir = metricas.calcularSinElegir({ miembros: mi.docs, eleccionesUids: new Set(pr.docs.map(d => String((d.data && d.data.uid) || d.id))) });
    return res.json({ ok: true, truncado: pr.docs.length > PRUEBAS_TOPE, ...resultado, sinElegir });
  }));

  // ════════════════════════════════════════════════════════════
  // ENCUESTA y preguntas sin respuesta: lectura con id y acciones
  // ════════════════════════════════════════════════════════════
  const mascara = numero => {
    const d = String(numero || '').replace(/\D/g, '');
    return d.length >= 8 ? `••• ••• ${d.slice(-4)}` : '';
  };

  app.get('/api/admin/encuesta/detalle', conAdmin('No se pudo leer la encuesta', 'encuesta-detalle', async (req, res) => {
    const limite = enc.limiteDeConsulta(req.query.limite, 1000, 2000);
    const snap = await db.collection('encuestasProspectos').orderBy('creado', 'desc').limit(limite).get();
    return res.json({
      ok: true,
      docs: snap.docs.map(d => {
        const datos = d.data() || {};
        const fila = enc.filaEncuesta(datos);
        const numero = fila.contacto;
        delete fila.contacto;
        return {
          ...fila, id: d.id, tieneContacto: Boolean(numero), contactoMascara: mascara(numero),
          atendida: datos.atendida === true, atendidaEn: panel.aIso(datos.atendidaEn)
        };
      })
    });
  }));

  app.get('/api/admin/encuesta/:id/contacto', conAdmin('No se pudo leer el contacto', 'encuesta-contacto', async (req, res, decoded) => {
    const id = String(req.params.id || '');
    if (!ID_ENCUESTA.test(id)) throw errorHttp(400, 'El identificador no es válido');
    const snap = await db.collection('encuestasProspectos').doc(id).get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos esa respuesta');
    const numero = String((snap.data() || {}).contacto || '').replace(/\D/g, '');
    if (!numero) throw errorHttp(404, 'Esa respuesta no dejó un número');
    await anotarAccion(decoded, 'ver-contacto-encuesta', id, 'Vio el WhatsApp de una respuesta de la encuesta');
    return res.json({ ok: true, contacto: numero });
  }));

  const listaDe = (cuerpo, campo, patron) => {
    const lista = cuerpo && Array.isArray(cuerpo[campo]) ? cuerpo[campo] : null;
    if (!lista || !lista.length || lista.length > LOTE_BORRAR) throw errorHttp(400, `Envía entre 1 y ${LOTE_BORRAR} elementos`);
    const limpia = [...new Set(lista.map(x => (typeof x === 'string' ? x.trim() : '')))];
    if (limpia.some(x => !patron.test(x))) throw errorHttp(400, 'Hay un identificador que no es válido');
    return limpia;
  };
  const booleano = (cuerpo, campo, defecto) => {
    if (cuerpo[campo] === undefined) return defecto;
    if (typeof cuerpo[campo] !== 'boolean') throw errorHttp(400, 'Los datos enviados no son válidos');
    return cuerpo[campo];
  };

  // Marca como atendidas (o quita la marca) y borra con copia previa en adminPapelera
  function montarAtenderBorrar({ rutaBase, coleccion, campoLista, patron, etiqueta, texto }) {
    app.post(`${rutaBase}/atender`, analizadorJson, conAdmin(`No se pudo actualizar ${texto}`, `${etiqueta}-atender`, async (req, res, decoded) => {
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const ids = listaDe(cuerpo, campoLista, patron);
      const atendida = booleano(cuerpo, 'atendida', true);
      let n = 0;
      for (const id of ids) {
        const ref = db.collection(coleccion).doc(id);
        if (!(await ref.get()).exists) continue;
        await ref.set(atendida ? { atendida: true, atendidaEn: FieldValue.serverTimestamp(), atendidaPor: decoded.uid } : { atendida: false, atendidaEn: null }, { merge: true });
        n += 1;
      }
      if (n) await anotarAccion(decoded, `${etiqueta}-atender`, ids[0], `${atendida ? 'Marcó como atendidas' : 'Quitó la marca de atendida a'} ${n} ${texto}`, { n, atendida });
      return res.json({ ok: true, actualizadas: n });
    }, { escritura: true }));

    app.post(`${rutaBase}/borrar`, analizadorJson, conAdmin(`No se pudo borrar ${texto}`, `${etiqueta}-borrar`, async (req, res, decoded) => {
      const ids = listaDe(req.body, campoLista, patron);
      let n = 0;
      for (const id of ids) {
        const ref = db.collection(coleccion).doc(id);
        const s = await ref.get();
        if (!s.exists) continue;
        // Copia previa: si fue un error, el dato se puede recuperar de adminPapelera
        await db.collection('adminPapelera').doc(`${etiqueta}__${id}`.slice(0, 200)).set({
          coleccion, id, datos: miembrosAdm.copiaLimpia(s.data() || {}), borradoEn: aTs(new Date()), borradoPor: decoded.uid
        });
        await ref.delete();
        n += 1;
      }
      if (n) await anotarAccion(decoded, `${etiqueta}-borrar`, ids[0], `Borró ${n} ${texto} (queda copia en adminPapelera)`, { n });
      return res.json({ ok: true, borradas: n });
    }, { escritura: true }));
  }
  montarAtenderBorrar({ rutaBase: '/api/admin/encuesta', coleccion: 'encuestasProspectos', campoLista: 'ids', patron: ID_ENCUESTA, etiqueta: 'encuesta', texto: 'respuestas de la encuesta' });
  montarAtenderBorrar({ rutaBase: '/api/admin/chatbot/sin-respuesta', coleccion: 'chatbotSinRespuesta', campoLista: 'claves', patron: CLAVE_CHATBOT, etiqueta: 'chatbot', texto: 'preguntas sin respuesta' });

  app.get('/api/admin/chatbot/sin-respuesta/detalle', conAdmin('No se pudieron leer las preguntas', 'chatbot-detalle', async (req, res) => {
    const limite = enc.limiteDeConsulta(req.query.limite, 200, 1000);
    const snap = await db.collection('chatbotSinRespuesta').orderBy('veces', 'desc').limit(limite).get();
    return res.json({
      ok: true,
      preguntas: snap.docs.map(d => {
        const datos = d.data() || {};
        return { ...enc.filaSinRespuesta(datos), clave: d.id, atendida: datos.atendida === true, atendidaEn: panel.aIso(datos.atendidaEn) };
      })
    });
  }));

  // ════════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/config', conAdmin('No se pudo leer la configuración', 'config', async (req, res) => {
    const mi = await miembros(refrescar(req));
    const config = await leerConfig(true);
    const porDocumento = mi.docs.filter(d => d.data && d.data.role === 'admin').slice(0, 20)
      .map(d => ({ nombre: nombreDe(d.data), correo: panel.enmascararCorreo(d.data.email) }));
    let dias7 = 0;
    try {
      const hasta = panel.diaMexico(new Date()); const desde = metricas.sumarDias(hasta, -6);
      const snap = await db.collection('visitasDiarias').where('dia', '>=', desde).where('dia', '<=', hasta).limit(10).get();
      dias7 = snap.docs.reduce((t, d) => t + (Number((d.data() || {}).total) || 0), 0);
    } catch (_) { dias7 = 0; }
    return res.json({
      ok: true, config,
      administradores: { porCorreo: [...correosAdministrador()].map(panel.enmascararCorreo).filter(Boolean), porDocumento },
      visitas: { activo: config.contadorVisitas, ultimos7Dias: dias7 },
      sitio: { leeConfigPublica: false }
    });
  }));

  app.post('/api/admin/config', analizadorJson, conAdmin('No se pudo guardar la configuración', 'config-guardar', async (req, res, decoded) => {
    const v = configAdm.validarCambios(req.body);
    if (v.error) throw errorHttp(400, v.error);
    await db.collection('config').doc('panel').set({
      ...v.cambios, actualizadoEn: FieldValue.serverTimestamp(), actualizadoPor: decoded.uid,
      actualizadoPorCorreo: miembrosAdm.normalizarCorreo(decoded.email).slice(0, 160)
    }, { merge: true });
    configCache = null;
    const config = await leerConfig(true);
    await anotarAccion(decoded, 'guardar-config', 'config/panel', `Cambió la configuración: ${Object.keys(v.cambios).join(', ')}`, { claves: Object.keys(v.cambios) });
    return res.json({ ok: true, config });
  }, { escritura: true }));

  // ── Públicas ──
  app.get('/api/config-publica', async (req, res) => {
    try {
      const config = await leerConfig(false);
      res.set('Cache-Control', 'public, max-age=60');
      return res.json({ ok: true, ...configAdm.vistaPublica(config) });
    } catch (_) {
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, clasesEnVivoPronto: null, avisoGlobal: null });
    }
  });

  const analizadorVisita = express.json({ limit: '1kb', type: ['application/json', 'text/plain'] });
  app.post('/api/visita', (req, res) => {
    // El contador nunca debe estorbar a quien visita: siempre 204, cuente o no la visita.
    analizadorVisita(req, res, async () => {
      try {
        if (visitas.visitaNoRastreable(req.headers)) return res.status(204).end();
        const ip = referidos.ipDeSolicitud(req.headers, req.ip) || 'desconocida';
        if (!permitirSolicitud(limitesPublicos.visitas, ip, VENTANA_VISITAS_MS, VISITAS_POR_IP) ||
            !permitirSolicitud(limitesPublicos.visitasGlobal, 'global', VENTANA_VISITAS_MS, VISITAS_GLOBAL)) return res.status(204).end();
        const config = await leerConfig(false);
        if (!config.contadorVisitas) return res.status(204).end();
        let cuerpo = req.body;
        if (typeof cuerpo === 'string') { try { cuerpo = JSON.parse(cuerpo); } catch (_) { cuerpo = {}; } }
        await visitas.registrarVisita(db, FieldValue, { pagina: cuerpo && cuerpo.pagina });
      } catch (e) {
        console.error('[Visitas] No se registró la visita:', e && e.message);
      }
      return res.status(204).end();
    });
  });

  return { limpiarConfig: () => { configCache = null; } };
}

module.exports = { montarRutasAdminExtra };
