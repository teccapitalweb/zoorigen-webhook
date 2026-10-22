'use strict';

// Materiales PDF: validación del catálogo, archivos solo del catálogo, estado de acceso.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../services/materiales');
const { materialValido, carpetaMateriales, carpetaTemporal, PDF_PRUEBA } = require('./helpers/materiales');

const FIXTURES = path.join(__dirname, 'fixtures', 'materiales');
const callar = fn => async () => {
  const original = console.warn; console.warn = () => {};
  try { await fn(); } finally { console.warn = original; }
};
const miembro = superados => ({ superados, membresia: true, esAdmin: false });

test('el catálogo de los fixtures carga con su PDF de prueba', () => {
  const { materiales, errores } = M.cargarMateriales(FIXTURES, { avisar: false });
  assert.deepEqual(errores, []);
  assert.equal(materiales.length, 1);
  assert.equal(materiales[0].id, 'guia-prueba');
  assert.ok(materiales[0].bytes > 100);
});

test('la carpeta real data/materiales carga sin errores (el detalle del contenido se prueba en contenido-real.test.js)', () => {
  const r = M.cargarMateriales(path.join(__dirname, '..', 'data', 'materiales'), { avisar: false });
  assert.deepEqual(r.errores, []);
  assert.ok(r.materiales.length >= 1);
});

test('normalizarMaterial: válido pasa; tipo, acceso, id y requiereRetos se validan', () => {
  assert.doesNotThrow(() => M.normalizarMaterial(materialValido('a-1', 'miembros')));
  assert.doesNotThrow(() => M.normalizarMaterial(materialValido('a-1', 'retos', 5)));
  for (const tipo of M.TIPOS) assert.doesNotThrow(() => M.normalizarMaterial(materialValido('a-1', 'miembros', 0, { tipo })));
  const malo = (extra, patron) => assert.throws(() => M.normalizarMaterial({ ...materialValido('ok', 'retos', 5), ...extra }), patron);
  malo({ tipo: 'video' }, /tipo/);
  malo({ acceso: 'todos' }, /acceso/);
  malo({ id: 'Con Espacio' }, /id/);
  malo({ requiereRetos: 0 }, /requiereRetos/);
  malo({ requiereRetos: 201 }, /requiereRetos/);
  malo({ requiereRetos: undefined }, /requiereRetos/);
  malo({ paginas: 0 }, /paginas/);
  malo({ paginas: 1.5 }, /paginas/);
  malo({ licencia: '' }, /licencia/);
  malo({ titulo: '<b>x</b>' }, /etiquetas/);
  malo({ descripcion: 'x'.repeat(401) }, /demasiado largo/);
  malo({ fuentes: [{ nombre: 'x', url: 'http://inseguro.org' }] }, /https/);
  assert.throws(() => M.normalizarMaterial(materialValido('ok', 'miembros', 0, { requiereRetos: 3 })), /miembros/);
});

test('normalizarMaterial: el nombre del archivo no puede llevar rutas ni extensiones raras', () => {
  const con = archivo => () => M.normalizarMaterial({ ...materialValido('ok'), archivo });
  for (const a of ['../secreto.pdf', '..\\secreto.pdf', 'sub/otro.pdf', '/etc/passwd', 'C:\\x.pdf', '%2e%2e%2fx.pdf', 'otro.PDF',
    'archivo.pdf.exe', 'archivo.txt', '.pdf', 'con espacio.pdf', 'a..b.pdf', '', null, 7, ['a.pdf']]) {
    assert.throws(con(a), /archivo/, JSON.stringify(a));
  }
  assert.doesNotThrow(con('bueno-1.pdf'));
});

