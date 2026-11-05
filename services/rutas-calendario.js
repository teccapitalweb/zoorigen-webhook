'use strict';

// ══ CALENDARIO DE CURSOS DEL MIEMBRO · Firestore y rutas ══
// Las reglas puras están en services/calendario.js. Aquí se guarda y se aplica:
//
//   calendariosCursos/{uid}   SOLO del servidor (las reglas de Firestore niegan lo que no listan, así que el navegador no
//                             puede leerla ni escribirla). Guarda el calendario del miembro:
//     { uid, version, modo ('legado' | 'nuevo' | 'prueba'), inicioMs, fuente, eleccion, planInicioMs, venceMs,
//       entradas: [{ cursoId, desbloqueoEn }], primerCursoId, cursoAdelantado: { cursoId, en, via, retos } | null }
//   config/calendario         { nuevoDesde }  desde cuándo quien empieza su plan cuenta desde el inicio de su plan.
//                             Se crea sola la primera vez que corre este servicio (el momento de publicar). Se puede
//                             fijar con CALENDARIO_NUEVO_DESDE (fecha ISO). Los miembros con plan anterior a esa fecha
//                             conservan la cuenta de siempre y no pierden nada.
//
//   GET /api/calendario   → estado de cada curso para la persona (abierto, "Restan N días", por premio, por retos),
//                           próximo desbloqueo y el avance de los 15 retos para abrir el primer curso.
//   exigirCurso / exigirVideo → los usan /api/bunny/embed-token y el progreso de clases. Con CALENDARIO_MODO=estricto un
//                           curso cerrado se rechaza (403, codigo 'curso-bloqueado'); sin definir (modo transición) solo
//                           se anota en la bitácora lo que se habría rechazado y nadie pierde acceso.

const cal = require('./calendario');
const retos = require('./retos');
const premios = require('./premios');
const avisos = require('./avisos');
const { permitirSolicitud } = require('./rutas-club');

const LECTURAS_POR_MINUTO = 60;
const CACHE_CONFIG_MS = 60 * 1000;
const VERSION = 1;

