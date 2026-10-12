'use strict';

// ══ LIBRO DE REGISTRO DE EJEMPLARES (reglas puras) ══
// Para miembros que manejan una UMA o un PIMVS: cada persona lleva SU inventario de ejemplares y una
// bitácora de eventos. De ahí se arma el inventario actual y el borrador del informe anual.
//
// Esta herramienta NO decide nada legal: solo ordena lo que la persona escribe. Aquí no hay plazos,
// categorías de riesgo ni valores de ninguna norma; si el sitio quiere recordar plazos, los pone él.
//
// Modelo (colecciones SOLO del servidor, una por persona):
//   registrosUma/{uid}/ejemplares/{id}  ->  el animal y cómo entró (alta o nacimiento, con su fecha)
//   registrosUma/{uid}/eventos/{id}     ->  lo que le pasa después: baja, muerte, traslado o nota
// El ESTADO del ejemplar no se guarda: se calcula con sus eventos (estadoEjemplar), así nunca queda
// desacomodado. Las fechas son 'AAAA-MM-DD' (día calendario, sin hora), tal como las escribe la persona.
//
// Los textos se guardan TAL CUAL (sin convertir < > & a entidades): quien los muestre debe ESCAPARLOS.

const MAX_EJEMPLARES = 500;
const MAX_EVENTOS = 5000;
const MAX_TEXTO = 300;
const MAX_NOTAS = 1000;
const ANIO_MINIMO = 2000;
const FECHA_MINIMA = '1900-01-01';

const TIPOS_INGRESO = Object.freeze(['alta', 'nacimiento']);
const TIPOS_SALIDA = Object.freeze(['baja', 'muerte', 'traslado']);
const TIPOS_EVENTO = Object.freeze(['baja', 'muerte', 'traslado', 'nota']);
const SEXOS = Object.freeze(['macho', 'hembra', 'indeterminado']);
const ESTADOS = Object.freeze(['activo', 'baja', 'muerte', 'traslado']);

// Los ids de ejemplares y eventos los crea el servidor: solo letras, números, guion y guion bajo.
// Se valida antes de armar cualquier ruta de documento (un id como "a/b" nunca llega a Firestore).
const ID_REGISTRO = /^[A-Za-z0-9_-]{8,64}$/;
const esIdRegistro = v => typeof v === 'string' && ID_REGISTRO.test(v);

// ── Fechas ──
// 'AAAA-MM-DD' real (rechaza 2026-02-30, 2026-13-01, "2026-1-5" y cualquier texto), desde 1900.
function fechaValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  if (a < 1900) return false;
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
// Como las dos son 'AAAA-MM-DD' válidas, comparar como texto es comparar fechas.
const noFutura = (fecha, hoy) => fechaValida(fecha) && fechaValida(hoy) && fecha <= hoy;

// ── Texto ──
// Caracteres de control, invisibles y de dirección de texto (salvo salto de línea)
const CONTROL = new RegExp('[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏ -‮⁦-⁩﻿]', 'g');

function limpiarTexto(valor, { saltos = false } = {}) {
  let t = String(valor).normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (saltos) t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  else t = t.replace(/\s+/g, ' ');
  return t.trim();
}

// Campo de texto. undefined/null/'' = vacío. Si viene otra cosa que texto, o es muy largo, es un error.
function leerTexto(valor, { max = MAX_TEXTO, etiqueta, requerido = false, saltos = false }) {
  if (valor === undefined || valor === null) {
    return requerido ? { error: `${etiqueta} es obligatorio` } : { valor: '' };
  }
  if (typeof valor !== 'string') return { error: `${etiqueta} no es válido` };
  const t = limpiarTexto(valor, { saltos });
  if (t.length > max) return { error: `${etiqueta} no puede pasar de ${max} caracteres` };
  if (requerido && t === '') return { error: `${etiqueta} es obligatorio` };
  return { valor: t };
}

