'use strict';

// ══ RUTAS DE MÉTRICAS DE VISITAS ══
//   POST /api/metricas/visita                    PÚBLICA, siempre 204. Cuenta una visita anónima (o de un miembro con sesión). Ver services/metricas-visitas.js
//   GET  /api/admin/visitas/metricas?dias=N      SOLO ADMIN. Agregados por día (con ceros), miembros que entraron, cuentas por origen, estado del contador
//   GET  /api/admin/visitas/registro?periodo=    SOLO ADMIN. Visitas una por una: hoy | ayer | 7 | 30
//
// Reglas de la ruta pública (todas en el servidor):
//   · Interruptor: config/panel.contadorVisitas (se cambia en Configuración del panel). Apagado → 204 sin contar. Caché de 30 s.
//   · CORS estricto: solo cuenta si la petición viene de zoorigen.com (o de localhost / 127.0.0.1 para pruebas); cualquier otro origen, o sin origen, se ignora.
//   · «No rastrear» (DNT: 1) y «Control global de privacidad» (Sec-GPC: 1) → no cuenta.
//   · Cuerpo de hasta 4 KB; solo campos de una lista cerrada, recortados. Páginas: landing, acceso, panel y legal.
//   · Límite de frecuencia por IP (60 cada 10 min) y global (3,000 cada 10 min), en memoria. Al pasarse responde 204 y no cuenta.
//   · Bots (por navegador) y administradores (por sesión) no cuentan. Un token vencido o con correo sin verificar cuenta como visita anónima.
//   · La IP y el navegador se usan solo en memoria. Nunca se guardan.

const express = require('express');
const crypto = require('crypto');
const visitas = require('./metricas-visitas');
const configAdm = require('./admin-config');
const { permitirSolicitud } = require('./rutas-club');
const panel = require('./admin-panel');

