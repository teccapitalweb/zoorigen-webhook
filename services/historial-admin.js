'use strict';

// ══ HISTORIAL DE MOVIMIENTOS DEL PANEL (bitácora de auditoría) ══
// Qué administrador hizo QUÉ y CUÁNDO. Un solo lugar para todas las acciones del panel:
//   · anotar(decoded, accion, destino, resumen, extra)  → escribe un documento en `adminAcciones` (solo el servidor escribe ahí)
//   · listar({ limite, cursor, administrador, tipo })    → lectura paginada por cursor, la más reciente primero
//   · limpiarAntiguos(db)                                → borra lo de más de RETENCION_MESES (lo corre la tarea diaria)
//   · registrarDesdePanel(...)                           → para lo que el panel todavía escribe directo en Firestore (cursos, videos, PDF,
//                                                          clases en vivo): el panel avisa, y el servidor arma la frase y pone al
//                                                          administrador desde el token verificado (nunca desde lo que mande el navegador)
// Cada documento: { accion (código), tipo (categoría), por (uid), porCorreo, porNombre, uidDestino, destinoNombre, resumen (frase legible),
// en (hora del servidor) }. Nunca guarda tokens, claves, tarjetas, teléfonos ni el contenido de mensajes.
// Anotar es "lo mejor posible": si falla, avisa en el registro del servidor y la acción principal sigue como si nada.

const COLECCION = 'adminAcciones';
const DOC_ADMINISTRADORES = 'historialAdmins';   // config/historialAdmins: quiénes han hecho algo (para el filtro «Administrador»; una escritura por persona y por arranque)
const RETENCION_MESES = 12;          // lo más antiguo se borra en la tarea diaria
const POR_PAGINA = 10;               // lo que se ve al abrir
const MAX_POR_PAGINA = 20;           // lo máximo que se pide de una vez
const ESCANEO_PAGINA = 50;           // al filtrar sin índice compuesto: documentos por lectura…
const ESCANEO_MAX = 200;             // …y tope de documentos revisados por petición (cuida las lecturas de Firestore)
const LOTE_BORRADO = 200;
const MAX_LOTES_POR_CORRIDA = 10;
const ID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;

// Categorías para filtrar
const TIPOS = Object.freeze([
  { id: 'cursos', texto: 'Cursos y materiales' },
  { id: 'miembros', texto: 'Miembros y membresías' },
  { id: 'creditos', texto: 'Créditos y cupones' },
  { id: 'contenido', texto: 'Noticias, avisos y clases en vivo' },
  { id: 'configuracion', texto: 'Configuración' },
  { id: 'moderacion', texto: 'Moderación' },
  { id: 'pagos', texto: 'Pagos y recordatorios' }
]);
const IDS_TIPOS = TIPOS.map(t => t.id);

// Código de acción → categoría (lo que no esté aquí se decide por su prefijo)
const TIPO_DE_ACCION = Object.freeze({
  'activar-plan': 'miembros', 'cancelar-plan': 'miembros', 'regalar-plan': 'miembros', 'quitar-acceso': 'miembros', 'editar-datos': 'miembros',
  'eliminar-miembro': 'miembros', 'restaurar-miembro': 'miembros', 'importar-avance': 'miembros',
  'creditos-regalar': 'creditos', 'cupon-crear': 'creditos', 'cupon-estado': 'creditos',
  'guardar-config': 'configuracion', 'contacto-guardar': 'configuracion', 'recordatorios-modo': 'configuracion', 'recordatorios-limites': 'configuracion',
  'reinicios-normales': 'configuracion',
  'pagos-sincronizar': 'pagos', 'recordatorios-ensayo': 'pagos', 'recordatorios-prueba': 'pagos',
  'foro-eliminar': 'moderacion', 'foro-respuesta-eliminar': 'moderacion', 'directorio-eliminar': 'moderacion', 'ver-contacto-encuesta': 'moderacion',
  'foro-publicar': 'contenido', 'certificado-emitir': 'cursos'
});
const PREFIJOS = [['curso-', 'cursos'], ['video-', 'cursos'], ['pdf-', 'cursos'], ['material-', 'cursos'], ['certificado-', 'cursos'], ['sesion-', 'contenido'], ['noticia', 'contenido'],
  ['aviso-', 'contenido'], ['dato-', 'contenido'], ['creditos-', 'creditos'], ['cupon', 'creditos'], ['pagos-', 'pagos'], ['recordatorios-', 'configuracion'],
  ['encuesta-', 'moderacion'], ['chatbot-', 'moderacion'], ['foro-', 'moderacion'], ['directorio-', 'moderacion']];

