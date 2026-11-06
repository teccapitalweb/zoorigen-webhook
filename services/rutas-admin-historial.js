'use strict';

// ══ HISTORIAL DE MOVIMIENTOS · rutas del panel (solo administración, verificada en el servidor) ══
//   GET  /api/admin/historial?limite=10&cursor=…&administrador=correo&tipo=cursos
//        → { ok, items:[{ id, accion, tipo, tipoTexto, por:{uid,nombre,correo}, resumen, destino:{id,nombre}, en }], siguiente, parcial,
//            limite, administradores:[{correo,nombre}], tipos:[{id,texto}], retencionMeses }
//        La más reciente primero; `siguiente` es el cursor de «Ver más» (null si ya no hay más). Pide 10 por defecto y 20 como máximo.
//   POST /api/admin/historial/registrar  { accion, id, nombre }
//        → lo usa el panel para avisar de lo que todavía guarda directo en Firestore (cursos, videos, PDF, clases en vivo). El servidor
//          toma al administrador de su token, arma la frase y solo acepta los códigos de DESDE_PANEL.
const h = require('./historial-admin');

const CACHE_ADMINS_MS = 10 * 60 * 1000;

function montarRutasAdminHistorial(app, deps, a) {
  const { db, errorHttp, correosAdministrador } = deps;
  const { conAdmin, historial, analizadorJson } = a;
  let adminsCache = null;

  // Los administradores para el filtro: los de ADMIN_EMAILS (con su nombre si ya tienen cuenta) más los que aparecen en la página
  async function listaAdministradores(items) {
    if (!adminsCache || Date.now() - adminsCache.en > CACHE_ADMINS_MS) {
      const mapa = new Map();
      for (const correo of (typeof correosAdministrador === 'function' ? [...correosAdministrador()] : [])) {
        let nombre = '';
        try {
          const s = await db.collection('miembros').where('email', '==', correo).limit(1).get();
          if (s.docs.length) { const d = s.docs[0].data() || {}; nombre = String(d.name || d.displayName || ''); }
        } catch (_) { /* sin nombre */ }
        mapa.set(correo, nombre || correo.split('@')[0]);
      }
      adminsCache = { en: Date.now(), mapa };
    }
    const todos = new Map(adminsCache.mapa);
    for (const i of items) if (i.por.correo && !todos.has(i.por.correo)) todos.set(i.por.correo, i.por.nombre || i.por.correo.split('@')[0]);
    return [...todos.entries()].map(([correo, nombre]) => ({ correo, nombre: h.limpiarTexto(nombre, 80) })).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
  }

  app.get('/api/admin/historial', conAdmin('No se pudo cargar el historial de movimientos', 'historial', async (req, res) => {
    const q = req.query || {};
    let limite = h.POR_PAGINA;
    if (q.limite !== undefined) {
      const n = Number.parseInt(q.limite, 10);
      if (!Number.isInteger(n) || n < 1) throw errorHttp(400, 'El tamaño de página no es válido');
      limite = Math.min(n, h.MAX_POR_PAGINA);
    }
    const cursor = h.decodificarCursor(q.cursor);
    if (cursor === undefined) throw errorHttp(400, 'El cursor no es válido');
    const tipo = q.tipo === undefined || q.tipo === '' ? '' : String(q.tipo);
    if (tipo && !h.IDS_TIPOS.includes(tipo)) throw errorHttp(400, 'El tipo de movimiento no es válido');
    const administrador = q.administrador === undefined ? '' : String(q.administrador).trim().toLowerCase();
    if (administrador && (administrador.length > 160 || !/^[^\s@]+@[^\s@]+$/.test(administrador))) throw errorHttp(400, 'El administrador no es válido');
    const r = await historial.listar({ limite, cursor, administrador, tipo });
    return res.json({
      ok: true, items: r.items, siguiente: r.siguiente, parcial: r.parcial === true, limite,
      administradores: await listaAdministradores(r.items), tipos: h.TIPOS, retencionMeses: h.RETENCION_MESES
    });
  }));

  app.post('/api/admin/historial/registrar', analizadorJson, conAdmin('No se pudo registrar el movimiento', 'historial-registrar', async (req, res, decoded) => {
    const r = await historial.registrarDesdePanel(decoded, req.body);
    if (r.error) throw errorHttp(400, r.error);
    return res.json({ ok: true, registrado: r.ok === true });
  }, { escritura: true }));
}

module.exports = { montarRutasAdminHistorial };