const VENTANA_MS = 10 * 60 * 1000;
const POR_IP = 60;
const GLOBAL = 3000;
const CONFIG_CACHE_MS = 30 * 1000;
const ORIGEN_PERMITIDO = /^(https:\/\/(www\.)?zoorigen\.com|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/i;

function montarRutasMetricasVisitas(app, deps, a = {}) {
  const { db, auth, esAdminPorCorreo, correosAdministrador } = deps;
  const { conAdmin, conCache, miembros, tieneAcceso, refrescar } = a;
  const extras = String(process.env.CORS_ORIGINS_VISITAS || '').split(',').map(x => x.trim()).filter(Boolean);
  const origenPermitido = o => ORIGEN_PERMITIDO.test(String(o || '')) || extras.includes(String(o || ''));

  // La clave del identificador anónimo sale de una clave del servidor (nunca se guarda ni se muestra)
  const llave = process.env.METRICAS_VISITAS_CLAVE || process.env.CERTIFICATE_SIGNING_KEY || process.env.STRIPE_WEBHOOK_SECRET || 'zoorigen-visitas-local';
  const secreto = crypto.createHmac('sha256', llave).update('metricas-visitas').digest('hex');

  const limites = { ip: new Map(), global: new Map() };
  let configCache = null;
  async function contadorEncendido() {
    if (configCache && Date.now() - configCache.en < CONFIG_CACHE_MS) return configCache.valor;
    let valor = configCache ? configCache.valor : false;
    try {
      const s = await db.collection('config').doc('panel').get();
      valor = configAdm.normalizarConfig(s.exists ? (s.data() || {}) : {}).contadorVisitas === true;
    } catch (_) { /* si Firestore falla se conserva lo último que se sabía */ }
    configCache = { en: Date.now(), valor };
    return valor;
  }

  // Administrador: marca en el token, correo en ADMIN_EMAILS o role «admin» en su ficha (así lo reconoce todo el servidor)
  const esAdminToken = async decoded => {
    if (decoded && decoded.admin === true) return true;
    try { if (typeof esAdminPorCorreo === 'function' && esAdminPorCorreo(decoded)) return true; } catch (_) { /* se sigue */ }
    try {
      const m = await db.collection('miembros').doc(decoded.uid).get();
      return Boolean(m.exists && (m.data() || {}).role === 'admin');
    } catch (_) { return false; }
  };

  const analizador = express.json({ limit: '4kb', type: ['application/json', 'text/plain'] });
  app.post('/api/metricas/visita', (req, res) => {
    // El contador nunca debe estorbar a quien visita: siempre 204, cuente o no la visita.
    analizador(req, res, async () => {
      try {
        if (visitas.visitaNoRastreable(req.headers)) return res.status(204).end();
        if (!origenPermitido(req.headers.origin)) return res.status(204).end();
        const ip = visitas.ipDeSolicitud(req.headers, req.ip);
        if (!permitirSolicitud(limites.global, 'global', VENTANA_MS, GLOBAL) || !permitirSolicitud(limites.ip, ip || 'desconocida', VENTANA_MS, POR_IP)) return res.status(204).end();
        if (!(await contadorEncendido())) return res.status(204).end();
        let cuerpo = req.body;
        if (typeof cuerpo === 'string') { try { cuerpo = JSON.parse(cuerpo); } catch (_) { cuerpo = {}; } }
        const datos = visitas.limpiarCuerpo(cuerpo);
        if (!datos) return res.status(204).end();
        let miembro = null;
        const cab = String(req.headers.authorization || '');
        if (cab.startsWith('Bearer ') && auth && typeof auth.verifyIdToken === 'function') {
          try {
            const decoded = await auth.verifyIdToken(cab.slice(7).trim());
            if (await esAdminToken(decoded)) return res.status(204).end();   // quien administra no cuenta como visita
            if (decoded.email_verified === true && decoded.email) {
              miembro = { uid: decoded.uid, email: decoded.email, nombre: decoded.name || String(decoded.email).split('@')[0] };
            }
          } catch (_) { /* token vencido o inválido: cuenta como visita anónima */ }
        }
        const r = await visitas.registrarVisita(db, {
          ...datos, ip, pais: visitas.paisDeSolicitud(req.headers, ip), userAgent: req.headers['user-agent'], secreto, miembro,
          origen: miembro ? datos.origen : null,
          obtenerCreada: async () => {
            const u = await auth.getUser(miembro.uid);
            return Date.parse(u && u.metadata && u.metadata.creationTime) || null;
          }
        });
        if (r && r.contada) visitas.marcarVisitaOk();
      } catch (e) {
        visitas.marcarVisitaError(e);
        console.error('[Visitas] No se registró la visita:', e && e.message);
      }
      return res.status(204).end();
    });
  });

  if (typeof conAdmin !== 'function') return {};

  app.get('/api/admin/visitas/metricas', conAdmin('No se pudieron cargar las métricas de visitas', 'visitas-metricas', async (req, res) => {
    const forzar = refrescar ? refrescar(req) : false;
    const mi = await miembros(forzar);
    const vip = new Map(mi.docs.map(({ id, data }) => [id, tieneAcceso(data)]));
    const r = await visitas.leerMetricas(db, { dias: req.query.dias, esVip: uid => vip.get(uid) === true });
    const activo = await contadorEncendido();
    // Última visita: el último día con actividad (sale de los agregados, no del reinicio del servidor)
    const conVisitas = r.dias.filter(d => d.total > 0).pop();
    // Cuentas nuevas por día (TODAS las cuentas, sin administradores) y cuántas ya tienen plan: es la cifra de «Cuentas nuevas» de la pantalla
    // (la versión completa; el origen solo se conoce de las cuentas que entraron con el contador encendido).
    const primero = r.dias.length ? r.dias[0].dia : null;
    const altas = {};
    for (const { id, data } of mi.docs) {
      if (data.role === 'admin') continue;
      const f = panel.aFecha(data.createdAt);
      if (!f) continue;
      const dia = visitas.claveDia(f);
      if (primero && dia < primero) continue;
      altas[dia] = altas[dia] || { n: 0, vip: 0 };
      altas[dia].n += 1;
      if (vip.get(id) === true) altas[dia].vip += 1;
    }
    return res.json({ ok: true, ...r, altas, activo, ultimoDia: conVisitas ? conVisitas.dia : null, ultimaVisita: visitas.estado().ultimoOk || (conVisitas && conVisitas.actualizado) || null });
  }));

  app.get('/api/admin/visitas/registro', conAdmin('No se pudo cargar el registro de visitas', 'visitas-registro', async (req, res) => {
    const r = await visitas.leerRegistro(db, { periodo: String(req.query.periodo || 'hoy') });
    return res.json({ ok: true, ...r });
  }));

  void conCache; void correosAdministrador;
  return { reiniciarConfig: () => { configCache = null; } };
}

module.exports = { montarRutasMetricasVisitas, ORIGEN_PERMITIDO };
