'use strict';

// ══ CRÉDITOS (regalo manual del administrador y canje por materiales) ══
// El administrador regala créditos desde su panel: la cantidad es un entero de 1 a MAX_REGALO (100 por omisión en el panel; también 200,
// 300, 400 u otra cantidad). Con 100 créditos la persona canjea UN material del apartado «PDFs y materiales» que no pertenezca a
// ningún curso (cada material cuesta 100, fijo en el servidor). Todo lo escribe SOLO el servidor:
//   creditosCuentas/{uid}           saldo, totales y el aviso de felicitación pendiente (cuenta de la persona)
//   creditosMovimientos/{id}        libro de movimientos APPEND-ONLY: tipo regalo | canje (nunca se edita ni se borra)
//   creditosDesbloqueos/{uid__clave} el desbloqueo permanente de UN material para ESA cuenta
// Las reglas de Firestore no listan estas colecciones: quedan cerradas al navegador (solo el Admin SDK del servidor entra).
// Este módulo no conoce Express: son funciones puras y transacciones que se prueban con Firestore simulado.

const crypto = require('crypto');

const REGALO = 100;                 // cantidad que propone el panel (la persona administradora puede cambiarla)
const MAX_REGALO = 1000;            // máximo por regalo (entero de 1 a este número)
const COSTO_MATERIAL = 100;         // lo que cuesta cada material (lo fija el servidor: el navegador no puede cambiarlo)
const CADUCIDAD_DIAS = null;        // null = sin caducidad. Si algún día se quiere, aquí se parametriza (días desde el regalo)
const TOPE_CREDITOS_POR_DIA = 1000; // créditos por cuenta y por día (hora de México): evita errores y regalos repetidos por equivocación
const TOPE_MOVIMIENTOS = 5000;      // lectura máxima del libro para el panel

const COL_CUENTAS = 'creditosCuentas';
const COL_MOVIMIENTOS = 'creditosMovimientos';
const COL_DESBLOQUEOS = 'creditosDesbloqueos';

const UID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;
const CLAVE_OPERACION = /^[A-Za-z0-9_-]{8,64}$/;
const ID_PARTE = /^[A-Za-z0-9_-]{1,80}$/;
const TIPOS = Object.freeze(['libro', 'pdf', 'drive']);

class ErrorCreditos extends Error {
  constructor(status, mensaje, codigo) { super(mensaje); this.status = status; this.codigo = codigo; }
}

const hash = texto => crypto.createHash('sha1').update(String(texto)).digest('hex').slice(0, 24);
const aMs = v => {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return null; } }
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = v => { const ms = aMs(v); return ms === null ? null : new Date(ms).toISOString(); };
const diaMexico = ms => new Date(ms - 6 * 3600 * 1000).toISOString().slice(0, 10);

/* ───────────────────────── Clave de material ─────────────────────────
   «libro:<id>», «pdf:<id>» (catálogo de archivos) o «drive:<id>» (PDF de Drive cargado desde el panel). */
function claveMaterial(tipo, id) { return `${tipo}:${id}`; }
function analizarClave(valor) {
  if (typeof valor !== 'string' || valor.length > 100) return null;
  const i = valor.indexOf(':');
  if (i < 1) return null;
  const tipo = valor.slice(0, i); const id = valor.slice(i + 1);
  if (!TIPOS.includes(tipo) || !ID_PARTE.test(id)) return null;
  return { tipo, id, clave: valor };
}
const docDesbloqueo = (uid, clave) => `${uid}__${clave.replace(':', '__')}`;

/* ───────────────────────── Qué se puede canjear ─────────────────────────
   Todo lo del apartado «PDFs y materiales» que NO pertenece a ningún curso: los libros de lectura, los PDF del catálogo de archivos
   con acceso por membresía o por retos y los PDF de Drive cargados desde el panel sin curso. Quedan fuera: lo ligado a un curso
   (acceso «curso» o con cursoId), los PDF de Drive con la liga mal escrita y los documentos oficiales por enlace (ya son gratis). */
