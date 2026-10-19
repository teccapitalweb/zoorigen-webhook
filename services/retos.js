'use strict';

// ══ RETOS → XP e insignias ══
// Toda la lógica vive en el servidor: el sitio solo informa el resultado de un reto y el
// servidor decide cuánto vale. Diseñado para que subir de nivel sea gradual y no se pueda
// "granjear" XP repitiendo un reto una y otra vez.
//
// Límite honesto: el servidor NO ve las respuestas, solo el puntaje que informa el navegador.
// Por eso el XP de retos tiene techos duros (TOPE_XP_PRACTICA y los totales del camino) y las
// insignias piden constancia en días distintos. Ver README.

// Tres tipos de práctica con camino (todos sus retos abiertos, en cualquier orden), más flashcards —repaso libre,
// sin XP, por eso no cuenta para "Todoterreno"— y los casos del modo historia.
const RETOS_BASE = ['quiz', 'detective', 'orden'];
const RETOS_VALIDOS = [...RETOS_BASE, 'flashcards', 'historia'];
const RETOS_SIN_XP = ['flashcards'];
const MINIMO_APROBAR = 0.6;   // 60 % para superar un reto
const XP_SUPERADO = 6;        // reto superado
const XP_PERFECTO = 10;       // reto con 100 %

// Práctica diaria: XP solo la primera vez que se supera cada reto cada día (hora de México).
// Aun así, el total de XP que puede dar la práctica diaria en toda la vida de la cuenta tiene
// techo; pasado el techo se sigue jugando y contando retos superados (insignias), pero ya no suma XP.
const TOPE_XP_PRACTICA = 600;

// Camino: dentro de quiz/detective/orden la persona elige qué reto resolver y en qué orden (todos están abiertos).
// El servidor guarda QUÉ índices ya superó (caminoHechos) y solo da XP la primera vez de cada uno: no se puede
// "granjear" XP repitiendo el mismo reto. Resolver cualquiera exige membresía vigente (lo comprueba la ruta).
// TOTALES_CAMINO es la cantidad de retos que existe en el sitio: un índice fuera de ese rango no es válido.
const CAMINO_MODOS = RETOS_BASE;
const TOTALES_CAMINO = Object.freeze({ quiz: 32, detective: 30, orden: 24 });
const XP_CAMINO = 6;
const XP_CAMINO_PERFECTO = 10;
const INDICE_MAXIMO = 200;
const TOTAL_MAXIMO = 30;

// Primer curso de la fila de desbloqueo: se puede abrir ANTES de su fecha superando 15 retos del camino, con un mínimo de 4 de cada
// tipo (quiz, detective y ordena) y 3 más del tipo que la persona prefiera. Solo adelanta ESE curso (los demás conservan su
// fecha). Es la regla de Alintec Food. Cada reto cuenta una sola vez (caminoHechos); flashcards, historia y práctica diaria no cuentan.
const PRIMER_CURSO_RETOS = Object.freeze({ total: 15, porTipo: 4 });

// XP máximo que pueden dar los retos en toda la vida de la cuenta (para el balance de niveles).
const XP_MAXIMO_RETOS = TOPE_XP_PRACTICA +
  CAMINO_MODOS.reduce((t, m) => t + TOTALES_CAMINO[m] * XP_CAMINO_PERFECTO, 0);