function tipoDe(accion) {
  const a = String(accion || '');
  if (TIPO_DE_ACCION[a]) return TIPO_DE_ACCION[a];
  if (/-(atender|borrar)$/.test(a)) return 'moderacion';
  const p = PREFIJOS.find(([prefijo]) => a.startsWith(prefijo));
  return p ? p[1] : 'configuracion';
}

// ── Lo que el panel avisa porque todavía escribe directo en Firestore ──
// código → frase. {n} es el nombre que manda el panel (limpio y corto). Estas son las únicas acciones que aceptamos desde el navegador.
const DESDE_PANEL = Object.freeze({
  'curso-crear': { tipo: 'cursos', frase: 'Creó el curso «{n}»' },
  'curso-editar': { tipo: 'cursos', frase: 'Editó el curso «{n}»' },
  'curso-eliminar': { tipo: 'cursos', frase: 'Eliminó el curso «{n}»' },
  'curso-sync-bunny': { tipo: 'cursos', frase: 'Sincronizó los cursos con Bunny{n}' },
  'video-crear': { tipo: 'cursos', frase: 'Creó el video «{n}»' },
  'video-editar': { tipo: 'cursos', frase: 'Editó el video «{n}»' },
  'video-eliminar': { tipo: 'cursos', frase: 'Eliminó el video «{n}»' },
  'pdf-crear': { tipo: 'cursos', frase: 'Creó el PDF «{n}»' },
  'pdf-editar': { tipo: 'cursos', frase: 'Editó el PDF «{n}»' },
  'pdf-eliminar': { tipo: 'cursos', frase: 'Eliminó el PDF «{n}»' },
  'sesion-crear': { tipo: 'contenido', frase: 'Creó la clase en vivo «{n}»' },
  'sesion-editar': { tipo: 'contenido', frase: 'Editó la clase en vivo «{n}»' },
  'sesion-eliminar': { tipo: 'contenido', frase: 'Eliminó la clase en vivo «{n}»' }
});

// ── Limpieza: nada sensible en lo que se guarda ──
const CLAVE_SENSIBLE = /token|secret|password|passwd|authorization|api[_-]?key|apikey|tarjeta|card|tel[eé]fono|phone|whatsapp|mensaje|contenido|cuerpo|body|email|correo/i;
const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NUMEROS_LARGOS = /\d(?:[\s().-]?\d){8,}/g;   // 9 dígitos o más (teléfonos, tarjetas); las fechas no se tocan
const TOKEN_LARGO = /\b[A-Za-z0-9_-]{32,}\b/g;

function limpiarTexto(valor, max) {
  return String(valor == null ? '' : valor)
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(CORREO, '[correo]')
    .replace(NUMEROS_LARGOS, '[número]')
    .replace(TOKEN_LARGO, '[código]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

// Los datos extra: solo números, textos cortos y listas cortas de textos, y nunca claves delicadas
function limpiarExtra(extra) {
  const salida = {};
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return salida;
  for (const [k, v] of Object.entries(extra)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k) || CLAVE_SENSIBLE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) salida[k] = v;
    else if (typeof v === 'boolean') salida[k] = v;
    else if (typeof v === 'string') salida[k] = limpiarTexto(v, 80);
    else if (Array.isArray(v)) salida[k] = v.filter(x => typeof x === 'string').slice(0, 10).map(x => limpiarTexto(x, 40));
  }
  return salida;
}

// Cursor: ID del último documento visto (texto opaco para el navegador)
const codificarCursor = id => Buffer.from(String(id), 'utf8').toString('base64url');
function decodificarCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 200) return undefined;
  let id;
  try { id = Buffer.from(cursor, 'base64url').toString('utf8'); } catch (_) { return undefined; }
  return ID_VALIDO.test(id) ? id : undefined;
}

