'use strict';

// ══ RUTAS: Libro de registro de ejemplares (inventario, bitácora e informe anual) ══
// server.js llama a montarRutasRegistro(app, deps) con lo que ya existe y con el contexto que devuelve
// montarRutasClub (leerContexto). Las reglas puras están en services/registro-ejemplares.js.
//
// Seguridad:
//  - Todo es SOLO DEL SERVIDOR: registrosUma/{uid}/ejemplares/{id} y registrosUma/{uid}/eventos/{id}. Las
//    reglas de Firestore niegan lo que no listan, así que el navegador nunca las toca directo.
//  - El uid sale SIEMPRE del token. Nada del cuerpo o de la URL decide de quién son los datos, así que una
//    persona no puede ver ni tocar los de otra (otro uid = otra ruta de documentos).
//  - Solo con membresía vigente o administrador.
//  - Los ids de la URL se validan antes de armar una ruta de documento.

const crypto = require('crypto');
const express = require('express');
const { permitirSolicitud } = require('./rutas-club');
const { fechaMexico } = require('./retos');
const reg = require('./registro-ejemplares');

const LECTURAS_POR_MINUTO = 30;
const ESCRITURAS_POR_MINUTO = 40;
const LIMITE_CUERPO = '20kb';
const LOTE_BORRADO = 400; // Firestore admite 500 operaciones por lote

