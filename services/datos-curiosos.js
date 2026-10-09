'use strict';

// ══ DATOS CURIOSOS ══
// datosCuriosos/{id} (solo del servidor) = banco de datos verificados que se envían a la campana como aviso
// global los MARTES y VIERNES. El banco inicial vive en data/datos-curiosos-banco.json y se siembra en
// Firestore solo si la colección está vacía; desde ahí el equipo lo administra en el panel.
//
// Fecha: se usa la de Ciudad de México con UTC-6 fijo (México ya no cambia de horario de verano, así que
// es exacto todo el año); es la misma regla que usan los retos (fechaMexico).

const fs = require('fs');
const path = require('path');
const { limpiarTexto, texto, urlHttps, aIso } = require('./texto');
const { crearNotificacionGlobal } = require('./avisos');

const RUTA_BANCO = path.join(__dirname, '..', 'data', 'datos-curiosos-banco.json');
const LARGO = Object.freeze({ min: 20, max: 300 });
const DIAS_DE_ENVIO = Object.freeze([2, 5]); // 0 = domingo ... 2 = martes, 5 = viernes
const ENLACE_AVISO = 'club-dashboard.html';

function fechaMexico(ahora = new Date()) {
  return new Date(ahora.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

// Martes (2) o viernes (5) en la fecha de México
function tocaEnviar(ahora = new Date()) {
  const dia = new Date(`${fechaMexico(ahora)}T12:00:00Z`).getUTCDay();
  return DIAS_DE_ENVIO.includes(dia);
}

// Valida texto/tema/fuente de un dato (admin o banco). Devuelve { error } o { datos }.
function validarDato({ texto: crudo, tema, fuente, fuenteUrl }, { parcial = false } = {}) {
  const datos = {};
  if (!parcial || crudo !== undefined) {
    if (typeof crudo !== 'string') return { error: `El dato debe ser un texto de ${LARGO.min} a ${LARGO.max} caracteres` };
    const t = limpiarTexto(crudo);
    if (t.length < LARGO.min || t.length > LARGO.max) return { error: `El dato debe tener entre ${LARGO.min} y ${LARGO.max} caracteres` };
    datos.texto = t;
  }
  if (!parcial || tema !== undefined) {
    if (typeof tema !== 'string') return { error: 'El tema es obligatorio (de 2 a 60 caracteres)' };
    const t = texto(tema, 61);
    if (t.length < 2 || t.length > 60) return { error: 'El tema debe tener entre 2 y 60 caracteres' };
    datos.tema = t;
  }
  if (fuente !== undefined && fuente !== null) {
    if (typeof fuente !== 'string') return { error: 'La fuente no es válida' };
    const f = texto(fuente, 121);
    if (f.length > 120) return { error: 'La fuente puede tener hasta 120 caracteres' };
    datos.fuente = f;
  }
  if (fuenteUrl !== undefined && fuenteUrl !== null && fuenteUrl !== '') {
    const u = urlHttps(fuenteUrl, 300);
    if (!u) return { error: 'El enlace de la fuente debe ser un enlace https válido' };
    datos.fuenteUrl = u;
  }
  return { datos };
}

// ── Banco inicial ──
// Lee y valida el archivo. Los datos marcados "prueba": true son de ejemplo y NO se siembran en producción
// (si se sembraran, la colección dejaría de estar vacía y el banco real ya no entraría).
function leerBanco(ruta = RUTA_BANCO, { incluirPrueba = false } = {}) {
  let lista;
  try { lista = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (error) {
    console.error('[Datos curiosos] No se pudo leer el banco:', error && error.message);
    return [];
  }
  if (!Array.isArray(lista)) return [];
  const ids = new Set();
  const validos = [];
  for (const e of lista) {
    if (!e || typeof e !== 'object') continue;
    if (e.prueba === true && !incluirPrueba) continue;
    const id = typeof e.id === 'string' && /^[A-Za-z0-9_-]{2,60}$/.test(e.id) ? e.id : '';
    if (!id || ids.has(id)) continue;
    const r = validarDato({ texto: e.texto, tema: e.tema, fuente: e.fuente, fuenteUrl: e.fuenteUrl });
    if (r.error) continue;
    ids.add(id);
    validos.push({ id, fuente: '', fuenteUrl: '', ...r.datos, ...(e.prueba === true ? { prueba: true } : {}) });
  }
  return validos;
}

// Siembra el banco SOLO si la colección está vacía. Devuelve cuántos datos sembró.
async function sembrarSiVacia(db, { banco, ahora = new Date(), incluirPrueba = false } = {}) {
  const hay = await db.collection('datosCuriosos').limit(1).get();
  if (!hay.empty) return 0;
  const lista = banco || leerBanco(RUTA_BANCO, { incluirPrueba });
  if (!lista.length) return 0;
  const lote = db.batch();
  for (const d of lista) {
    lote.set(db.collection('datosCuriosos').doc(d.id), {
      texto: d.texto, tema: d.tema, fuente: d.fuente || '', fuenteUrl: d.fuenteUrl || '',
      activo: true, veces: 0, ultimoEnvio: null, origen: 'base', creadoEn: ahora
    });
  }
  await lote.commit();
  return lista.length;
}

// ── Elección: activo con menos veces, luego el último envío más antiguo (nunca enviado primero), luego id ──
function elegirDato(datos) {
  const validos = (Array.isArray(datos) ? datos : []).filter(d => d && d.activo !== false && typeof d.texto === 'string' &&
    d.texto.length >= LARGO.min && d.texto.length <= LARGO.max);
  const veces = d => (Number.isFinite(d.veces) ? d.veces : 0);
  const ultimo = d => (typeof d.ultimoEnvio === 'string' && d.ultimoEnvio ? d.ultimoEnvio : '');
  validos.sort((a, b) => veces(a) - veces(b) || (ultimo(a) < ultimo(b) ? -1 : ultimo(a) > ultimo(b) ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return validos[0] || null;
}

const vistaDato = doc => {
  const d = doc.data() || {};
  return {
    id: doc.id, texto: String(d.texto || ''), tema: String(d.tema || ''), fuente: String(d.fuente || ''), fuenteUrl: String(d.fuenteUrl || ''),
    activo: d.activo !== false, veces: Number.isFinite(d.veces) ? d.veces : 0, ultimoEnvio: typeof d.ultimoEnvio === 'string' ? d.ultimoEnvio : null,
    origen: d.origen === 'admin' ? 'admin' : 'base', creadoEn: aIso(d.creadoEn)
  };
};

async function listarDatos(db) {
  const snap = await db.collection('datosCuriosos').get();
  return snap.docs.map(vistaDato).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Crea el aviso global del dato y lo marca como enviado hoy. Idempotente por día y por dato.
async function enviarDato(db, dato, { ahora = new Date() } = {}) {
  const fecha = fechaMexico(ahora);
  const aviso = await crearNotificacionGlobal(db, {
    id: `dato_${fecha}_${dato.id}`, tipo: 'dato', titulo: '💡 Dato curioso', descripcion: dato.texto, enlace: ENLACE_AVISO, origen: 'auto'
  }, { ahora });
  if (aviso.creado) {
    const ref = db.collection('datosCuriosos').doc(dato.id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const d = snap.data() || {};
      tx.set(ref, { veces: (Number.isFinite(d.veces) ? d.veces : 0) + 1, ultimoEnvio: fecha }, { merge: true });
    });
  }
  return { enviado: aviso.creado, avisoId: aviso.id || null, motivo: aviso.creado ? undefined : (aviso.motivo || 'ya-enviado') };
}

// Tarea diaria: solo martes y viernes (fecha de México), una vez por día, aunque el servidor se reinicie.
// `forzar` ignora el día de la semana (no la idempotencia).
async function enviarDatoCuriosoSiToca(db, { ahora = new Date(), forzar = false, incluirPrueba = false } = {}) {
  const fecha = fechaMexico(ahora);
  if (!forzar && !tocaEnviar(ahora)) return { enviado: false, motivo: 'no-toca', fecha };

  const configRef = db.collection('config').doc('datosCuriosos');
  // Se reserva el día dentro de una transacción: dos procesos a la vez no envían dos datos
  const previo = await db.runTransaction(async tx => {
    const snap = await tx.get(configRef);
    const antes = snap.exists ? (snap.data() || {}).ultimoEnvioFecha || null : null;
    if (antes === fecha) return { ocupado: true };
    tx.set(configRef, { ultimoEnvioFecha: fecha }, { merge: true });
    return { antes };
  });
  if (previo.ocupado) return { enviado: false, motivo: 'ya-enviado', fecha };

  const liberar = () => configRef.set({ ultimoEnvioFecha: previo.antes }, { merge: true }).catch(() => {});
  try {
    await sembrarSiVacia(db, { ahora, incluirPrueba });
    const dato = elegirDato(await listarDatos(db));
    if (!dato) { await liberar(); return { enviado: false, motivo: 'sin-datos', fecha }; }
    const r = await enviarDato(db, dato, { ahora });
    if (!r.enviado && r.motivo === 'error') { await liberar(); return { enviado: false, motivo: 'error', fecha }; }
    return { enviado: r.enviado, datoId: dato.id, avisoId: r.avisoId, fecha, ...(r.motivo ? { motivo: r.motivo } : {}) };
  } catch (error) {
    await liberar();
    console.error('[Datos curiosos] No se pudo enviar el dato del día:', error && error.message);
    return { enviado: false, motivo: 'error', fecha };
  }
}

// ── Administración ──
async function crearDato(db, datos, { ahora = new Date() } = {}) {
  await sembrarSiVacia(db, { ahora });
  const id = `adm_${ahora.getTime()}`;
  const doc = {
    texto: datos.texto, tema: datos.tema, fuente: datos.fuente || '', fuenteUrl: datos.fuenteUrl || '',
    activo: true, veces: 0, ultimoEnvio: null, origen: 'admin', creadoEn: ahora
  };
  const ref = db.collection('datosCuriosos').doc(id);
  const creado = await db.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) return false;
    tx.set(ref, doc);
    return true;
  });
  if (!creado) throw new Error('No se pudo asignar un identificador al dato');
  return vistaDato(await ref.get());
}

// Devuelve el dato actualizado o null si no existe
async function actualizarDato(db, id, cambios) {
  const ref = db.collection('datosCuriosos').doc(id);
  const ok = await db.runTransaction(async tx => {
    if (!(await tx.get(ref)).exists) return false;
    tx.set(ref, cambios, { merge: true });
    return true;
  });
  return ok ? vistaDato(await ref.get()) : null;
}

async function eliminarDato(db, id) {
  const ref = db.collection('datosCuriosos').doc(id);
  if (!(await ref.get()).exists) return false;
  await ref.delete();
  return true;
}

module.exports = {
  LARGO, DIAS_DE_ENVIO, RUTA_BANCO, fechaMexico, tocaEnviar, validarDato, leerBanco, sembrarSiVacia, elegirDato,
  listarDatos, vistaDato, enviarDato, enviarDatoCuriosoSiToca, crearDato, actualizarDato, eliminarDato
};