function catalogoCanjeable({ libros = [], materiales = [], drive = [] } = {}) {
  const lista = [];
  for (const l of libros) {
    lista.push({ clave: claveMaterial('libro', l.id), tipo: 'libro', id: l.id, titulo: l.titulo, area: l.categoria || 'Libro', descripcion: l.resumen || '', paginas: Array.isArray(l.paginas) ? l.paginas.length : 0, formato: 'Libro' });
  }
  for (const m of materiales) {
    if (m.acceso === 'curso' || m.cursoId) continue;
    lista.push({ clave: claveMaterial('pdf', m.id), tipo: 'pdf', id: m.id, titulo: m.titulo, area: m.area, descripcion: m.descripcion || '', paginas: m.paginas || 0, formato: m.tipo });
  }
  for (const m of drive) {
    if (m.cursoId || m.configuracionInvalida) continue;
    lista.push({ clave: claveMaterial('drive', m.id), tipo: 'drive', id: m.id, titulo: m.titulo, area: m.area, descripcion: '', paginas: m.paginas || 0, formato: 'PDF' });
  }
  return lista;
}

/* ───────────────────────── Estado de acceso con créditos ─────────────────────────
   Quien canjeó un material lo abre como si cumpliera la regla (membresía y retos) SOLO para ese material. Se devuelve un estado
   nuevo; el original no cambia, así los demás materiales siguen exigiendo lo de siempre. */
function estadoConCredito(estado, tipo, id, desbloqueos) {
  if (!(desbloqueos instanceof Set) || !desbloqueos.has(claveMaterial(tipo, id))) return estado;
  return { ...estado, membresia: true, superados: 1000000 };
}

/* ───────────────────────── Lecturas ───────────────────────── */
async function leerCuenta(db, uid) {
  const s = await db.collection(COL_CUENTAS).doc(uid).get();
  const d = s.exists ? (s.data() || {}) : {};
  return {
    saldo: Number.isInteger(d.saldo) && d.saldo > 0 ? d.saldo : 0,
    regalados: Number(d.regalados) || 0, canjeados: Number(d.canjeados) || 0,
    avisoPendiente: Number.isInteger(d.avisoPendiente) && d.avisoPendiente > 0 ? d.avisoPendiente : 0,
    ultimoRegaloEn: iso(d.ultimoRegaloEn)
  };
}

// Claves («libro:id», «pdf:id», «drive:id») que esta cuenta ya canjeó
async function leerDesbloqueos(db, uid) {
  if (!UID_VALIDO.test(String(uid || ''))) return new Set();
  const snap = await db.collection(COL_DESBLOQUEOS).where('uid', '==', uid).limit(500).get();
  return new Set(snap.docs.map(d => (d.data() || {}).clave).filter(c => typeof c === 'string'));
}

/* Cantidad de un regalo: un ENTERO de 1 a MAX_REGALO (número, no texto; sin decimales, negativos ni notación rara) */
function cantidadValida(valor) {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 1 && valor <= MAX_REGALO;
}

/* ───────────────────────── Regalar (administrador) ─────────────────────────
   Transacción: lee el movimiento de esta operación (si ya existe, es un doble clic: devuelve lo mismo sin regalar otra vez), revisa el
   tope diario de créditos de la cuenta y suma el saldo. El libro de movimientos es append-only: el regalo es un documento nuevo y
   nunca se modifica. */
