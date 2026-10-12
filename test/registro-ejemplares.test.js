'use strict';

// Libro de registro de ejemplares: reglas puras (validar, estado por eventos, inventario e informe anual).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../services/registro-ejemplares');

const HOY = '2026-10-12';
const ej = (id, extra = {}) => ({
  id, nombreComun: 'Boa', nombreCientifico: 'Boa imperator', nombre: '', marca: '', sexo: 'indeterminado', origen: 'Criadero',
  tipoIngreso: 'alta', fechaIngreso: '2023-05-10', notas: '', creado: `2023-05-10T10:00:0${id.length % 10}.000Z`, actualizado: '', ...extra
});
const ev = (id, ejemplarId, tipo, fecha, extra = {}) => ({
  id, ejemplarId, tipo, fecha, causa: '', destino: '', notas: '', creado: `${fecha}T12:00:00.000Z`, ...extra
});

// ── Fechas ──
test('fechaValida: solo AAAA-MM-DD reales', () => {
  for (const ok of ['2026-02-28', '2024-02-29', '1900-01-01', '2026-12-31']) assert.equal(R.fechaValida(ok), true, ok);
  for (const mal of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '26-01-01', '2026/01/01', '2026-01-01T00:00:00Z',
    '1899-12-31', '', ' 2026-01-01', null, undefined, 20260101, {}, ['2026-01-01']]) {
    assert.equal(R.fechaValida(mal), false, String(mal));
  }
});

test('noFutura: hoy sí, mañana no', () => {
  assert.equal(R.noFutura('2026-10-12', HOY), true);
  assert.equal(R.noFutura('2026-10-11', HOY), true);
  assert.equal(R.noFutura('2026-10-13', HOY), false);
  assert.equal(R.noFutura('2027-01-01', HOY), false);
});

test('ids: solo letras, números, guion y guion bajo; nunca separadores', () => {
  for (const ok of ['abcdef012345', 'sal_abcdef012345', 'A-b_C-1234']) assert.equal(R.esIdRegistro(ok), true, ok);
  for (const mal of ['a/b/cdefgh', '../x', 'corto', 'a'.repeat(65), 'con espacio', 'ñandú1234', '', null, 12345678, 'abc%2fdef12']) {
    assert.equal(R.esIdRegistro(mal), false, String(mal));
  }
});

// ── validarEjemplar ──
const base = (extra = {}) => ({ nombreComun: 'Boa constrictor', origen: 'Criadero', tipoIngreso: 'alta', fechaIngreso: '2026-03-15', ...extra });

test('validarEjemplar: lo mínimo basta y el sexo queda indeterminado', () => {
  const r = R.validarEjemplar(base(), { hoy: HOY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.valor, {
    nombreComun: 'Boa constrictor', nombreCientifico: '', nombre: '', marca: '', origen: 'Criadero', notas: '',
    sexo: 'indeterminado', tipoIngreso: 'alta', fechaIngreso: '2026-03-15'
  });
});

test('validarEjemplar: guarda solo los campos conocidos (uid, id, estado y demás se ignoran)', () => {
  const r = R.validarEjemplar(base({ uid: 'otra-persona', id: 'x', estado: 'muerte', creado: 'x', nada: 1, __proto__: { admin: true } }), { hoy: HOY });
  assert.equal(r.ok, true);
  for (const k of ['uid', 'id', 'estado', 'creado', 'nada', 'admin']) assert.equal(k in r.valor, false, k);
});

test('validarEjemplar: obligatorios, con mensaje y campo', () => {
  const casos = [
    [{ nombreComun: '' }, 'nombreComun'], [{ nombreComun: '   ' }, 'nombreComun'], [{ nombreComun: undefined }, 'nombreComun'],
    [{ origen: '' }, 'origen'], [{ origen: undefined }, 'origen'],
    [{ tipoIngreso: 'compra' }, 'tipoIngreso'], [{ tipoIngreso: undefined }, 'tipoIngreso'],
    [{ fechaIngreso: '2026-02-30' }, 'fechaIngreso'], [{ fechaIngreso: undefined }, 'fechaIngreso'], [{ fechaIngreso: '2026-10-13' }, 'fechaIngreso'],
    [{ sexo: 'x' }, 'sexo'], [{ sexo: 5 }, 'sexo']
  ];
  for (const [extra, campo] of casos) {
    const r = R.validarEjemplar(base(extra), { hoy: HOY });
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.campo, campo, JSON.stringify(extra));
    assert.ok(r.error && /[a-záéíóú]/i.test(r.error));
  }
  assert.equal(R.validarEjemplar(null, { hoy: HOY }).ok, false);
  assert.equal(R.validarEjemplar([], { hoy: HOY }).ok, false);
  assert.equal(R.validarEjemplar('texto', { hoy: HOY }).ok, false);
});