// Sin tildes, en minúsculas y con espacios simples: para agrupar y buscar sin importar cómo se escribió
const plano = t => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const claveEspecie = nombreComun => plano(nombreComun);

const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ══════════════════════════════════════════════════════════════
// VALIDAR ENTRADAS
// ══════════════════════════════════════════════════════════════

// Campos del ejemplar que la persona puede escribir. Cualquier otro (uid, id, estado, creado...) se ignora.
const CAMPOS_EJEMPLAR = Object.freeze([
  ['nombreComun', 'La especie (nombre común)', { requerido: true }],
  ['nombreCientifico', 'El nombre científico', {}],
  ['nombre', 'El nombre o apodo', {}],
  ['marca', 'La marca de identificación', {}],
  ['origen', 'El origen', { requerido: true }],
  ['notas', 'Las notas', { max: MAX_NOTAS, saltos: true }]
]);

// Crear (parcial=false): especie, origen, tipo de ingreso y fecha de ingreso son obligatorios.
// Editar (parcial=true): solo se revisan los campos que vienen; los obligatorios no pueden quedar vacíos.
// Devuelve { ok:true, valor } o { ok:false, campo, error }.
function validarEjemplar(entrada, { hoy, parcial = false } = {}) {
  if (!esObjeto(entrada)) return { ok: false, campo: null, error: 'Faltan los datos del ejemplar' };
  const valor = {};
  const falla = (campo, error) => ({ ok: false, campo, error });
  const viene = c => entrada[c] !== undefined;

  for (const [campo, etiqueta, op] of CAMPOS_EJEMPLAR) {
    if (parcial && !viene(campo)) continue;
    // Al editar, mandar null o '' en un campo obligatorio es un error (no "no cambiar")
    const r = leerTexto(entrada[campo], { ...op, etiqueta });
    if (r.error) return falla(campo, r.error);
    valor[campo] = r.valor;
  }

  if (!parcial || viene('sexo')) {
    const crudo = entrada.sexo;
    if (crudo === undefined || crudo === null || crudo === '') {
      valor.sexo = 'indeterminado';
    } else {
      const s = typeof crudo === 'string' ? plano(crudo) : '';
      if (!SEXOS.includes(s)) return falla('sexo', 'El sexo debe ser macho, hembra o indeterminado');
      valor.sexo = s;
    }
  }

  if (!parcial || viene('tipoIngreso')) {
    const t = typeof entrada.tipoIngreso === 'string' ? plano(entrada.tipoIngreso) : '';
    if (!TIPOS_INGRESO.includes(t)) return falla('tipoIngreso', 'Indica si es un ingreso (alta) o un nacimiento');
    valor.tipoIngreso = t;
  }

  if (!parcial || viene('fechaIngreso')) {
    const f = entrada.fechaIngreso;
    if (!fechaValida(f)) return falla('fechaIngreso', 'La fecha de ingreso no es válida. Usa el formato AAAA-MM-DD (por ejemplo 2026-03-15)');
    if (hoy && !noFutura(f, hoy)) return falla('fechaIngreso', 'La fecha de ingreso no puede ser futura');
    valor.fechaIngreso = f;
  }

  return { ok: true, valor };
}

