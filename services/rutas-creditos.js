'use strict';

// ══ RUTAS: créditos (regalo manual del administrador y canje por materiales) ══
// Administrador (verificado en el servidor, límite de peticiones y bitácora adminAcciones):
//   GET  /api/admin/creditos/miembros    todas las cuentas, de la más reciente a la más antigua, con saldo y último regalo
//   POST /api/admin/creditos/regalar     { uid, cantidad, clave } regala esa cantidad (entero de 1 a 1,000; el panel ofrece 100, 200, 300, 400
//                                        u otra); la clave evita regalar dos veces por un doble clic; tope de 1,000 créditos por cuenta y día
//   GET  /api/admin/creditos/historial   cada regalo: persona, cantidad, fecha, quién lo regaló, Pendiente / Canjeados 1 de 3 / Canjeado + materiales
//   GET  /api/admin/creditos/metricas    regalados, canjeados, pendientes y cuántos canjes tuvo cada material (para la gráfica)
// Persona con sesión:
//   GET  /api/creditos/estado            saldo, aviso de felicitación pendiente y materiales canjeables (costo 100). Por libro: canjeable (true/false) y
//                                        motivo (ya-accesible, ya-canjeo-libro, saldo-insuficiente); de la cuenta: librosCanjeadosConCreditos (0 o 1) y libroCanjeadoId
//   POST /api/creditos/canjear           { materialId } descuenta 100 (costo fijo del servidor) y desbloquea ESE material para esta cuenta, para siempre.
//                                        Solo UN libro por cuenta en toda su vida (409 «ya-canjeo-libro» sin cobrar); los demás materiales no tienen límite
//   POST /api/creditos/aviso-visto       marca la felicitación como vista (vive en el servidor, no en el navegador)
//   GET  /api/creditos/regalos           ligera: los regalos de ESTA cuenta de los últimos 30 días ({ id, cantidad, en }) para la campana de avisos del Club
// Las reglas del servicio están en services/creditos.js. El acceso a los materiales canjeados lo valida rutas-materiales.js.

const { permitirSolicitud } = require('./rutas-club');
const panel = require('./admin-panel');
const creditos = require('./creditos');
const libros = require('./libros');
const materiales = require('./materiales');
const porCurso = require('./materiales-curso');

const ESTADO_POR_MINUTO = 60;
const CANJES_POR_MINUTO = 10;
const POR_PAGINA = 25;
const FILTROS_HISTORIAL = ['todos', 'pendientes', 'canjeados'];

// PDF de Drive cargados desde el panel (colección pdfs), ya normalizados
async function leerPdfsDrive(db) {
  const snap = await db.collection('pdfs').get();
  const lista = [];
  for (const d of snap.docs) {
    const m = porCurso.normalizarPdfDrive(d.id, d.data());
    if (m) lista.push(m);
  }
  return lista.slice(0, 300);
}

const sinAcentos = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function responderError(res, err, generico, etiqueta) {
  if (err && err.status) return res.status(err.status).json(err.codigo ? { error: err.message, codigo: err.codigo } : { error: err.message });
  console.error(`[Créditos ${etiqueta || 'api'}]`, err && err.message);
  return res.status(500).json({ error: generico });
}