// Insignias de la categoría "Retos" (fuente única: el sitio las pinta tal como llegan).
// cumple(e) recibe el estado normalizado de retos.
const INSIGNIAS = [
  { id: 'r1', nombre: 'Primer reto', desc: 'Superaste tu primer reto', xp: 20, criterio: 'Supera 1 reto',
    cumple: e => e.superados >= 1 },
  { id: 'r2', nombre: 'Repaso constante', desc: 'Superaste 10 retos', xp: 40, criterio: 'Supera 10 retos',
    cumple: e => e.superados >= 10 },
  { id: 'r3', nombre: 'Ojo de naturalista', desc: 'Detective de campo con puntaje perfecto', xp: 40,
    criterio: 'Consigue 100 % en el Detective de campo',
    cumple: e => ((e.porReto.detective || {}).perfectos || 0) >= 1 },
  { id: 'r4', nombre: 'Mente afilada', desc: 'Tres quizzes relámpago perfectos', xp: 50,
    criterio: 'Consigue 100 % en 3 quizzes relámpago',
    cumple: e => ((e.porReto.quiz || {}).perfectos || 0) >= 3 },
  { id: 'r5', nombre: 'Racha de retos', desc: 'Retos superados en 5 días distintos', xp: 50,
    criterio: 'Supera retos en 5 días distintos', cumple: e => e.dias.length >= 5 },
  { id: 'r6', nombre: 'Maestro de retos', desc: 'Superaste 50 retos', xp: 80, criterio: 'Supera 50 retos',
    cumple: e => e.superados >= 50 },
  { id: 'r7', nombre: 'Todoterreno', desc: 'Superaste quiz, detective y ordena', xp: 50,
    criterio: 'Supera al menos un reto de cada camino (quiz, detective y ordena)',
    cumple: e => RETOS_BASE.every(id => ((e.porReto[id] || {}).superados || 0) >= 1) },
  { id: 'r8', nombre: 'Explorador de mundos', desc: 'Superaste 3 casos del modo historia', xp: 40,
    criterio: 'Supera 3 casos del modo historia',
    cumple: e => ((e.porReto.historia || {}).superados || 0) >= 3 },
  { id: 'r9', nombre: 'Constancia de campo', desc: 'Retos superados en 15 días distintos', xp: 60,
    criterio: 'Supera retos en 15 días distintos', cumple: e => e.dias.length >= 15 },
  { id: 'r10', nombre: 'Leyenda de los retos', desc: 'Superaste 100 retos', xp: 70, criterio: 'Supera 100 retos',
    cumple: e => e.superados >= 100 }
];

function estadoInicial() {
  return {
    xp: 0, xpPractica: 0, superados: 0, porReto: {}, dias: [],
    retosHoy: { fecha: '', ids: [] }, camino: { quiz: 0, detective: 0, orden: 0 },
    caminoHechos: { quiz: [], detective: [], orden: [] }
  };
}

const entero = v => (Number.isInteger(v) && v >= 0 ? v : 0);

function normalizarCamino(guardado) {
  const out = {};
  CAMINO_MODOS.forEach(m => { out[m] = guardado && typeof guardado === 'object' ? entero(guardado[m]) : 0; });
  return out;
}

// Índices superados de cada modo. Las cuentas anteriores solo guardaban un contador (camino[modo] = N, o sea los N
// primeros retos), así que sin lista propia se reconstruye como 0..N-1: nadie pierde avance.
function normalizarCaminoHechos(guardado, camino) {
  const out = {};
  CAMINO_MODOS.forEach(m => {
    const lista = guardado && typeof guardado === 'object' && Array.isArray(guardado[m]) ? guardado[m] : null;
    if (lista) {
      out[m] = [...new Set(lista.filter(n => Number.isInteger(n) && n >= 0 && n < TOTALES_CAMINO[m]))].sort((a, b) => a - b);
    } else {
      out[m] = Array.from({ length: Math.min(camino[m], TOTALES_CAMINO[m]) }, (_, i) => i);
    }
  });
  return out;
}

function normalizarPorReto(guardado) {
  const out = {};
  if (!guardado || typeof guardado !== 'object') return out;
  for (const id of RETOS_VALIDOS) {
    const r = guardado[id];
    if (!r || typeof r !== 'object') continue;
    out[id] = {
      veces: entero(r.veces), mejor: entero(r.mejor), total: entero(r.total) || 1,
      superados: entero(r.superados), perfectos: entero(r.perfectos)
    };
  }
  return out;
}