// Valida un evento nuevo sobre un ejemplar. `ejemplar` ({ fechaIngreso }) y `estado` (el actual) son opcionales
// para poder probar la forma sola; la ruta siempre los pasa.
// Devuelve { ok:true, valor } o { ok:false, campo, error, conflicto? } (conflicto = el estado no lo permite, 409).
function validarEvento(entrada, { hoy, ejemplar, estado } = {}) {
  if (!esObjeto(entrada)) return { ok: false, campo: null, error: 'Faltan los datos del evento' };
  const falla = (campo, error, extra) => ({ ok: false, campo, error, ...(extra || {}) });

  const tipo = typeof entrada.tipo === 'string' ? plano(entrada.tipo) : '';
  if (tipo === 'alta' || tipo === 'nacimiento') {
    return falla('tipo', 'Las altas y los nacimientos se registran creando un ejemplar nuevo, con su origen');
  }
  if (!TIPOS_EVENTO.includes(tipo)) return falla('tipo', 'El tipo de evento debe ser baja, muerte, traslado o nota');

  const fecha = entrada.fecha;
  if (!fechaValida(fecha)) return falla('fecha', 'La fecha no es válida. Usa el formato AAAA-MM-DD (por ejemplo 2026-03-15)');
  if (hoy && !noFutura(fecha, hoy)) return falla('fecha', 'La fecha del evento no puede ser futura');
  if (ejemplar && fechaValida(ejemplar.fechaIngreso) && fecha < ejemplar.fechaIngreso) {
    return falla('fecha', `La fecha no puede ser anterior al ingreso del ejemplar (${ejemplar.fechaIngreso})`);
  }

  if (TIPOS_SALIDA.includes(tipo) && estado && estado !== 'activo') {
    const dice = { baja: 'una baja', muerte: 'una muerte', traslado: 'un traslado' }[estado];
    return falla('tipo', `Este ejemplar ya tiene registrada ${dice}. Si fue un error, elimina ese evento primero`, { conflicto: true });
  }

  const valor = { tipo, fecha, causa: '', destino: '', notas: '' };
  const causa = leerTexto(entrada.causa, { etiqueta: 'La causa o motivo', requerido: tipo === 'baja' });
  if (causa.error) return falla('causa', causa.error);
  const destino = leerTexto(entrada.destino, { etiqueta: 'El destino', requerido: tipo === 'traslado' });
  if (destino.error) return falla('destino', destino.error);
  const notas = leerTexto(entrada.notas, { max: MAX_NOTAS, etiqueta: 'Las notas', saltos: true, requerido: tipo === 'nota' });
  if (notas.error) return falla('notas', notas.error);

  // Cada tipo guarda solo lo que le corresponde (nada de destino en una muerte o causa en una nota)
  if (tipo === 'baja') { valor.causa = causa.valor; valor.destino = destino.valor; }
  if (tipo === 'muerte') { valor.causa = causa.valor; }
  if (tipo === 'traslado') { valor.destino = destino.valor; valor.causa = causa.valor; }
  valor.notas = notas.valor;
  return { ok: true, valor };
}

// Año del informe: 4 dígitos, de 2000 al año de hoy.
function validarAnio(valor, hoy) {
  const anioHoy = Number(String(hoy).slice(0, 4));
  if (typeof valor !== 'string' || !/^\d{4}$/.test(valor.trim())) {
    return { ok: false, error: `Escribe el año con cuatro dígitos, entre ${ANIO_MINIMO} y ${anioHoy}` };
  }
  const anio = Number(valor.trim());
  if (anio < ANIO_MINIMO || anio > anioHoy) {
    return { ok: false, error: `El año debe estar entre ${ANIO_MINIMO} y ${anioHoy}` };
  }
  return { ok: true, anio };
}

// ══════════════════════════════════════════════════════════════
// DOCUMENTOS GUARDADOS -> LO QUE VE EL SITIO
// ══════════════════════════════════════════════════════════════
const t = v => (typeof v === 'string' ? v : '');

function ejemplarPublico(id, doc) {
  const d = esObjeto(doc) ? doc : {};
  return {
    id,
    nombreComun: t(d.nombreComun), nombreCientifico: t(d.nombreCientifico), nombre: t(d.nombre), marca: t(d.marca),
    sexo: SEXOS.includes(d.sexo) ? d.sexo : 'indeterminado',
    origen: t(d.origen),
    tipoIngreso: TIPOS_INGRESO.includes(d.tipoIngreso) ? d.tipoIngreso : 'alta',
    fechaIngreso: fechaValida(d.fechaIngreso) ? d.fechaIngreso : '',
    notas: t(d.notas), creado: t(d.creado), actualizado: t(d.actualizado)
  };
}

