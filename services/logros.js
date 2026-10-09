'use strict';

// ══ LOGROS, XP Y NIVELES (calculados en el SERVIDOR) ══
// El nivel decide premios que abren contenido de pago, así que no depende de datos guardados
// solo en el navegador. El nivel NO se guarda: se recalcula en cada consulta.
//
// XP total = logros (l1..l26) + insignias de retos (r1..r10) + XP de retos + XP por referidos
//          + XP por cursos terminados (fórmula fija, ver xpDeCurso) + premio de bienvenida (+100, una vez).
// La tabla de abajo es la fuente única: el README la documenta y una prueba verifica el balance.

const retos = require('./retos');
const referidos = require('./referidos');

const NIVELES = [
  { id: 1, nombre: 'Aprendiz', desde: 0, hasta: 300 },
  { id: 2, nombre: 'Técnico', desde: 300, hasta: 1200 },
  { id: 3, nombre: 'Profesional', desde: 1200, hasta: 2500 },
  { id: 4, nombre: 'Líder', desde: 2500, hasta: 4500 },
  { id: 5, nombre: 'Maestro', desde: 4500, hasta: 99999 }
];

const CATEGORIAS = ['Inicio', 'Cursos', 'Constancia', 'Comunidad', 'Retos', 'Maestría'];
const TOTAL_CURSOS = 15;
const XP_BIENVENIDA = 100;   // premio único para cuentas nuevas (POST /api/premios/bienvenida)

// d = { esVIP, completados, areas, diasActivos, racha, tarjetaDir, foroPosts, foroRespuestas,
//       foroLikes, invitadosValidos }
const LOGROS = [
  // Inicio
  { id: 'l1', nombre: 'Bienvenido a la manada', descripcion: 'Tu membresía del Club VIP está vigente', categoria: 'Inicio', xp: 20, cumple: d => d.esVIP },
  { id: 'l2', nombre: 'Primeros pasos', descripcion: 'Entra al club en 3 días distintos', categoria: 'Inicio', xp: 30, cumple: d => d.diasActivos >= 3 },
  { id: 'l3', nombre: 'Tarjeta de presentación', descripcion: 'Crea tu tarjeta en el directorio de la comunidad', categoria: 'Inicio', xp: 60, cumple: d => d.tarjetaDir },
  // Cursos (cada uno pide el certificado de un curso real del club)
  { id: 'l4', nombre: 'Primer curso', descripcion: 'Termina tu primer curso y obtén tu certificado', categoria: 'Cursos', xp: 60, cumple: d => d.completados >= 1 },
  { id: 'l5', nombre: 'Curiosidad en marcha', descripcion: 'Termina 2 cursos', categoria: 'Cursos', xp: 80, cumple: d => d.completados >= 2 },
  { id: 'l6', nombre: 'Estudiante constante', descripcion: 'Termina 4 cursos', categoria: 'Cursos', xp: 140, cumple: d => d.completados >= 4 },
  { id: 'l7', nombre: 'Biblioteca viva', descripcion: 'Termina 6 cursos', categoria: 'Cursos', xp: 200, cumple: d => d.completados >= 6 },
  { id: 'l8', nombre: 'Mirada amplia', descripcion: 'Termina cursos de 2 áreas distintas', categoria: 'Cursos', xp: 50, cumple: d => d.areas >= 2 },
  // Constancia (días en que entras al club, hora de México)
  { id: 'l9', nombre: 'Rastro fresco', descripcion: 'Entra 3 días seguidos', categoria: 'Constancia', xp: 30, cumple: d => d.racha >= 3 },
  { id: 'l10', nombre: 'Semana de campo', descripcion: 'Entra 7 días seguidos', categoria: 'Constancia', xp: 70, cumple: d => d.racha >= 7 },
  { id: 'l11', nombre: 'Quincena firme', descripcion: 'Entra 14 días seguidos', categoria: 'Constancia', xp: 150, cumple: d => d.racha >= 14 },
  { id: 'l12', nombre: 'Mes de expedición', descripcion: 'Entra 30 días seguidos', categoria: 'Constancia', xp: 250, cumple: d => d.racha >= 30 },
  { id: 'l13', nombre: 'Temporada completa', descripcion: 'Entra 60 días seguidos', categoria: 'Constancia', xp: 350, cumple: d => d.racha >= 60 },
  { id: 'l14', nombre: 'Treinta días en la manada', descripcion: 'Suma 30 días distintos dentro del club', categoria: 'Constancia', xp: 150, cumple: d => d.diasActivos >= 30 },
  // Comunidad (foro, referidos)
  { id: 'l15', nombre: 'Primera discusión', descripcion: 'Publica tu primera discusión en el foro', categoria: 'Comunidad', xp: 50, cumple: d => d.foroPosts >= 1 },
  { id: 'l16', nombre: 'Voz propia', descripcion: 'Publica 3 discusiones en el foro', categoria: 'Comunidad', xp: 100, cumple: d => d.foroPosts >= 3 },
  { id: 'l17', nombre: 'Líder de opinión', descripcion: 'Publica 6 discusiones en el foro', categoria: 'Comunidad', xp: 150, cumple: d => d.foroPosts >= 6 },
  { id: 'l18', nombre: 'Conversación viva', descripcion: 'Tus discusiones reciben 5 respuestas', categoria: 'Comunidad', xp: 100, cumple: d => d.foroRespuestas >= 5 },
  { id: 'l19', nombre: 'Querido por la manada', descripcion: 'Tus discusiones reciben 10 me gusta', categoria: 'Comunidad', xp: 100, cumple: d => d.foroLikes >= 10 },
  { id: 'l20', nombre: 'Referente del foro', descripcion: 'Tus discusiones reciben 25 me gusta', categoria: 'Comunidad', xp: 150, cumple: d => d.foroLikes >= 25 },
  { id: 'l21', nombre: 'Embajador', descripcion: 'Invita a 1 persona que confirme su cuenta', categoria: 'Comunidad', xp: 60, cumple: d => d.invitadosValidos >= 1 },
  { id: 'l22', nombre: 'La manada crece', descripcion: 'Invita a 4 personas que confirmen su cuenta', categoria: 'Comunidad', xp: 150, cumple: d => d.invitadosValidos >= 4 },
  // Maestría (los hitos grandes de los cursos)
  { id: 'l23', nombre: 'Medio camino', descripcion: 'Termina 8 cursos', categoria: 'Maestría', xp: 260, cumple: d => d.completados >= 8 },
  { id: 'l24', nombre: 'Experto en fauna', descripcion: 'Termina 12 cursos', categoria: 'Maestría', xp: 380, cumple: d => d.completados >= 12 },
  { id: 'l25', nombre: 'Naturalista completo', descripcion: 'Termina cursos de 4 áreas distintas', categoria: 'Maestría', xp: 150, cumple: d => d.areas >= 4 },
  { id: 'l26', nombre: 'Maestro de la fauna', descripcion: 'Termina los ' + TOTAL_CURSOS + ' cursos del club', categoria: 'Maestría', xp: 500, cumple: d => d.completados >= TOTAL_CURSOS }
];

