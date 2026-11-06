'use strict';

// ══ MATERIALES CONSERVADOS ══
// Regla acordada con el dueño: los materiales que una persona YA desbloqueó con retos siguen desbloqueados aunque la escalera nueva suba
// el umbral (requiereRetos). Los umbrales nuevos solo valen para quien todavía no los había desbloqueado.
//
//   materialesConservados/{uid} = { ids: [idDeMaterial…], creadoEn, actualizadoEn, version }
//     · Lo escribe SOLO el servidor (queda cubierta por la regla final de Firestore que niega todo al navegador).
//     · Solo se AGREGA (unión): nunca se quita un material de la lista.
//     · No se escribe nada en documentos que ya existían (miembros, retosUsuario…).
//   config/migraciones.materialesConservadosV1 = true  → la migración única ya terminó.
//
// Cómo se llena:
//   1) Migración única al arrancar (en segundo plano, idempotente): recorre retosUsuario por páginas, calcula qué materiales cumplía cada
//      persona con los UMBRALES ANTERIORES (services/materiales-umbrales-previos.js) y guarda ese conjunto si no está vacío.
//      Si falla o se interrumpe, la bandera NO se marca y se reintenta en el siguiente arranque (lo ya guardado no se repite).
//   2) Respaldo perezoso: mientras la migración no haya terminado, si alguien sin documento entra a materiales, créditos o suma un reto,
//      se calcula y guarda su conjunto con sus retos de ANTES de sumar el reto nuevo (en la misma transacción del reto). Cuando la
//      migración ya terminó no se hace: quien no tiene documento no tenía nada que conservar y usa los umbrales nuevos.
// El ACCESO sigue exigiendo membresía vigente (esa regla no cambia): lo conservado se guarda según retos, no según membresía.

const { UMBRALES_PREVIOS } = require('./materiales-umbrales-previos');
const retos = require('./retos');

const COLECCION = 'materialesConservados';
const VERSION = 1;
const CLAVE_MIGRACION = 'materialesConservadosV1';
const PAGINA = 200;                    // retosUsuario por lectura durante la migración
const REVISION_BANDERA_MS = 30 * 1000; // cada cuánto se vuelve a mirar la bandera mientras no esté marcada
const RETRASO_ARRANQUE_MS = 8 * 1000;  // la migración empieza unos segundos después de arrancar (nunca retrasa el arranque)
const UID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;
const ACCION_SISTEMA = 'sistema-conservar-materiales';

const entero = n => (Number.isInteger(n) && n > 0 ? n : 0);

// Materiales (de la tabla) que se cumplían con `superados` retos y los umbrales anteriores
function previosCumplidos(superados, tabla = UMBRALES_PREVIOS) {
  const s = entero(superados);
  return Object.keys(tabla).filter(id => s >= tabla[id]).sort();
}

const idsDe = datos => new Set((datos && Array.isArray(datos.ids) ? datos.ids : []).filter(i => typeof i === 'string' && i && i.length <= 80));