test('validarEjemplar: límites de largo (300 texto, 1000 notas) y tipos', () => {
  assert.equal(R.validarEjemplar(base({ nombreComun: 'a'.repeat(300) }), { hoy: HOY }).ok, true);
  assert.equal(R.validarEjemplar(base({ nombreComun: 'a'.repeat(301) }), { hoy: HOY }).ok, false);
  for (const campo of ['nombreCientifico', 'nombre', 'marca', 'origen']) {
    assert.equal(R.validarEjemplar(base({ [campo]: 'b'.repeat(300) }), { hoy: HOY }).ok, true, campo);
    const r = R.validarEjemplar(base({ [campo]: 'b'.repeat(301) }), { hoy: HOY });
    assert.equal(r.ok, false, campo);
    assert.equal(r.campo, campo);
  }
  assert.equal(R.validarEjemplar(base({ notas: 'n'.repeat(1000) }), { hoy: HOY }).ok, true);
  assert.equal(R.validarEjemplar(base({ notas: 'n'.repeat(1001) }), { hoy: HOY }).ok, false);
  for (const malo of [5, true, {}, ['a']]) assert.equal(R.validarEjemplar(base({ marca: malo }), { hoy: HOY }).ok, false, JSON.stringify(malo));
});

test('validarEjemplar: limpia espacios y caracteres de control; guarda el texto sin convertirlo a HTML', () => {
  const r = R.validarEjemplar(base({ nombreComun: '  Boa \n  constrictor\u0000​ ', marca: "<b>A-1</b> & 'x'", notas: 'línea 1\r\n\r\n\r\n\r\nlínea 2\u0007' }), { hoy: HOY });
  assert.equal(r.ok, true);
  assert.equal(r.valor.nombreComun, 'Boa constrictor');
  assert.equal(r.valor.marca, "<b>A-1</b> & 'x'");
  assert.equal(r.valor.notas, 'línea 1\n\nlínea 2');
  assert.equal(R.validarEjemplar(base({ nombreComun: '\u0000​ ' }), { hoy: HOY }).ok, false);
});

test('validarEjemplar: sexo acepta mayúsculas y vacío', () => {
  assert.equal(R.validarEjemplar(base({ sexo: 'Hembra' }), { hoy: HOY }).valor.sexo, 'hembra');
  assert.equal(R.validarEjemplar(base({ sexo: ' MACHO ' }), { hoy: HOY }).valor.sexo, 'macho');
  assert.equal(R.validarEjemplar(base({ sexo: '' }), { hoy: HOY }).valor.sexo, 'indeterminado');
  assert.equal(R.validarEjemplar(base({ sexo: null }), { hoy: HOY }).valor.sexo, 'indeterminado');
});