function fechaMexico(ahora = new Date()) { return retos.fechaMexico(ahora); }

// ── XP por cursos terminados ──
// El n-ésimo curso terminado (ordenados por fecha del certificado) paga: 20, 30, 40 ... 100 y el décimo
// 180; luego el ciclo se repite (11 -> 20 ... 19 -> 100, 20 -> 180...). Cada curso paga UNA sola vez.
function xpDeCurso(n) {
  const k = Math.floor(Number(n));
  if (!(k >= 1)) return 0;
  return k % 10 === 0 ? 180 : 10 + 10 * (k % 10);
}

const aMilis = f => {
  if (f && typeof f.toMillis === 'function') return f.toMillis();
  if (f && typeof f.toDate === 'function') return f.toDate().getTime();
  if (f instanceof Date) return f.getTime();
  if (typeof f === 'number') return f;
  const t = typeof f === 'string' ? Date.parse(f) : NaN;
  return Number.isNaN(t) ? null : t;
};

// certificados: [{ courseId, folio, fecha }] (fecha: texto ISO, Date, Timestamp o número) · existe(courseId) -> bool
// Solo cuentan cursos DISTINTOS que existan de verdad; de cada curso vale su certificado más antiguo
// (con la misma fecha, el de folio menor). Se ordenan por esa fecha y, en empate, por folio.
// Devuelve [{ courseId, n, xp, fecha }] en orden cronológico (fecha: texto ISO o null si el certificado no trae una válida).
function cursosTerminados(certificados, existe) {
  const clave = c => [c.t === null ? Infinity : c.t, c.folio];
  const antes = (a, b) => { const [ta, fa] = clave(a); const [tb, fb] = clave(b); return ta !== tb ? (ta < tb ? -1 : 1) : (fa < fb ? -1 : fa > fb ? 1 : 0); };
  const porCurso = new Map();
  for (const c of Array.isArray(certificados) ? certificados : []) {
    const courseId = String((c && c.courseId) || '');
    if (!courseId || !existe(courseId)) continue;
    const reg = { courseId, folio: String((c && c.folio) || ''), t: aMilis(c.fecha) };
    const previo = porCurso.get(courseId);
    if (!previo || antes(reg, previo) < 0) porCurso.set(courseId, reg);
  }
  return [...porCurso.values()].sort(antes).map((c, i) => ({
    courseId: c.courseId, n: i + 1, xp: xpDeCurso(i + 1), fecha: c.t === null ? null : new Date(c.t).toISOString()
  }));
}