async function regalar(db, admin, { uid, adminUid, adminCorreo = '', clave, cantidad, ahora = Date.now() }) {
  if (!UID_VALIDO.test(String(uid || ''))) throw new ErrorCreditos(400, 'El identificador no es válido');
  if (!cantidadValida(cantidad)) throw new ErrorCreditos(400, `La cantidad debe ser un número entero de 1 a ${MAX_REGALO}`, 'cantidad-invalida');
  if (!CLAVE_OPERACION.test(String(clave || ''))) throw new ErrorCreditos(400, 'Falta la clave de la operación (se genera al abrir la confirmación)');
  const cuentaRef = db.collection(COL_CUENTAS).doc(uid);
  const movRef = db.collection(COL_MOVIMIENTOS).doc('regalo_' + hash(uid + '|' + clave));
  const hoy = diaMexico(ahora);
  const FieldValue = admin.firestore.FieldValue;
  return db.runTransaction(async tx => {
    const [mov, cuenta] = await Promise.all([tx.get(movRef), tx.get(cuentaRef)]);
    const previo = cuenta.exists ? (cuenta.data() || {}) : {};
    if (mov.exists) return { repetido: true, saldo: Number.isInteger(previo.saldo) ? previo.saldo : 0, cantidad: Number((mov.data() || {}).cantidad) || cantidad, movimientoId: movRef.id };
    const hoyRegalos = previo.regalosHoy && previo.regalosHoy.dia === hoy ? previo.regalosHoy : null;
    const regalosDia = hoyRegalos ? Number(hoyRegalos.n) || 0 : 0;
    // Cuentas anteriores a este cambio solo guardaban cuántos regalos (de 100): se convierten a créditos
    const creditosDia = hoyRegalos ? (Number.isInteger(hoyRegalos.creditos) ? hoyRegalos.creditos : regalosDia * REGALO) : 0;
    if (creditosDia + cantidad > TOPE_CREDITOS_POR_DIA) {
      const quedan = Math.max(0, TOPE_CREDITOS_POR_DIA - creditosDia);
      throw new ErrorCreditos(429, `Esta persona ya recibió ${creditosDia} créditos hoy y el tope por día es de ${TOPE_CREDITOS_POR_DIA} (para evitar errores). ${quedan ? `Hoy todavía puedes regalarle hasta ${quedan}.` : 'Inténtalo mañana.'}`, 'tope-diario');
    }
    const saldo = (Number.isInteger(previo.saldo) && previo.saldo > 0 ? previo.saldo : 0) + cantidad;
    tx.set(cuentaRef, {
      uid, saldo, regalados: (Number(previo.regalados) || 0) + cantidad, canjeados: Number(previo.canjeados) || 0,
      avisoPendiente: (Number.isInteger(previo.avisoPendiente) && previo.avisoPendiente > 0 ? previo.avisoPendiente : 0) + cantidad,
      ultimoRegaloEn: FieldValue.serverTimestamp(), ultimoRegaloPor: adminUid, regalosHoy: { dia: hoy, n: regalosDia + 1, creditos: creditosDia + cantidad }, actualizado: FieldValue.serverTimestamp()
    });
    tx.set(movRef, {
      tipo: 'regalo', uid, cantidad, adminUid, adminCorreo: String(adminCorreo || '').toLowerCase().slice(0, 160),
      en: FieldValue.serverTimestamp(), operacion: hash(clave), caduca: CADUCIDAD_DIAS ? new Date(ahora + CADUCIDAD_DIAS * 86400000) : null
    });
    return { repetido: false, saldo, cantidad, movimientoId: movRef.id };
  });
}

/* ───────────────────────── Canjear (la persona) ─────────────────────────
   Transacción: saldo >= costo, el material aún no es suyo; descuenta, crea el desbloqueo permanente y anota el movimiento.
   Dos canjes a la vez del mismo material o con un solo saldo: solo uno gana (el otro recibe 409 o 402). */