test('cargarMateriales: descarta entradas inválidas, duplicadas o sin archivo; conserva las buenas', callar(() => {
  const entradas = [
    materialValido('bueno', 'miembros'),
    materialValido('retos-5', 'retos', 5),
    materialValido('bueno', 'miembros'),                       // duplicado
    materialValido('sin-archivo', 'miembros'),                 // el PDF no existe (se borra abajo)
    materialValido('ruta-fea', 'miembros', 0, { archivo: '../fuera.pdf' }),
    materialValido('mal-tipo', 'miembros', 0, { tipo: 'zip' }),
    'no soy un objeto',
    null
  ];
  const dir = carpetaMateriales(entradas);
  fs.unlinkSync(path.join(dir, 'sin-archivo.pdf'));
  const { materiales, errores } = M.cargarMateriales(dir);
  assert.deepEqual(materiales.map(m => m.id), ['bueno', 'retos-5']);
  assert.equal(errores.length, 6);
  const texto = JSON.stringify(errores);
  assert.equal(/[\\/]/.test(texto.replace(/\\"/g, '')) , false, 'los errores no llevan rutas del disco');
  assert.ok(errores.some(e => /No se encontró el archivo del material/.test(e.error)));
  assert.ok(errores.some(e => /otro material con ese id/.test(e.error)));
}));

test('cargarMateriales: un archivo que no es PDF o está vacío se descarta', callar(() => {
  const dir = carpetaMateriales([materialValido('falso'), materialValido('vacio'), materialValido('bueno')]);
  fs.writeFileSync(path.join(dir, 'falso.pdf'), 'Esto es texto, no un PDF');
  fs.writeFileSync(path.join(dir, 'vacio.pdf'), '');
  const { materiales, errores } = M.cargarMateriales(dir);
  assert.deepEqual(materiales.map(m => m.id), ['bueno']);
  assert.equal(errores.length, 2);
  assert.ok(errores.every(e => /PDF|vacío/.test(e.error)));
}));

test('cargarMateriales: un enlace simbólico que apunta fuera de la carpeta se descarta', callar(() => {
  const dir = carpetaMateriales([materialValido('enlace')], { crearArchivos: false });
  const fuera = path.join(carpetaTemporal('fuera'), 'secreto.pdf');
  fs.copyFileSync(PDF_PRUEBA, fuera);
  try { fs.symlinkSync(fuera, path.join(dir, 'enlace.pdf')); } catch (_) { return; } // sin permiso de symlink (Windows): se omite
  const { materiales, errores } = M.cargarMateriales(dir);
  assert.equal(materiales.length, 0);
  assert.match(errores[0].error, /directamente dentro/);
}));

test('cargarMateriales: catálogo ausente, roto o que no es lista no lanza', callar(() => {
  const vacia = carpetaTemporal('sin-catalogo');
  assert.equal(M.cargarMateriales(vacia).errores.length, 1);
  const rota = carpetaTemporal('rota');
  fs.writeFileSync(path.join(rota, 'catalogo.json'), '{ no json');
  assert.deepEqual(M.cargarMateriales(rota).materiales, []);
  const objeto = carpetaTemporal('objeto');
  fs.writeFileSync(path.join(objeto, 'catalogo.json'), '{"a":1}');
  const r = M.cargarMateriales(objeto);
  assert.deepEqual(r.materiales, []);
  assert.match(r.errores[0].error, /lista/);
  assert.equal(JSON.stringify(r).includes(objeto), false);
}));

test('buscarMaterial solo encuentra ids exactos del catálogo', () => {
  const { materiales } = M.cargarMateriales(FIXTURES, { avisar: false });
  assert.equal(M.buscarMaterial(materiales, 'guia-prueba').id, 'guia-prueba');
  for (const id of ['../guia-prueba', 'guia-prueba.pdf', 'GUIA-PRUEBA', '..', '%2e%2e', 'guia-prueba/', 'guia prueba', '', null, undefined, 5, ['guia-prueba'], 'x'.repeat(100)]) {
    assert.equal(M.buscarMaterial(materiales, id), null, JSON.stringify(id));
  }
});

// ── Estado de acceso ──
const miembros = M.normalizarMaterial(materialValido('m', 'miembros'));
const reto5 = M.normalizarMaterial(materialValido('r', 'retos', 5));

test('acceso "miembros": abre con membresía, sin importar los retos', () => {
  assert.equal(M.acceso(miembros, miembro(0)).desbloqueado, true);
  assert.equal(M.acceso(miembros, { superados: 0, membresia: false }).desbloqueado, false);
  assert.equal(M.acceso(miembros, { superados: 99, membresia: false }).desbloqueado, false);
  assert.equal(M.acceso(miembros, { esAdmin: true }).desbloqueado, true);
  assert.deepEqual(M.acceso(miembros, miembro(0)), { desbloqueado: true, faltan: 0, soloMiembros: false });
  assert.deepEqual(M.acceso(miembros, { membresia: false }), { desbloqueado: false, faltan: 0, soloMiembros: true });
});

test('acceso "retos": justo en el límite, uno antes, admin y sin membresía', () => {
  assert.deepEqual(M.acceso(reto5, miembro(4)), { desbloqueado: false, faltan: 1, soloMiembros: false });
  assert.deepEqual(M.acceso(reto5, miembro(5)), { desbloqueado: true, faltan: 0, soloMiembros: false });
  assert.deepEqual(M.acceso(reto5, miembro(6)), { desbloqueado: true, faltan: 0, soloMiembros: false });
  assert.deepEqual(M.acceso(reto5, miembro(0)), { desbloqueado: false, faltan: 5, soloMiembros: false });
  assert.deepEqual(M.acceso(reto5, { superados: 0, membresia: true, esAdmin: true }), { desbloqueado: true, faltan: 0, soloMiembros: false });
  assert.deepEqual(M.acceso(reto5, { superados: 100, membresia: false }), { desbloqueado: false, faltan: 5, soloMiembros: true });
  for (const superados of [undefined, null, NaN, -1, 4.9, '9']) assert.equal(M.acceso(reto5, { superados, membresia: true }).desbloqueado, false);
});

test('resumenMaterial no revela archivo ni ruta (el tamaño sale solo en KB aproximados)', () => {
  const r = M.resumenMaterial({ ...reto5, ruta: '/secreto/r.pdf', bytes: 123 }, miembro(2));
  assert.deepEqual(Object.keys(r).sort(), ['acceso', 'area', 'desbloqueado', 'descripcion', 'faltan', 'formato', 'id', 'licencia', 'paginas',
    'requiereRetos', 'soloMiembros', 'tamanoKb', 'tipo', 'titulo']);
  assert.equal(r.tamanoKb, 1);
  assert.equal(r.formato, 'pdf');
  assert.equal(JSON.stringify(r).includes('secreto'), false);
  assert.equal(r.faltan, 3);
  assert.equal(M.resumenMaterial(miembros, miembro(0)).requiereRetos, 0);
});

// ── Excel y PowerPoint ──
const { OFFICE_PRUEBA } = require('./helpers/materiales');

test('tipos excel y powerpoint: llevan .xlsx y .pptx; la extensión debe coincidir con el tipo', () => {
  assert.ok(M.TIPOS.includes('excel') && M.TIPOS.includes('powerpoint'));
  assert.equal(M.normalizarMaterial(materialValido('hoja', 'miembros', 0, { tipo: 'excel' })).archivo, 'hoja.xlsx');
  assert.equal(M.normalizarMaterial(materialValido('deck', 'retos', 5, { tipo: 'powerpoint' })).archivo, 'deck.pptx');
  const malo = extra => () => M.normalizarMaterial(materialValido('x', 'miembros', 0, extra));
  assert.throws(malo({ tipo: 'excel', archivo: 'x.pdf' }), /xlsx/);
  assert.throws(malo({ tipo: 'powerpoint', archivo: 'x.xlsx' }), /pptx/);
  assert.throws(malo({ tipo: 'guia', archivo: 'x.xlsx' }), /pdf/);
  assert.throws(malo({ tipo: 'excel', archivo: 'x.xlsm' }), /archivo/);
  assert.throws(malo({ tipo: 'excel', archivo: '../x.xlsx' }), /archivo/);
});

test('version y fecha del material: opcionales, con formato válido', () => {
  const ok = M.normalizarMaterial(materialValido('v', 'miembros', 0, { version: '1.2', fecha: '2026-10-22' }));
  assert.equal(ok.version, '1.2');
  assert.equal(ok.fecha, '2026-10-22');
  for (const version of ['x', '1.2.3.4', 1, '']) assert.throws(() => M.normalizarMaterial(materialValido('v', 'miembros', 0, { version })), /version/);
  for (const fecha of ['22/10/2026', '2026-13-01', '2026-02-30', 20261022]) assert.throws(() => M.normalizarMaterial(materialValido('v', 'miembros', 0, { fecha })), /fecha/);
  assert.equal(M.normalizarMaterial(materialValido('v')).version, undefined);
});

test('cargarMateriales: Excel y PowerPoint se aceptan por su firma ZIP y un PDF disfrazado se descarta', callar(() => {
  const dir = carpetaMateriales([materialValido('hoja', 'miembros', 0, { tipo: 'excel' }), materialValido('deck', 'miembros', 0, { tipo: 'powerpoint' }),
    materialValido('falsa', 'miembros', 0, { tipo: 'excel' }), materialValido('pdf-ok')]);
  fs.writeFileSync(path.join(dir, 'falsa.xlsx'), '%PDF-1.4 esto no es un xlsx');
  const { materiales, errores } = M.cargarMateriales(dir);
  assert.deepEqual(materiales.map(m => m.id), ['hoja', 'deck', 'pdf-ok']);
  assert.equal(errores.length, 1);
  assert.match(errores[0].error, /Office/);
  assert.equal(fs.readFileSync(materiales[0].ruta).equals(OFFICE_PRUEBA), true);
}));

test('resumenMaterial: formato (pdf, excel, powerpoint), tamaño, versión y fecha', () => {
  const hoja = M.normalizarMaterial(materialValido('hoja', 'miembros', 0, { tipo: 'excel', version: '1.0', fecha: '2026-10-22' }));
  const r = M.resumenMaterial({ ...hoja, bytes: 51200, ruta: '/secreto/hoja.xlsx' }, miembro(0));
  assert.equal(r.formato, 'excel');
  assert.equal(r.tamanoKb, 50);
  assert.equal(r.version, '1.0');
  assert.equal(r.fecha, '2026-10-22');
  assert.equal(JSON.stringify(r).includes('secreto'), false);
  assert.equal(M.resumenMaterial(M.normalizarMaterial(materialValido('d', 'miembros', 0, { tipo: 'powerpoint' })), miembro(0)).formato, 'powerpoint');
  assert.equal(M.formatoDe('checklist'), 'pdf');
  assert.equal(M.FORMATOS.excel.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(M.FORMATOS.powerpoint.contentType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
});