function crearConservacion({ db, admin, historial = null, tabla = UMBRALES_PREVIOS, log = console } = {}) {
  const FieldValue = admin.firestore.FieldValue;
  const refDe = uid => db.collection(COLECCION).doc(uid);
  let hecha = false;
  let revisada = 0;

  async function migracionCompleta() {
    if (hecha) return true;
    if (Date.now() - revisada < REVISION_BANDERA_MS) return false;
    revisada = Date.now();
    try {
      const snap = await db.collection('config').doc('migraciones').get();
      if (snap.exists && (snap.data() || {})[CLAVE_MIGRACION] === true) hecha = true;
    } catch (_) { /* sin saberlo se sigue protegiendo con el respaldo perezoso */ }
    return hecha;
  }

  // El documento de una persona: { existe, ids:Set }
  async function leerDoc(uid) {
    if (!UID_VALIDO.test(String(uid || ''))) return { existe: false, ids: new Set() };
    const snap = await refDe(uid).get();
    return { existe: snap.exists, ids: snap.exists ? idsDe(snap.data()) : new Set() };
  }

  // Lo conservado (ids). Nunca lanza: si falla la lectura, se registra y se devuelve vacío (no se rompe materiales).
  async function leer(uid) {
    try { return (await leerDoc(uid)).ids; } catch (e) { log.error('[Materiales conservados] No se pudo leer:', e && e.message); return new Set(); }
  }

  // Agrega ids a lo conservado (unión; nunca quita). `soloSiNoExiste`: no toca un documento que ya está (lo usa la migración).
  async function guardarUnion(uid, ids, { soloSiNoExiste = false } = {}) {
    let creado = false;
    await db.runTransaction(async tx => {
      const snap = await tx.get(refDe(uid));
      const previo = snap.exists ? snap.data() || {} : null;
      if (previo && soloSiNoExiste) return;
      const union = new Set([...idsDe(previo), ...ids]);
      if (previo && union.size === idsDe(previo).size) return;
      tx.set(refDe(uid), {
        ids: [...union].sort(), version: VERSION,
        creadoEn: previo && previo.creadoEn ? previo.creadoEn : FieldValue.serverTimestamp(), actualizadoEn: FieldValue.serverTimestamp()
      });
      creado = !previo;
    });
    return creado;
  }

  // Respaldo perezoso para lecturas (materiales, créditos): si aún no hay documento y la migración no terminó, lo crea con los retos actuales.
  async function asegurarPerezoso(uid, superados) {
    if (!UID_VALIDO.test(String(uid || '')) || await migracionCompleta()) return null;
    let ids = new Set();
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(refDe(uid));
        if (snap.exists) { ids = idsDe(snap.data()); return; }
        const nuevos = previosCumplidos(superados, tabla);
        ids = new Set(nuevos);
        tx.set(refDe(uid), { ids: nuevos, version: VERSION, creadoEn: FieldValue.serverTimestamp(), actualizadoEn: FieldValue.serverTimestamp(), origen: 'respaldo' });
      });
      return ids;
    } catch (e) {
      log.error('[Materiales conservados] No se pudo guardar el respaldo:', e && e.message);
      return null;
    }
  }

  // Para el reto nuevo: lo llama la transacción que guarda el reto ANTES de sumarlo. Devuelve { ref, datos } a escribir o null.
  // `tx` ya leyó retosUsuario; aquí se lee el documento de conservados (lectura) y se decide (la escritura la hace quien llama).
  async function leerParaReto(tx, uid, superadosAntes, activo) {
    if (!activo || !UID_VALIDO.test(String(uid || ''))) return null;
    const snap = await tx.get(refDe(uid));
    if (snap.exists) return null;
    return { ref: refDe(uid), datos: { ids: previosCumplidos(superadosAntes, tabla), version: VERSION, creadoEn: FieldValue.serverTimestamp(), actualizadoEn: FieldValue.serverTimestamp(), origen: 'respaldo-reto' } };
  }

  // Lo conservado que cuenta para el ACCESO de esta persona (Set de ids de material)
  async function paraAcceso(uid, { superados = 0, membresia = false, esAdmin = false } = {}) {
    if (esAdmin) return new Set();
    try {
      const d = await leerDoc(uid);
      if (d.existe) return d.ids;
      if (!membresia) return new Set();
      return (await asegurarPerezoso(uid, superados)) || new Set();
    } catch (e) {
      log.error('[Materiales conservados] No se pudo preparar el acceso:', e && e.message);
      return new Set();
    }
  }

  // Migración única. Devuelve { omitida } si ya estaba hecha; si no, { revisados, conservados }. Lanza si algo falla (la bandera NO se marca).
  async function migrar({ pagina = PAGINA } = {}) {
    if (await migracionCompleta()) return { omitida: true };
    let ultimo = null; let revisados = 0; let conservados = 0; let paginas = 0;
    const id = admin.firestore.FieldPath.documentId();
    for (;;) {
      let q = db.collection('retosUsuario').orderBy(id).limit(pagina);
      if (ultimo) q = q.startAfter(ultimo);
      const snap = await q.get();
      paginas += 1;
      for (const d of snap.docs) {
        revisados += 1;
        const ids = previosCumplidos(retos.normalizarEstado(d.data() || null).superados, tabla);   // la MISMA cuenta que usa el servidor para materiales
        if (!ids.length || !UID_VALIDO.test(d.id)) continue;
        if (await guardarUnion(d.id, ids, { soloSiNoExiste: true })) conservados += 1;
      }
      if (snap.docs.length < pagina) break;
      ultimo = snap.docs[snap.docs.length - 1];
    }
    await db.collection('config').doc('migraciones').set({
      [CLAVE_MIGRACION]: true, [CLAVE_MIGRACION + 'En']: FieldValue.serverTimestamp(), [CLAVE_MIGRACION + 'Miembros']: conservados, [CLAVE_MIGRACION + 'Revisados']: revisados
    }, { merge: true });
    hecha = true;
    if (historial) await historial.anotar({ uid: 'sistema', name: 'Sistema' }, ACCION_SISTEMA, null, `Conservó los desbloqueos de materiales de ${conservados} ${conservados === 1 ? 'miembro' : 'miembros'}`, { miembros: conservados, revisados });
    return { revisados, conservados, paginas };
  }

  // Arranque: en segundo plano, con try/catch y logs claros. Nunca lanza ni retrasa el arranque del servidor.
  function iniciar({ retrasoMs = RETRASO_ARRANQUE_MS } = {}) {
    let detenido = false;
    const t = setTimeout(async () => {
      if (detenido) return;
      try {
        const r = await migrar();
        if (r.omitida) log.log('[Materiales conservados] Migración ya hecha: nada que hacer.');
        else log.log(`[Materiales conservados] Migración lista: ${r.conservados} miembros con desbloqueos conservados (${r.revisados} revisados).`);
      } catch (e) {
        log.error('[Materiales conservados] La migración falló y se reintentará en el siguiente arranque:', e && e.message);
      }
    }, retrasoMs);
    if (t.unref) t.unref();
    return { detener() { detenido = true; clearTimeout(t); } };
  }

  return { leer, leerDoc, guardarUnion, asegurarPerezoso, leerParaReto, paraAcceso, migrar, iniciar, migracionCompleta, refDe };
}

module.exports = { COLECCION, VERSION, CLAVE_MIGRACION, PAGINA, ACCION_SISTEMA, previosCumplidos, crearConservacion };
