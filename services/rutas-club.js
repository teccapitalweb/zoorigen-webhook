'use strict';

// ══ RUTAS DEL CLUB: logros, premios, retos, referidos y directorio ══
// Pegamento entre Express/Firestore y las reglas puras de services/. server.js llama a
// montarRutasClub(app, deps) pasando lo que ya existe (autenticarFirebase, esAdminPorDocumentos,
// tienePlanVigente, obtenerIndiceVideos...).
//
// Seguridad: todas las colecciones que usa este archivo son SOLO DEL SERVIDOR (las reglas de
// Firestore niegan lo que no listan): retosUsuario, premiosUsuario, actividadUsuario, referidos,
// dispositivosAnfitrion, codigosReferido, directorio. El navegador solo pregunta; nunca decide.

const logros = require('./logros');
const retos = require('./retos');
const premios = require('./premios');
const referidos = require('./referidos');
const directorio = require('./directorio');
const avisos = require('./avisos');
const libros = require('./libros');

// Límite de solicitudes por clave en una ventana (memoria del proceso; suficiente para frenar abusos).
function permitirSolicitud(mapa, clave, ventanaMs, maximo) {
  const ahora = Date.now();
  if (mapa.size > 5000) {
    for (const [k, v] of mapa) if (ahora >= v.hasta) mapa.delete(k);
  }
  const actual = mapa.get(clave);
  if (!actual || ahora >= actual.hasta) { mapa.set(clave, { cantidad: 1, hasta: ahora + ventanaMs }); return true; }
  actual.cantidad += 1;
  return actual.cantidad <= maximo;
}