async function canjear(db, admin, { uid, material, ahora = Date.now() }) {
  const parsed = analizarClave(material && material.clave);
  if (!parsed) throw new ErrorCreditos(404, 'Ese material no se puede canjear', 'no-canjeable');
  const cuentaRef = db.collection(COL_CUENTAS).doc(uid);
  const desbRef = db.collection(COL_DESBLOQUEOS).doc(docDesbloqueo(uid, parsed.clave));
  const movRef = db.collection(COL_MOVIMIENTOS).doc('canje_' + hash(uid + '|' + parsed.clave));
  const FieldValue = admin.firestore.FieldValue;
  return db.runTransaction(async tx => {
    const [cuenta, desb] = await Promise.all([tx.get(cuentaRef), tx.get(desbRef)]);
    if (desb.exists) throw new ErrorCreditos(409, 'Ya canjeaste este material', 'ya-desbloqueado');
    const previo = cuenta.exists ? (cuenta.data() || {}) : {};
    const saldo = Number.isInteger(previo.saldo) && previo.saldo > 0 ? previo.saldo : 0;
    if (saldo < COSTO_MATERIAL) throw new ErrorCreditos(402, `Te faltan créditos: este material cuesta ${COSTO_MATERIAL} y tienes ${saldo}`, 'saldo-insuficiente');
    tx.set(cuentaRef, { ...previo, uid, saldo: saldo - COSTO_MATERIAL, canjeados: (Number(previo.canjeados) || 0) + COSTO_MATERIAL, actualizado: FieldValue.serverTimestamp() });
    tx.set(desbRef, { uid, clave: parsed.clave, tipo: parsed.tipo, materialId: parsed.id, titulo: String(material.titulo || '').slice(0, 140), en: FieldValue.serverTimestamp() });
    tx.set(movRef, {
      tipo: 'canje', uid, cantidad: COSTO_MATERIAL, materialId: parsed.clave, materialTipo: parsed.tipo, materialTitulo: String(material.titulo || '').slice(0, 140),
      en: FieldValue.serverTimestamp(), operacion: hash(uid + '|' + parsed.clave)
    });
    return { saldo: saldo - COSTO_MATERIAL, clave: parsed.clave };
  });
}

// El aviso de felicitación se muestra UNA vez por regalo: el servidor lo recuerda (no el navegador)
async function marcarAvisoVisto(db, admin, uid) {
  const ref = db.collection(COL_CUENTAS).doc(uid);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return { avisoPendiente: 0 };
    const d = s.data() || {};
    if (!d.avisoPendiente) return { avisoPendiente: 0 };
    tx.set(ref, { ...d, avisoPendiente: 0, avisoVistoEn: admin.firestore.FieldValue.serverTimestamp() });
    return { avisoPendiente: 0 };
  });
}

/* ───────────────────────── Historial y métricas (panel) ───────────────────────── */
async function leerMovimientos(db) {
  const snap = await db.collection(COL_MOVIMIENTOS).limit(TOPE_MOVIMIENTOS + 1).get();
  const lista = snap.docs.slice(0, TOPE_MOVIMIENTOS).map(d => ({ id: d.id, ...(d.data() || {}) }))
    .map(m => ({ ...m, enMs: aMs(m.en) || 0 }));
  return { movimientos: lista, truncado: snap.docs.length > TOPE_MOVIMIENTOS };
}