function crearServicioCalendario(deps) {
  const { db, admin, auth, esAdminPorDocumentos, tienePlanVigente, obtenerIndiceVideos, leerEleccionPrueba, errorHttp } = deps;
  const estricto = String(deps.modo || '').trim().toLowerCase() === 'estricto';
  const nuevoDesdeEnv = cal.aMs(String(deps.nuevoDesde || '').trim().replace(/^["']|["']$/g, '').trim() || null);
  const FieldValue = admin.firestore.FieldValue;
  const limites = { lecturas: new Map() };
  const estadisticas = { rechazosSimulados: 0, rechazos: 0, ultimoSimulado: null };

  const refCalendario = uid => db.collection('calendariosCursos').doc(uid);
  const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

  /* ── Desde cuándo cuenta el calendario "nuevo" ── */
  let nuevoDesdeCache = null;
  async function leerNuevoDesde(ahoraMs) {
    if (nuevoDesdeEnv !== null) return nuevoDesdeEnv;
    if (nuevoDesdeCache && ahoraMs - nuevoDesdeCache.leidoEn < CACHE_CONFIG_MS) return nuevoDesdeCache.valor;
    const ref = db.collection('config').doc('calendario');
    const valor = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const guardado = snap.exists && snap.data() ? cal.aMs(snap.data().nuevoDesde) : null;
      if (guardado !== null) return guardado;
      tx.set(ref, { nuevoDesde: admin.firestore.Timestamp.fromMillis(ahoraMs), nota: 'Se fijó sola al activar el calendario del servidor', creadoEn: FieldValue.serverTimestamp() }, { merge: true });
      return ahoraMs;
    });
    nuevoDesdeCache = { valor, leidoEn: ahoraMs };
    return valor;
  }

  /* ── Contexto de la persona ── */
  async function leerContexto(uid) {
    const [adminDoc, miembroDoc, usuarioDoc] = await Promise.all([
      db.collection('admins').doc(uid).get(),
      db.collection('miembros').doc(uid).get(),
      db.collection('usuarios').doc(uid).get()
    ]);
    const esAdmin = esAdminPorDocumentos(adminDoc, miembroDoc);
    const tienePlan = tienePlanVigente(miembroDoc, usuarioDoc);
    return { uid, esAdmin, tienePlan, membresia: esAdmin || tienePlan, miembro: miembroDoc.exists ? miembroDoc.data() : null, usuario: usuarioDoc.exists ? usuarioDoc.data() : null };
  }

  async function leerPremiosUsados(uid) {
    try {
      const snap = await db.collection('premiosUsuario').doc(uid).get();
      return premios.normalizarGuardado(snap.exists ? snap.data() : null).usados.map(u => u.cursoId);
    } catch (error) {
      console.warn('[Calendario] No se pudieron leer los premios usados:', error && error.message);
      return [];
    }
  }

  async function cuentaCreadaMs(uid) {
    try { const u = await auth.getUser(uid); return cal.aMs(u && u.metadata && u.metadata.creationTime); } catch (error) { return null; }
  }

  // Cursos en el orden de la fila (o null si el índice de cursos aún no se pudo leer)
  async function leerFila() {
    const indice = await obtenerIndiceVideos();
    if (!indice || !indice.cargadoEn || !Array.isArray(indice.calendarioCursos)) return null;
    return { indice, lista: cal.ordenParaDesbloqueo(indice.calendarioCursos) };
  }

  /* ── Armar o poner al día el calendario guardado ──
     Devuelve { doc, lista, estados, proximo, guardado } o null si la persona no tiene calendario (administrador, sin membresía,
     o no se pudo leer el catálogo). Es idempotente: llamarlo varias veces no cambia nada. */
  async function asegurar(uid, ctx, ahoraMs = Date.now()) {
    if (!ctx || ctx.esAdmin || !ctx.tienePlan) return null;
    const fila = await leerFila();
    if (!fila || !fila.lista.length) return null;
    const { lista } = fila;
    const existe = new Set(lista.map(c => c.id));
    let eleccion = await leerEleccionPrueba(uid);
    if (eleccion && !existe.has(eleccion)) eleccion = null;
    let nuevoDesdeMs = null;
    try { nuevoDesdeMs = await leerNuevoDesde(ahoraMs); } catch (error) {
      console.warn('[Calendario] No se pudo leer la fecha de activación; se usa la regla de siempre:', error && error.message);
    }
    const premiosUsados = await leerPremiosUsados(uid);
    const miembro = ctx.miembro || {};
    const usuario = ctx.usuario || {};
    const planMs = cal.inicioDePlanMs(miembro, usuario);
    const venceMs = cal.aMs(miembro.planVence) !== null ? cal.aMs(miembro.planVence) : cal.aMs(usuario.fechaExpiracion);
    // Último respaldo para saber desde cuándo cuenta: la fecha de creación de la cuenta (solo si no hay registro ni plan)
    const cuenta = cal.aMs(miembro.createdAt) === null && planMs === null ? await cuentaCreadaMs(uid) : null;
    // Sin la fecha de activación (falló su lectura) y sin prueba elegida, la regla de siempre se usa pero NO se guarda:
    // así nadie queda marcado con una regla equivocada por un fallo pasajero.
    const persistir = Number.isFinite(nuevoDesdeMs) || Boolean(eleccion);

    const ref = refCalendario(uid);
    const guardado = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const previo = snap.exists && esObjeto(snap.data()) ? snap.data() : null;
      let doc;
      let cambio = false;
      if (!previo || !Array.isArray(previo.entradas)) {
        // Primera vez: se arma con la regla que le toca (sin fecha de activación no se guarda el modo "nuevo")
        const inicio = cal.inicioDelCalendario({ miembro, usuario, tieneEleccion: Boolean(eleccion), nuevoDesdeMs, cuentaCreadaMs: cuenta, ahoraMs });
        const entradas = cal.construirEntradas({ lista, eleccion, inicioMs: inicio.inicioMs });
        doc = {
          uid, version: VERSION, modo: inicio.modo, fuente: inicio.fuente, inicioMs: inicio.inicioMs, eleccion: eleccion || null,
          planInicioMs: planMs, venceMs, entradas,
          // El primer curso que seguía cerrado al armar el calendario es el único que se abre con 15 retos
          primerCursoId: cal.primerCursoCerrado(entradas, ahoraMs), cursoAdelantado: null
        };
        cambio = true;
      } else {
        doc = { ...previo, entradas: previo.entradas.map(e => ({ ...e })) };
        // Volvió a pagar después de vencerse: lo que seguía cerrado se vuelve a fechar desde la reactivación
        if (planMs !== null && Number.isFinite(doc.planInicioMs) && planMs > doc.planInicioMs + 1000 && Number.isFinite(doc.venceMs) && doc.venceMs < planMs) {
          const r = cal.reanudarEntradas(doc.entradas, doc.venceMs, planMs);
          doc.entradas = r.entradas;
          cambio = cambio || r.cambio;
        }
        if (eleccion && doc.eleccion !== eleccion) { doc.eleccion = eleccion; cambio = true; }
        const inicioMs = Number.isFinite(doc.inicioMs) ? doc.inicioMs : (planMs !== null ? planMs : ahoraMs);
        const c = cal.completarEntradas({ entradas: doc.entradas, lista, eleccion: doc.eleccion || null, inicioMs });
        if (c.cambio) { doc.entradas = c.entradas; cambio = true; }
        if (planMs !== null && doc.planInicioMs !== planMs) { doc.planInicioMs = planMs; cambio = true; }
        if (venceMs !== null && doc.venceMs !== venceMs) { doc.venceMs = venceMs; cambio = true; }
      }
      if (cambio && persistir) tx.set(ref, { ...doc, actualizadoEn: FieldValue.serverTimestamp() }, { merge: false });
      return doc;
    });

    const estados = cal.estadoDeCursos({
      lista, entradas: guardado.entradas, eleccion: guardado.eleccion || null, premios: premiosUsados,
      adelantado: guardado.cursoAdelantado && guardado.cursoAdelantado.cursoId, esAdmin: false, ahoraMs
    });
    return { doc: guardado, lista, estados, proximo: cal.proximoDesbloqueo(estados), indice: fila.indice };
  }

  const tituloDe = (lista, id) => { const c = lista.find(x => x.id === id); return c ? c.titulo : ''; };

  /* ── Primer curso con 15 retos ── */
  // Solo cuentas nuevas que usaron su prueba gratuita y ya pagaron (no miembros de antes ni quien volvió a pagar tras vencerse): ver cal.elegibleParaAdelanto.
  async function esMiembroNuevo(doc, ahoraMs) {
    try { return cal.elegibleParaAdelanto(doc, await leerNuevoDesde(ahoraMs)); } catch (error) { return false; }
  }
  // Devuelve { aplica, estado: 'pendiente' | 'abierto-ahora' | 'ninguno', cursoId, titulo, desbloqueoEn, diasFalta, progreso }
  // Si el avance ya completa los 15 retos y el curso sigue cerrado, lo abre (una sola vez) y lo anota en el calendario.
  async function evaluarPrimerCurso(uid, estadoRetos, ctx, ahoraMs = Date.now()) {
    const sin = { aplica: false, estado: 'ninguno' };
    try {
      if (!ctx || ctx.esAdmin || !ctx.tienePlan) return sin;
      const cuadro = await asegurar(uid, ctx, ahoraMs);
      if (!cuadro) return sin;
      const { doc, lista } = cuadro;
      if (doc.cursoAdelantado || !doc.primerCursoId) return sin;
      // Solo cuentas nuevas con prueba gratuita ya pagada. Los miembros de antes y quien vuelve a pagar tras vencerse conservan su calendario de siempre.
      if (!(await esMiembroNuevo(doc, ahoraMs))) return sin;
      const estado = cuadro.estados.find(e => e.cursoId === doc.primerCursoId);
      if (!estado || estado.abierto) return sin;          // ya se abrió por su fecha o por un premio
      const progreso = retos.progresoPrimerCurso(estadoRetos);
      const base = { aplica: true, cursoId: doc.primerCursoId, titulo: tituloDe(lista, doc.primerCursoId), desbloqueoEn: estado.desbloqueoEn, diasFalta: estado.diasFalta, progreso };
      if (!progreso.completo) return { ...base, estado: 'pendiente' };

      let abierto = false;
      await db.runTransaction(async tx => {
        const ref = refCalendario(uid);
        const snap = await tx.get(ref);
        const d = snap.exists ? snap.data() : null;
        if (!d || d.cursoAdelantado || d.primerCursoId !== doc.primerCursoId) return;
        const e = (d.entradas || []).find(x => x.cursoId === doc.primerCursoId);
        const fecha = e ? cal.aMs(e.desbloqueoEn) : null;
        if (fecha !== null && fecha <= ahoraMs) return;     // se abrió por tiempo mientras tanto
        tx.set(ref, {
          cursoAdelantado: { cursoId: doc.primerCursoId, en: new Date(ahoraMs).toISOString(), via: 'retos', retos: { hechos: progreso.hechos, meta: progreso.meta } },
          actualizadoEn: FieldValue.serverTimestamp()
        }, { merge: true });
        abierto = true;
      });
      if (abierto) {
        // Copia visible en la ficha del miembro (solo para el panel de administración; quien manda es calendariosCursos)
        try { await db.collection('miembros').doc(uid).set({ cursoAdelantado: doc.primerCursoId, cursoAdelantadoEn: FieldValue.serverTimestamp() }, { merge: true }); } catch (error) {
          console.warn('[Calendario] No se pudo anotar el curso adelantado en la ficha:', error && error.message);
        }
        await avisos.crearAviso(db, uid, {
          id: 'primer_curso_retos', tipo: 'curso', titulo: 'Tu curso está abierto',
          texto: 'Resolviste 15 retos y abriste «' + (base.titulo || 'tu siguiente curso').slice(0, 80) + '». Ya puedes empezar desde Cursos.',
          enlace: 'club-biblioteca.html'
        });
        return { ...base, estado: 'abierto-ahora', abierto: true, desbloqueoEn: new Date(ahoraMs).toISOString(), diasFalta: 0 };
      }
      return { ...base, estado: 'pendiente' };
    } catch (error) {
      console.warn('[Calendario] No se pudo evaluar el primer curso por retos:', error && error.message);
      return sin;
    }
  }

  /* ── Cambiar el orden de los cursos cerrados con retos ──
     Reglas en services/retos.js (CAMBIOS_ORDEN_DEFINIDOS: 35 y 55 retos acumulados, 8 y 14 de cada tipo, solo retos nuevos; MAX_CAMBIOS_ORDEN dice cuántos están vigentes) y en
     services/calendario.js (moverCursoAlSiguiente: las mismas fechas con otro curso en cada lugar). Todo es del servidor. */
  const MENSAJES_CAMBIO = {
    'ya-es-el-siguiente': 'Ese curso ya es el siguiente en abrirse. Elige otro curso cerrado.',
    'no-cerrado': 'Solo puedes mover cursos que todavía están cerrados.'
  };
  // XP de las insignias del cambio de orden (fuente única: retos.INSIGNIAS)
  const xpInsigniasCambio = () => ({ 1: (retos.insigniasVigentes().find(i => i.id === 'r11') || {}).xp || 0, 2: (retos.insigniasVigentes().find(i => i.id === 'r12') || {}).xp || 0 });
  const mensajeSinCambios = () => retos.maxCambiosOrden() >= 2 ? 'Ya usaste tus ' + retos.maxCambiosOrden() + ' cambios de orden. No hay más.' : 'Ya usaste tu cambio de orden. Solo hay uno por miembro.';
  const faltanTexto = tramo => {
    const partes = [];
    [['quiz', 'quiz'], ['detective', 'detective'], ['orden', 'ordena']].forEach(([k, nombre]) => { if (tramo.faltan[k] > 0) partes.push(tramo.faltan[k] + ' de ' + nombre); });
    return partes.join(', ');
  };

  // Estado para pintar el bloque "Cambia el orden de tu calendario": avance, cursos cerrados que se pueden mover y cambios ya hechos.
  async function estadoCambioOrden(uid, ctx, estadoRetos, ahoraMs = Date.now()) {
    const progreso = retos.progresoCambioOrden(estadoRetos);
    const base = { ok: true, aplica: false, ...progreso, disponible: false, cursosCerrados: [], siguienteCurso: null, cambios: [], xpInsignias: xpInsigniasCambio() };
    if (!ctx || ctx.esAdmin || !ctx.tienePlan) return base;
    const cuadro = await asegurar(uid, ctx, ahoraMs);
    if (!cuadro) return base;
    const cerrados = cal.cursosCerradosEnOrden(cuadro.estados).map(c => {
      const e = cuadro.estados.find(x => x.cursoId === c.cursoId) || {};
      return { cursoId: c.cursoId, titulo: tituloDe(cuadro.lista, c.cursoId), lugar: c.lugar, desbloqueoEn: c.desbloqueoEn, diasFalta: e.diasFalta };
    });
    const cambios = Array.isArray(cuadro.doc.cambiosOrden) ? cuadro.doc.cambiosOrden.map(c => ({ n: c.n, cursoId: c.cursoId, titulo: c.titulo, deLugar: c.deLugar, en: c.en })) : [];
    const siguiente = progreso.siguiente;
    // La oferta siempre va ligada al SIGUIENTE curso por abrirse (el primero de los cerrados): si ese curso se abre solo por su fecha,
    // la oferta pasa sola al nuevo siguiente. Los retos contados y los cambios disponibles no dependen del calendario y no se pierden.
    return { ...base, aplica: true, cursosCerrados: cerrados, siguienteCurso: cerrados[0] || null, cambios, disponible: Boolean(siguiente && siguiente.cumple && cerrados.length > 1) };
  }

  // Aplica el cambio. Todo ocurre en una transacción (calendario + retos): dos clics a la vez gastan un solo cambio.
  // Devuelve { registro, antes, despues } (estados de retos antes y después, para las insignias).
  async function cambiarOrden(uid, cursoId, ctx, ahoraMs = Date.now()) {
    if (!ctx || ctx.esAdmin) throw errorHttp(400, 'Las cuentas de administrador ya tienen todos los cursos abiertos');
    if (!ctx.tienePlan) throw errorHttp(403, 'Necesitas una membresía activa para cambiar el orden de tus cursos');
    if (typeof cursoId !== 'string' || !cursoId.trim() || cursoId.length > 200) throw errorHttp(400, 'Falta el curso que quieres adelantar');
    const refRetos = db.collection('retosUsuario').doc(uid);
    // Si ya tenía los 15 retos del primer curso, se abre antes de reordenar (así el reordenamiento nunca lo estorba)
    try {
      const previo = await refRetos.get();
      await evaluarPrimerCurso(uid, retos.normalizarEstado(previo.exists ? previo.data() : null), ctx, ahoraMs);
    } catch (error) { /* si falla se sigue: el cambio solo toca cursos cerrados */ }
    const cuadro = await asegurar(uid, ctx, ahoraMs);
    if (!cuadro) throw errorHttp(409, 'Tu calendario todavía no está listo. Intenta de nuevo en un momento');
    const premiosUsados = await leerPremiosUsados(uid);
    const refCal = refCalendario(uid);
    const idCambio = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    let salida;
    await db.runTransaction(async tx => {
      const snapCal = await tx.get(refCal);
      const snapRetos = await tx.get(refRetos);
      const doc = snapCal.exists && esObjeto(snapCal.data()) ? snapCal.data() : null;
      if (!doc || !Array.isArray(doc.entradas)) throw errorHttp(409, 'Tu calendario todavía no está listo. Intenta de nuevo en un momento');
      const antes = retos.normalizarEstado(snapRetos.exists ? snapRetos.data() : null);
      const progreso = retos.progresoCambioOrden(antes);
      const tramo = progreso.siguiente;
      if (!tramo) throw Object.assign(errorHttp(409, mensajeSinCambios()), { codigo: 'sin-cambios' });
      if (!tramo.cumple) {
        const falta = faltanTexto(tramo);
        throw Object.assign(errorHttp(403, `Todavía no puedes hacer el cambio ${tramo.n}: necesitas ${tramo.total} retos nuevos (mínimo ${tramo.porTipo} de cada tipo).` + (falta ? ` Te faltan: ${falta}.` : '')), { codigo: 'retos-insuficientes', faltan: tramo.faltan });
      }
      const estados = cal.estadoDeCursos({
        lista: cuadro.lista, entradas: doc.entradas, eleccion: doc.eleccion || null, premios: premiosUsados,
        adelantado: doc.cursoAdelantado && doc.cursoAdelantado.cursoId, esAdmin: false, ahoraMs
      });
      const cerrados = cal.cursosCerradosEnOrden(estados);
      const m = cal.moverCursoAlSiguiente(doc.entradas, cerrados, cursoId);
      if (!m.ok) throw Object.assign(errorHttp(m.motivo === 'ya-es-el-siguiente' ? 409 : 400, MENSAJES_CAMBIO[m.motivo]), { codigo: m.motivo });
      // El curso que se abre con 15 retos es "el siguiente en abrirse": si todavía no se usó, la ventaja sigue a ese lugar
      const primerCursoId = !doc.cursoAdelantado && doc.primerCursoId && cerrados.some(c => c.cursoId === doc.primerCursoId) ? cursoId : (doc.primerCursoId || null);
      const registro = {
        n: tramo.n, cursoId, titulo: tituloDe(cuadro.lista, cursoId), deLugar: m.deLugar, aLugar: m.aLugar, desbloqueoEn: m.fecha,
        // El curso que iba primero (el siguiente por abrirse) antes de este cambio: el panel de administración muestra «de cuál a cuál»
        anteriorCursoId: cerrados[0] ? cerrados[0].cursoId : null, anteriorTitulo: cerrados[0] ? tituloDe(cuadro.lista, cerrados[0].cursoId) : '',
        en: new Date(ahoraMs).toISOString(), retos: { ...progreso.contados }
      };
      const despues = { ...antes, cambiosOrden: tramo.n };
      tx.set(refCal, { entradas: m.entradas, primerCursoId, cambiosOrden: [...(Array.isArray(doc.cambiosOrden) ? doc.cambiosOrden : []), registro], actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(refRetos, { ...despues, uid, actualizadoEn: FieldValue.serverTimestamp() });
      // Copia para el panel de administración (quién cambió qué y cuándo)
      tx.set(db.collection('calendarioCambios').doc(idCambio), { uid, ...registro, fecha: FieldValue.serverTimestamp() });
      salida = { registro, antes, despues };
    });
    try {
      await avisos.crearAviso(db, uid, {
        id: 'cambio_orden_' + salida.registro.n, tipo: 'curso', titulo: 'Cambiaste el orden de tu calendario',
        texto: '«' + (salida.registro.titulo || 'Tu curso').slice(0, 80) + '» ahora es el siguiente en abrirse.' + (salida.registro.n < retos.maxCambiosOrden() ? ' Te queda ' + (retos.maxCambiosOrden() - salida.registro.n) + ' cambio más.' : (retos.maxCambiosOrden() >= 2 ? ' Usaste tus ' + retos.maxCambiosOrden() + ' cambios.' : ' Ya usaste tu cambio.')),
        enlace: 'club-biblioteca.html'
      });
    } catch (error) { console.warn('[Calendario] No se pudo avisar del cambio de orden:', error && error.message); }
    return salida;
  }

  /* ── Vista para el sitio ── */
  const vistaCurso = (e, lista) => ({
    cursoId: e.cursoId, titulo: tituloDe(lista, e.cursoId), abierto: e.abierto, motivo: e.motivo, desbloqueoEn: e.desbloqueoEn,
    diasFalta: e.diasFalta, porPremio: e.porPremio, porRetos: e.porRetos, esPrueba: e.esPrueba
  });

  async function vista(uid, ctx, ahoraMs = Date.now()) {
    if (ctx.esAdmin) return { ok: true, membresia: true, admin: true, modoServidor: estricto ? 'estricto' : 'transicion', ahora: new Date(ahoraMs).toISOString(), cursos: [], proximo: null, primerCurso: { aplica: false, estado: 'ninguno' } };
    if (!ctx.tienePlan) return { ok: true, membresia: false, admin: false, modoServidor: estricto ? 'estricto' : 'transicion', ahora: new Date(ahoraMs).toISOString(), cursos: [], proximo: null, primerCurso: { aplica: false, estado: 'ninguno' } };
    let estadoRetos;
    try {
      const snap = await db.collection('retosUsuario').doc(uid).get();
      estadoRetos = retos.normalizarEstado(snap.exists ? snap.data() : null);
    } catch (error) { estadoRetos = retos.estadoInicial(); }
    // Primero se evalúan los 15 retos (puede abrir el primer curso) y después se lee el calendario ya actualizado
    const primerCurso = await evaluarPrimerCurso(uid, estadoRetos, ctx, ahoraMs);
    const cuadro = await asegurar(uid, ctx, ahoraMs);
    if (!cuadro) return { ok: true, membresia: true, admin: false, calendario: null, modoServidor: estricto ? 'estricto' : 'transicion', ahora: new Date(ahoraMs).toISOString(), cursos: [], proximo: null, primerCurso };
    const p = cuadro.proximo;
    return {
      ok: true, membresia: true, admin: false, modoServidor: estricto ? 'estricto' : 'transicion', ahora: new Date(ahoraMs).toISOString(),
      calendario: { modo: cuadro.doc.modo, inicio: new Date(cuadro.doc.inicioMs).toISOString(), eleccion: cuadro.doc.eleccion || null, diasPorCurso: cal.DIAS_POR_CURSO },
      cursos: cuadro.estados.map(e => vistaCurso(e, cuadro.lista)),
      proximo: p ? { cursoId: p.cursoId, titulo: tituloDe(cuadro.lista, p.cursoId), desbloqueoEn: p.desbloqueoEn, diasFalta: p.diasFalta, msFalta: p.msFalta } : null,
      primerCurso
    };
  }

  /* ── Acceso a un curso o a un video (embed-token y progreso) ── */
  // Resultado: { permitido, motivo, cursoId?, desbloqueoEn?, diasFalta? } ; nunca lanza (ante cualquier duda, permite).
  async function accesoCurso(uid, cursoId, ctx, ahoraMs = Date.now()) {
    try {
      if (!ctx || ctx.esAdmin) return { permitido: true, motivo: 'admin' };
      if (!ctx.tienePlan) return { permitido: true, motivo: 'sin-plan' };
      const cuadro = await asegurar(uid, ctx, ahoraMs);
      if (!cuadro) return { permitido: true, motivo: 'sin-calendario' };
      const e = cuadro.estados.find(x => x.cursoId === cursoId);
      if (!e) return { permitido: true, motivo: 'curso-fuera-de-fila' };
      if (e.abierto) return { permitido: true, motivo: 'abierto' };
      const puedeAdelantar = !cuadro.doc.cursoAdelantado && cuadro.doc.primerCursoId === cursoId && await esMiembroNuevo(cuadro.doc, ahoraMs);
      return { permitido: false, motivo: 'bloqueado', cursoId, desbloqueoEn: e.desbloqueoEn, diasFalta: e.diasFalta, puedeAdelantar };
    } catch (error) {
      console.warn('[Calendario] No se pudo revisar el acceso al curso; se permite:', error && error.message);
      return { permitido: true, motivo: 'error' };
    }
  }

  async function accesoVideo(uid, videoId, ctx, ahoraMs = Date.now()) {
    try {
      if (!ctx || ctx.esAdmin) return { permitido: true, motivo: 'admin' };
      if (!ctx.tienePlan) return { permitido: true, motivo: 'sin-plan' };
      const fila = await leerFila();
      const cursos = fila && fila.indice.videoACursos ? fila.indice.videoACursos.get(videoId) : null;
      if (!cursos || !cursos.length) return { permitido: true, motivo: 'video-sin-curso' };
      let ultimo = null;
      for (const cursoId of cursos) {
        const r = await accesoCurso(uid, cursoId, ctx, ahoraMs);
        if (r.permitido) return r;
        ultimo = r;
      }
      return ultimo || { permitido: true, motivo: 'sin-datos' };
    } catch (error) {
      console.warn('[Calendario] No se pudo revisar el acceso al video; se permite:', error && error.message);
      return { permitido: true, motivo: 'error' };
    }
  }

  function mensajeBloqueado(r) {
    const n = Number(r && r.diasFalta);
    const cuando = Number.isFinite(n) ? (n <= 1 ? 'mañana' : `en ${n} días`) : 'más adelante';
    return `Este curso todavía no está abierto: se desbloquea ${cuando}.` + (r && r.puedeAdelantar ? ' También puedes abrirlo antes resolviendo 15 retos en la sección Retos.' : '');
  }

  // Aplica la decisión: en modo estricto rechaza; en transición solo lo anota y deja pasar.
  function aplicar(r, donde, uid) {
    if (!r || r.permitido) return;
    if (estricto) {
      estadisticas.rechazos += 1;
      throw Object.assign(errorHttp(403, mensajeBloqueado(r)), { codigo: 'curso-bloqueado', cursoId: r.cursoId, desbloqueoEn: r.desbloqueoEn, diasFalta: r.diasFalta });
    }
    estadisticas.rechazosSimulados += 1;
    estadisticas.ultimoSimulado = new Date().toISOString();
    console.warn(`[Calendario] (modo transición) habría rechazado ${donde} del curso ${r.cursoId} a ${String(uid).slice(0, 6)}… (faltan ${r.diasFalta} días); se permite`);
  }

  async function exigirCurso(uid, cursoId, ctx, donde = 'el curso') { aplicar(await accesoCurso(uid, cursoId, ctx), donde, uid); }
  async function exigirVideo(uid, videoId, ctx, donde = 'el video') { aplicar(await accesoVideo(uid, videoId, ctx), donde, uid); }

  /* ── Rutas ── */
  function montar(app) {
    app.get('/api/calendario', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const decoded = await deps.autenticarFirebase(req, res);
        if (!decoded) return undefined;
        if (!permitirSolicitud(limites.lecturas, decoded.uid, 60 * 1000, LECTURAS_POR_MINUTO)) {
          throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
        }
        const ctx = await leerContexto(decoded.uid);
        return res.json(await vista(decoded.uid, ctx));
      } catch (error) {
        if (error && error.status) return res.status(error.status).json({ error: error.message });
        console.error('[Calendario api]', error && error.message);
        return res.status(500).json({ error: 'No se pudo cargar tu calendario de cursos' });
      }
    });
  }

  // Administración (solo lectura): modo actual, cuántas veces se habría rechazado y el calendario de una persona
  function montarAdmin(app) {
    const conAdmin = fn => async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const decoded = await deps.autenticarAdmin(req, res);
        if (!decoded) return undefined;
        return await fn(req, res, decoded);
      } catch (error) {
        if (error && error.status) return res.status(error.status).json({ error: error.message });
        console.error('[Calendario admin]', error && error.message);
        return res.status(500).json({ error: 'No se pudo leer el calendario' });
      }
    };
    app.get('/api/admin/calendario', conAdmin(async (req, res) => {
      let nuevoDesde = null;
      try { nuevoDesde = await leerNuevoDesde(Date.now()); } catch (error) { nuevoDesde = null; }
      return res.json({ ok: true, modo: estricto ? 'estricto' : 'transicion', nuevoDesde: nuevoDesde !== null ? new Date(nuevoDesde).toISOString() : null, ...estadisticas });
    }));
    // GET /api/admin/cambios-orden vive en rutas-admin-comunidad.js (junto a las demás cifras de Retos: ahí están los miembros y sus retos)
    app.get('/api/admin/calendario/:uid', conAdmin(async (req, res) => {
      const uid = String(req.params.uid || '');
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw errorHttp(400, 'Esa cuenta no es válida');
      const ctx = await leerContexto(uid);
      const guardado = await refCalendario(uid).get();
      return res.json({ ok: true, tienePlan: ctx.tienePlan, esAdmin: ctx.esAdmin, guardado: guardado.exists ? guardado.data() : null });
    }));
  }

  return {
    montarAdmin, asegurar, evaluarPrimerCurso, estadoCambioOrden, cambiarOrden, vista, accesoCurso, accesoVideo, exigirCurso, exigirVideo, leerContexto, montar,
    estadisticas, get estricto() { return estricto; }, get modo() { return estricto ? 'estricto' : 'transicion'; }
  };
}

module.exports = { crearServicioCalendario };