function montarRutasClub(app, deps) {
  const {
    express, db, auth, admin, autenticarFirebase, esAdminPorDocumentos, tienePlanVigente,
    obtenerIndiceVideos, leerEleccionPrueba, errorHttp, catalogoLibros
  } = deps;
  const FieldValue = admin.firestore.FieldValue;

  const limites = { lecturas: new Map(), retos: new Map(), premios: new Map(), referidos: new Map(), directorio: new Map() };
  const CAMBIOS_DIRECTORIO_POR_MINUTO = 20;
  const REGISTROS_POR_MINUTO = 10;
  const LECTURAS_POR_MINUTO = 60;
  const RETOS_POR_MINUTO = 60;       // contrato: 60 solicitudes por minuto por usuario
  const CANJES_POR_MINUTO = 10;

  const ENLACE_LOGROS = 'club-logros.html';
  const sinMembresia = mensaje => Object.assign(errorHttp(403, mensaje), { codigo: 'membresia-requerida' });

  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) {
      const cuerpo = { error: err.message };
      if (err.codigo) cuerpo.codigo = err.codigo;
      return res.status(err.status).json(cuerpo);
    }
    console.error(`[Club ${etiqueta || 'api'}]`, err);
    return res.status(500).json({ error: mensajeGenerico });
  }

  const limitar = (mapa, uid, maximo) => {
    if (!permitirSolicitud(mapa, uid, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };

  // ── Contexto de la persona: ¿administrador?, ¿membresía vigente? (mismas reglas de siempre) ──
  async function leerContexto(uid) {
    const [adminDoc, miembroDoc, usuarioDoc] = await Promise.all([
      db.collection('admins').doc(uid).get(),
      db.collection('miembros').doc(uid).get(),
      db.collection('usuarios').doc(uid).get()
    ]);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    return {
      uid, esAdmin, tienePlan, membresia: esAdmin || tienePlan,
      miembro: miembroDoc.exists ? miembroDoc.data() : null,
      usuario: usuarioDoc.exists ? usuarioDoc.data() : null
    };
  }

  // ── Actividad: día activo (fecha de México, últimos 120) ──
  const DIAS_ACTIVIDAD = 120;
  async function registrarDiaActivo(uid, ahora = new Date()) {
    const ref = db.collection('actividadUsuario').doc(uid);
    const hoy = logros.fechaMexico(ahora);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const dias = snap.exists && Array.isArray(snap.data().dias) ? snap.data().dias.filter(d => typeof d === 'string') : [];
      if (dias.includes(hoy)) return dias;
      const nuevos = [...dias, hoy].sort().slice(-DIAS_ACTIVIDAD);
      tx.set(ref, { uid, dias: nuevos, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
      return nuevos;
    });
  }

  // ── Datos verificables para los logros ──
  // Los certificados y el foro los escribe el navegador (reglas de Firestore): son MENOS
  // confiables que los retos o los referidos. Por eso cada certificado solo cuenta si su curso
  // existe de verdad en `cursos`, un curso se cuenta una vez, y el XP tiene techo por tabla.
  async function datosParaLogros(ctx, dias, invitadosValidos) {
    const uid = ctx.uid;
    const indice = await obtenerIndiceVideos();
    const [certSnap, postsSnap, dirSnap] = await Promise.all([
      db.collection('certificados').where('memberUid', '==', uid).limit(200).get(),
      db.collection('foroPosts').where('authorUid', '==', uid).limit(200).get(),
      db.collection('directorio').doc(uid).get()
    ]);
    const existe = id => Boolean(indice.datos && indice.datos.get(id));
    const cursosLista = logros.cursosTerminados(
      certSnap.docs.map(doc => { const c = doc.data() || {}; return { courseId: c.courseId, folio: c.folio || doc.id, fecha: c.issuedAt }; }),
      existe);
    const areas = new Set();
    for (const c of cursosLista) { const curso = indice.datos.get(c.courseId); if (curso && curso.area) areas.add(curso.area); }
    let foroRespuestas = 0; let foroLikes = 0;
    for (const doc of postsSnap.docs) {
      const post = doc.data() || {};
      foroRespuestas += Math.min(50, Math.max(0, Number(post.repliesCount) || 0));
      const likes = Array.isArray(post.likes) ? post.likes : [];
      // Sin contar los me gusta que la propia persona se da, ni repetidos
      foroLikes += new Set(likes.filter(u => typeof u === 'string' && u !== uid)).size;
    }
    return {
      esVIP: ctx.membresia,
      completados: cursosLista.length,
      cursosLista,
      areas: areas.size,
      dias,
      tarjetaDir: dirSnap.exists,
      foroPosts: postsSnap.docs.length,
      foroRespuestas,
      foroLikes,
      invitadosValidos
    };
  }

  // ── Referidos ──
  // referidos/{uidInvitado}, dispositivosAnfitrion/{uid} y codigosReferido/{CODIGO}: solo del servidor.
  const MAX_INVITADOS_LEIDOS = 200;
  const ESTADOS = referidos.ESTADOS;

  async function leerUsuariosAuth(uids) {
    const mapa = new Map();
    for (let i = 0; i < uids.length; i += 100) {
      try {
        const r = await auth.getUsers(uids.slice(i, i + 100).map(uid => ({ uid })));
        for (const u of r.users || []) {
          mapa.set(u.uid, { emailVerified: u.emailVerified === true, creationTime: u.metadata && u.metadata.creationTime });
        }
      } catch (error) {
        console.error('[Club referidos] No se pudo consultar Firebase Auth:', error && error.message);
      }
    }
    return mapa;
  }

  // Código -> uid del anfitrión. Primero el registro de códigos; si no está (códigos viejos que nadie
  // ha abierto aún), busca el miembro cuyo id empieza con esas 6 letras (todas las combinaciones de
  // mayúsculas y minúsculas) y deja el código registrado para la próxima.
  async function buscarAnfitrion(codigo) {
    const registro = await db.collection('codigosReferido').doc(codigo).get();
    const uidRegistrado = registro.exists ? registro.data().uid : null;
    if (typeof uidRegistrado === 'string' && uidRegistrado) {
      if ((await db.collection('miembros').doc(uidRegistrado).get()).exists) return uidRegistrado;
    }
    const id = admin.firestore.FieldPath.documentId();
    const consultas = referidos.variantesDePrefijo(codigo).map(p =>
      db.collection('miembros').where(id, '>=', p).where(id, '<', p + '\uf8ff').limit(1).get());
    const encontrado = (await Promise.all(consultas)).flatMap(r => r.docs).find(d => referidos.codigoDeUid(d.id) === codigo);
    if (!encontrado) return null;
    await db.collection('codigosReferido').doc(codigo).set({ uid: encontrado.id, codigo, creadoEn: FieldValue.serverTimestamp() });
    return encontrado.id;
  }

  async function asegurarCodigo(uid) {
    const codigo = referidos.codigoDeUid(uid);
    const ref = db.collection('codigosReferido').doc(codigo);
    const actual = await ref.get();
    if (!actual.exists) await ref.set({ uid, codigo, creadoEn: FieldValue.serverTimestamp() });
    return codigo;
  }

  // Dispositivos conocidos del anfitrión: los que guardó al abrir su pantalla de referidos más el
  // dispositivo con el que él mismo se registró como invitado (si lo hizo).
  async function dispositivosDeAnfitrion(uid) {
    const [guardado, propio] = await Promise.all([
      db.collection('dispositivosAnfitrion').doc(uid).get(),
      db.collection('referidos').doc(uid).get()
    ]);
    let disp = referidos.normalizarDispositivosAnfitrion(guardado.exists ? guardado.data() : null);
    if (propio.exists) disp = referidos.agregarDispositivo(disp, propio.data());
    return disp;
  }

  async function guardarDispositivoAnfitrion(uid, dispositivo) {
    const ref = db.collection('dispositivosAnfitrion').doc(uid);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const actual = snap.exists ? snap.data() : null;
      const nuevo = referidos.agregarDispositivo(actual, dispositivo);
      const previo = referidos.normalizarDispositivosAnfitrion(actual);
      if (snap.exists && JSON.stringify(nuevo) === JSON.stringify(previo)) return;
      tx.set(ref, { uid, ...nuevo, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  const idDe = req => {
    const v = req.get('x-device-id');
    return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.trim()) ? v.trim() : null;
  };

  // Pone al día los invitados de un anfitrión y los devuelve (del más antiguo al más nuevo):
  //  · pendiente-correo -> valido (o rechazado) cuando Firebase Auth dice que ya confirmó su correo
  //  · hitos (pagó, 5 retos, 15 retos) de los invitados válidos que suman XP; un hito logrado no se pierde
  async function sincronizarInvitados(hostUid) {
    const snap = await db.collection('referidos').where('anfitrionUid', '==', hostUid).limit(MAX_INVITADOS_LEIDOS).get();
    const invitados = referidos.ordenarInvitados(snap.docs.map(d => ({ ...d.data(), uid: d.id })));
    if (!invitados.length) return invitados;

    const pendientes = invitados.filter(i => i.estado === ESTADOS.PENDIENTE);
    if (pendientes.length) {
      const dispositivos = await dispositivosDeAnfitrion(hostUid);
      const verificados = await leerUsuariosAuth(pendientes.map(i => i.uid));
      // Un invitado que confirma su correo solo cuenta si quien lo invitó sigue con membresía vigente.
      // Si no la tiene, se queda pendiente (no se rechaza): cuenta cuando su anfitrión renueve.
      let anfitrionEsMiembro = null;
      for (const i of pendientes) {
        const info = verificados.get(i.uid);
        if (!info || !info.emailVerified) continue;
        if (anfitrionEsMiembro === null) anfitrionEsMiembro = (await leerContexto(hostUid)).membresia;
        if (!anfitrionEsMiembro) continue;
        const motivo = referidos.evaluarDispositivo({ ...i, anfitrionUid: hostUid }, dispositivos, invitados);
        const cambios = motivo ? { estado: ESTADOS.RECHAZADO, motivo: referidos.MOTIVOS[motivo] } : { estado: ESTADOS.VALIDO, motivo: null };
        await db.collection('referidos').doc(i.uid).set(cambios, { merge: true });
        Object.assign(i, cambios);
      }
    }

    // Hitos: solo los primeros invitados válidos que suman XP
    const conXp = invitados.filter(i => i.estado === ESTADOS.VALIDO).slice(0, referidos.MAX_INVITADOS_CON_XP);
    if (conXp.length) {
      const refs = conXp.flatMap(i => [
        db.collection('miembros').doc(i.uid), db.collection('usuarios').doc(i.uid), db.collection('retosUsuario').doc(i.uid)
      ]);
      const docs = await db.getAll(...refs);
      for (const [n, i] of conXp.entries()) {
        const [miembroDoc, usuarioDoc, retosDoc] = docs.slice(n * 3, n * 3 + 3);
        const pago = referidos.invitadoPago(
          miembroDoc.exists ? miembroDoc.data() : null, usuarioDoc.exists ? usuarioDoc.data() : null, tienePlanVigente(miembroDoc, usuarioDoc));
        const retosSuperados = retos.normalizarEstado(retosDoc.exists ? retosDoc.data() : null).superados;
        const { hitos, nuevos } = referidos.actualizarHitos(i.hitos, { pago, retosSuperados });
        if (nuevos.length) await db.collection('referidos').doc(i.uid).set({ hitos }, { merge: true });
        i.hitos = hitos;
      }
    }
    return invitados;
  }

  async function resumenReferidos(uid) {
    const invitados = await sincronizarInvitados(uid);
    const r = referidos.resumirInvitados(invitados);
    return { validos: r.validos, xp: r.xp };
  }

  // ── Premios guardados (colección premiosUsuario, solo servidor) ──
  async function leerPremiosGuardados(uid) {
    const snap = await db.collection('premiosUsuario').doc(uid).get();
    return premios.normalizarGuardado(snap.exists ? snap.data() : null);
  }

  // Un premio ganado no se pierde aunque el XP baje: solo se AGREGAN claves a `ganados`, y dentro de
  // una transacción para no pisar un canje simultáneo. También deja el XP total para la clasificación.
  //
  // Avisos de la campana: `logrosGanados` y `cursosTerminados` (ids) se comparan con lo que ya se avisó
  // (logrosAvisados / cursosAvisados) para devolver solo los NUEVOS. Una cuenta que ya existía antes de los avisos
  // (ya tiene XP calculado) toma lo que tiene como punto de partida SIN avisar, para no llenarle la campana de cosas viejas.
  async function guardarProgreso(uid, { claves, xpTotal, conRanking, logrosGanados, cursosTerminados }) {
    const ref = db.collection('premiosUsuario').doc(uid);
    const r = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const actual = snap.exists ? (snap.data() || {}) : {};
      const guardado = premios.normalizarGuardado(actual);
      const nuevas = claves.filter(c => !guardado.ganados.includes(c));
      const cambios = {};
      if (nuevas.length || !snap.exists) cambios.ganados = [...guardado.ganados, ...nuevas];
      if (!snap.exists) cambios.usados = [];
      if (conRanking && actual.xpTotal !== xpTotal) cambios.xpTotal = xpTotal;

      const yaCalculada = snap.exists && (actual.xpTotal !== undefined || guardado.ganados.length > 0);
      const nuevosAvisos = { logrosNuevos: [], cursosNuevos: [] };
      for (const [campo, ids, salida] of [['logrosAvisados', logrosGanados, 'logrosNuevos'], ['cursosAvisados', cursosTerminados, 'cursosNuevos']]) {
        if (!Array.isArray(ids)) continue;
        const previos = Array.isArray(actual[campo]) ? actual[campo] : null;
        if (previos === null && yaCalculada) { cambios[campo] = ids; continue; }
        const base = previos || [];
        const nuevosIds = ids.filter(id => !base.includes(id));
        nuevosAvisos[salida] = nuevosIds;
        if (nuevosIds.length || previos === null) cambios[campo] = [...base, ...nuevosIds];
      }

      if (Object.keys(cambios).length) {
        tx.set(ref, { uid, ...cambios, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
      }
      return { ganados: cambios.ganados || guardado.ganados, usados: guardado.usados, nuevas, ...nuevosAvisos };
    });
    // Premios que se acaban de ganar -> aviso personal (no sobrescribe si ya existe; nunca lanza)
    for (const clave of r.nuevas) {
      const premio = premios.PREMIOS.find(p => p.clave === clave);
      await avisos.crearAviso(db, uid, {
        id: `premio_${clave}`, tipo: 'premio', titulo: '🎁 ¡Ganaste un premio!',
        texto: `${premio ? premio.titulo : 'Un premio nuevo'}: abre un curso antes de su fecha.`, enlace: ENLACE_LOGROS
      });
    }
    return r;
  }

  // Avisos por logros nuevos y por XP de cursos terminados (los premios los avisa guardarProgreso)
  async function avisarNovedades(uid, ev, guardado) {
    try {
      for (const id of guardado.logrosNuevos || []) {
        const logro = ev.logros.find(l => l.id === id);
        if (!logro) continue;
        await avisos.crearAviso(db, uid, {
          id: `logro_${id}`, tipo: 'logro', titulo: '🏅 ¡Nueva insignia!', texto: `${logro.nombre} · +${logro.xp} XP`, enlace: ENLACE_LOGROS
        });
      }
      for (const cursoId of guardado.cursosNuevos || []) {
        const curso = ev.cursos.lista.find(c => c.courseId === cursoId);
        if (!curso) continue;
        await avisos.crearAviso(db, uid, {
          id: `bonoxp_${cursoId}`, tipo: 'xp', titulo: '⭐ ¡Curso terminado!',
          texto: `Ganaste +${curso.xp} XP por terminar tu curso número ${curso.n}.`, enlace: ENLACE_LOGROS
        });
      }
    } catch (error) {
      console.error('[Club avisos] No se pudieron crear los avisos:', error && error.message);
    }
  }

  // ── Cálculo completo (nivel, XP, logros, premios) de una persona con membresía ──
  async function calcularResumen(ctx, { estadoRetos } = {}) {
    const uid = ctx.uid;
    const [dias, estado, referidosInfo, previo] = await Promise.all([
      registrarDiaActivo(uid),
      estadoRetos ? Promise.resolve(estadoRetos) : leerEstadoRetos(uid),
      resumenReferidos(uid),
      leerPremiosGuardados(uid)
    ]);
    const datos = { ...(await datosParaLogros(ctx, dias, referidosInfo.validos)), bienvenida: Boolean(previo.bienvenida) };
    const ev = logros.evaluar(datos, estado, referidosInfo.xp);
    const claves = premios.clavesQueCumple({ nivelId: ev.nivel.id, invitadosValidos: referidosInfo.validos });
    // Los administradores no reciben avisos de insignias ni de cursos (ya lo tienen todo abierto)
    const guardado = await guardarProgreso(uid, {
      claves, xpTotal: ev.xp.total, conRanking: !ctx.esAdmin,
      ...(ctx.esAdmin ? {} : { logrosGanados: ev.logros.filter(l => l.ganado).map(l => l.id), cursosTerminados: ev.cursos.lista.map(c => c.courseId) })
    });
    await avisarNovedades(uid, ev, guardado);
    return { ev, estadoRetos: estado, guardado, referidos: referidosInfo };
  }

  async function leerEstadoRetos(uid) {
    const snap = await db.collection('retosUsuario').doc(uid).get();
    return retos.normalizarEstado(snap.exists ? snap.data() : null);
  }

  const NIVEL_VISTA_PREVIA = logros.infoNivel(0);

  // ── Premio de bienvenida: la fecha de creación de la cuenta la da Firebase Auth (no el navegador) ──
  // Nunca cambia, así que se recuerda en memoria para no consultar Auth en cada GET.
  const creaciones = new Map();
  async function creacionDeCuenta(uid) {
    if (creaciones.has(uid)) return creaciones.get(uid);
    let info;
    try { info = await auth.getUser(uid); } catch (error) {
      if (error && error.code === 'auth/user-not-found') return null;
      throw error;
    }
    const t = (info && info.metadata && info.metadata.creationTime) || null;
    if (t) { if (creaciones.size > 5000) creaciones.clear(); creaciones.set(uid, t); }
    return t;
  }

  // ¿Se le puede ofrecer el premio de bienvenida? (cuenta nueva, sin reclamar y no administrador).
  // Si Auth no responde, simplemente no se ofrece: no debe tumbar la pantalla de premios.
  async function bienvenidaOfrecida(ctx, reclamado) {
    if (ctx.esAdmin || reclamado) return false;
    try { return premios.bienvenidaDisponible(await creacionDeCuenta(ctx.uid)); } catch (error) {
      console.error('[Club premios] No se pudo consultar la fecha de creación de la cuenta:', error && error.message);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  // GET /api/premios — nivel, XP, logros y premios
  // ════════════════════════════════════════════════════════════
  app.get('/api/premios', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);

      // Sin membresía: vista previa. No se calcula ni se escribe nada.
      if (!ctx.membresia) {
        const guardado = await leerPremiosGuardados(decoded.uid);
        const lista = premios.armarPremios({ ...guardado, membresia: false });
        const disponible = await bienvenidaOfrecida(ctx, Boolean(guardado.bienvenida));
        return res.json({
          ok: true, membresia: false, nivel: NIVEL_VISTA_PREVIA, niveles: logros.listaNiveles(),
          xp: { total: 0, logros: 0, retos: 0, referidos: 0, cursos: 0, bienvenida: 0 }, cursos: { terminados: 0, lista: [] },
          bienvenida: { disponible, xp: logros.XP_BIENVENIDA },
          racha: 0, diasActivos: 0, logros: logros.logrosVistaPrevia(), premios: lista, disponibles: 0
        });
      }

      const { ev, guardado } = await calcularResumen(ctx);
      const lista = premios.armarPremios({ ganados: guardado.ganados, usados: guardado.usados, membresia: ctx.tienePlan });
      const reclamado = ev.xp.bienvenida > 0;
      const disponible = await bienvenidaOfrecida(ctx, reclamado);
      return res.json({
        ok: true, membresia: true, nivel: ev.nivel, niveles: logros.listaNiveles(), xp: ev.xp, cursos: ev.cursos,
        bienvenida: { disponible, xp: logros.XP_BIENVENIDA, reclamado }, racha: ev.racha, diasActivos: ev.diasActivos,
        logros: ev.logros, premios: lista, disponibles: lista.filter(p => p.disponible).length
      });
    } catch (error) {
      return responderError(res, error, 'No se pudieron cargar tus logros y premios', 'premios');
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /api/premios/bienvenida — +100 XP por ser una cuenta nueva (una sola vez)
  // ════════════════════════════════════════════════════════════
  // Sin membresía se permite (el XP queda guardado y cuenta cuando se suscriba). Solo cuentas creadas
  // hace 14 días o menos según Firebase Auth. Idempotente: se guarda en premiosUsuario/{uid}.bienvenida
  // dentro de una transacción, así dos solicitudes a la vez pagan una sola vez.
  app.post('/api/premios/bienvenida', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      const uid = decoded.uid;
      limitar(limites.premios, uid, CANJES_POR_MINUTO);
      const ctx = await leerContexto(uid);
      if (ctx.esAdmin) throw errorHttp(403, 'Las cuentas de administrador no reciben el premio de bienvenida');

      const ref = db.collection('premiosUsuario').doc(uid);
      if (!(await leerPremiosGuardados(uid)).bienvenida) {
        let creacion;
        try { creacion = await creacionDeCuenta(uid); } catch (error) {
          console.error('[Club premios] No se pudo consultar Firebase Auth:', error && error.message);
          throw errorHttp(503, 'No pudimos verificar tu cuenta. Intenta de nuevo en un momento');
        }
        if (!premios.bienvenidaDisponible(creacion)) {
          throw errorHttp(403, 'El premio de bienvenida es solo para cuentas nuevas (hasta ' + premios.DIAS_CUENTA_NUEVA + ' días después de registrarte)');
        }
      }
      const yaReclamado = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const actual = snap.exists ? (snap.data() || {}) : {};
        if (premios.normalizarGuardado(actual).bienvenida) return true;
        const inicio = snap.exists ? {} : { ganados: [], usados: [] };
        tx.set(ref, { uid, ...inicio, bienvenida: { fecha: new Date().toISOString() }, actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
        return false;
      });
      if (!yaReclamado) {
        await avisos.crearAviso(db, uid, {
          id: 'bono_bienvenida', tipo: 'bienvenida', titulo: '👋 ¡Bienvenido al club!',
          texto: `Recibiste +${logros.XP_BIENVENIDA} XP de regalo por tu cuenta nueva.`, enlace: ENLACE_LOGROS
        });
      }

      // Con membresía se devuelve el XP total real; sin ella solo cuenta lo guardado (los 100 de bienvenida)
      let xpTotal = logros.XP_BIENVENIDA;
      let nivel = logros.infoNivel(xpTotal);
      if (ctx.membresia) { const { ev } = await calcularResumen(ctx); xpTotal = ev.xp.total; nivel = ev.nivel; }
      return res.json({ ok: true, xp: logros.XP_BIENVENIDA, yaReclamado, xpTotal, nivel });
    } catch (error) {
      return responderError(res, error, 'No se pudo darte el premio de bienvenida', 'premios');
    }
  });

  // ════════════════════════════════════════════════════════════
  // RETOS
  // ════════════════════════════════════════════════════════════
  const CAMINO_VACIO = Object.freeze({ quiz: 0, detective: 0, orden: 0 });
  const HECHOS_VACIO = () => ({ quiz: [], detective: [], orden: [] });

  function vistaRetos(estado) {
    const hoy = logros.fechaMexico();
    return {
      superados: estado.superados,
      porReto: retos.resumenPorReto(estado),
      camino: estado.camino,
      caminoHechos: estado.caminoHechos,
      retosHoy: estado.retosHoy.fecha === hoy ? estado.retosHoy.ids : [],
      totales: retos.TOTALES_CAMINO
    };
  }

  // GET /api/retos — progreso de la persona (y registra el día activo)
  app.get('/api/retos', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) {
        return res.json({
          ok: true, membresia: false, nivel: NIVEL_VISTA_PREVIA, xp: 0, superados: 0, porReto: {},
          camino: { ...CAMINO_VACIO }, caminoHechos: HECHOS_VACIO(), retosHoy: [], totales: retos.TOTALES_CAMINO
        });
      }
      const { ev, estadoRetos } = await calcularResumen(ctx);
      return res.json({ ok: true, membresia: true, nivel: ev.nivel, xp: ev.xp.total, ...vistaRetos(estadoRetos) });
    } catch (error) {
      return responderError(res, error, 'No se pudieron cargar tus retos', 'retos');
    }
  });

  // Lee, aplica y guarda el estado de retos dentro de una transacción (dos solicitudes a la vez no se pisan)
  async function guardarRetos(uid, aplicar) {
    const ref = db.collection('retosUsuario').doc(uid);
    let salida;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const antes = retos.normalizarEstado(snap.exists ? snap.data() : null);
      const r = aplicar(antes);
      salida = { antes, ...r };
      if (r.guardar !== false) tx.set(ref, { ...r.estado, uid, actualizadoEn: FieldValue.serverTimestamp() });
    });
    return salida;
  }

  // Libros de lectura que se desbloquean con retos: tras un avance se devuelve la lista (sin páginas) y los recién
  // cruzados, y se crean los avisos de la campana. Nunca lanza; sin catálogo de libros no agrega nada.
  async function novedadesLibros(ctx, antes, despues) {
    try {
      if (!catalogoLibros) return {};
      const estado = { superados: despues.superados, membresia: ctx.membresia, esAdmin: ctx.esAdmin };
      const nuevos = ctx.esAdmin ? [] : libros.librosNuevos(catalogoLibros.libros, antes, despues);
      if (despues.superados > antes.superados) await libros.avisarLibros(db, ctx.uid, catalogoLibros.libros, estado);
      return { libros: libros.resumenLibros(catalogoLibros.libros, estado), librosNuevos: nuevos.map(l => l.id) };
    } catch (error) {
      console.error('[Club libros] No se pudieron calcular los libros nuevos:', error && error.message);
      return {};
    }
  }

  const resumenInsignias = lista => lista.map(i => ({ id: i.id, nombre: i.nombre }));

  // POST /api/retos/resultado — práctica diaria (XP una vez por reto por día)
  app.post('/api/retos/resultado', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.retos, decoded.uid, RETOS_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const datos = { retoId: cuerpo.retoId, puntaje: cuerpo.puntaje, total: cuerpo.total };
      const invalido = retos.validarResultado(datos);
      if (invalido) throw errorHttp(400, invalido);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('Los retos son parte de la membresía. Activa tu suscripción para resolverlos');

      const r = await guardarRetos(decoded.uid, antes => retos.aplicarResultado(antes, datos));
      const { ev } = await calcularResumen(ctx, { estadoRetos: r.estado });
      return res.json({
        ok: true, aprobado: r.aprobado, xpGanado: r.xpGanado, xp: ev.xp.total, nivel: ev.nivel,
        insigniasNuevas: resumenInsignias(retos.insigniasNuevas(r.antes, r.estado)),
        ...(await novedadesLibros(ctx, r.antes, r.estado))
      });
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar el resultado del reto', 'retos');
    }
  });

  // POST /api/retos/camino — todos los retos del camino están abiertos para un miembro; el servidor guarda cuáles ya
  // superó y da XP una sola vez por reto (sin membresía vigente: 403)
  app.post('/api/retos/camino', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.retos, decoded.uid, RETOS_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const datos = { modo: cuerpo.modo, indice: cuerpo.indice, puntaje: cuerpo.puntaje, total: cuerpo.total };
      const invalido = retos.validarCaminoResultado(datos);
      if (invalido) throw errorHttp(400, invalido);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('Los retos son parte de la membresía. Activa tu suscripción para resolverlos');

      const r = await guardarRetos(decoded.uid, antes => {
        const o = retos.aplicarCaminoResultado(antes, datos);
        return { ...o, guardar: o.aceptado };
      });
      const salida = { ok: true, aceptado: r.aceptado, aprobado: r.aprobado, xpGanado: r.xpGanado, camino: r.estado.camino, caminoHechos: r.estado.caminoHechos };
      if (r.aceptado) {
        const { ev } = await calcularResumen(ctx, { estadoRetos: r.estado });
        Object.assign(salida, { xp: ev.xp.total, nivel: ev.nivel, insigniasNuevas: resumenInsignias(retos.insigniasNuevas(r.antes, r.estado)),
          ...(await novedadesLibros(ctx, r.antes, r.estado)) });
      }
      return res.json(salida);
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar tu avance en el camino', 'retos');
    }
  });

  // GET /api/retos/clasificacion — top 20 por XP total. Solo nombre público (primer nombre + inicial),
  // XP y nivel: nunca correo, teléfono ni membresía.
  app.get('/api/retos/clasificacion', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('La clasificación es parte de la membresía');

      const coleccion = db.collection('premiosUsuario');
      const top = await coleccion.where('xpTotal', '>', 0).orderBy('xpTotal', 'desc').limit(20).get();
      const perfiles = top.docs.length
        ? await db.getAll(...top.docs.map(d => db.collection('miembros').doc(d.id)))
        : [];
      let posicion = 0; let xpPrevio = null;
      const filas = top.docs.map((d, i) => {
        const xp = d.data().xpTotal;
        if (xp !== xpPrevio) { posicion = i + 1; xpPrevio = xp; }   // mismo XP = misma posición
        const perfil = perfiles[i] && perfiles[i].exists ? perfiles[i].data() : {};
        const nivel = logros.infoNivel(xp);
        return { posicion, nombre: referidos.aliasDeNombre(perfil.name || perfil.nombreCompleto), xp, nivel: { id: nivel.id, nombre: nivel.nombre } };
      });

      let yo = null;
      if (!ctx.esAdmin) {
        const mio = await coleccion.doc(decoded.uid).get();
        const xpMio = mio.exists ? mio.data().xpTotal : null;
        if (typeof xpMio === 'number' && xpMio > 0) {
          const mayores = (await coleccion.where('xpTotal', '>', xpMio).count().get()).data().count;
          yo = { posicion: mayores + 1, xp: xpMio };
        }
      }
      return res.json({ ok: true, top: filas, yo });
    } catch (error) {
      return responderError(res, error, 'No se pudo cargar la clasificación', 'retos');
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /api/premios/usar — canjea UN premio por UN curso adelantado
  // ════════════════════════════════════════════════════════════
  // El adelanto lo pinta el sitio (su calendario de 8 días): considera ABIERTOS los cursos que
  // estén en premiosUsuario/{uid}.usados[].cursoId. Aquí solo se decide si el canje es válido y
  // se registra, dentro de una transacción para que un doble clic o dos pestañas no gasten dos premios.
  app.post('/api/premios/usar', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      const uid = decoded.uid;
      limitar(limites.premios, uid, CANJES_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const cursoId = typeof cuerpo.cursoId === 'string' ? cuerpo.cursoId.trim() : '';
      if (!cursoId || cursoId.length > 200) throw errorHttp(400, 'Falta el curso que quieres abrir');

      const ctx = await leerContexto(uid);
      if (ctx.esAdmin) throw errorHttp(400, 'Las cuentas de administrador ya tienen todos los cursos abiertos');
      if (!ctx.tienePlan) throw sinMembresia('Necesitas una membresía activa para usar tu premio');

      // El curso debe existir de verdad en `cursos` (con un refresco limitado si no aparece)
      let curso = (await obtenerIndiceVideos()).datos.get(cursoId);
      if (!curso) {
        const fresco = await obtenerIndiceVideos({ forzar: true });
        if (!fresco.cargadoEn) throw errorHttp(503, 'No pudimos cargar los cursos. Intenta de nuevo en un momento');
        curso = fresco.datos.get(cursoId);
      }
      if (!curso) throw errorHttp(404, 'Ese curso no existe');
      if (curso.disponibleSiempre || curso.cursoMuestraGratis) throw errorHttp(409, 'Ese curso ya está abierto para todos');
      if ((await leerEleccionPrueba(uid)) === cursoId) throw errorHttp(409, 'Ese curso ya es tu prueba gratuita');

      // Pone al día los premios ganados (por nivel o por invitados) antes de buscar uno libre
      await calcularResumen(ctx);

      const ref = db.collection('premiosUsuario').doc(uid);
      const clave = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const guardado = premios.normalizarGuardado(snap.exists ? snap.data() : null);
        if (guardado.usados.some(u => u.cursoId === cursoId)) throw errorHttp(409, 'Ese curso ya fue adelantado con un premio');
        const libre = premios.premioLibre(guardado.ganados, guardado.usados);
        if (!libre) throw errorHttp(403, 'No tienes premios disponibles');
        tx.set(ref, {
          uid, ganados: guardado.ganados,
          usados: [...guardado.usados, { clave: libre, cursoId, fecha: new Date().toISOString() }],
          actualizadoEn: FieldValue.serverTimestamp()
        }, { merge: true });
        return libre;
      });
      return res.json({ ok: true, cursoId, clave });
    } catch (error) {
      return responderError(res, error, 'No se pudo usar el premio', 'premios');
    }
  });

  // ════════════════════════════════════════════════════════════
  // REFERIDOS
  // ════════════════════════════════════════════════════════════
  // POST /api/referidos/registrar — el invitado se registra con el código de quien lo invitó.
  // Lo que el navegador escriba en miembros.referredBy ya no cuenta: solo cuenta este registro.
  // Es idempotente: cada invitado se registra una sola vez.
  app.post('/api/referidos/registrar', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      const uid = decoded.uid;
      limitar(limites.referidos, uid, REGISTROS_POR_MINUTO);
      const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
      const codigo = referidos.normalizarCodigo(cuerpo.codigo);
      if (!codigo) throw errorHttp(400, 'El código de invitación no es válido');
      const dispositivo = referidos.validarDispositivo(cuerpo);
      if (!dispositivo) throw errorHttp(400, 'No pudimos identificar tu dispositivo');
      const respuesta = (estado, motivo) => res.json({ ok: true, estado, ...(motivo ? { motivo } : {}) });

      // Idempotente: si ya se registró, se devuelve su estado (y se revisa si ya confirmó su correo)
      const previo = await db.collection('referidos').doc(uid).get();
      if (previo.exists) {
        const lista = await sincronizarInvitados(previo.data().anfitrionUid);
        const mio = lista.find(i => i.uid === uid) || previo.data();
        return respuesta(mio.estado, mio.motivo);
      }

      const anfitrionUid = await buscarAnfitrion(codigo);
      if (!anfitrionUid) return respuesta(ESTADOS.RECHAZADO, referidos.MOTIVOS['codigo-inexistente']);
      if (anfitrionUid === uid) return respuesta(ESTADOS.RECHAZADO, referidos.MOTIVOS['mismo-usuario']);
      // Solo invitan los miembros: si quien invita no tiene membresía vigente (o la dejó), la invitación
      // no cuenta y NO se guarda nada. El registro del invitado sigue su curso normal.
      if (!(await leerContexto(anfitrionUid)).membresia) return respuesta(ESTADOS.RECHAZADO, referidos.MOTIVOS['anfitrion-sin-membresia']);

      const ip = referidos.ipDeSolicitud(req.headers, req.ip);
      const ua = String(req.get('user-agent') || '').slice(0, 200);
      const info = (await leerUsuariosAuth([uid])).get(uid);
      const correoConfirmado = info ? info.emailVerified : decoded.email_verified === true;

      const [dispositivosAnfitrion, snapInvitados] = await Promise.all([
        dispositivosDeAnfitrion(anfitrionUid),
        db.collection('referidos').where('anfitrionUid', '==', anfitrionUid).limit(MAX_INVITADOS_LEIDOS).get()
      ]);
      const otros = snapInvitados.docs.map(d => ({ ...d.data(), uid: d.id }));
      const yo = { uid, anfitrionUid, ...dispositivo, ip, creadoEn: Date.now() };

      let motivo = null;
      if (info && !referidos.cuentaNueva(info.creationTime)) motivo = 'cuenta-antigua';
      else motivo = referidos.evaluarDispositivo(yo, dispositivosAnfitrion, otros);
      const estado = motivo ? ESTADOS.RECHAZADO : (correoConfirmado ? ESTADOS.VALIDO : ESTADOS.PENDIENTE);

      const ref = db.collection('referidos').doc(uid);
      const resultado = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists) return { existente: snap.data() };
        tx.set(ref, {
          anfitrionUid, codigo, ...dispositivo, ip, ua, creadoEn: FieldValue.serverTimestamp(),
          estado, motivo: motivo ? referidos.MOTIVOS[motivo] : null, hitos: referidos.normalizarHitos(null)
        });
        return { nuevo: true };
      });
      if (resultado.existente) return respuesta(resultado.existente.estado, resultado.existente.motivo);

      // El dispositivo con el que se registra también cuenta como suyo si algún día invita a alguien
      await guardarDispositivoAnfitrion(uid, { ...dispositivo, ip });

      // Dos invitados que se registran a la vez desde el mismo dispositivo: se queda el que llegó primero
      if (estado === ESTADOS.VALIDO) {
        const actual = await db.collection('referidos').where('anfitrionUid', '==', anfitrionUid).limit(MAX_INVITADOS_LEIDOS).get();
        const todos = actual.docs.map(d => ({ ...d.data(), uid: d.id }));
        const yoGuardado = todos.find(i => i.uid === uid);
        const choque = yoGuardado && referidos.evaluarDispositivo({ ...yoGuardado, anfitrionUid }, dispositivosAnfitrion, todos, { soloAnteriores: true });
        if (choque) {
          const cambios = { estado: ESTADOS.RECHAZADO, motivo: referidos.MOTIVOS[choque] };
          await ref.set(cambios, { merge: true });
          return respuesta(cambios.estado, cambios.motivo);
        }
      }
      return respuesta(estado, motivo ? referidos.MOTIVOS[motivo] : null);
    } catch (error) {
      return responderError(res, error, 'No se pudo registrar tu invitación', 'referidos');
    }
  });

  // GET /api/referidos/estado — la pantalla de referidos del anfitrión. Solo alias (primer nombre e
  // inicial); jamás correos ni teléfonos de los invitados.
  app.get('/api/referidos/estado', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      const uid = decoded.uid;
      limitar(limites.lecturas, uid, LECTURAS_POR_MINUTO);
      // Invitar amigos es para miembros (membresía vigente o administrador): sin ella no hay enlace ni código.
      const ctx = await leerContexto(uid);
      if (!ctx.membresia) throw sinMembresia('Invitar amigos es para miembros. Activa tu membresía para obtener tu enlace de invitación');

      // El dispositivo desde el que el anfitrión mira su pantalla queda registrado como suyo
      const deviceId = idDe(req);
      if (deviceId) {
        const huella = req.get('x-huella');
        await guardarDispositivoAnfitrion(uid, {
          deviceId, ip: referidos.ipDeSolicitud(req.headers, req.ip),
          huella: typeof huella === 'string' && /^[A-Za-z0-9+/=_-]{6,128}$/.test(huella.trim()) ? huella.trim() : null
        });
      }
      const codigo = await asegurarCodigo(uid);
      const invitados = await sincronizarInvitados(uid);
      const resumen = referidos.resumirInvitados(invitados);

      const perfiles = invitados.length
        ? await db.getAll(...invitados.map(i => db.collection('miembros').doc(i.uid)))
        : [];
      const lista = invitados.map((i, n) => {
        const perfil = perfiles[n] && perfiles[n].exists ? perfiles[n].data() : {};
        const fecha = i.creadoEn && typeof i.creadoEn.toDate === 'function' ? i.creadoEn.toDate().toISOString() : null;
        const d = resumen.detalle[n];
        const item = {
          alias: referidos.aliasDeNombre(perfil.name || perfil.nombreCompleto), fecha, estado: i.estado,
          hitos: referidos.listaDeHitos(i.hitos, i.estado === ESTADOS.VALIDO), puntos: d.puntos
        };
        if (i.motivo) item.motivo = i.motivo;
        if (i.estado === ESTADOS.VALIDO && !d.conPuntos) item.sinPuntos = true;  // pasó el tope de invitados con XP
        return item;
      });

      const guardado = await guardarProgreso(uid, {
        claves: premios.clavesQueCumple({ nivelId: 1, invitadosValidos: resumen.validos }), xpTotal: 0, conRanking: false
      });
      const premiosReferidos = premios.PREMIOS.filter(p => p.clave.startsWith('referidos-')).map(p => {
        const uso = guardado.usados.find(u => u.clave === p.clave);
        return {
          clave: p.clave, requisito: p.requisito, faltan: p.faltan({ invitadosValidos: resumen.validos }),
          ganado: guardado.ganados.includes(p.clave), usado: uso ? { cursoId: uso.cursoId, fecha: uso.fecha } : null
        };
      });
      return res.json({
        ok: true, codigo, enlace: referidos.enlaceDeCodigo(codigo),
        validos: resumen.validos, pendientes: resumen.pendientes, rechazados: resumen.rechazados,
        invitados: lista, puntosTotales: resumen.xp, premios: premiosReferidos
      });
    } catch (error) {
      return responderError(res, error, 'No se pudieron cargar tus invitados', 'referidos');
    }
  });

  // ════════════════════════════════════════════════════════════
  // DIRECTORIO — una tarjeta profesional por miembro (colección directorio, solo del servidor)
  // ════════════════════════════════════════════════════════════
  const parametroTexto = v => (typeof v === 'string' ? v.trim().slice(0, 80) : '');

  // ¿Quiénes de estos uid tienen membresía vigente ahora? (mismas reglas de siempre: leerContexto).
  // Se recuerda un minuto por persona para no leer 3 documentos por tarjeta en cada visita.
  const VIGENCIA_SELLO_MS = 60 * 1000;
  const cacheSello = new Map();
  async function membresiasVigentes(uids, ahora = Date.now()) {
    const vigentes = new Set();
    await Promise.all([...new Set(uids)].map(async uid => {
      const previo = cacheSello.get(uid);
      let ok;
      if (previo && ahora - previo.t < VIGENCIA_SELLO_MS) ok = previo.ok;
      else { ok = (await leerContexto(uid)).membresia === true; cacheSello.set(uid, { t: ahora, ok }); }
      if (ok) vigentes.add(uid);
    }));
    if (cacheSello.size > 2000) cacheSello.clear();
    return vigentes;
  }

  // GET /api/directorio?sector=&q= — con membresía: hasta 300 tarjetas reales; sin ella, 6 ejemplos ficticios
  app.get('/api/directorio', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.lecturas, decoded.uid, LECTURAS_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) {
        return res.json({ ok: true, membresia: false, tarjetas: directorio.EJEMPLOS.map(t => ({ ...t, contacto: {} })), mia: null });
      }
      // Una tarjeta es PRIVADA hasta que su dueña o dueño la publica: las demás personas solo ven las que
      // tienen publicado === true. La propia siempre se devuelve en "mia" (publicada o no).
      const [snap, miDoc] = await Promise.all([
        db.collection('directorio').orderBy('actualizado', 'desc').limit(1000).get(),
        db.collection('directorio').doc(decoded.uid).get()
      ]);
      const publicadas = snap.docs.filter(d => d.data() && d.data().publicado === true);
      const filtradas = directorio.filtrar(
        publicadas.map(d => directorio.tarjetaPublica(d.id, d.data(), { esMia: d.id === decoded.uid })),
        { sector: parametroTexto(req.query.sector), q: parametroTexto(req.query.q) }
      ).slice(0, directorio.MAX_TARJETAS);
      // Sello "verificado": membresía vigente de cada dueña o dueño, calculada aquí (nunca viene del navegador)
      const vigentes = await membresiasVigentes([...filtradas.map(t => t.uid), decoded.uid]);
      const conSello = t => ({ ...t, verificado: vigentes.has(t.uid) });
      return res.json({
        ok: true, membresia: true, tarjetas: filtradas.map(conSello),
        mia: miDoc.exists ? conSello(directorio.tarjetaPublica(decoded.uid, miDoc.data(), { esMia: true })) : null
      });
    } catch (error) {
      return responderError(res, error, 'No se pudo cargar el directorio', 'directorio');
    }
  });

  // POST /api/directorio — crea o actualiza MI tarjeta (requiere membresía)
  app.post('/api/directorio', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.directorio, decoded.uid, CAMBIOS_DIRECTORIO_POR_MINUTO);
      const ctx = await leerContexto(decoded.uid);
      if (!ctx.membresia) throw sinMembresia('El directorio es parte de la membresía. Activa tu suscripción para crear tu tarjeta');
      const r = directorio.validarTarjeta(req.body);
      if (r.error) throw errorHttp(400, r.error);
      const ref = db.collection('directorio').doc(decoded.uid);
      // set completo: la tarjeta guardada es exactamente la validada (nada extra que haya mandado el navegador)
      await ref.set({ uid: decoded.uid, ...r.tarjeta, actualizado: FieldValue.serverTimestamp() });
      return res.json({ ok: true, tarjeta: directorio.tarjetaPublica(decoded.uid, (await ref.get()).data(), { esMia: true, verificado: true }) });
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar tu tarjeta', 'directorio');
    }
  });

  // DELETE /api/directorio — borra MI tarjeta (también sin membresía: siempre puedes retirar tus datos)
  app.delete('/api/directorio', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return;
      limitar(limites.directorio, decoded.uid, CAMBIOS_DIRECTORIO_POR_MINUTO);
      await db.collection('directorio').doc(decoded.uid).delete();
      return res.json({ ok: true });
    } catch (error) {
      return responderError(res, error, 'No se pudo borrar tu tarjeta', 'directorio');
    }
  });

  return { leerContexto, calcularResumen, leerEstadoRetos, limites, limitar, sinMembresia, responderError, FieldValue };
}

module.exports = { montarRutasClub, permitirSolicitud };
