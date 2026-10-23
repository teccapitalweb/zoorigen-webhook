'use strict';

// ══ CUPONES DE CRÉDITOS ═══════════════════════════════════════════
// La administración crea un cupón (una clave y cuántos créditos entrega) y lo comparte por el canal de WhatsApp. Cada persona con la
// clave la escribe en «¿Tienes un código?» (PDFs y materiales) y recibe los créditos al instante. Reglas:
//  · Una vez por persona y por cupón (creditosCuponCanjes/{clave__uid}); la clave no distingue mayúsculas, acentos ni espacios.
//  · Opcionales: fecha y hora límite, y máximo de personas. Se puede pausar y reactivar; un cupón usado nunca se borra.
//  · Para quién es: todas las cuentas, solo cuentas gratuitas (sin membresía vigente) o solo miembros VIP (con membresía vigente). La tarjeta de aviso
//    solo se le ofrece a quien el cupón le sirve, y al canjear el servidor vuelve a comprobarlo.
//  · Los créditos entran al libro de movimientos como un regalo más (origen «cupon»), así el canje de materiales y el historial
//    funcionan igual que con los regalos del administrador. No cuentan para el tope diario de regalos (cada cupón fija su cantidad).
//  · Quien se equivoca muchas veces espera (frena adivinar claves). Solo cuentas con correo verificado y que no sean administración.
//  · Nada de esto llega al navegador de las demás personas: la tarjeta de aviso solo dice que HAY un cupón, nunca su clave.
// Todo lo escribe SOLO el servidor (colecciones cerradas al navegador por las reglas de Firestore).

const crypto = require('crypto');
const creditos = require('./creditos');

const COL_CUPONES = 'creditosCupones';
const COL_CANJES = 'creditosCuponCanjes';
const MAX_CREDITOS = creditos.MAX_REGALO;      // créditos por canje de un cupón: de 1 a 1,000
const MAX_PERSONAS = 100000;
const TOPE_LISTA = 500;
const TOPE_CANJES = 5000;
const CLAVE_VALIDA = /^[A-Z0-9_-]{4,24}$/;
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sin 0, O, 1, I, L para que no se confundan al teclear
const AUDIENCIAS = Object.freeze(['todos', 'gratuitos', 'vip']);   // a quién le sirve el cupón
const INTENTOS_MAX = 5;                        // fallos permitidos por persona...
const INTENTOS_VENTANA_MS = 15 * 60 * 1000;    // ...en esta ventana; después espera a que pase

class ErrorCupon extends Error {
  constructor(status, mensaje, codigo, extra) { super(mensaje); this.status = status; this.codigo = codigo; if (extra) Object.assign(this, extra); }
}

const hash = texto => crypto.createHash('sha1').update(String(texto)).digest('hex');
const aMs = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return null; } }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/* La clave tal como se guarda: mayúsculas, sin acentos ni espacios. '' si no es válida. */
function normalizarClave(texto) {
  const t = String(texto == null ? '' : texto).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, '');
  return CLAVE_VALIDA.test(t) ? t : '';
}

function generarClave(azar = n => crypto.randomInt(n)) {
  let s = 'ZOO';
  for (let i = 0; i < 6; i++) s += ALFABETO[azar(ALFABETO.length)];
  return s;
}

// Identificador que se puede mostrar (no revela la clave): sirve para contar cuántas veces se le enseñó el aviso a una persona
const idPublico = clave => hash('cupon|' + clave).slice(0, 12);

// 'pausado' | 'vencido' | 'agotado' | 'activo'
function estadoDe(c, ahora = Date.now()) {
  if (c.estado === 'pausado') return 'pausado';
  const vence = aMs(c.venceMs);
  if (vence !== null && vence <= ahora) return 'vencido';
  if (Number.isInteger(c.maxPersonas) && c.maxPersonas > 0 && (Number(c.canjes) || 0) >= c.maxPersonas) return 'agotado';
  return 'activo';
}

// ¿Le sirve este cupón a esta persona? membresia = tiene una membresía vigente
function aplicaA(audiencia, membresia) {
  if (audiencia === 'vip') return membresia === true;
  if (audiencia === 'gratuitos') return membresia !== true;
  return true;
}
const audienciaDe = d => (AUDIENCIAS.includes(d && d.audiencia) ? d.audiencia : 'todos');