function normalizarEstado(guardado) {
  const base = estadoInicial();
  if (!guardado || typeof guardado !== 'object') return base;
  const retosHoy = guardado.retosHoy && typeof guardado.retosHoy === 'object'
    ? { fecha: String(guardado.retosHoy.fecha || ''), ids: Array.isArray(guardado.retosHoy.ids) ? guardado.retosHoy.ids.filter(i => RETOS_VALIDOS.includes(i)) : [] }
    : base.retosHoy;
  const camino = normalizarCamino(guardado.camino);
  const caminoHechos = normalizarCaminoHechos(guardado.caminoHechos, camino);
  // "camino" es siempre la cantidad de retos superados de cada modo (lo que ya leen el sitio, los logros y las pruebas)
  CAMINO_MODOS.forEach(m => { camino[m] = caminoHechos[m].length; });
  return {
    xp: entero(guardado.xp),
    xpPractica: entero(guardado.xpPractica),
    superados: entero(guardado.superados),
    porReto: normalizarPorReto(guardado.porReto),
    dias: Array.isArray(guardado.dias) ? guardado.dias.filter(d => typeof d === 'string') : [],
    retosHoy,
    camino,
    caminoHechos
  };
}

// Fecha de "hoy" en hora de México (UTC-6, sin horario de verano desde 2022)
function fechaMexico(ahora = new Date()) {
  return new Date(ahora.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

function validarResultado({ retoId, puntaje, total }) {
  if (typeof retoId !== 'string' || !RETOS_VALIDOS.includes(retoId)) return 'Reto no válido';
  if (!Number.isInteger(total) || total < 1 || total > TOTAL_MAXIMO) return 'Total no válido';
  if (!Number.isInteger(puntaje) || puntaje < 0 || puntaje > total) return 'Puntaje no válido';
  return null;
}

function validarCaminoResultado({ modo, indice, puntaje, total }) {
  if (typeof modo !== 'string' || !CAMINO_MODOS.includes(modo)) return 'Modo no válido';
  if (!Number.isInteger(indice) || indice < 0 || indice > INDICE_MAXIMO || indice >= TOTALES_CAMINO[modo]) return 'Índice no válido';
  if (!Number.isInteger(total) || total < 1 || total > TOTAL_MAXIMO) return 'Total no válido';
  if (!Number.isInteger(puntaje) || puntaje < 0 || puntaje > total) return 'Puntaje no válido';
  return null;
}

const mejorQue = (puntaje, total, reto) => puntaje / total > reto.mejor / (reto.total || 1);

// Aplica un resultado de práctica y devuelve { estado, xpGanado, aprobado }. Un reto solo da XP
// la primera vez que se supera cada día; repetirlo el mismo día no suma nada. Flashcards nunca.
function aplicarResultado(estadoPrevio, { retoId, puntaje, total }, ahora = new Date()) {
  const estado = normalizarEstado(estadoPrevio);
  const hoy = fechaMexico(ahora);
  if (estado.retosHoy.fecha !== hoy) estado.retosHoy = { fecha: hoy, ids: [] };

  const reto = estado.porReto[retoId] || { mejor: 0, total, veces: 0, superados: 0, perfectos: 0 };
  reto.veces += 1;
  if (mejorQue(puntaje, total, reto)) { reto.mejor = puntaje; reto.total = total; }

  const aprobado = puntaje / total >= MINIMO_APROBAR;
  const perfecto = puntaje === total;
  let xpGanado = 0;
  if (aprobado && !RETOS_SIN_XP.includes(retoId) && !estado.retosHoy.ids.includes(retoId)) {
    const base = perfecto ? XP_PERFECTO : XP_SUPERADO;
    xpGanado = Math.max(0, Math.min(base, TOPE_XP_PRACTICA - estado.xpPractica));
    estado.retosHoy.ids.push(retoId);
    estado.xp += xpGanado;
    estado.xpPractica += xpGanado;
    estado.superados += 1;
    reto.superados += 1;
    if (perfecto) reto.perfectos += 1;
    if (!estado.dias.includes(hoy)) estado.dias = [...estado.dias, hoy].slice(-400);
  }
  estado.porReto[retoId] = reto;
  return { estado, xpGanado, aprobado };
}

// Aplica el resultado de UN reto del camino. Cualquier índice que exista en el sitio se puede resolver, en el orden
// que la persona elija, pero solo se acepta si se aprueba con 60 % o más y solo da XP la primera vez que se supera:
// un índice ya superado no se acepta de nuevo. Superarlo también cuenta para las insignias (mismo contador
// porReto/superados que la práctica).
function aplicarCaminoResultado(estadoPrevio, { modo, indice, puntaje, total }, ahora = new Date()) {
  const estado = normalizarEstado(estadoPrevio);
  const aprobado = puntaje / total >= MINIMO_APROBAR;
  if (estado.caminoHechos[modo].includes(indice) || indice >= TOTALES_CAMINO[modo] || !aprobado) {
    return { estado, xpGanado: 0, aceptado: false, aprobado };
  }

  const hoy = fechaMexico(ahora);
  const perfecto = puntaje === total;
  const reto = estado.porReto[modo] || { mejor: 0, total, veces: 0, superados: 0, perfectos: 0 };
  reto.veces += 1;
  reto.superados += 1;
  if (perfecto) reto.perfectos += 1;
  if (mejorQue(puntaje, total, reto)) { reto.mejor = puntaje; reto.total = total; }
  estado.porReto[modo] = reto;

  const xpGanado = perfecto ? XP_CAMINO_PERFECTO : XP_CAMINO;
  estado.xp += xpGanado;
  estado.superados += 1;
  estado.caminoHechos[modo] = [...estado.caminoHechos[modo], indice].sort((a, b) => a - b);
  estado.camino[modo] = estado.caminoHechos[modo].length;
  if (!estado.dias.includes(hoy)) estado.dias = [...estado.dias, hoy].slice(-400);
  return { estado, xpGanado, aceptado: true, aprobado };
}

// Avance hacia abrir el primer curso: { tipos: { quiz: {hechos, meta}, ... }, libres: {hechos, meta}, hechos, meta, completo }
function progresoPrimerCurso(estado) {
  const e = normalizarEstado(estado);
  const minimo = PRIMER_CURSO_RETOS.porTipo;
  const metaLibres = PRIMER_CURSO_RETOS.total - minimo * CAMINO_MODOS.length;
  const tipos = {};
  let extras = 0;
  CAMINO_MODOS.forEach(m => {
    const n = e.caminoHechos[m].length;
    tipos[m] = { hechos: Math.min(n, minimo), meta: minimo };
    extras += Math.max(0, n - minimo);
  });
  const libres = { hechos: Math.min(extras, metaLibres), meta: metaLibres };
  const hechos = CAMINO_MODOS.reduce((t, m) => t + tipos[m].hechos, 0) + libres.hechos;
  return { tipos, libres, hechos, meta: PRIMER_CURSO_RETOS.total, completo: hechos >= PRIMER_CURSO_RETOS.total };
}

function insignias(estado) {
  const e = normalizarEstado(estado);
  return INSIGNIAS.map(i => ({ id: i.id, nombre: i.nombre, desc: i.desc, xp: i.xp, criterio: i.criterio, desbloqueada: Boolean(i.cumple(e)) }));
}

// Insignias que se ganaron justo con este avance (antes no, ahora sí)
function insigniasNuevas(antes, despues) {
  const previas = new Set(insignias(antes).filter(i => i.desbloqueada).map(i => i.id));
  return insignias(despues).filter(i => i.desbloqueada && !previas.has(i.id));
}

// Lo que el sitio pinta de cada reto: { veces, mejor, total, superados, perfectos, mejorPct }
function resumenPorReto(estado) {
  const e = normalizarEstado(estado);
  const out = {};
  for (const [id, r] of Object.entries(e.porReto)) {
    out[id] = { ...r, mejorPct: Math.round((r.mejor / (r.total || 1)) * 100) };
  }
  return out;
}

module.exports = {
  RETOS_VALIDOS, RETOS_BASE, RETOS_SIN_XP, MINIMO_APROBAR, XP_SUPERADO, XP_PERFECTO, TOPE_XP_PRACTICA,
  CAMINO_MODOS, TOTALES_CAMINO, PRIMER_CURSO_RETOS, progresoPrimerCurso, XP_CAMINO, XP_CAMINO_PERFECTO, XP_MAXIMO_RETOS, INSIGNIAS,
  estadoInicial, normalizarEstado, fechaMexico, validarResultado, aplicarResultado,
  validarCaminoResultado, aplicarCaminoResultado, insignias, insigniasNuevas, resumenPorReto
};