const aMs = v => {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

function vistaDeAccion(id, d) {
  const ms = aMs(d.en);
  const tipo = IDS_TIPOS.includes(d.tipo) ? d.tipo : tipoDe(d.accion);
  return {
    id, accion: String(d.accion || '').slice(0, 60), tipo, tipoTexto: (TIPOS.find(t => t.id === tipo) || {}).texto || '',
    por: { uid: String(d.por || '').slice(0, 128), nombre: String(d.porNombre || '').slice(0, 120), correo: String(d.porCorreo || '').slice(0, 160) },
    resumen: limpiarTexto(d.resumen, 200),
    destino: { id: d.uidDestino ? String(d.uidDestino).slice(0, 128) : '', nombre: String(d.destinoNombre || '').slice(0, 120) },
    en: ms === null ? null : new Date(ms).toISOString()
  };
}

// Borra lo que tenga más de RETENCION_MESES (la tarea diaria lo llama una vez al día). Por lotes, con tope por corrida.
async function limpiarAntiguos(db, { ahora = new Date(), meses = RETENCION_MESES } = {}) {
  const corte = new Date(ahora.getTime());
  corte.setMonth(corte.getMonth() - meses);
  let borrados = 0;
  for (let i = 0; i < MAX_LOTES_POR_CORRIDA; i++) {
    const snap = await db.collection(COLECCION).where('en', '<', corte).limit(LOTE_BORRADO).get();
    if (!snap.docs.length) break;
    const lote = db.batch();
    snap.docs.forEach(d => lote.delete(d.ref));
    await lote.commit();
    borrados += snap.docs.length;
    if (snap.docs.length < LOTE_BORRADO) break;
  }
  return { borrados, corte: corte.toISOString() };
}

function crearHistorial({ db, admin } = {}) {
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const ahora = () => new Date();
  const nombres = new Map();       // uid → nombre del administrador (para no leer Firestore en cada acción)
  const registrados = new Set();   // administradores ya anotados en config/historialAdmins durante este arranque

  async function nombreAdmin(decoded) {
    const uid = String((decoded && decoded.uid) || '');
    if (nombres.has(uid)) return nombres.get(uid);
    let nombre = '';
    try {
      const snap = await db.collection('miembros').doc(uid).get();
      const d = snap.exists ? snap.data() || {} : {};
      nombre = String(d.name || d.displayName || '');
    } catch (_) { /* sin nombre: se usa el del token o el correo */ }
    if (!nombre) nombre = String((decoded && decoded.name) || '');
    if (!nombre) nombre = String((decoded && decoded.email) || '').split('@')[0];
    nombre = limpiarTexto(nombre, 80) || 'Administración';
    nombres.set(uid, nombre);
    return nombre;
  }

  // Mismo orden de argumentos que ya usaba el panel: (decoded, accion, destino, resumen, extra)
  async function anotar(decoded, accion, destino, resumen, extra = {}) {
    try {
      if (!decoded || !decoded.uid) throw new Error('sin administrador verificado');
      const limpio = limpiarExtra(extra);
      // Única excepción: el contacto público del sitio (WhatsApp, Instagram y correo del negocio) se guarda antes/después para poder revisar el cambio.
      // El historial que se muestra nunca devuelve estos datos extra.
      if (accion === 'contacto-guardar' && extra) {
        for (const k of ['antes', 'despues']) {
          if (extra[k] && typeof extra[k] === 'object') limpio[k] = Object.fromEntries(Object.entries(extra[k]).filter(([, v]) => typeof v === 'string').slice(0, 6).map(([c, v]) => [c, String(v).slice(0, 120)]));
        }
      }
      const destinoNombre = limpio.destinoNombre;
      delete limpio.destinoNombre;
      const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      await db.collection(COLECCION).doc(id).set({
        accion: String(accion || '').slice(0, 60), tipo: tipoDe(accion),
        por: decoded.uid, porCorreo: String(decoded.email || '').toLowerCase().slice(0, 160), porNombre: await nombreAdmin(decoded),
        uidDestino: destino === undefined || destino === null || destino === '' ? null : String(destino).slice(0, 128),
        ...(destinoNombre ? { destinoNombre: limpiarTexto(destinoNombre, 120) } : {}),
        resumen: limpiarTexto(resumen, 200), en: FieldValue.serverTimestamp(), ...limpio
      });
      if (!registrados.has(decoded.uid)) {
        registrados.add(decoded.uid);
        await db.collection('config').doc(DOC_ADMINISTRADORES).set({ [decoded.uid]: { correo: String(decoded.email || '').toLowerCase().slice(0, 160), nombre: await nombreAdmin(decoded) } }, { merge: true })
          .catch(e => { registrados.delete(decoded.uid); console.error('[Admin acciones] No se pudo guardar la lista de administradores:', e && e.message); });
      }
      return id;
    } catch (e) {
      console.error('[Admin acciones] No se pudo anotar la acción:', e && e.message);
      return null;
    }
  }

  // Lo que el panel avisa: { accion, id, nombre, cantidad, creados, actualizados }
  function validarDesdePanel(cuerpo) {
    const c = cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : {};
    const def = typeof c.accion === 'string' ? DESDE_PANEL[c.accion] : null;
    if (!def) return { error: 'Esa acción no se puede registrar desde el panel' };
    const id = c.id === undefined || c.id === null || c.id === '' ? '' : String(c.id);
    if (id && !ID_VALIDO.test(id)) return { error: 'El identificador no es válido' };
    let n = limpiarTexto(c.nombre, 120);
    const extra = {};
    if (c.accion === 'curso-sync-bunny') {
      const creados = Number.isInteger(c.creados) && c.creados >= 0 ? Math.min(c.creados, 9999) : null;
      const actualizados = Number.isInteger(c.actualizados) && c.actualizados >= 0 ? Math.min(c.actualizados, 9999) : null;
      n = creados === null && actualizados === null ? '' : ` (${actualizados || 0} cursos actualizados, ${creados || 0} creados)`;
      if (creados !== null) extra.creados = creados;
      if (actualizados !== null) extra.actualizados = actualizados;
    } else if (!n) return { error: 'Falta el nombre' };
    return { accion: c.accion, tipo: def.tipo, id, nombre: n, extra, resumen: def.frase.replace('{n}', n) };
  }

  async function registrarDesdePanel(decoded, cuerpo) {
    const v = validarDesdePanel(cuerpo);
    if (v.error) return { error: v.error };
    const guardado = await anotar(decoded, v.accion, v.id || null, v.resumen, { ...v.extra, destinoNombre: v.accion === 'curso-sync-bunny' ? '' : v.nombre });
    return { ok: Boolean(guardado), id: guardado };
  }

  // Una página, la más reciente primero. Con filtros intenta la consulta directa (necesita índice compuesto en Firestore; ver
  // FIRESTORE-REGLAS-v7-PARA-PEGAR.txt); si el índice no existe, revisa hacia atrás en bloques pequeños y filtra aquí (hasta ESCANEO_MAX lecturas).
  async function listar({ limite = POR_PAGINA, cursor = null, administrador = '', tipo = '' } = {}) {
    const tam = Math.max(1, Math.min(MAX_POR_PAGINA, Number.isInteger(limite) ? limite : POR_PAGINA));
    const col = db.collection(COLECCION);
    const correo = String(administrador || '').trim().toLowerCase();
    const hayFiltro = Boolean(correo || tipo);
    const coincide = d => (!correo || String(d.porCorreo || '').toLowerCase() === correo) && (!tipo || (IDS_TIPOS.includes(d.tipo) ? d.tipo : tipoDe(d.accion)) === tipo);
    let referencia = null;
    if (cursor) {
      referencia = await col.doc(cursor).get();
      if (!referencia.exists) referencia = null;
    }
    const base = () => {
      let q = col;
      if (correo) q = q.where('porCorreo', '==', correo);
      if (tipo) q = q.where('tipo', '==', tipo);
      q = q.orderBy('en', 'desc');
      return referencia ? q.startAfter(referencia) : q;
    };

    let docs = null;
    try {
      docs = (await base().limit(tam + 1).get()).docs;
    } catch (e) {
      if (!hayFiltro) throw e;
      docs = null;     // sin índice compuesto: se filtra aquí
    }
    if (docs === null) {
      docs = [];
      let ref = referencia;
      let revisados = 0;
      let fin = false;
      while (docs.length < tam + 1 && revisados < ESCANEO_MAX) {
        const q = ref ? col.orderBy('en', 'desc').startAfter(ref) : col.orderBy('en', 'desc');
        const lote = (await q.limit(ESCANEO_PAGINA).get()).docs;
        for (const d of lote) { if (coincide(d.data() || {})) docs.push(d); }
        revisados += lote.length;
        if (lote.length) ref = lote[lote.length - 1];
        if (lote.length < ESCANEO_PAGINA) { fin = true; break; }
      }
      if (!fin && docs.length <= tam && ref) {      // se llegó al tope de lecturas: el cursor sigue desde donde se dejó de revisar
        return { items: docs.map(d => vistaDeAccion(d.id, d.data() || {})), siguiente: codificarCursor(ref.id), parcial: true };
      }
    }
    const hayMas = docs.length > tam;
    const pagina = docs.slice(0, tam);
    return {
      items: pagina.map(d => vistaDeAccion(d.id, d.data() || {})),
      siguiente: hayMas ? codificarCursor(pagina[pagina.length - 1].id) : null,
      parcial: false
    };
  }

  return { anotar, listar, limpiarAntiguos: opciones => limpiarAntiguos(db, { ahora: ahora(), ...(opciones || {}) }), registrarDesdePanel, validarDesdePanel, nombreAdmin };
}

module.exports = {
  COLECCION, DOC_ADMINISTRADORES, RETENCION_MESES, POR_PAGINA, MAX_POR_PAGINA, ESCANEO_PAGINA, ESCANEO_MAX, TIPOS, IDS_TIPOS, DESDE_PANEL,
  tipoDe, limpiarTexto, limpiarExtra, codificarCursor, decodificarCursor, vistaDeAccion, limpiarAntiguos, crearHistorial
};
