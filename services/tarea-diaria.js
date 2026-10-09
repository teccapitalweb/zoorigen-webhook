'use strict';

// ══ TAREA DIARIA (noticias + dato curioso) ══
// Corre dentro del propio proceso, sin dependencias nuevas:
//   · una corrida a los 20 s de arrancar (si la última sincronización tiene más de 6 horas), y
//   · después cada día a las 13:00 UTC (7:00 a.m. de Ciudad de México).
// Pasos (cada uno aislado: si uno falla, el otro corre igual):
//   1) syncNoticias -> si guardó alguna, aviso global "📰 Nuevas noticias del sector" (id noticias_<fecha>, uno por día)
//   2) enviarDatoCuriosoSiToca -> martes y viernes (fecha de México), una vez por día
// Los temporizadores no mantienen vivo el proceso (unref) y se pueden detener con detener().
// Se desactiva con NOTICIAS_TAREA=off (o pasando activa:false); las pruebas nunca la arrancan.

const { syncNoticias } = require('./noticias');
const { enviarDatoCuriosoSiToca, fechaMexico } = require('./datos-curiosos');
const { crearNotificacionGlobal } = require('./avisos');

const HORA_UTC = 13;
const RETRASO_ARRANQUE_MS = 20 * 1000;
const HORAS_MIN_ARRANQUE = 6;
const DIA_MS = 24 * 60 * 60 * 1000;
const ENLACE_NOTICIAS = 'club-noticias.html';

// Milisegundos hasta la próxima 13:00 UTC (si ya pasó hoy, la de mañana)
function msHastaProxima(ahora = new Date(), hora = HORA_UTC) {
  const objetivo = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), hora, 0, 0, 0);
  const falta = objetivo - ahora.getTime();
  return falta > 0 ? falta : falta + DIA_MS;
}

async function ultimaSync(db) {
  try {
    const snap = await db.collection('config').doc('noticiasSector').get();
    const t = snap.exists ? Date.parse((snap.data() || {}).ultimaSync) : NaN;
    return Number.isNaN(t) ? null : t;
  } catch (_) { return null; }
}

// Aviso global "Nuevas noticias del sector" (uno por día: el id lleva la fecha). null si no hubo noticias nuevas.
async function avisarNoticiasNuevas(db, resultado, { ahora = new Date() } = {}) {
  if (!resultado || !(resultado.guardadas > 0)) return null;
  const primera = (resultado.nuevas && resultado.nuevas[0] && resultado.nuevas[0].titulo) || '';
  return crearNotificacionGlobal(db, {
    id: `noticias_${fechaMexico(ahora)}`, tipo: 'noticia', titulo: '📰 Nuevas noticias del sector',
    descripcion: primera ? `${primera}${resultado.guardadas > 1 ? ` y ${resultado.guardadas - 1} más` : ''}` : `Hay ${resultado.guardadas} noticias nuevas para ti.`,
    enlace: ENLACE_NOTICIAS, origen: 'auto'
  }, { ahora });
}

// Ejecuta la tarea una vez. `minHoras`: si la última sincronización es más reciente, se salta el paso de noticias.
async function ejecutarTareaDiaria(db, { ahora = new Date(), minHoras = 0, sync = syncNoticias, syncOpciones = {} } = {}) {
  const salida = { noticias: null, aviso: null, dato: null };

  try {
    const ultima = minHoras > 0 ? await ultimaSync(db) : null;
    if (ultima !== null && ahora.getTime() - ultima < minHoras * 3600 * 1000) {
      salida.noticias = { omitida: true, motivo: 'reciente' };
    } else {
      const r = await sync(db, { ...syncOpciones, ahora });
      salida.noticias = { guardadas: r.guardadas, omitidas: r.omitidas, eliminadas: r.eliminadas || 0, fuentes: r.fuentes };
      salida.aviso = await avisarNoticiasNuevas(db, r, { ahora });
    }
  } catch (error) {
    console.error('[Tarea diaria] Falló la sincronización de noticias:', error && error.message);
    salida.noticias = { error: true };
  }

  try {
    salida.dato = await enviarDatoCuriosoSiToca(db, { ahora });
  } catch (error) {
    console.error('[Tarea diaria] Falló el dato curioso:', error && error.message);
    salida.dato = { enviado: false, motivo: 'error' };
  }
  return salida;
}

// Arranca el programador. Devuelve { detener } (y `proximaEn()` para consultar el siguiente disparo).
function iniciarProgramador(db, opciones = {}) {
  const { activa = process.env.NOTICIAS_TAREA !== 'off', ejecutar = ejecutarTareaDiaria, retrasoArranqueMs = RETRASO_ARRANQUE_MS } = opciones;
  if (!activa) return { detener() {}, activo: false };

  let temporizadorDia = null;
  let temporizadorArranque = null;
  let detenido = false;
  const correr = minHoras => Promise.resolve()
    .then(() => ejecutar(db, { minHoras }))
    .catch(error => console.error('[Tarea diaria] Error inesperado:', error && error.message));

  // `margenMs`: tras una corrida se mira un minuto adelante, así un disparo que llegue unos ms antes de las 13:00 no se repite
  const programar = (margenMs = 0) => {
    if (detenido) return;
    temporizadorDia = setTimeout(() => { correr(0).finally(() => programar(60 * 1000)); }, msHastaProxima(new Date(Date.now() + margenMs)) + margenMs);
    if (temporizadorDia.unref) temporizadorDia.unref();
  };
  temporizadorArranque = setTimeout(() => { correr(HORAS_MIN_ARRANQUE); }, retrasoArranqueMs);
  if (temporizadorArranque.unref) temporizadorArranque.unref();
  programar();

  return {
    activo: true,
    detener() { detenido = true; clearTimeout(temporizadorDia); clearTimeout(temporizadorArranque); }
  };
}

module.exports = { HORA_UTC, avisarNoticiasNuevas, RETRASO_ARRANQUE_MS, msHastaProxima, ejecutarTareaDiaria, iniciarProgramador };
