'use strict';

// ══ PANEL DE ADMINISTRACIÓN · COMUNIDAD (foro, directorio e historial de retos) ══
// rutas-admin.js llama a montarRutasAdminComunidad(app, deps, ayudas). Todas son SOLO administrador (mismo conAdmin: sesión de
// Firebase + ADMIN_EMAILS o marca, límite de peticiones y sin caché) y lo que cambia datos queda en adminAcciones.
//
//   GET  /api/admin/retos/historial   quién resolvió qué reto: tipo, fecha y hora, XP (filtros y paginación)
//   GET  /api/admin/retos/usuarios    totales reales por persona (retosUsuario): retos superados, XP y último día
//   GET  /api/admin/foro              publicaciones recientes con su texto y sus respuestas
//   POST /api/admin/foro/publicar     publica como cuenta oficial «Zoorigen» (texto de hasta 1,500 caracteres; sin imagen)
//   POST /api/admin/foro/:id/eliminar                     borra la publicación y sus respuestas
//   POST /api/admin/foro/:id/respuestas/:rid/eliminar     borra una respuesta
//   GET  /api/admin/directorio        TODAS las tarjetas (publicadas y privadas) con el contacto completo (solo se ve aquí)
//   POST /api/admin/directorio/:uid/eliminar              borra una tarjeta
//
// El foro y el directorio los lee y escribe el navegador de los miembros con las reglas de Firestore; estas rutas usan el Admin SDK
// (que se salta las reglas) y por eso exigen administrador en el servidor. Las publicaciones oficiales llevan authorUid
// «zoorigen-oficial» (que no es el uid de nadie): ningún miembro puede editarlas ni borrarlas con las reglas actuales.

const panel = require('./admin-panel');
const directorio = require('./directorio');

const AUTOR_OFICIAL_UID = 'zoorigen-oficial';
const AUTOR_OFICIAL_NOMBRE = 'Zoorigen';
const MAX_TEXTO_OFICIAL = 1500;
const MAX_TITULO_OFICIAL = 90;
const ID_DOC = /^[A-Za-z0-9_-]{1,64}$/;
const TOPE_HISTORIAL = 5000;
const PAGINA_HISTORIAL = 50;
const MAX_PAGINA_HISTORIAL = 100;
const TOPE_FORO = 40;
const TOPE_RESPUESTAS = 30;
const TOPE_DIRECTORIO = 1000;

const NOMBRES_RETO = Object.freeze({
  quiz: 'Quiz relámpago', detective: 'Detective de campo', orden: 'Ordena la secuencia', historia: 'Modo historia', flashcards: 'Flashcards'
});
const TIPOS_HISTORIAL = Object.freeze(['practica', 'camino']);
const NOMBRES_TIPO = Object.freeze({ practica: 'Práctica diaria', camino: 'Camino' });

// Quita caracteres de control (menos salto de línea y tabulador) y de dirección de texto; recorta espacios.
function limpiarTextoLibre(valor) {
  return String(valor === undefined || valor === null ? '' : valor)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();
}

// Valida el cuerpo de POST /api/admin/foro/publicar. Devuelve { error } o { datos: { titulo, contenido } }.
function validarPublicacionOficial(cuerpo) {
  const c = cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : null;
  if (!c || typeof c.texto !== 'string') return { error: 'Escribe el anuncio o mensaje' };
  const texto = limpiarTextoLibre(c.texto);
  if (!texto) return { error: 'Escribe el anuncio o mensaje' };
  if (texto.length > MAX_TEXTO_OFICIAL) return { error: `El mensaje puede tener hasta ${MAX_TEXTO_OFICIAL} caracteres` };
  const primera = texto.split('\n').map(l => l.trim()).find(Boolean) || texto;
  const titulo = primera.length > MAX_TITULO_OFICIAL ? primera.slice(0, MAX_TITULO_OFICIAL - 1).trimEnd() + '…' : primera;
  return { datos: { titulo, contenido: texto } };
}

// Filtros del historial. Devuelve { tipo, uid, q, desde, hasta } ya validados (o lanza el mensaje en `error`).
function filtrosHistorial(q) {
  const f = { tipo: '', uid: '', q: '', desde: null, hasta: null };
  const tipo = String(q.tipo || '');
  if (tipo && tipo !== 'todos') { if (!TIPOS_HISTORIAL.includes(tipo)) return { error: 'El tipo de reto no es válido' }; f.tipo = tipo; }
  const uid = String(q.uid || '');
  if (uid) { if (!ID_DOC.test(uid)) return { error: 'El identificador no es válido' }; f.uid = uid; }
  f.q = String(q.q || '').slice(0, 80).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  for (const [campo, fin] of [['desde', false], ['hasta', true]]) {
    const t = String(q[campo] || '');
    if (!t) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: 'Las fechas deben ir como AAAA-MM-DD' };
    // Día de México (UTC-6): de las 00:00 a las 23:59:59.999 de ese día
    const ms = Date.parse(t + 'T00:00:00Z');
    if (Number.isNaN(ms)) return { error: 'La fecha no es válida' };
    f[campo] = ms + 6 * 3600 * 1000 + (fin ? 86400000 - 1 : 0);
  }
  return f;
}

