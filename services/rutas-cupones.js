'use strict';

// ══ RUTAS: cupones de créditos ══
// Persona con sesión (verificada en el servidor; solo cuentas con el correo verificado y que no sean de administración):
//   GET  /api/creditos/cupon-disponible  ¿hay un cupón que esta persona aún pueda canjear? { hay, cantidad, creditos (el mayor), limitado, ids }.
//                                        NUNCA devuelve claves: la tarjeta de aviso solo invita a unirse al canal de WhatsApp
//   POST /api/creditos/cupon/canjear     { clave } suma los créditos al instante. Una vez por persona y cupón. Errores: 404 «no-valido»
//                                        (no existe o está pausado), 409 «ya-canjeado», 403 «cupon-no-aplica» (el cupón es solo para miembros VIP o solo para
//                                        cuentas gratuitas), 410 «cupon-agotado» (con { limite }) y «cupon-vencido»,
//                                        429 «demasiados-intentos» (5 fallos en 15 minutos)
// Administración (verificada en el servidor, con límite de peticiones y bitácora adminAcciones):
//   GET  /api/admin/creditos/cupones           todos los cupones con estado (activo, pausado, vencido, agotado), canjes y créditos entregados
//   POST /api/admin/creditos/cupones           { clave? (vacía = al azar), creditos (1 a 1,000), vence? (fecha y hora), maxPersonas?, audiencia? ('todos' por omisión,
//                                              'gratuitos' o 'vip') } crea un cupón
//   POST /api/admin/creditos/cupones/estado    { clave, estado: 'activo' | 'pausado' } pausa o reactiva
//   GET  /api/admin/creditos/cupones/canjes    ?clave= quién lo canjeó (nombre, correo, créditos, fecha)
// Las reglas del servicio están en services/cupones.js.

const { permitirSolicitud } = require('./rutas-club');
const panel = require('./admin-panel');
const cupones = require('./cupones');

const POR_MINUTO = 30;

function responderError(res, err, generico, etiqueta) {
  if (err && err.status) {
    const cuerpo = { error: err.message };
    if (err.codigo) cuerpo.codigo = err.codigo;
    if (err.limite !== undefined) cuerpo.limite = err.limite;
    if (err.esperaMin !== undefined) cuerpo.esperaMin = err.esperaMin;
    if (err.audiencia !== undefined) cuerpo.audiencia = err.audiencia;
    return res.status(err.status).json(cuerpo);
  }
  console.error(`[Cupones ${etiqueta || 'api'}]`, err && err.message);
  return res.status(500).json({ error: generico });
}