test('validarEjemplar parcial: solo valida lo que viene', () => {
  const r = R.validarEjemplar({ marca: 'ARETE-9' }, { hoy: HOY, parcial: true });
  assert.deepEqual(r, { ok: true, valor: { marca: 'ARETE-9' } });
  assert.deepEqual(R.validarEjemplar({}, { hoy: HOY, parcial: true }), { ok: true, valor: {} });
  assert.deepEqual(R.validarEjemplar({ uid: 'otro', estado: 'muerte' }, { hoy: HOY, parcial: true }), { ok: true, valor: {} });
  assert.equal(R.validarEjemplar({ nombreComun: '' }, { hoy: HOY, parcial: true }).ok, false);
  assert.equal(R.validarEjemplar({ nombreComun: null }, { hoy: HOY, parcial: true }).ok, false);
  assert.equal(R.validarEjemplar({ origen: ' ' }, { hoy: HOY, parcial: true }).ok, false);
  assert.equal(R.validarEjemplar({ fechaIngreso: '2027-01-01' }, { hoy: HOY, parcial: true }).ok, false);
  assert.equal(R.validarEjemplar({ marca: '' }, { hoy: HOY, parcial: true }).valor.marca, '');
  assert.equal(R.validarEjemplar({ sexo: 'hembra', tipoIngreso: 'nacimiento' }, { hoy: HOY, parcial: true }).valor.tipoIngreso, 'nacimiento');
});

// ── validarEvento ──
const EJ = { id: 'ejemplar-0001', fechaIngreso: '2026-01-10' };
const val = (e, extra = {}) => R.validarEvento(e, { hoy: HOY, ejemplar: EJ, estado: 'activo', ...extra });

test('validarEvento: baja pide causa; traslado pide destino; nota pide texto; muerte no pide nada más', () => {
  assert.equal(val({ tipo: 'baja', fecha: '2026-05-01' }).ok, false);
  assert.equal(val({ tipo: 'baja', fecha: '2026-05-01' }).campo, 'causa');
  assert.deepEqual(val({ tipo: 'baja', fecha: '2026-05-01', causa: 'Donación', destino: 'Zoológico X', notas: 'ok' }).valor,
    { tipo: 'baja', fecha: '2026-05-01', causa: 'Donación', destino: 'Zoológico X', notas: 'ok' });
  assert.equal(val({ tipo: 'traslado', fecha: '2026-05-01' }).campo, 'destino');
  assert.deepEqual(val({ tipo: 'traslado', fecha: '2026-05-01', destino: 'UMA Norte', causa: 'Reproducción' }).valor,
    { tipo: 'traslado', fecha: '2026-05-01', causa: 'Reproducción', destino: 'UMA Norte', notas: '' });
  assert.equal(val({ tipo: 'nota', fecha: '2026-05-01' }).campo, 'notas');
  assert.equal(val({ tipo: 'nota', fecha: '2026-05-01', notas: '   ' }).ok, false);
  assert.deepEqual(val({ tipo: 'nota', fecha: '2026-05-01', notas: 'Revisión' }).valor,
    { tipo: 'nota', fecha: '2026-05-01', causa: '', destino: '', notas: 'Revisión' });
  assert.deepEqual(val({ tipo: 'muerte', fecha: '2026-05-01' }).valor,
    { tipo: 'muerte', fecha: '2026-05-01', causa: '', destino: '', notas: '' });
});

test('validarEvento: cada tipo guarda solo lo suyo', () => {
  const m = val({ tipo: 'muerte', fecha: '2026-05-01', causa: 'Neumonía', destino: 'No aplica' }).valor;
  assert.equal(m.destino, '');
  assert.equal(m.causa, 'Neumonía');
  const n = val({ tipo: 'nota', fecha: '2026-05-01', notas: 'x', causa: 'y', destino: 'z' }).valor;
  assert.equal(n.causa, ''); assert.equal(n.destino, '');
});

test('validarEvento: nacimientos y altas se crean como ejemplar nuevo; tipos raros no pasan', () => {
  for (const tipo of ['nacimiento', 'alta']) {
    const r = val({ tipo, fecha: '2026-05-01' });
    assert.equal(r.ok, false);
    assert.match(r.error, /ejemplar nuevo/);
  }
  for (const tipo of ['fuga', '', null, undefined, 3, {}, 'BAJA ']) {
    const r = val({ tipo, fecha: '2026-05-01', causa: 'x' });
    // 'BAJA ' se acepta porque se normaliza; lo demás no
    assert.equal(r.ok, tipo === 'BAJA ', String(tipo));
  }
});