function eventoPublico(id, doc) {
  const d = esObjeto(doc) ? doc : {};
  return {
    id, ejemplarId: t(d.ejemplarId),
    tipo: TIPOS_EVENTO.includes(d.tipo) ? d.tipo : 'nota',
    fecha: fechaValida(d.fecha) ? d.fecha : '',
    causa: t(d.causa), destino: t(d.destino), notas: t(d.notas), creado: t(d.creado)
  };
}

// ══════════════════════════════════════════════════════════════
// ESTADO, INVENTARIO E INFORME
// ══════════════════════════════════════════════════════════════
const porFechaYCreacion = (a, b) => {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  if (a.creado !== b.creado) return a.creado < b.creado ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// Estado del ejemplar a partir de SUS eventos: el último evento de salida (baja, muerte o traslado) manda.
// Sin salida está 'activo'. Devuelve { estado, fechaSalida, salida } ('salida' es el evento o null).
function estadoEjemplar(ejemplar, eventos) {
  const propios = (Array.isArray(eventos) ? eventos : [])
    .filter(e => e && e.ejemplarId === ejemplar.id && TIPOS_SALIDA.includes(e.tipo) && fechaValida(e.fecha))
    .sort(porFechaYCreacion);
  const salida = propios.length ? propios[propios.length - 1] : null;
  return salida
    ? { estado: salida.tipo, fechaSalida: salida.fecha, salida }
    : { estado: 'activo', fechaSalida: null, salida: null };
}

// Ejemplar tal como lo ve el sitio: sus datos + estado + fecha de salida
function vistaEjemplar(ejemplar, eventos) {
  const e = estadoEjemplar(ejemplar, eventos);
  return { ...ejemplar, estado: e.estado, fechaSalida: e.fechaSalida };
}

const esp = (porClave, ej) => {
  const clave = claveEspecie(ej.nombreComun) || '(sin nombre)';
  let f = porClave.get(clave);
  if (!f) {
    f = { clave, especie: ej.nombreComun || '(sin nombre)', nombreCientifico: '' };
    porClave.set(clave, f);
  }
  if (!f.nombreCientifico && ej.nombreCientifico) f.nombreCientifico = ej.nombreCientifico;
  return f;
};
const porNombre = (a, b) => a.especie.localeCompare(b.especie, 'es') || (a.clave < b.clave ? -1 : 1);

// Inventario actual por especie: cuántos hay hoy (por sexo) y cuántos ya salieron, y totales.
function resumenInventario(ejemplares, eventos) {
  const filas = new Map();
  const total = { registrados: 0, activos: 0, machos: 0, hembras: 0, indeterminados: 0, bajas: 0, muertes: 0, traslados: 0 };
  for (const ej of ejemplares) {
    const f = esp(filas, ej);
    for (const k of ['registrados', 'activos', 'machos', 'hembras', 'indeterminados', 'bajas', 'muertes', 'traslados']) if (f[k] === undefined) f[k] = 0;
    const { estado } = estadoEjemplar(ej, eventos);
    f.registrados++; total.registrados++;
    if (estado === 'activo') {
      f.activos++; total.activos++;
      const clave = ej.sexo === 'macho' ? 'machos' : ej.sexo === 'hembra' ? 'hembras' : 'indeterminados';
      f[clave]++; total[clave]++;
    } else {
      const clave = estado === 'baja' ? 'bajas' : estado === 'muerte' ? 'muertes' : 'traslados';
      f[clave]++; total[clave]++;
    }
  }
  return { ...total, porEspecie: [...filas.values()].sort(porNombre) };
}

const ORDEN_MOVIMIENTO = { alta: 0, nacimiento: 1, baja: 2, traslado: 3, muerte: 4 };

// Informe de un año calendario: existencias al 1 de enero, altas, nacimientos, bajas, muertes, traslados y
// existencias al 31 de diciembre, por especie y en total. Una persona que entra y sale el mismo año cuenta en
// ambos movimientos y en ninguna existencia, así que siempre: inicio + altas + nacimientos - salidas = fin.
// Si el año todavía no termina, "existencias al 31 de diciembre" es lo que hay a la fecha de hoy.
function informeAnual(ejemplares, eventos, anio, { hoy } = {}) {
  const desde = `${anio}-01-01`;
  const hasta = `${anio}-12-31`;
  const filas = new Map();
  const CONTADORES = ['existenciasInicio', 'altas', 'nacimientos', 'bajas', 'muertes', 'traslados', 'existenciasFin'];
  const total = Object.fromEntries(CONTADORES.map(k => [k, 0]));
  const movimientos = [];
  const enAnio = f => typeof f === 'string' && f >= desde && f <= hasta;

  for (const ej of ejemplares) {
    if (!fechaValida(ej.fechaIngreso)) continue; // un documento dañado no cuenta
    const f = esp(filas, ej);
    for (const k of CONTADORES) if (f[k] === undefined) f[k] = 0;
    const { estado, fechaSalida, salida } = estadoEjemplar(ej, eventos);
    const cuenta = (campo) => { f[campo]++; total[campo]++; };

    if (ej.fechaIngreso < desde && (fechaSalida === null || fechaSalida >= desde)) cuenta('existenciasInicio');
    if (enAnio(ej.fechaIngreso)) {
      cuenta(ej.tipoIngreso === 'nacimiento' ? 'nacimientos' : 'altas');
      movimientos.push({
        fecha: ej.fechaIngreso, tipo: ej.tipoIngreso === 'nacimiento' ? 'nacimiento' : 'alta', ejemplarId: ej.id,
        especie: ej.nombreComun, nombreCientifico: ej.nombreCientifico, marca: ej.marca, sexo: ej.sexo,
        origen: ej.origen, causa: '', destino: '', _creado: ej.creado, _id: ej.id
      });
    }
    if (salida && enAnio(fechaSalida)) {
      cuenta(estado === 'baja' ? 'bajas' : estado === 'muerte' ? 'muertes' : 'traslados');
      movimientos.push({
        fecha: fechaSalida, tipo: estado, ejemplarId: ej.id,
        especie: ej.nombreComun, nombreCientifico: ej.nombreCientifico, marca: ej.marca, sexo: ej.sexo,
        origen: '', causa: salida.causa || '', destino: salida.destino || '', _creado: salida.creado, _id: salida.id
      });
    }
    if (ej.fechaIngreso <= hasta && (fechaSalida === null || fechaSalida > hasta)) cuenta('existenciasFin');
  }

  movimientos.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0)
    || (ORDEN_MOVIMIENTO[a.tipo] - ORDEN_MOVIMIENTO[b.tipo])
    || (a._creado < b._creado ? -1 : a._creado > b._creado ? 1 : 0)
    || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  for (const m of movimientos) { delete m._creado; delete m._id; }

  const porEspecie = [...filas.values()]
    // Una especie que no tuvo nada en el año (ni existencias ni movimientos) no aparece en el informe
    .filter(f => CONTADORES.some(k => f[k] > 0))
    .sort(porNombre);

  return {
    anio, desde, hasta,
    enCurso: Boolean(hoy) && hoy <= hasta,
    corte: hoy && hoy < hasta ? hoy : hasta,
    porEspecie, total, movimientos
  };
}

module.exports = {
  MAX_EJEMPLARES, MAX_EVENTOS, MAX_TEXTO, MAX_NOTAS, ANIO_MINIMO, FECHA_MINIMA,
  TIPOS_INGRESO, TIPOS_EVENTO, TIPOS_SALIDA, SEXOS, ESTADOS, ID_REGISTRO,
  esIdRegistro, fechaValida, noFutura, limpiarTexto, claveEspecie,
  validarEjemplar, validarEvento, validarAnio,
  ejemplarPublico, eventoPublico,
  estadoEjemplar, vistaEjemplar, resumenInventario, informeAnual
};