function montarRutasAdminComunidad(app, deps, a) {
  const { db, admin, errorHttp } = deps;
  const { conAdmin, anotarAccion, conCache, miembros, leerColeccion, refrescar, tieneAcceso, nombreDe, analizadorJson } = a;
  void admin;

  const idDe = (req, campo) => {
    const id = String(req.params[campo] || '');
    if (!ID_DOC.test(id)) throw errorHttp(400, 'El identificador no es válido');
    return id;
  };

  const vistaEvento = (id, d, nombres) => {
    const fecha = panel.aFecha(d.fecha);
    return {
      id, uid: String(d.uid || ''), nombre: nombres.get(d.uid) || 'Sin nombre', tipo: d.tipo === 'camino' ? 'camino' : 'practica',
      retoId: String(d.retoId || ''), reto: NOMBRES_RETO[d.retoId] || String(d.retoId || '').slice(0, 40),
      indice: Number.isInteger(d.indice) ? d.indice : null,
      puntaje: Number.isFinite(d.puntaje) ? d.puntaje : null, total: Number.isFinite(d.total) ? d.total : null,
      perfecto: d.perfecto === true, xp: Number.isFinite(d.xp) ? d.xp : 0, en: fecha ? fecha.toISOString() : null
    };
  };

  // ════════════════════════════════════════════════════════════
  // Retos: historial por persona y totales reales por persona
  // ════════════════════════════════════════════════════════════
  async function leerHistorial(forzar) {
    return conCache('retosHistorial', async () => {
      const snap = await db.collection('retosHistorial').orderBy('fecha', 'desc').limit(TOPE_HISTORIAL + 1).get();
      return { docs: snap.docs.slice(0, TOPE_HISTORIAL).map(d => ({ id: d.id, data: d.data() || {} })), truncado: snap.docs.length > TOPE_HISTORIAL };
    }, forzar);
  }

  app.get('/api/admin/retos/historial', conAdmin('No se pudo cargar el historial de retos', 'retos-historial', async (req, res) => {
    const f = filtrosHistorial(req.query);
    if (f.error) throw errorHttp(400, f.error);
    const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const limite = Math.min(MAX_PAGINA_HISTORIAL, Math.max(1, parseInt(req.query.limite, 10) || PAGINA_HISTORIAL));
    const [h, mi] = await Promise.all([leerHistorial(refrescar(req)), miembros(false)]);
    const nombres = new Map(mi.docs.map(({ id, data }) => [id, nombreDe(data)]));
    const eventos = h.docs.map(({ id, data }) => vistaEvento(id, data, nombres));
    const filtrados = eventos.filter(e => {
      if (f.tipo && e.tipo !== f.tipo) return false;
      if (f.uid && e.uid !== f.uid) return false;
      if (f.desde !== null || f.hasta !== null) {
        const t = e.en ? Date.parse(e.en) : null;
        if (t === null) return false;
        if (f.desde !== null && t < f.desde) return false;
        if (f.hasta !== null && t > f.hasta) return false;
      }
      if (f.q) {
        const nombre = e.nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const reto = e.reto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (!nombre.includes(f.q) && !reto.includes(f.q)) return false;
      }
      return true;
    });
    const paginas = Math.max(1, Math.ceil(filtrados.length / limite));
    const desde = eventos.length ? eventos[eventos.length - 1].en : null;
    let xp = 0; const personas = new Set();
    for (const e of filtrados) { xp += e.xp; personas.add(e.uid); }
    return res.json({
      ok: true, generado: new Date().toISOString(), truncado: h.truncado,
      // Desde cuándo se guarda el historial detallado (los retos anteriores solo tienen totales por persona)
      historialDesde: desde,
      totales: { eventos: filtrados.length, personas: personas.size, xp },
      pagina: Math.min(pagina, paginas), paginas, limite,
      tipos: TIPOS_HISTORIAL.map(id => ({ id, nombre: NOMBRES_TIPO[id] })),
      eventos: filtrados.slice((Math.min(pagina, paginas) - 1) * limite, Math.min(pagina, paginas) * limite)
    });
  }));

  app.get('/api/admin/retos/usuarios', conAdmin('No se pudieron cargar los retos por persona', 'retos-usuarios', async (req, res) => {
    const [rt, mi] = await Promise.all([conCache('retosUsuario', () => leerColeccion('retosUsuario'), refrescar(req)), miembros(false)]);
    const nombres = new Map(mi.docs.map(({ id, data }) => [id, nombreDe(data)]));
    const filas = rt.docs.map(({ id, data }) => {
      const porReto = {};
      for (const k of Object.keys(data.porReto && typeof data.porReto === 'object' ? data.porReto : {})) {
        const r = data.porReto[k] || {};
        if (NOMBRES_RETO[k]) porReto[k] = { veces: Number(r.veces) || 0, superados: Number(r.superados) || 0, perfectos: Number(r.perfectos) || 0 };
      }
      const ultima = panel.aFecha(data.actualizadoEn);
      return {
        uid: id, nombre: nombres.get(id) || 'Sin nombre', xp: Number.isFinite(data.xp) ? data.xp : 0,
        superados: Number.isFinite(data.superados) ? data.superados : 0, dias: Array.isArray(data.dias) ? data.dias.length : 0,
        ultimaVez: ultima ? ultima.toISOString() : null, porReto
      };
    }).filter(f => f.xp > 0 || f.superados > 0 || Object.keys(f.porReto).length);
    filas.sort((x, y) => y.xp - x.xp || y.superados - x.superados);
    return res.json({ ok: true, truncado: rt.truncado, total: filas.length, usuarios: filas });
  }));

  // ════════════════════════════════════════════════════════════
  // Foro
  // ════════════════════════════════════════════════════════════
  const vistaPost = (id, p, respuestas) => ({
    id, titulo: String(p.title || '').slice(0, 140), texto: String(p.content || '').slice(0, 4000),
    autor: String(p.authorName || 'Miembro').slice(0, 80), oficial: p.oficial === true,
    categoria: String(p.category || '').slice(0, 30), creado: panel.aIso(p.createdAt),
    respuestas: Number.isFinite(p.repliesCount) ? p.repliesCount : (respuestas ? respuestas.length : 0),
    meGusta: Array.isArray(p.likes) ? p.likes.length : 0, vistas: Number.isFinite(p.views) ? p.views : 0,
    respuestasLista: (respuestas || []).map(r => ({
      id: r.id, autor: String(r.data.authorName || 'Miembro').slice(0, 80), texto: String(r.data.text || '').slice(0, 1500),
      creado: panel.aIso(r.data.createdAt), oficial: r.data.oficial === true
    }))
  });

  app.get('/api/admin/foro', conAdmin('No se pudo cargar el foro', 'foro', async (req, res) => {
    const snap = await db.collection('foroPosts').orderBy('createdAt', 'desc').limit(TOPE_FORO).get().catch(() => ({ docs: [] }));
    const posts = [];
    for (const d of snap.docs) {
      const p = d.data() || {};
      let respuestas = [];
      if ((Number.isFinite(p.repliesCount) ? p.repliesCount : 1) > 0) {
        const rs = await db.collection('foroPosts').doc(d.id).collection('replies').limit(TOPE_RESPUESTAS).get().catch(() => ({ docs: [] }));
        respuestas = rs.docs.map(r => ({ id: r.id, data: r.data() || {} }))
          .sort((x, y) => String(panel.aIso(x.data.createdAt) || '').localeCompare(String(panel.aIso(y.data.createdAt) || '')));
      }
      posts.push(vistaPost(d.id, p, respuestas));
    }
    return res.json({
      ok: true, generado: new Date().toISOString(), total: posts.length,
      limiteTexto: MAX_TEXTO_OFICIAL, autorOficial: AUTOR_OFICIAL_NOMBRE, publicaciones: posts
    });
  }));

  app.post('/api/admin/foro/publicar', analizadorJson, conAdmin('No se pudo publicar el mensaje', 'foro-publicar', async (req, res, decoded) => {
    const v = validarPublicacionOficial(req.body);
    if (v.error) throw errorHttp(400, v.error);
    const id = 'oficial-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ahora = new Date().toISOString();
    // Mismos campos que una discusión de miembro (así el foro la pinta igual), más oficial: true. authorUid no es el de nadie.
    await db.collection('foroPosts').doc(id).set({
      title: v.datos.titulo, content: v.datos.contenido, category: 'oficial',
      authorUid: AUTOR_OFICIAL_UID, authorName: AUTOR_OFICIAL_NOMBRE, oficial: true,
      createdAt: ahora, likes: [], views: 0, repliesCount: 0
    });
    await anotarAccion(decoded, 'foro-publicar', AUTOR_OFICIAL_UID, `Publicó como Zoorigen en el foro: «${v.datos.titulo}»`);
    return res.json({ ok: true, id });
  }, { escritura: true }));

  app.post('/api/admin/foro/:id/eliminar', analizadorJson, conAdmin('No se pudo eliminar la publicación', 'foro-eliminar', async (req, res, decoded) => {
    const id = idDe(req, 'id');
    const ref = db.collection('foroPosts').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos esa publicación');
    const p = snap.data() || {};
    // Firestore no borra las respuestas al borrar la publicación: se borran primero, en lotes
    let borradas = 0;
    for (let i = 0; i < 20; i++) {
      const rs = await ref.collection('replies').limit(100).get();
      if (!rs.docs.length) break;
      await Promise.all(rs.docs.map(r => r.ref.delete()));
      borradas += rs.docs.length;
    }
    await ref.delete();
    await anotarAccion(decoded, 'foro-eliminar', String(p.authorUid || '').slice(0, 128) || null,
      `Eliminó del foro «${String(p.title || '').slice(0, 80)}» de ${String(p.authorName || 'un miembro').slice(0, 60)} (con ${borradas} respuestas)`);
    return res.json({ ok: true, respuestasBorradas: borradas });
  }, { escritura: true, limite: 'eliminaciones' }));

  app.post('/api/admin/foro/:id/respuestas/:rid/eliminar', analizadorJson, conAdmin('No se pudo eliminar la respuesta', 'foro-respuesta', async (req, res, decoded) => {
    const id = idDe(req, 'id'); const rid = idDe(req, 'rid');
    const post = db.collection('foroPosts').doc(id);
    const ref = post.collection('replies').doc(rid);
    const snap = await ref.get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos esa respuesta');
    const r = snap.data() || {};
    await ref.delete();
    // El contador de respuestas del foro se corrige con lo que realmente queda
    const quedan = await post.collection('replies').limit(500).get();
    await post.set({ repliesCount: quedan.docs.length }, { merge: true }).catch(() => {});
    await anotarAccion(decoded, 'foro-respuesta-eliminar', String(r.authorUid || '').slice(0, 128) || null,
      `Eliminó una respuesta de ${String(r.authorName || 'un miembro').slice(0, 60)} en el foro`);
    return res.json({ ok: true, respuestas: quedan.docs.length });
  }, { escritura: true, limite: 'eliminaciones' }));

  // ════════════════════════════════════════════════════════════
  // Directorio: todas las tarjetas, con el contacto completo
  // ════════════════════════════════════════════════════════════
  app.get('/api/admin/directorio', conAdmin('No se pudo cargar el directorio', 'directorio-admin', async (req, res) => {
    const [snap, mi] = await Promise.all([
      db.collection('directorio').limit(TOPE_DIRECTORIO + 1).get(),
      miembros(refrescar(req))
    ]);
    const porUid = new Map(mi.docs.map(({ id, data }) => [id, data]));
    const tarjetas = snap.docs.slice(0, TOPE_DIRECTORIO).map(d => {
      const base = directorio.tarjetaPublica(d.id, d.data() || {}, { esMia: true });
      const dueno = porUid.get(d.id);
      return {
        ...base, verificado: Boolean(dueno && tieneAcceso(dueno)),
        correoCuenta: dueno ? String(dueno.email || '').slice(0, 160) : '',
        miembro: Boolean(dueno)
      };
    });
    tarjetas.sort((x, y) => String(y.actualizado || '').localeCompare(String(x.actualizado || '')));
    const publicadas = tarjetas.filter(t => t.publicado).length;
    return res.json({
      ok: true, generado: new Date().toISOString(), truncado: snap.docs.length > TOPE_DIRECTORIO,
      totales: { total: tarjetas.length, publicadas, privadas: tarjetas.length - publicadas, verificadas: tarjetas.filter(t => t.verificado).length },
      tarjetas
    });
  }));

  app.post('/api/admin/directorio/:uid/eliminar', analizadorJson, conAdmin('No se pudo eliminar la tarjeta', 'directorio-eliminar', async (req, res, decoded) => {
    const uid = idDe(req, 'uid');
    const ref = db.collection('directorio').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw errorHttp(404, 'No encontramos esa tarjeta');
    const t = snap.data() || {};
    await ref.delete();
    a.cache.delete('directorio');
    await anotarAccion(decoded, 'directorio-eliminar', uid, `Eliminó la tarjeta del directorio de ${String(t.nombre || 'un miembro').slice(0, 80)}`);
    return res.json({ ok: true });
  }, { escritura: true, limite: 'eliminaciones' }));

  return null;
}

module.exports = {
  montarRutasAdminComunidad, validarPublicacionOficial, filtrosHistorial, limpiarTextoLibre,
  AUTOR_OFICIAL_UID, AUTOR_OFICIAL_NOMBRE, MAX_TEXTO_OFICIAL, NOMBRES_RETO
};