test('validarEvento: fecha válida, no futura y no anterior al ingreso', () => {
  for (const f of ['2026-02-30', '', undefined, '2026-5-1', 20260501]) assert.equal(val({ tipo: 'nota', fecha: f, notas: 'x' }).campo, 'fecha', String(f));
  assert.equal(val({ tipo: 'nota', fecha: HOY, notas: 'x' }).ok, true);
  assert.equal(val({ tipo: 'nota', fecha: '2026-10-13', notas: 'x' }).ok, false);
  assert.equal(val({ tipo: 'nota', fecha: '2026-01-10', notas: 'x' }).ok, true, 'el mismo día del ingreso');
  const antes = val({ tipo: 'nota', fecha: '2026-01-09', notas: 'x' });
  assert.equal(antes.ok, false);
  assert.match(antes.error, /ingreso/);
});

test('validarEvento: largos 300 / 1000', () => {
  assert.equal(val({ tipo: 'baja', fecha: '2026-05-01', causa: 'c'.repeat(300) }).ok, true);
  assert.equal(val({ tipo: 'baja', fecha: '2026-05-01', causa: 'c'.repeat(301) }).ok, false);
  assert.equal(val({ tipo: 'traslado', fecha: '2026-05-01', destino: 'd'.repeat(301) }).ok, false);
  assert.equal(val({ tipo: 'nota', fecha: '2026-05-01', notas: 'n'.repeat(1000) }).ok, true);
  assert.equal(val({ tipo: 'nota', fecha: '2026-05-01', notas: 'n'.repeat(1001) }).ok, false);
});

test('validarEvento: una segunda salida es un conflicto; una nota siempre se puede', () => {
  for (const estado of ['baja', 'muerte', 'traslado']) {
    const r = val({ tipo: 'muerte', fecha: '2026-05-01' }, { estado });
    assert.equal(r.ok, false);
    assert.equal(r.conflicto, true);
    assert.equal(val({ tipo: 'nota', fecha: '2026-05-01', notas: 'x' }, { estado }).ok, true);
  }
});

test('validarEvento: cuerpo que no es objeto', () => {
  for (const mal of [null, undefined, 'x', 5, [], [{ tipo: 'nota' }]]) assert.equal(val(mal).ok, false, JSON.stringify(mal));
});

// ── Estado por eventos ──
test('estadoEjemplar: sin salida está activo; las notas no cambian el estado', () => {
  const e = ej('uno-0001');
  assert.deepEqual(R.estadoEjemplar(e, []), { estado: 'activo', fechaSalida: null, salida: null });
  const r = R.estadoEjemplar(e, [ev('n1-000001', e.id, 'nota', '2024-01-01')]);
  assert.equal(r.estado, 'activo');
});

test('estadoEjemplar: baja, muerte y traslado; solo cuentan los eventos de ese ejemplar', () => {
  const e = ej('uno-0001');
  for (const tipo of ['baja', 'muerte', 'traslado']) {
    const r = R.estadoEjemplar(e, [ev('s-00000001', e.id, tipo, '2025-03-03')]);
    assert.equal(r.estado, tipo);
    assert.equal(r.fechaSalida, '2025-03-03');
  }
  const ajeno = ev('s-00000002', 'otro-00001', 'muerte', '2025-03-03');
  assert.equal(R.estadoEjemplar(e, [ajeno]).estado, 'activo');
});

test('estadoEjemplar: con datos incoherentes manda la salida más reciente (y a igual fecha, la creada después)', () => {
  const e = ej('uno-0001');
  const a = ev('s-00000001', e.id, 'traslado', '2025-03-03');
  const b = ev('s-00000002', e.id, 'muerte', '2025-06-01');
  assert.equal(R.estadoEjemplar(e, [b, a]).estado, 'muerte');
  const c = ev('s-00000003', e.id, 'baja', '2025-06-01', { creado: '2025-06-01T18:00:00.000Z' });
  assert.equal(R.estadoEjemplar(e, [c, b, a]).estado, 'baja');
});