// Racha = días consecutivos que terminan hoy (hora de México). El servidor registra el día de hoy
// antes de calcularla, así que quien entra hoy ya cuenta hoy.
function calcularRacha(dias, ahora = new Date()) {
  const set = new Set(dias);
  let racha = 0;
  const d = new Date(fechaMexico(ahora) + 'T12:00:00Z');
  while (set.has(d.toISOString().slice(0, 10))) { racha++; d.setUTCDate(d.getUTCDate() - 1); }
  return racha;
}

// Los 5 niveles tal como los pinta el sitio (así no los copia)
function listaNiveles() { return NIVELES.map(n => ({ id: n.id, nombre: n.nombre, desde: n.desde, hasta: n.hasta })); }

function nivelPorXp(xp) {
  return NIVELES.find(n => xp >= n.desde && xp < n.hasta) || NIVELES[NIVELES.length - 1];
}

// Lo que el sitio pinta del nivel: { id, nombre, xp, desde, hasta, faltan }
function infoNivel(xp) {
  const n = nivelPorXp(xp);
  const ultimo = n.id === NIVELES[NIVELES.length - 1].id;
  return { id: n.id, nombre: n.nombre, xp, desde: n.desde, hasta: n.hasta, faltan: ultimo ? 0 : Math.max(0, n.hasta - xp) };
}

// Vista previa (sin membresía): todos los logros, sin XP ni "ganado"
function logrosVistaPrevia() {
  const base = LOGROS.map(l => ({ id: l.id, nombre: l.nombre, descripcion: l.descripcion, categoria: l.categoria }));
  const ins = retos.INSIGNIAS.map(i => ({ id: i.id, nombre: i.nombre, descripcion: i.desc, categoria: 'Retos' }));
  return [...base, ...ins];
}

// datos: ver LOGROS (+ cursosLista: resultado de cursosTerminados) · estadoRetos: estado guardado de retos (o null) · xpReferidos: número
function evaluar(datos, estadoRetos, xpReferidos = 0, ahora = new Date()) {
  const dias = Array.isArray(datos.dias) ? datos.dias : [];
  const d = { ...datos, dias, racha: calcularRacha(dias, ahora), diasActivos: dias.length };
  const ganadosL = LOGROS.filter(l => l.cumple(d));
  const insigniasGanadas = retos.insignias(estadoRetos).filter(i => i.desbloqueada);
  const estado = retos.normalizarEstado(estadoRetos);
  const xpLogros = ganadosL.reduce((t, l) => t + l.xp, 0);
  const xpRetos = insigniasGanadas.reduce((t, i) => t + i.xp, 0) + estado.xp;
  const xpRef = Math.max(0, Number(xpReferidos) || 0);
  const lista = Array.isArray(datos.cursosLista) ? datos.cursosLista : [];
  const xpCursos = lista.reduce((t, c) => t + c.xp, 0);
  const xpBienvenida = datos.bienvenida === true ? XP_BIENVENIDA : 0;
  const total = xpLogros + xpRetos + xpRef + xpCursos + xpBienvenida;
  const ganados = new Set([...ganadosL.map(l => l.id), ...insigniasGanadas.map(i => i.id)]);
  const logros = [
    ...LOGROS.map(l => ({ id: l.id, nombre: l.nombre, descripcion: l.descripcion, categoria: l.categoria, xp: l.xp, ganado: ganados.has(l.id) })),
    ...retos.INSIGNIAS.map(i => ({ id: i.id, nombre: i.nombre, descripcion: i.desc, categoria: 'Retos', xp: i.xp, ganado: ganados.has(i.id) }))
  ];
  return {
    xp: { total, logros: xpLogros, retos: xpRetos, referidos: xpRef, cursos: xpCursos, bienvenida: xpBienvenida },
    nivel: infoNivel(total),
    cursos: { terminados: lista.length, lista },
    logros,
    racha: d.racha,
    diasActivos: dias.length
  };
}

// XP máximo que se puede juntar en toda la vida de la cuenta (para el balance de niveles y el README).
function xpMaximo() {
  const m = {
    logros: LOGROS.reduce((t, l) => t + l.xp, 0),
    insignias: retos.INSIGNIAS.reduce((t, i) => t + i.xp, 0),
    retos: retos.XP_MAXIMO_RETOS,
    referidos: referidos.XP_MAXIMO_REFERIDOS,
    cursos: Array.from({ length: TOTAL_CURSOS }, (_, i) => xpDeCurso(i + 1)).reduce((t, x) => t + x, 0),
    bienvenida: XP_BIENVENIDA
  };
  m.total = m.logros + m.insignias + m.retos + m.referidos + m.cursos + m.bienvenida;
  return m;
}

module.exports = {
  NIVELES, CATEGORIAS, LOGROS, TOTAL_CURSOS, XP_BIENVENIDA,
  fechaMexico, xpDeCurso, cursosTerminados, calcularRacha, nivelPorXp, infoNivel, listaNiveles, logrosVistaPrevia, evaluar, xpMaximo
};
