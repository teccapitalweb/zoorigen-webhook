'use strict';

// ══ TAREAS DE CLASES EN VIVO ══
// Dos `setInterval` artesanales (mismo estilo que services/tarea-diaria.js, pero sin node-cron):
//   · cada 3 min: busca la grabación de las clases ya iniciadas sin video y, si la encuentra, la sube a Bunny.
//   · cada 1 min: avisa por la campana «falta 1 hora» y «ya empezó» (ids deterministas: nunca se duplican).
// Se apaga con WEBINARS_TAREA=off. Los temporizadores no mantienen vivo el proceso (unref).

const { crearNotificacionGlobal } = require('./avisos');

const INTERVALO_GRABACION_MS = 3 * 60 * 1000;
const INTERVALO_AVISOS_MS = 60 * 1000;
const AVISO_ANTES_MIN = 60;

async function clasesPendientesDeGrabacion(db) {
  const ahoraISO = new Date().toISOString();
  const resultado = [];
  for (const [col, esPrueba] of [['sesiones', false], ['sesionesPrueba', true]]) {
    const snap = await db.collection(col).where('inicioISO', '<=', ahoraISO).where('tieneGrabacion', '==', false).limit(50).get();
    snap.docs.forEach(d => resultado.push({ id: d.id, esPrueba }));
  }
  return resultado;
}

async function clasesPorAvisar(db) {
  const ahora = Date.now();
  const antes = new Date(ahora + AVISO_ANTES_MIN * 60000).toISOString();
  const snap = await db.collection('sesiones').where('inicioISO', '<=', antes).where('estado', '==', 'programada').limit(100).get();
  return snap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
}

async function avisarSiToca(db, { id, data }) {
  const inicioMs = Date.parse(data.inicioISO);
  const ahora = Date.now();
  if (ahora >= inicioMs - AVISO_ANTES_MIN * 60000) {
    await crearNotificacionGlobal(db, { id: `clase-recordatorio_${id}`, tipo: 'clase', titulo: '⏰ Tu clase empieza en 1 hora', descripcion: data.titulo, enlace: 'club-sesiones.html' });
  }
  if (ahora >= inicioMs) {
    await crearNotificacionGlobal(db, { id: `clase-inicio_${id}`, tipo: 'clase', titulo: '🔴 ¡Tu clase ya empezó!', descripcion: data.titulo, enlace: 'club-sesiones.html' });
  }
}

function iniciarTareaWebinars(db, { webinars, activa = (process.env.WEBINARS_TAREA || '').trim().toLowerCase() !== 'off' } = {}) {
  if (!activa || !webinars) return { activo: false, detener() {} };
  let detenido = false;

  async function corridaGrabaciones() {
    try {
      const pendientes = await clasesPendientesDeGrabacion(db);
      for (const { id, esPrueba } of pendientes) {
        if (detenido) return;
        await webinars.buscarGrabacionParaSesion(id, { esPrueba });
      }
    } catch (error) {
      console.error('[Webinars] Error en la ronda de grabaciones:', error && error.message);
    }
  }

  async function corridaAvisos() {
    try {
      const lista = await clasesPorAvisar(db);
      for (const item of lista) { if (detenido) return; await avisarSiToca(db, item); }
    } catch (error) {
      console.error('[Webinars] Error en la ronda de avisos:', error && error.message);
    }
  }

  const tGrabaciones = setInterval(corridaGrabaciones, INTERVALO_GRABACION_MS);
  if (tGrabaciones.unref) tGrabaciones.unref();
  const tAvisos = setInterval(corridaAvisos, INTERVALO_AVISOS_MS);
  if (tAvisos.unref) tAvisos.unref();

  return {
    activo: true,
    detener() { detenido = true; clearInterval(tGrabaciones); clearInterval(tAvisos); }
  };
}

module.exports = { iniciarTareaWebinars, clasesPendientesDeGrabacion, clasesPorAvisar, avisarSiToca, INTERVALO_GRABACION_MS, INTERVALO_AVISOS_MS, AVISO_ANTES_MIN };