function montarRutasCupones(app, deps) {
  const { db, admin, auth, autenticarFirebase, errorHttp, club } = deps;
  const servicio = cupones.crearServicio({ db, admin });
  const intentos = cupones.crearLimitadorIntentos();
  const limites = { lecturas: new Map(), canjes: new Map() };
  const limitar = (mapa, clave, maximo) => {
    if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };
  const conSesion = (generico, etiqueta, mapa, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(mapa, decoded.uid, POR_MINUTO);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, generico, etiqueta);
    }
  };

  // Cuentas de administración no reciben créditos
  async function datosDeMiembro(uid) {
    const m = await db.collection('miembros').doc(uid).get();
    return (m.exists && m.data()) || {};
  }

  app.get('/api/creditos/cupon-disponible', conSesion('No se pudo consultar el cupón', 'disponible', limites.lecturas, async (req, res, decoded) => {
    const datos = await datosDeMiembro(decoded.uid);
    if (datos.role === 'admin') return res.json({ ok: true, hay: false, cantidad: 0, creditos: 0, limitado: false, ids: [] });
    const ctx = await club.leerContexto(decoded.uid);
    return res.json({ ok: true, ...(await servicio.disponiblesPara(decoded.uid, { membresia: ctx.tienePlan === true })) });
  }));

  app.post('/api/creditos/cupon/canjear', deps.analizadorJson || ((req, res, next) => next()), conSesion('No se pudo canjear el cupón', 'canjear', limites.canjes, async (req, res, decoded) => {
    const datos = await datosDeMiembro(decoded.uid);
    if (datos.role === 'admin') throw Object.assign(errorHttp(409, 'Las cuentas de administración no reciben créditos'), { codigo: 'admin' });
    let verificado = false;
    try { const u = await auth.getUser(decoded.uid); verificado = u.emailVerified === true; } catch (e) { throw errorHttp(503, 'No se pudo comprobar tu correo. Inténtalo de nuevo'); }
    if (!verificado) throw Object.assign(errorHttp(409, 'Primero confirma tu correo para poder canjear cupones'), { codigo: 'correo-no-verificado' });
    intentos.revisar(decoded.uid);
    const ctx = await club.leerContexto(decoded.uid);
    const clave = req.body && typeof req.body.clave === 'string' ? req.body.clave : '';
    try {
      const r = await servicio.canjear({ uid: decoded.uid, nombre: panel.limpiarTexto(datos.name || datos.displayName || decoded.name || '', 120), email: decoded.email, clave, membresia: ctx.tienePlan === true });
      intentos.acierto(decoded.uid);
      return res.json({ ok: true, creditos: r.creditos, saldo: r.saldo });
    } catch (e) {
      // Equivocarse (clave que no existe, vencida o agotada) cuenta como intento fallido; haberlo canjeado antes o que el cupón sea de otro tipo de cuenta no
      if (e instanceof cupones.ErrorCupon && e.codigo !== 'ya-canjeado' && e.codigo !== 'cupon-no-aplica') intentos.fallo(decoded.uid);
      throw e;
    }
  }));

  return { servicio };
}

function montarRutasAdminCupones(app, deps, a) {
  const { db, admin } = deps;
  const { conAdmin, anotarAccion, analizadorJson } = a;
  const servicio = cupones.crearServicio({ db, admin });

  app.get('/api/admin/creditos/cupones', conAdmin('No se pudieron cargar los cupones', 'cupones-lista', async (req, res) => {
    return res.json({ ok: true, cupones: await servicio.listar(), maxCreditos: cupones.MAX_CREDITOS, maxPersonas: cupones.MAX_PERSONAS });
  }));

  app.post('/api/admin/creditos/cupones', analizadorJson, conAdmin('No se pudo crear el cupón', 'cupones-crear', async (req, res, decoded) => {
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    const fila = await servicio.crear({ adminUid: decoded.uid, adminCorreo: decoded.email, clave: c.clave, creditos: c.creditos, venceMs: c.vence, maxPersonas: c.maxPersonas, audiencia: c.audiencia });
    await anotarAccion(decoded, 'cupon-crear', fila.clave, `Creó el cupón ${fila.clave} de ${fila.creditos} créditos`, { creditos: fila.creditos, maxPersonas: fila.maxPersonas, vence: fila.vence, audiencia: fila.audiencia });
    return res.json({ ok: true, cupon: fila });
  }, { escritura: true }));

  app.post('/api/admin/creditos/cupones/estado', analizadorJson, conAdmin('No se pudo cambiar el cupón', 'cupones-estado', async (req, res, decoded) => {
    const c = req.body && typeof req.body === 'object' ? req.body : {};
    const fila = await servicio.cambiarEstado({ clave: c.clave, estado: c.estado });
    await anotarAccion(decoded, 'cupon-estado', fila.clave, `${c.estado === 'pausado' ? 'Pausó' : 'Reactivó'} el cupón ${fila.clave}`, { estado: c.estado });
    return res.json({ ok: true, cupon: fila });
  }, { escritura: true }));

  app.get('/api/admin/creditos/cupones/canjes', conAdmin('No se pudo cargar quién canjeó el cupón', 'cupones-canjes', async (req, res) => {
    const canjes = await servicio.canjesDe(String(req.query.clave || ''));
    return res.json({ ok: true, canjes, total: canjes.length });
  }));
}

module.exports = { montarRutasCupones, montarRutasAdminCupones };