test('estadoEjemplar: ignora eventos dañados (fecha inválida o tipo desconocido)', () => {
  const e = ej('uno-0001');
  assert.equal(R.estadoEjemplar(e, [ev('x-00000001', e.id, 'muerte', 'ayer'), { id: 'y', ejemplarId: e.id, tipo: 'fuga', fecha: '2025-01-01' }, null]).estado, 'activo');
});

// ── Inventario ──
test('resumenInventario: por especie sin importar mayúsculas ni acentos, con sexo y salidas', () => {
  const e = [
    ej('a-0000001', { nombreComun: 'Iguana verde', sexo: 'macho' }),
    ej('a-0000002', { nombreComun: 'iguana  VERDE', sexo: 'hembra' }),
    ej('a-0000003', { nombreComun: 'Iguana verde', sexo: 'indeterminado' }),
    ej('a-0000004', { nombreComun: 'Águila real', nombreCientifico: 'Aquila chrysaetos', sexo: 'hembra' }),
    ej('a-0000005', { nombreComun: 'aguila real', sexo: 'macho' }),
    ej('a-0000006', { nombreComun: 'Boa', sexo: 'macho' })
  ];
  const v = [ev('s-1000001', 'a-0000003', 'muerte', '2025-01-01'), ev('s-1000002', 'a-0000005', 'traslado', '2025-02-01'), ev('s-1000003', 'a-0000006', 'baja', '2025-02-02')];
  const r = R.resumenInventario(e, v);
  assert.equal(r.registrados, 6);
  assert.equal(r.activos, 3);
  assert.equal(r.muertes, 1); assert.equal(r.traslados, 1); assert.equal(r.bajas, 1);
  assert.equal(r.machos, 1); assert.equal(r.hembras, 2); assert.equal(r.indeterminados, 0);
  assert.deepEqual(r.porEspecie.map(f => [f.especie, f.registrados, f.activos]), [['Águila real', 2, 1], ['Boa', 1, 0], ['Iguana verde', 3, 2]]);
  const aguila = r.porEspecie[0];
  assert.equal(aguila.nombreCientifico, 'Aquila chrysaetos', 'toma el científico de cualquiera de los registros');
  assert.equal(aguila.traslados, 1);
  assert.equal(aguila.hembras, 1);
});

test('resumenInventario: vacío', () => {
  assert.deepEqual(R.resumenInventario([], []), { registrados: 0, activos: 0, machos: 0, hembras: 0, indeterminados: 0, bajas: 0, muertes: 0, traslados: 0, porEspecie: [] });
});

// ── Informe anual ──
function escenario() {
  const ejemplares = [
    ej('boa-e1-001', { nombreComun: 'Boa', fechaIngreso: '2023-05-10' }),
    ej('boa-e2-002', { nombreComun: 'Boa', fechaIngreso: '2024-12-31' }),
    ej('boa-e3-003', { nombreComun: 'Boa', fechaIngreso: '2025-03-01', tipoIngreso: 'nacimiento' }),
    ej('boa-e4-004', { nombreComun: 'Boa', fechaIngreso: '2025-04-01', tipoIngreso: 'nacimiento' }),
    ej('ig-e5-0005', { nombreComun: 'Iguana', fechaIngreso: '2025-01-01' }),
    ej('ig-e6-0006', { nombreComun: 'Iguana', fechaIngreso: '2025-12-31' }),
    ej('ig-e7-0007', { nombreComun: 'Iguana', fechaIngreso: '2026-01-01' }),
    ej('tor-e8-008', { nombreComun: 'Tortuga', fechaIngreso: '2020-01-01' }),
    ej('tor-e9-009', { nombreComun: 'Tortuga', fechaIngreso: '2020-01-01' })
  ];
  const eventos = [
    ev('s-0000000a', 'boa-e2-002', 'traslado', '2025-01-01', { destino: 'UMA Norte' }),
    ev('s-0000000b', 'boa-e4-004', 'muerte', '2025-06-01', { causa: 'Neumonía' }),
    ev('s-0000000c', 'ig-e5-0005', 'baja', '2025-12-31', { causa: 'Donación', destino: 'Zoo X' }),
    ev('s-0000000d', 'tor-e8-008', 'muerte', '2024-06-01'),
    ev('s-0000000e', 'tor-e9-009', 'baja', '2025-07-07', { causa: 'Venta' }),
    ev('n-0000000f', 'boa-e1-001', 'nota', '2025-02-02', { notas: 'Revisión' })
  ];
  return { ejemplares, eventos };
}
const fila = (inf, nombre) => inf.porEspecie.find(f => f.especie === nombre);
const numeros = f => [f.existenciasInicio, f.altas, f.nacimientos, f.bajas, f.muertes, f.traslados, f.existenciasFin];