function montarRutasRegistro(app, deps) {
  const { db, autenticarFirebase, errorHttp, club } = deps;
  const limites = { lecturas: new Map(), escrituras: new Map() };
  const MAXIMOS = { lecturas: LECTURAS_POR_MINUTO, escrituras: ESCRITURAS_POR_MINUTO };
  const analizadorJson = express.json({ limit: LIMITE_CUERPO });

  const raiz = uid => db.collection('registrosUma').doc(uid);
  const colEjemplares = uid => raiz(uid).collection('ejemplares');
  const colEventos = uid => raiz(uid).collection('eventos');

  const limitar = (mapa, clave, maximo) => {
    if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };
  const sinMembresia = () => Object.assign(
    errorHttp(403, 'El libro de registro es parte de la membresía. Activa tu suscripción para usarlo'),
    { codigo: 'membresia-requerida' }
  );
  const conflicto = (mensaje, codigo) => Object.assign(errorHttp(409, mensaje), codigo ? { codigo } : {});
  const noExisteEjemplar = () => errorHttp(404, 'Ese ejemplar no existe');
  const noExisteEvento = () => errorHttp(404, 'Ese evento no existe');
  const invalido = r => Object.assign(errorHttp(400, r.error), r.campo ? { campo: r.campo } : {});

  // Los mensajes de error son siempre en español y nunca llevan datos internos
  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) {
      const cuerpo = { error: err.message };
      if (err.codigo) cuerpo.codigo = err.codigo;
      if (err.campo) cuerpo.campo = err.campo;
      return res.status(err.status).json(cuerpo);
    }
    console.error(`[Registro ${etiqueta || 'api'}]`, err && err.message);
    return res.status(500).json({ error: mensajeGenerico });
  }

  // Envoltura común: sin caché, sesión, límite por minuto y membresía. `fn` recibe el uid DEL TOKEN.
  const protegida = (clase, mensajeGenerico, etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(limites[clase], decoded.uid, MAXIMOS[clase]);
      const ctx = await club.leerContexto(decoded.uid);
      if (!(ctx.membresia || ctx.esAdmin)) throw sinMembresia();
      return await fn(req, res, decoded.uid);
    } catch (error) {
      return responderError(res, error, mensajeGenerico, etiqueta);
    }
  };

  // El cuerpo JSON se lee DESPUÉS de saber quién es y que tiene membresía.
  async function leerCuerpo(req, res) {
    await new Promise((resolver, rechazar) => analizadorJson(req, res, err => (err ? rechazar(err) : resolver())));
    return req.body;
  }
  const cuerpoJson = async (req, res) => {
    try {
      return await leerCuerpo(req, res);
    } catch (err) {
      if (err && err.type === 'entity.too.large') throw errorHttp(413, 'Los datos enviados son demasiado grandes');
      throw errorHttp(400, 'Los datos enviados no son válidos');
    }
  };

  const nuevoId = () => crypto.randomBytes(12).toString('hex');
  const ahoraIso = () => new Date().toISOString();
  const hoyMexico = () => fechaMexico(new Date());

  async function contar(coleccion) {
    if (typeof coleccion.count === 'function') {
      const r = await coleccion.count().get();
      return r.data().count;
    }
    return (await coleccion.get()).size;
  }

  // Todo lo de una persona, ya limpio. Los eventos de un ejemplar que ya no existe no cuentan.
  async function leerTodo(uid) {
    const [snapE, snapV] = await Promise.all([
      colEjemplares(uid).limit(reg.MAX_EJEMPLARES + 100).get(),
      colEventos(uid).limit(reg.MAX_EVENTOS + 100).get()
    ]);
    const ejemplares = snapE.docs.map(d => reg.ejemplarPublico(d.id, d.data()));
    const ids = new Set(ejemplares.map(e => e.id));
    const eventos = snapV.docs.map(d => reg.eventoPublico(d.id, d.data())).filter(e => ids.has(e.ejemplarId));
    return { ejemplares, eventos };
  }

  async function eventosDe(uid, ejemplarId) {
    const snap = await colEventos(uid).where('ejemplarId', '==', ejemplarId).get();
    return snap.docs.map(d => reg.eventoPublico(d.id, d.data()));
  }

  async function leerEjemplar(uid, id) {
    if (!reg.esIdRegistro(id)) throw noExisteEjemplar();
    const snap = await colEjemplares(uid).doc(id).get();
    if (!snap.exists) throw noExisteEjemplar();
    return reg.ejemplarPublico(snap.id, snap.data());
  }

  const porNombreEjemplar = (a, b) =>
    a.nombreComun.localeCompare(b.nombreComun, 'es') || (a.fechaIngreso < b.fechaIngreso ? -1 : a.fechaIngreso > b.fechaIngreso ? 1 : 0) || (a.id < b.id ? -1 : 1);
  const masRecientePrimero = (a, b) =>
    (a.fecha !== b.fecha ? (a.fecha < b.fecha ? 1 : -1) : 0) || (a.creado !== b.creado ? (a.creado < b.creado ? 1 : -1) : 0) || (a.id < b.id ? 1 : -1);

  // ════════════════════════════════════════════════════════════
  // GET /api/registro — ejemplares (con estado), eventos y resumen
  // ════════════════════════════════════════════════════════════
  app.get('/api/registro', protegida('lecturas', 'No se pudo cargar tu libro de registro', 'leer', async (req, res, uid) => {
    const { ejemplares, eventos } = await leerTodo(uid);
    return res.json({
      ok: true,
      hoy: hoyMexico(),
      ejemplares: ejemplares.map(e => reg.vistaEjemplar(e, eventos)).sort(porNombreEjemplar),
      eventos: eventos.slice().sort(masRecientePrimero),
      resumen: reg.resumenInventario(ejemplares, eventos),
      limites: { maxEjemplares: reg.MAX_EJEMPLARES, maxEventos: reg.MAX_EVENTOS }
    });
  }));

  // ════════════════════════════════════════════════════════════
  // POST /api/registro/ejemplares — alta o nacimiento: crea un ejemplar nuevo con su origen
  // ════════════════════════════════════════════════════════════
  app.post('/api/registro/ejemplares', protegida('escrituras', 'No se pudo guardar el ejemplar', 'crear', async (req, res, uid) => {
    const r = reg.validarEjemplar(await cuerpoJson(req, res), { hoy: hoyMexico() });
    if (!r.ok) throw invalido(r);
    if (await contar(colEjemplares(uid)) >= reg.MAX_EJEMPLARES) {
      throw conflicto(`Llegaste al máximo de ${reg.MAX_EJEMPLARES} ejemplares. Elimina alguno que ya no necesites para agregar otro`, 'limite-ejemplares');
    }
    const id = nuevoId();
    const ahora = ahoraIso();
    // set completo: lo guardado es exactamente lo validado (nada extra que mande el navegador) y el uid es el del token
    await colEjemplares(uid).doc(id).set({ uid, ...r.valor, creado: ahora, actualizado: ahora });
    const ejemplar = reg.ejemplarPublico(id, { ...r.valor, creado: ahora, actualizado: ahora });
    return res.status(201).json({ ok: true, ejemplar: reg.vistaEjemplar(ejemplar, []) });
  }));

  // ════════════════════════════════════════════════════════════
  // PATCH /api/registro/ejemplares/:id — corregir datos del ejemplar
  // ════════════════════════════════════════════════════════════
  app.patch('/api/registro/ejemplares/:id', protegida('escrituras', 'No se pudo actualizar el ejemplar', 'editar', async (req, res, uid) => {
    const actual = await leerEjemplar(uid, req.params.id);
    const r = reg.validarEjemplar(await cuerpoJson(req, res), { hoy: hoyMexico(), parcial: true });
    if (!r.ok) throw invalido(r);
    if (Object.keys(r.valor).length === 0) throw errorHttp(400, 'No hay cambios para guardar');
    const eventos = await eventosDe(uid, actual.id);
    if (r.valor.fechaIngreso) {
      const antes = eventos.find(e => e.fecha && e.fecha < r.valor.fechaIngreso);
      if (antes) throw invalido({ campo: 'fechaIngreso', error: `La fecha de ingreso no puede ser posterior a un evento ya registrado (${antes.fecha})` });
    }
    const actualizado = ahoraIso();
    await colEjemplares(uid).doc(actual.id).set({ uid, ...r.valor, actualizado }, { merge: true });
    const ejemplar = { ...actual, ...r.valor, actualizado };
    return res.json({ ok: true, ejemplar: reg.vistaEjemplar(ejemplar, eventos) });
  }));

  // ════════════════════════════════════════════════════════════
  // DELETE /api/registro/ejemplares/:id — borra el ejemplar y TODOS sus eventos
  // ════════════════════════════════════════════════════════════
  app.delete('/api/registro/ejemplares/:id', protegida('escrituras', 'No se pudo eliminar el ejemplar', 'borrar', async (req, res, uid) => {
    const id = req.params.id;
    if (!reg.esIdRegistro(id)) throw noExisteEjemplar();
    const ref = colEjemplares(uid).doc(id);
    const snap = await ref.get();
    // Primero los eventos y al final el ejemplar: si algo falla a medias, el ejemplar sigue ahí y se puede reintentar
    const eventos = await colEventos(uid).where('ejemplarId', '==', id).get();
    for (let i = 0; i < eventos.docs.length; i += LOTE_BORRADO) {
      const lote = db.batch();
      for (const d of eventos.docs.slice(i, i + LOTE_BORRADO)) lote.delete(colEventos(uid).doc(d.id));
      await lote.commit();
    }
    if (!snap.exists) throw noExisteEjemplar();
    await ref.delete();
    return res.json({ ok: true, eventosEliminados: eventos.docs.length });
  }));

  // ════════════════════════════════════════════════════════════
  // POST /api/registro/ejemplares/:id/eventos — baja, muerte, traslado o nota
  // ════════════════════════════════════════════════════════════
  app.post('/api/registro/ejemplares/:id/eventos', protegida('escrituras', 'No se pudo guardar el evento', 'evento', async (req, res, uid) => {
    const ejemplar = await leerEjemplar(uid, req.params.id);
    const cuerpo = await cuerpoJson(req, res);
    const eventos = await eventosDe(uid, ejemplar.id);
    const { estado } = reg.estadoEjemplar(ejemplar, eventos);
    const r = reg.validarEvento(cuerpo, { hoy: hoyMexico(), ejemplar, estado });
    if (!r.ok) {
      if (r.conflicto) throw conflicto(r.error, 'ya-tiene-salida');
      throw invalido(r);
    }
    if (await contar(colEventos(uid)) >= reg.MAX_EVENTOS) {
      throw conflicto(`Llegaste al máximo de ${reg.MAX_EVENTOS} eventos. Elimina alguno que ya no necesites para agregar otro`, 'limite-eventos');
    }
    const esSalida = reg.TIPOS_SALIDA.includes(r.valor.tipo);
    // Un ejemplar solo puede tener UNA salida: su id es fijo, y la transacción rechaza una segunda aunque lleguen a la vez
    const id = esSalida ? `sal_${ejemplar.id}` : nuevoId();
    const ref = colEventos(uid).doc(id);
    const doc = { uid, ejemplarId: ejemplar.id, ...r.valor, creado: ahoraIso() };
    await db.runTransaction(async tx => {
      if (esSalida) {
        const previo = await tx.get(ref);
        if (previo.exists) throw conflicto('Este ejemplar ya tiene registrada una salida. Si fue un error, elimina ese evento primero', 'ya-tiene-salida');
      }
      tx.set(ref, doc);
    });
    const evento = reg.eventoPublico(id, doc);
    return res.status(201).json({ ok: true, evento, ejemplar: reg.vistaEjemplar(ejemplar, [...eventos, evento]) });
  }));

  // ════════════════════════════════════════════════════════════
  // DELETE /api/registro/eventos/:id — deshacer un evento registrado por error
  // ════════════════════════════════════════════════════════════
  app.delete('/api/registro/eventos/:id', protegida('escrituras', 'No se pudo eliminar el evento', 'borrar-evento', async (req, res, uid) => {
    const id = req.params.id;
    if (!reg.esIdRegistro(id)) throw noExisteEvento();
    const ref = colEventos(uid).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw noExisteEvento();
    const ejemplarId = reg.eventoPublico(snap.id, snap.data()).ejemplarId;
    await ref.delete();
    return res.json({ ok: true, ejemplarId });
  }));

  // ════════════════════════════════════════════════════════════
  // GET /api/registro/informe?anio=AAAA — informe anual por especie y total
  // ════════════════════════════════════════════════════════════
  app.get('/api/registro/informe', protegida('lecturas', 'No se pudo armar el informe', 'informe', async (req, res, uid) => {
    const hoy = hoyMexico();
    const a = reg.validarAnio(req.query.anio, hoy);
    if (!a.ok) throw errorHttp(400, a.error);
    const { ejemplares, eventos } = await leerTodo(uid);
    return res.json({ ok: true, hoy, ...reg.informeAnual(ejemplares, eventos, a.anio, { hoy }) });
  }));

  return { limites };
}

module.exports = { montarRutasRegistro, LECTURAS_POR_MINUTO, ESCRITURAS_POR_MINUTO };