/* ═════════════════════ Persona con sesión ═════════════════════ */
function montarRutasCreditos(app, deps) {
  const { db, admin, autenticarFirebase, errorHttp, club, catalogoLibros, catalogoMateriales } = deps;
  const limites = { estado: new Map(), canjes: new Map() };
  const limitar = (mapa, clave, maximo) => {
    if (!permitirSolicitud(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
  };
  const conSesion = (generico, etiqueta, mapa, maximo, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const decoded = await autenticarFirebase(req, res);
      if (!decoded) return undefined;
      limitar(mapa, decoded.uid, maximo);
      return await fn(req, res, decoded);
    } catch (error) {
      return responderError(res, error, generico, etiqueta);
    }
  };

  // Lo que la persona puede hoy, SIN créditos (membresía y retos), para saber qué ya abre por otra vía
  async function estadoDeAcceso(uid) {
    const ctx = await club.leerContexto(uid);
    const superados = ctx.membresia ? (await club.leerEstadoRetos(uid)).superados : 0;
    return { superados, membresia: ctx.membresia, esAdmin: ctx.esAdmin };
  }

  // Cada material canjeable con su estado para ESTA persona: 'canjeado', 'otra-via' (ya lo abre por membresía o retos) o 'canjeable'
  async function materialesDe(uid, estado) {
    const [drive, desbloqueos] = await Promise.all([leerPdfsDrive(db), creditos.leerDesbloqueos(db, uid)]);
    const lista = creditos.catalogoCanjeable({ libros: catalogoLibros.libros, materiales: catalogoMateriales.materiales, drive });
    const librosPorId = new Map(catalogoLibros.libros.map(l => [l.id, l]));
    const pdfsPorId = new Map(catalogoMateriales.materiales.map(m => [m.id, m]));
    const drivePorId = new Map(drive.map(m => [m.id, m]));
    const sinCredito = lista.map(item => {
      let abre = false;
      if (item.tipo === 'libro') abre = libros.acceso(librosPorId.get(item.id), estado).desbloqueado;
      else if (item.tipo === 'pdf') abre = materiales.acceso(pdfsPorId.get(item.id), estado).desbloqueado;
      else abre = porCurso.acceso(drivePorId.get(item.id), estado).desbloqueado;
      const canjeado = desbloqueos.has(item.clave);
      return { ...item, estado: canjeado ? 'canjeado' : (abre ? 'otra-via' : 'canjeable') };
    });
    return sinCredito;
  }

  app.get('/api/creditos/estado', conSesion('No se pudieron cargar tus créditos', 'estado', limites.estado, ESTADO_POR_MINUTO, async (req, res, decoded) => {
    const [cuenta, estado] = await Promise.all([creditos.leerCuenta(db, decoded.uid), estadoDeAcceso(decoded.uid)]);
    const lista = await materialesDe(decoded.uid, estado);
    // Regla de los libros: a lo más UNO con créditos en toda la vida de la cuenta. Los que abre por retos o membresía no cuentan.
    const claveLibro = cuenta.libroCanjeado || ((lista.find(m => m.tipo === 'libro' && m.estado === 'canjeado') || {}).clave || '');
    const motivoDeLibro = m => {
      if (m.estado === 'canjeado') return { canjeable: false, motivo: 'ya-canjeado' };
      if (m.estado === 'otra-via') return { canjeable: false, motivo: 'ya-accesible' };
      if (claveLibro) return { canjeable: false, motivo: 'ya-canjeo-libro' };
      if (cuenta.saldo < creditos.COSTO_MATERIAL) return { canjeable: false, motivo: 'saldo-insuficiente' };
      return { canjeable: true, motivo: null };
    };
    const libros = lista.filter(m => m.tipo === 'libro').map(m => ({ clave: m.clave, id: m.id, titulo: m.titulo, desbloqueado: m.estado === 'canjeado', ...motivoDeLibro(m) }));
    const porClaveLibro = new Map(libros.map(l => [l.clave, l]));
    return res.json({
      ok: true, saldo: cuenta.saldo, costo: creditos.COSTO_MATERIAL, avisoPendiente: cuenta.avisoPendiente, regalo: creditos.REGALO,
      librosCanjeadosConCreditos: claveLibro ? 1 : 0, libroCanjeadoId: claveLibro ? claveLibro.slice('libro:'.length) : null, maxLibrosPorCreditos: creditos.MAX_LIBROS_POR_CREDITOS, libros,
      // Lo que ya abre por membresía o retos no se ofrece para canjear
      materiales: lista.filter(m => m.estado !== 'otra-via').map(m => ({
        clave: m.clave, tipo: m.tipo, id: m.id, titulo: m.titulo, area: m.area, descripcion: m.descripcion, paginas: m.paginas, formato: m.formato,
        costo: creditos.COSTO_MATERIAL, desbloqueado: m.estado === 'canjeado',
        ...(m.tipo === 'libro' ? { canjeable: porClaveLibro.get(m.clave).canjeable, motivo: porClaveLibro.get(m.clave).motivo } : {})
      }))
    });
  }));

  app.post('/api/creditos/canjear', deps.analizadorJson || ((req, res, next) => next()), conSesion('No se pudo canjear el material', 'canjear', limites.canjes, CANJES_POR_MINUTO, async (req, res, decoded) => {
    const clave = req.body && typeof req.body.materialId === 'string' ? req.body.materialId : '';
    const parsed = creditos.analizarClave(clave);
    if (!parsed) throw errorHttp(400, 'Elige un material de la lista');
    const estado = await estadoDeAcceso(decoded.uid);
    if (estado.esAdmin) throw Object.assign(errorHttp(409, 'Las cuentas de administración ya abren todo'), { codigo: 'ya-accesible' });
    const lista = await materialesDe(decoded.uid, estado);
    const item = lista.find(m => m.clave === parsed.clave);
    if (!item) throw Object.assign(errorHttp(404, 'Ese material no se puede canjear con créditos'), { codigo: 'no-canjeable' });
    if (item.estado === 'canjeado') throw Object.assign(errorHttp(409, 'Ya canjeaste este material'), { codigo: 'ya-desbloqueado' });
    if (item.estado === 'otra-via') throw Object.assign(errorHttp(409, 'Ya tienes acceso a este material: no hace falta gastar créditos'), { codigo: 'ya-accesible' });
    try {
      const r = await creditos.canjear(db, admin, { uid: decoded.uid, material: item });
      return res.json({ ok: true, saldo: r.saldo, materialId: r.clave, tipo: item.tipo, id: item.id, titulo: item.titulo });
    } catch (e) {
      if (e instanceof creditos.ErrorCreditos) throw Object.assign(errorHttp(e.status, e.message), { codigo: e.codigo });
      throw e;
    }
  }));

  // Ruta ligera para la campana de avisos: solo el libro de movimientos de esta cuenta (no lee catálogos ni accesos). Si falla, la campana sigue sin ese aviso.
  app.get('/api/creditos/regalos', conSesion('No se pudieron cargar tus avisos de créditos', 'regalos', limites.estado, ESTADO_POR_MINUTO, async (req, res, decoded) => {
    const regalos = await creditos.leerRegalosRecientes(db, decoded.uid);
    return res.json({ ok: true, regalos, dias: creditos.DIAS_AVISO_REGALO });
  }));

  app.post('/api/creditos/aviso-visto', deps.analizadorJson || ((req, res, next) => next()), conSesion('No se pudo guardar', 'aviso-visto', limites.estado, ESTADO_POR_MINUTO, async (req, res, decoded) => {
    await creditos.marcarAvisoVisto(db, admin, decoded.uid);
    return res.json({ ok: true, avisoPendiente: 0 });
  }));

  return { limites, materialesDe };
}

/* ═════════════════════ Administración ═════════════════════ */
function montarRutasAdminCreditos(app, deps, a) {
  const { db, admin, auth, errorHttp } = deps;
  const { conAdmin, anotarAccion, listaMiembros, refrescar, analizadorJson } = a;

  async function cuentas() {
    const snap = await db.collection(creditos.COL_CUENTAS).limit(creditos.TOPE_MOVIMIENTOS).get();
    return new Map(snap.docs.map(d => [d.id, d.data() || {}]));
  }

  app.get('/api/admin/creditos/miembros', conAdmin('No se pudieron cargar los miembros', 'creditos-miembros', async (req, res) => {
    const [{ lista, truncado }, mapa] = await Promise.all([listaMiembros(refrescar(req)), cuentas()]);
    const filas = lista.filter(v => !v.esAdmin).map(v => {
      const c = mapa.get(v.uid) || {};
      return {
        uid: v.uid, nombre: v.nombre, correo: v.correo, registro: v.registro, estado: v.estado, conAcceso: v.conAcceso, planTipo: v.planTipo,
        saldo: Number.isInteger(c.saldo) && c.saldo > 0 ? c.saldo : 0, regalados: Number(c.regalados) || 0, canjeados: Number(c.canjeados) || 0,
        ultimoRegalo: creditos.iso(c.ultimoRegaloEn), avisoPendiente: Number(c.avisoPendiente) > 0
      };
    });
    return res.json({ ok: true, generado: new Date().toISOString(), total: filas.length, truncado, regalo: creditos.REGALO, maxRegalo: creditos.MAX_REGALO, topeDia: creditos.TOPE_CREDITOS_POR_DIA, costo: creditos.COSTO_MATERIAL, miembros: filas });
  }));

  app.post('/api/admin/creditos/regalar', analizadorJson, conAdmin('No se pudieron regalar los créditos', 'creditos-regalar', async (req, res, decoded) => {
    const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
    const uid = typeof cuerpo.uid === 'string' ? cuerpo.uid : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw errorHttp(400, 'El identificador no es válido');
    const m = await db.collection('miembros').doc(uid).get();
    if (!m.exists) throw errorHttp(404, 'No encontramos a esa persona');
    const datos = m.data() || {};
    if (datos.role === 'admin') throw errorHttp(409, 'Las cuentas de administración no reciben créditos');
    // La cantidad la elige la administración: entero de 1 a 1,000 (nunca texto, decimales ni negativos)
    if (!creditos.cantidadValida(cuerpo.cantidad)) throw Object.assign(errorHttp(400, `Escribe cuántos créditos regalar: un número entero de 1 a ${creditos.MAX_REGALO}`), { codigo: 'cantidad-invalida' });
    // Solo cuentas con el correo confirmado (así un regalo nunca queda en una cuenta falsa o ajena)
    let verificado = false;
    try { const u = await auth.getUser(uid); verificado = u.emailVerified === true; } catch (e) {
      if (e && e.code === 'auth/user-not-found') throw errorHttp(404, 'Esa cuenta ya no existe');
      throw errorHttp(503, 'No se pudo comprobar el correo de la cuenta. Inténtalo de nuevo');
    }
    if (!verificado) throw Object.assign(errorHttp(409, 'Esa cuenta todavía no confirmó su correo. Cuando lo confirme podrás regalarle créditos'), { codigo: 'correo-no-verificado' });
    try {
      const r = await creditos.regalar(db, admin, { uid, adminUid: decoded.uid, adminCorreo: decoded.email, clave: cuerpo.clave, cantidad: cuerpo.cantidad });
      if (!r.repetido) {
        await anotarAccion(decoded, 'creditos-regalar', uid, `Regaló ${r.cantidad} créditos a ${panel.limpiarTexto(datos.name || datos.displayName || 'una persona', 60)}`, { cantidad: r.cantidad });
      }
      return res.json({ ok: true, saldo: r.saldo, cantidad: r.cantidad, materiales: Math.floor(r.cantidad / creditos.COSTO_MATERIAL), repetido: r.repetido });
    } catch (e) {
      if (e instanceof creditos.ErrorCreditos) throw Object.assign(errorHttp(e.status, e.message), { codigo: e.codigo });
      throw e;
    }
  }, { escritura: true }));

  app.get('/api/admin/creditos/historial', conAdmin('No se pudo cargar el historial de regalos', 'creditos-historial', async (req, res) => {
    const filtro = FILTROS_HISTORIAL.includes(req.query.estado) ? req.query.estado : 'todos';
    const q = sinAcentos(String(req.query.q || '').slice(0, 80)).trim();
    const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const [{ movimientos, truncado }, { lista }] = await Promise.all([creditos.leerMovimientos(db), listaMiembros(refrescar(req))]);
    const personas = new Map(lista.map(v => [v.uid, v]));
    const adminsNombre = new Map();
    let regalos = creditos.historialDeRegalos(movimientos).map(r => {
      const p = personas.get(r.uid) || {};
      return { ...r, nombre: p.nombre || 'Cuenta eliminada', correo: p.correo || '', adminCorreo: r.adminCorreo };
    });
    void adminsNombre;
    const totales = { todos: regalos.length, pendientes: regalos.filter(r => r.estado !== 'canjeado').length, canjeados: regalos.filter(r => r.estado === 'canjeado').length };
    if (filtro === 'pendientes') regalos = regalos.filter(r => r.estado !== 'canjeado');
    else if (filtro === 'canjeados') regalos = regalos.filter(r => r.estado === 'canjeado');
    if (q) regalos = regalos.filter(r => sinAcentos(`${r.nombre} ${r.correo} ${r.canjes.map(c => c.titulo).join(' ')}`).includes(q));
    const total = regalos.length;
    const filas = regalos.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA).map(r => ({
      id: r.id, uid: r.uid, nombre: r.nombre, correo: r.correo, cantidad: r.cantidad, en: r.en, regaladoPor: r.adminCorreo, origen: r.origen, cupon: r.cupon, estado: r.estado, canje: r.canje,
      materialesTotal: r.materialesTotal, materialesCanjeados: r.materialesCanjeados, usados: r.usados, sobrante: r.sobrante, canjes: r.canjes
    }));
    return res.json({ ok: true, generado: new Date().toISOString(), truncado, total, totales, pagina, porPagina: POR_PAGINA, hayMas: pagina * POR_PAGINA < total, regalos: filas });
  }));

  app.get('/api/admin/creditos/metricas', conAdmin('No se pudieron cargar las cifras de créditos', 'creditos-metricas', async (req, res) => {
    const { movimientos, truncado } = await creditos.leerMovimientos(db);
    return res.json({ ok: true, generado: new Date().toISOString(), truncado, ...creditos.metricas(movimientos) });
  }));
}

module.exports = { montarRutasCreditos, montarRutasAdminCreditos, leerPdfsDrive };