test('informeAnual 2025: existencias, movimientos y total', () => {
  const { ejemplares, eventos } = escenario();
  const inf = R.informeAnual(ejemplares, eventos, 2025, { hoy: HOY });
  assert.equal(inf.anio, 2025);
  assert.equal(inf.desde, '2025-01-01');
  assert.equal(inf.hasta, '2025-12-31');
  assert.equal(inf.enCurso, false);
  assert.equal(inf.corte, '2025-12-31');
  assert.deepEqual(inf.porEspecie.map(f => f.especie), ['Boa', 'Iguana', 'Tortuga']);
  // inicio, altas, nacimientos, bajas, muertes, traslados, fin
  assert.deepEqual(numeros(fila(inf, 'Boa')), [2, 0, 2, 0, 1, 1, 2]);
  assert.deepEqual(numeros(fila(inf, 'Iguana')), [0, 2, 0, 1, 0, 0, 1]);
  assert.deepEqual(numeros(fila(inf, 'Tortuga')), [1, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(numeros(inf.total), [3, 2, 2, 2, 1, 1, 3]);
});

test('informeAnual: la cuenta cuadra siempre (inicio + altas + nacimientos - salidas = fin)', () => {
  const { ejemplares, eventos } = escenario();
  for (const anio of [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]) {
    const inf = R.informeAnual(ejemplares, eventos, anio, { hoy: '2027-06-01' });
    for (const f of [...inf.porEspecie, inf.total]) {
      assert.equal(f.existenciasInicio + f.altas + f.nacimientos - f.bajas - f.muertes - f.traslados, f.existenciasFin, `${anio} ${f.especie || 'total'}`);
    }
    const suma = k => inf.porEspecie.reduce((a, f) => a + f[k], 0);
    for (const k of ['existenciasInicio', 'altas', 'nacimientos', 'bajas', 'muertes', 'traslados', 'existenciasFin']) assert.equal(suma(k), inf.total[k], `${anio} ${k}`);
  }
});

test('informeAnual 2024: el traslado del 1 de enero pertenece a 2025; la muerte de 2024 sale en 2024', () => {
  const { ejemplares, eventos } = escenario();
  const inf = R.informeAnual(ejemplares, eventos, 2024, { hoy: HOY });
  assert.deepEqual(numeros(fila(inf, 'Boa')), [1, 1, 0, 0, 0, 0, 2], 'e1 existía; e2 llegó el 31 de dic y sigue ahí al cierre');
  assert.deepEqual(numeros(fila(inf, 'Tortuga')), [2, 0, 0, 0, 1, 0, 1]);
  assert.equal(fila(inf, 'Iguana'), undefined, 'una especie sin nada en el año no aparece');
});

test('informeAnual: ingresar y salir el mismo año cuenta en movimientos y en ninguna existencia', () => {
  const e = [ej('x-00000001', { nombreComun: 'Zorro', fechaIngreso: '2025-02-01', tipoIngreso: 'nacimiento' })];
  const v = [ev('s-0000000x', 'x-00000001', 'muerte', '2025-02-20')];
  const inf = R.informeAnual(e, v, 2025, { hoy: HOY });
  assert.deepEqual(numeros(inf.total), [0, 0, 1, 0, 1, 0, 0]);
});

test('informeAnual: el año en curso corta en hoy y lo avisa', () => {
  const e = [ej('x-00000001', { nombreComun: 'Zorro', fechaIngreso: '2026-02-01' })];
  const inf = R.informeAnual(e, [], 2026, { hoy: HOY });
  assert.equal(inf.enCurso, true);
  assert.equal(inf.corte, HOY);
  assert.equal(inf.total.existenciasFin, 1);
  assert.equal(inf.total.altas, 1);
});

test('informeAnual: movimientos del año en orden, con especie, marca, causa y destino', () => {
  const { ejemplares, eventos } = escenario();
  ejemplares[0].marca = 'ARETE-1';
  const inf = R.informeAnual(ejemplares, eventos, 2025, { hoy: HOY });
  assert.deepEqual(inf.movimientos.map(m => [m.fecha, m.tipo, m.especie]), [
    ['2025-01-01', 'alta', 'Iguana'],
    ['2025-01-01', 'traslado', 'Boa'],
    ['2025-03-01', 'nacimiento', 'Boa'],
    ['2025-04-01', 'nacimiento', 'Boa'],
    ['2025-06-01', 'muerte', 'Boa'],
    ['2025-07-07', 'baja', 'Tortuga'],
    ['2025-12-31', 'alta', 'Iguana'],
    ['2025-12-31', 'baja', 'Iguana']
  ]);
  const baja = inf.movimientos.find(m => m.tipo === 'baja' && m.especie === 'Iguana');
  assert.equal(baja.causa, 'Donación');
  assert.equal(baja.destino, 'Zoo X');
  assert.ok(inf.movimientos.every(m => !('_creado' in m) && !('_id' in m)));
});

test('informeAnual: ejemplar con fecha de ingreso dañada no cuenta ni rompe nada', () => {
  const e = [ej('x-00000001', { fechaIngreso: '' }), ej('x-00000002', { fechaIngreso: '2025-01-05' })];
  const inf = R.informeAnual(e, [], 2025, { hoy: HOY });
  assert.equal(inf.total.altas, 1);
  assert.equal(inf.total.existenciasFin, 1);
});

test('informeAnual sin datos', () => {
  const inf = R.informeAnual([], [], 2025, { hoy: HOY });
  assert.deepEqual(inf.porEspecie, []);
  assert.deepEqual(numeros(inf.total), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(inf.movimientos, []);
});

test('validarAnio', () => {
  assert.deepEqual(R.validarAnio('2025', HOY), { ok: true, anio: 2025 });
  assert.deepEqual(R.validarAnio('2026', HOY), { ok: true, anio: 2026 });
  assert.deepEqual(R.validarAnio('2000', HOY), { ok: true, anio: 2000 });
  for (const mal of ['2027', '1999', '25', '20250', 'abcd', '2025.5', '', undefined, null, ['2025'], { a: 1 }, '2025; DROP', ' ']) {
    assert.equal(R.validarAnio(mal, HOY).ok, false, JSON.stringify(mal));
  }
});

test('ejemplarPublico y eventoPublico: no inventan valores si el documento viene dañado', () => {
  const e = R.ejemplarPublico('id-0000001', { nombreComun: 5, sexo: 'x', tipoIngreso: 'compra', fechaIngreso: 'ayer', uid: 'secreto' });
  assert.deepEqual(e, { id: 'id-0000001', nombreComun: '', nombreCientifico: '', nombre: '', marca: '', sexo: 'indeterminado', origen: '',
    tipoIngreso: 'alta', fechaIngreso: '', notas: '', creado: '', actualizado: '' });
  assert.equal('uid' in e, false);
  const v = R.eventoPublico('ev-0000001', { tipo: 'fuga', fecha: 3 });
  assert.equal(v.tipo, 'nota'); assert.equal(v.fecha, '');
  assert.deepEqual(R.ejemplarPublico('id-0000001', null).nombreComun, '');
});