// Empareja, por persona y POR CRÉDITOS, los canjes con los regalos: del más antiguo al más nuevo (primero en entrar, primero en salir).
// Cada canje gasta COSTO_MATERIAL de los regalos más viejos que aún tengan saldo; un canje puede repartirse entre dos regalos.
// Por regalo: estado 'pendiente' (nada usado), 'parcial' (algo usado) o 'canjeado' (todo usado, o todos sus materiales canjeados),
// cuántos materiales alcanzaban (materialesTotal) y cuántos se canjearon (materialesCanjeados), el sobrante que no completa un
// material y la lista de materiales canjeados con su fecha. Devuelve los regalos de más reciente a más antiguo.
function historialDeRegalos(movimientos) {
  const porUid = new Map();
  for (const m of movimientos) {
    if (m.tipo !== 'regalo' && m.tipo !== 'canje') continue;
    const g = porUid.get(m.uid) || { regalos: [], canjes: [] };
    (m.tipo === 'regalo' ? g.regalos : g.canjes).push(m);
    porUid.set(m.uid, g);
  }
  const salida = [];
  for (const [uid, g] of porUid) {
    g.regalos.sort((x, y) => x.enMs - y.enMs);
    g.canjes.sort((x, y) => x.enMs - y.enMs);
    const filas = g.regalos.map(r => {
      const cantidad = Number.isInteger(Number(r.cantidad)) && Number(r.cantidad) > 0 ? Number(r.cantidad) : REGALO;
      return { r, cantidad, restante: cantidad, canjes: [] };
    });
    for (const c of g.canjes) {
      let falta = Number(c.cantidad) > 0 ? Number(c.cantidad) : COSTO_MATERIAL;
      for (const f of filas) {
        if (falta <= 0) break;
        if (f.restante <= 0) continue;
        const toma = Math.min(f.restante, falta);
        f.restante -= toma; falta -= toma;
        f.canjes.push({ materialId: c.materialId, titulo: c.materialTitulo || '', tipo: c.materialTipo || '', en: iso(c.en) });
      }
    }
    for (const f of filas) {
      const usados = f.cantidad - f.restante;
      const materialesTotal = Math.floor(f.cantidad / COSTO_MATERIAL);
      const materialesCanjeados = Math.min(materialesTotal, Math.floor(usados / COSTO_MATERIAL));
      const completo = usados >= f.cantidad || (materialesTotal > 0 && materialesCanjeados >= materialesTotal);
      const estado = usados === 0 ? 'pendiente' : (completo ? 'canjeado' : 'parcial');
      salida.push({
        id: f.r.id, uid, cantidad: f.cantidad, en: iso(f.r.en), enMs: f.r.enMs, adminUid: f.r.adminUid || '', adminCorreo: f.r.adminCorreo || '',
        estado, materialesTotal, materialesCanjeados, usados, sobrante: f.cantidad % COSTO_MATERIAL,
        canjes: f.canjes, canje: f.canjes.length ? f.canjes[f.canjes.length - 1] : null
      });
    }
  }
  salida.sort((x, y) => y.enMs - x.enMs);
  return salida;
}

function metricas(movimientos) {
  let regalados = 0; let canjeados = 0; let regalos = 0; let canjes = 0;
  const porMaterial = new Map();
  for (const m of movimientos) {
    const n = Number(m.cantidad) || 0;
    if (m.tipo === 'regalo') { regalados += n; regalos += 1; }
    else if (m.tipo === 'canje') {
      canjeados += n; canjes += 1;
      const clave = String(m.materialId || '');
      const previo = porMaterial.get(clave) || { clave, titulo: String(m.materialTitulo || clave), canjes: 0 };
      previo.canjes += 1; porMaterial.set(clave, previo);
    }
  }
  const materiales = [...porMaterial.values()].sort((a, b) => b.canjes - a.canjes || a.titulo.localeCompare(b.titulo, 'es'));
  return { regalados, canjeados, pendientes: Math.max(0, regalados - canjeados), regalos, canjes, materiales };
}

module.exports = {
  REGALO, MAX_REGALO, COSTO_MATERIAL, CADUCIDAD_DIAS, TOPE_CREDITOS_POR_DIA, TOPE_MOVIMIENTOS, cantidadValida, COL_CUENTAS, COL_MOVIMIENTOS, COL_DESBLOQUEOS, TIPOS,
  ErrorCreditos, claveMaterial, analizarClave, docDesbloqueo, catalogoCanjeable, estadoConCredito,
  leerCuenta, leerDesbloqueos, regalar, canjear, marcarAvisoVisto, leerMovimientos, historialDeRegalos, metricas, diaMexico, iso
};