function validarNuevo({ clave, creditos: cantidad, venceMs, maxPersonas, audiencia }, ahora = Date.now()) {
  const cl = String(clave == null ? '' : clave).trim() ? normalizarClave(clave) : '';
  if (String(clave == null ? '' : clave).trim() && !cl) throw new ErrorCupon(400, 'La clave debe tener de 4 a 24 letras o números, sin símbolos (puedes usar guion).', 'clave-invalida');
  if (typeof cantidad !== 'number' || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CREDITOS) {
    throw new ErrorCupon(400, `Escribe cuántos créditos entrega: un número entero de 1 a ${MAX_CREDITOS}.`, 'creditos-invalidos');
  }
  let vence = null;
  if (venceMs !== null && venceMs !== undefined && venceMs !== '') {
    vence = aMs(venceMs);
    if (vence === null) throw new ErrorCupon(400, 'La fecha límite no es válida.', 'fecha-invalida');
    if (vence <= ahora) throw new ErrorCupon(400, 'La fecha y hora límite deben ser futuras.', 'fecha-pasada');
  }
  let max = null;
  if (maxPersonas !== null && maxPersonas !== undefined && maxPersonas !== '') {
    if (typeof maxPersonas !== 'number' || !Number.isInteger(maxPersonas) || maxPersonas < 1 || maxPersonas > MAX_PERSONAS) {
      throw new ErrorCupon(400, `El máximo de personas debe ser un número entero de 1 a ${MAX_PERSONAS}, o dejarlo vacío para no poner límite.`, 'maximo-invalido');
    }
    max = maxPersonas;
  }
  const aud = audiencia === undefined || audiencia === null || audiencia === '' ? 'todos' : audiencia;
  if (!AUDIENCIAS.includes(aud)) throw new ErrorCupon(400, 'Elige a quién le llega el cupón: miembros no VIP, miembros VIP o ambos.', 'audiencia-invalida');
  return { clave: cl, creditos: cantidad, venceMs: vence, maxPersonas: max, audiencia: aud };
}

// Frena adivinar claves: tras INTENTOS_MAX fallos en la ventana, la persona espera. Un acierto borra sus fallos.
function crearLimitadorIntentos({ ahora = () => Date.now(), max = INTENTOS_MAX, ventanaMs = INTENTOS_VENTANA_MS } = {}) {
  const fallos = new Map();
  const vigentes = uid => { const t = ahora(); const l = (fallos.get(uid) || []).filter(x => t - x < ventanaMs); if (l.length) fallos.set(uid, l); else fallos.delete(uid); return l; };
  return {
    revisar(uid) {
      const l = vigentes(uid);
      if (l.length >= max) {
        const minutos = Math.max(1, Math.ceil((l[0] + ventanaMs - ahora()) / 60000));
        throw new ErrorCupon(429, `Demasiados intentos con claves que no sirven. Espera ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} e inténtalo de nuevo.`, 'demasiados-intentos', { esperaMin: minutos });
      }
    },
    fallo(uid) { const l = vigentes(uid); l.push(ahora()); fallos.set(uid, l); },
    acierto(uid) { fallos.delete(uid); }
  };
}

function filaPublica(id, d, ahora) {
  return {
    clave: d.clave || id, creditos: Number(d.creditos) || 0, estado: estadoDe(d, ahora), estadoGuardado: d.estado === 'pausado' ? 'pausado' : 'activo',
    canjes: Number(d.canjes) || 0, maxPersonas: Number.isInteger(d.maxPersonas) ? d.maxPersonas : null,
    creditosEntregados: Number(d.creditosEntregados) || 0, audiencia: audienciaDe(d), vence: aMs(d.venceMs) !== null ? new Date(aMs(d.venceMs)).toISOString() : null,
    creado: aMs(d.creadoMs) !== null ? new Date(aMs(d.creadoMs)).toISOString() : null, creadoPor: d.creadoPorCorreo || ''
  };
}

function crearServicio({ db, admin, ahora = () => Date.now(), azar }) {
  const FieldValue = () => admin.firestore.FieldValue;

  async function crear({ adminUid, adminCorreo = '', clave, creditos: cantidad, venceMs, maxPersonas, audiencia }) {
    const t = ahora();
    const v = validarNuevo({ clave, creditos: cantidad, venceMs, maxPersonas, audiencia }, t);
    const propia = !!v.clave;
    for (let intento = 0; intento < 6; intento++) {
      const cl = v.clave || generarClave(azar);
      const ref = db.collection(COL_CUPONES).doc(cl);
      const hecho = await db.runTransaction(async tx => {
        const previo = await tx.get(ref);
        if (previo.exists) return null;
        tx.set(ref, {
          clave: cl, creditos: v.creditos, venceMs: v.venceMs, maxPersonas: v.maxPersonas, audiencia: v.audiencia, canjes: 0, creditosEntregados: 0, estado: 'activo',
          creadoMs: t, creadoPor: adminUid, creadoPorCorreo: String(adminCorreo || '').toLowerCase().slice(0, 160), id: idPublico(cl)
        });
        return cl;
      });
      if (hecho) return filaPublica(hecho, { clave: hecho, creditos: v.creditos, venceMs: v.venceMs, maxPersonas: v.maxPersonas, audiencia: v.audiencia, canjes: 0, creditosEntregados: 0, estado: 'activo', creadoMs: t, creadoPorCorreo: adminCorreo }, t);
      if (propia) throw new ErrorCupon(409, 'Ya existe un cupón con esa clave. Elige otra o déjala vacía para que se cree una al azar.', 'clave-existe');
    }
    throw new ErrorCupon(503, 'No se pudo generar una clave libre. Inténtalo de nuevo.', 'sin-clave');
  }

  async function listar() {
    const snap = await db.collection(COL_CUPONES).limit(TOPE_LISTA).get();
    const t = ahora();
    return snap.docs.map(d => filaPublica(d.id, d.data() || {}, t)).sort((a, b) => String(b.creado || '').localeCompare(String(a.creado || '')));
  }

  async function cambiarEstado({ clave, estado }) {
    const cl = normalizarClave(clave);
    if (!cl) throw new ErrorCupon(400, 'La clave no es válida.', 'clave-invalida');
    if (estado !== 'activo' && estado !== 'pausado') throw new ErrorCupon(400, 'El estado debe ser activo o pausado.', 'estado-invalido');
    const ref = db.collection(COL_CUPONES).doc(cl);
    return db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) throw new ErrorCupon(404, 'No encontramos ese cupón.', 'no-existe');
      const d = s.data() || {};
      tx.set(ref, { ...d, estado, estadoCambiadoMs: ahora() });
      return filaPublica(cl, { ...d, estado }, ahora());
    });
  }

  async function canjesDe(clave) {
    const cl = normalizarClave(clave);
    if (!cl) throw new ErrorCupon(400, 'La clave no es válida.', 'clave-invalida');
    const snap = await db.collection(COL_CANJES).where('clave', '==', cl).limit(TOPE_CANJES).get();
    return snap.docs.map(d => { const x = d.data() || {}; return { nombre: x.nombre || '', correo: x.email || '', creditos: Number(x.creditos) || 0, en: aMs(x.enMs) !== null ? new Date(aMs(x.enMs)).toISOString() : null }; })
      .sort((a, b) => String(b.en || '').localeCompare(String(a.en || '')));
  }

  // Lo que ESTA persona aún puede canjear: cuántos cupones activos hay y cuántos créditos da el mayor. Nunca devuelve claves.
  async function disponiblesPara(uid, { membresia = false } = {}) {
    const [cupones, hechos] = await Promise.all([
      db.collection(COL_CUPONES).limit(TOPE_LISTA).get(),
      db.collection(COL_CANJES).where('uid', '==', uid).limit(TOPE_LISTA).get()
    ]);
    const ya = new Set(hechos.docs.map(d => (d.data() || {}).clave));
    const t = ahora();
    const lista = cupones.docs.map(d => ({ id: d.id, d: d.data() || {} })).filter(x => estadoDe(x.d, t) === 'activo' && aplicaA(audienciaDe(x.d), membresia) && !ya.has(x.d.clave || x.id));
    return {
      hay: lista.length > 0, cantidad: lista.length, creditos: lista.reduce((m, x) => Math.max(m, Number(x.d.creditos) || 0), 0),
      limitado: lista.some(x => aMs(x.d.venceMs) !== null || Number.isInteger(x.d.maxPersonas)), ids: lista.map(x => idPublico(x.d.clave || x.id))
    };
  }

  async function canjear({ uid, nombre = '', email = '', clave, membresia = false }) {
    const cl = normalizarClave(clave);
    if (!cl) throw new ErrorCupon(404, 'Esa clave no es válida o ya no está disponible.', 'no-valido');
    const cuponRef = db.collection(COL_CUPONES).doc(cl);
    const canjeRef = db.collection(COL_CANJES).doc(cl + '__' + uid);
    const cuentaRef = db.collection(creditos.COL_CUENTAS).doc(uid);
    const movRef = db.collection(creditos.COL_MOVIMIENTOS).doc('regalo_' + hash(uid + '|cupon:' + cl).slice(0, 24));
    const t = ahora();
    return db.runTransaction(async tx => {
      const [cupon, canje, cuenta] = await Promise.all([tx.get(cuponRef), tx.get(canjeRef), tx.get(cuentaRef)]);
      if (!cupon.exists) throw new ErrorCupon(404, 'Esa clave no es válida o ya no está disponible.', 'no-valido');
      const c = cupon.data() || {};
      if (canje.exists) throw new ErrorCupon(409, 'Ya canjeaste este cupón. Cada persona lo puede usar una sola vez.', 'ya-canjeado');
      const estado = estadoDe(c, t);
      if (estado === 'pausado') throw new ErrorCupon(404, 'Esa clave no es válida o ya no está disponible.', 'no-valido');
      const aud = audienciaDe(c);
      if (!aplicaA(aud, membresia)) {
        throw new ErrorCupon(403, aud === 'vip' ? 'Este cupón es solo para miembros VIP.' : 'Este cupón es solo para miembros no VIP (plan gratuito).', 'cupon-no-aplica', { audiencia: aud });
      }
      if (estado === 'vencido') throw new ErrorCupon(410, 'Este cupón ya venció.', 'cupon-vencido');
      if (estado === 'agotado') throw new ErrorCupon(410, `Este cupón ya alcanzó su límite de ${c.maxPersonas} personas.`, 'cupon-agotado', { limite: c.maxPersonas });
      const cantidad = Number(c.creditos) || 0;
      const previo = cuenta.exists ? (cuenta.data() || {}) : {};
      const saldo = (Number.isInteger(previo.saldo) && previo.saldo > 0 ? previo.saldo : 0) + cantidad;
      tx.set(cuentaRef, {
        ...previo, uid, saldo, regalados: (Number(previo.regalados) || 0) + cantidad, canjeados: Number(previo.canjeados) || 0,
        ultimoRegaloEn: FieldValue().serverTimestamp(), actualizado: FieldValue().serverTimestamp()
      });
      tx.set(movRef, { tipo: 'regalo', uid, cantidad, origen: 'cupon', cupon: cl, adminUid: '', adminCorreo: '', en: FieldValue().serverTimestamp(), operacion: hash('cupon|' + cl + '|' + uid) });
      tx.set(canjeRef, { uid, clave: cl, creditos: cantidad, nombre: String(nombre || '').slice(0, 120), email: String(email || '').toLowerCase().slice(0, 160), enMs: t });
      tx.set(cuponRef, { ...c, canjes: (Number(c.canjes) || 0) + 1, creditosEntregados: (Number(c.creditosEntregados) || 0) + cantidad });
      return { creditos: cantidad, saldo };
    });
  }

  return { crear, listar, cambiarEstado, canjesDe, disponiblesPara, canjear };
}

module.exports = {
  COL_CUPONES, COL_CANJES, AUDIENCIAS, aplicaA, MAX_CREDITOS, MAX_PERSONAS, INTENTOS_MAX, INTENTOS_VENTANA_MS, ErrorCupon,
  normalizarClave, generarClave, idPublico, estadoDe, validarNuevo, crearLimitadorIntentos, filaPublica, crearServicio
};
