'use strict';

// Libros que se desbloquean con retos: validación estricta, carga desde disco, umbrales y avisos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../services/libros');
const avisos = require('../services/avisos');
const { FakeFirestore } = require('./helpers/fake-firestore');
const { libroValido, carpetaLibros, carpetaTemporal } = require('./helpers/materiales');

const FIXTURES = path.join(__dirname, 'fixtures', 'libros');
const callar = fn => async () => {
  const original = console.warn; console.warn = () => {};
  try { await fn(); } finally { console.warn = original; }
};
const miembro = superados => ({ superados, membresia: true, esAdmin: false });

// ── Validación ──
test('el libro de prueba de los fixtures carga completo', () => {
  const { libros, errores } = L.cargarLibros(FIXTURES, { avisar: false });
  assert.deepEqual(errores, []);
  assert.equal(libros.length, 1);
  assert.equal(libros[0].id, 'libro-prueba');
  assert.equal(libros[0].prueba, true);
  assert.equal(libros[0].paginas.length, 3);
  assert.equal(libros[0].requiereRetos, 1);
  assert.deepEqual(libros[0].paginas[1].lista, ['Primer punto', 'Segundo punto']);
});

test('normalizarLibro: un libro válido pasa y solo conserva los campos conocidos', () => {
  const l = L.normalizarLibro({ ...libroValido('ley-fauna-mx', 5), extraño: 'x' });
  assert.equal(l.id, 'ley-fauna-mx');
  assert.equal('extraño' in l, false);
});

test('normalizarLibro rechaza ids raros, umbrales fuera de rango y colores/fechas mal escritos', () => {
  const malo = extra => () => L.normalizarLibro({ ...libroValido('ok', 5), ...extra });
  for (const id of ['', 'Mayus', 'con espacio', '../x', 'a/b', 'a_b', '-a', 'a-', 'a--b', 'x'.repeat(61), 5, null]) {
    assert.throws(malo({ id }), /id/, `id ${JSON.stringify(id)}`);
  }
  for (const requiereRetos of [0, -1, 201, 1.5, '5', null, undefined, NaN]) {
    assert.throws(malo({ requiereRetos }), /requiereRetos/, `requiere ${requiereRetos}`);
  }
  assert.doesNotThrow(malo({ requiereRetos: 1 }));
  assert.doesNotThrow(malo({ requiereRetos: 200 }));
  assert.throws(malo({ color: 'verde' }), /color/);
  assert.throws(malo({ actualizado: '10/2026' }), /actualizado/);
  assert.throws(malo({ actualizado: '2026-13-45' }), /actualizado/);
});

test('normalizarLibro: páginas de 3 a 40', () => {
  const con = n => () => L.normalizarLibro({ ...libroValido('ok', 5), paginas: Array.from({ length: n }, (_, i) => ({ titulo: `P${i}`, parrafos: ['Texto.'] })) });
  assert.throws(con(2), /3 a 40/);
  assert.doesNotThrow(con(3));
  assert.doesNotThrow(con(40));
  assert.throws(con(41), /3 a 40/);
  assert.throws(() => L.normalizarLibro({ ...libroValido('ok', 5), paginas: 'no' }), /paginas/);
});

test('normalizarLibro rechaza etiquetas HTML en cualquier texto (título, resumen, páginas, listas, fuentes, revisión)', () => {
  const base = libroValido('ok', 5);
  const mal = parche => () => L.normalizarLibro({ ...base, ...parche });
  assert.throws(mal({ titulo: 'Hola <b>mundo</b>' }), /etiquetas/);
  assert.throws(mal({ resumen: 'Resumen <script>alert(1)</script> largo' }), /etiquetas/);
  assert.throws(mal({ autor: '<img src=x>' }), /etiquetas/);
  assert.throws(mal({ paginas: [...base.paginas.slice(0, 2), { titulo: 'T', parrafos: ['ok <i>x</i>'] }] }), /etiquetas/);
  assert.throws(mal({ paginas: [...base.paginas.slice(0, 2), { titulo: 'T', parrafos: ['ok'], lista: ['<a href=x>x</a>'] }] }), /etiquetas/);
  assert.throws(mal({ fuentes: [{ nombre: '<b>x</b>', url: 'https://example.org/' }] }), /etiquetas/);
  assert.throws(mal({ revision: [{ pregunta: '<svg onload=1>' }] }), /etiquetas/);
  assert.throws(mal({ revision: [{ pregunta: '<!-- x -->' }] }), /etiquetas/);
});

test('normalizarLibro: las fuentes solo aceptan https', () => {
  const base = libroValido('ok', 5);
  for (const url of ['http://example.org/', 'javascript:alert(1)', 'ftp://example.org/', 'example.org', 'https://user:pw@example.org/']) {
    assert.throws(() => L.normalizarLibro({ ...base, fuentes: [{ nombre: 'F', url }] }), /https/, url);
  }
});

test('normalizarLibro: límites de largo y tipos', () => {
  const base = libroValido('ok', 5);
  assert.throws(() => L.normalizarLibro({ ...base, titulo: 'x'.repeat(141) }), /demasiado largo/);
  assert.throws(() => L.normalizarLibro({ ...base, titulo: 'ab' }), /vacío|titulo/);
  assert.throws(() => L.normalizarLibro({ ...base, resumen: 123 }), /texto/);
  assert.throws(() => L.normalizarLibro(null), /objeto/);
  assert.throws(() => L.normalizarLibro([]), /objeto/);
  assert.throws(() => L.normalizarLibro({ ...base, revision: 'no' }), /revision/);
});

test('normalizarLibro limpia caracteres de control y espacios', () => {
  const l = L.normalizarLibro({ ...libroValido('ok', 5), titulo: '  Título\u0000   con   espacios‮ ' });
  assert.equal(l.titulo, 'Título con espacios');
});

// ── Carga desde disco ──
test('cargarLibros descarta lo inválido con aviso y conserva lo bueno', callar(() => {
  const dir = carpetaLibros([libroValido('bueno', 5), libroValido('otro', 1)]);
  fs.writeFileSync(path.join(dir, 'roto.json'), '{ esto no es json');
  fs.writeFileSync(path.join(dir, 'sin-paginas.json'), JSON.stringify({ ...libroValido('sin-paginas', 5), paginas: [] }));
  fs.writeFileSync(path.join(dir, 'no-coincide.json'), JSON.stringify(libroValido('otro-id', 5)));
  fs.writeFileSync(path.join(dir, 'Mayus.JSON'), JSON.stringify(libroValido('mayus', 5)));
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'ignorado');
  const { libros, errores } = L.cargarLibros(dir);
  assert.deepEqual(libros.map(l => l.id), ['otro', 'bueno'], 'ordenados por umbral');
  assert.deepEqual(errores.map(e => e.archivo).sort(), ['Mayus.JSON', 'no-coincide.json', 'roto.json', 'sin-paginas.json']);
  for (const e of errores) assert.equal(/[\\/]/.test(e.error), false, 'los errores no llevan rutas del disco');
  assert.match(errores.find(e => e.archivo === 'roto.json').error, /JSON/);
  assert.match(errores.find(e => e.archivo === 'no-coincide.json').error, /coincidir/);
}));

test('cargarLibros: carpeta inexistente y carpeta vacía no lanzan', callar(() => {
  const r = L.cargarLibros(path.join(carpetaTemporal('x'), 'no-existe'));
  assert.deepEqual(r.libros, []);
  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].error.includes('no-existe'), false);
  assert.deepEqual(L.cargarLibros(carpetaTemporal('vacia'), { avisar: false }), { libros: [], errores: [] });
}));

test('cargarLibros ignora archivos de más de 1 MB', callar(() => {
  const dir = carpetaTemporal('grande');
  fs.writeFileSync(path.join(dir, 'grande.json'), JSON.stringify({ ...libroValido('grande', 5), relleno: 'x'.repeat(1100000) }));
  const r = L.cargarLibros(dir);
  assert.equal(r.libros.length, 0);
  assert.match(r.errores[0].error, /1 MB/);
}));

test('cargarLibros: dos libros con el mismo id (por nombre de archivo distinto) no se duplican', callar(() => {
  const dir = carpetaLibros([libroValido('uno', 1)]);
  fs.writeFileSync(path.join(dir, 'uno-copia.json'), JSON.stringify(libroValido('uno', 2)));
  const r = L.cargarLibros(dir);
  assert.deepEqual(r.libros.map(l => l.id), ['uno']);
  assert.equal(r.errores.length, 1);
}));

test('la carpeta real data/libros arranca sin errores de formato', () => {
  const r = L.cargarLibros(path.join(__dirname, '..', 'data', 'libros'), { avisar: false });
  assert.deepEqual(r.errores, []);
});

// ── Umbrales ──
const libros = [libroValido('uno', 1), libroValido('cinco', 5), libroValido('quince', 15)].map(L.normalizarLibro);

test('acceso: justo en el límite, uno antes y uno después', () => {
  const de = n => L.resumenLibros(libros, miembro(n)).map(l => [l.id, l.desbloqueado, l.faltan]);
  assert.deepEqual(de(0), [['uno', false, 1], ['cinco', false, 5], ['quince', false, 15]]);
  assert.deepEqual(de(1), [['uno', true, 0], ['cinco', false, 4], ['quince', false, 14]]);
  assert.deepEqual(de(4), [['uno', true, 0], ['cinco', false, 1], ['quince', false, 11]]);
  assert.deepEqual(de(5), [['uno', true, 0], ['cinco', true, 0], ['quince', false, 10]]);
  assert.deepEqual(de(14), [['uno', true, 0], ['cinco', true, 0], ['quince', false, 1]]);
  assert.deepEqual(de(15), [['uno', true, 0], ['cinco', true, 0], ['quince', true, 0]]);
  assert.deepEqual(de(999), [['uno', true, 0], ['cinco', true, 0], ['quince', true, 0]]);
});

test('acceso: administrador todo abierto; sin membresía nada abre y marca soloMiembros', () => {
  const admin = L.resumenLibros(libros, { superados: 0, membresia: true, esAdmin: true });
  assert.ok(admin.every(l => l.desbloqueado && l.faltan === 0 && l.soloMiembros === false));
  const sin = L.resumenLibros(libros, { superados: 500, membresia: false, esAdmin: false });
  assert.ok(sin.every(l => l.desbloqueado === false && l.soloMiembros === true));
  assert.deepEqual(sin.map(l => l.faltan), [1, 5, 15], 'sin membresía faltan = el umbral completo');
  const con = L.resumenLibros(libros, miembro(2));
  assert.ok(con.every(l => l.soloMiembros === false));
});

test('acceso: datos raros no abren nada', () => {
  for (const superados of [undefined, null, NaN, -3, 2.5, '99']) {
    assert.equal(L.acceso(libros[1], { superados, membresia: true }).desbloqueado, false, String(superados));
  }
  assert.equal(L.acceso(libros[0], undefined).desbloqueado, false);
});

test('resumenLibros NUNCA trae páginas, fuentes ni revisión, y cuenta las páginas', () => {
  const resumen = L.resumenLibros([L.normalizarLibro({ ...libroValido('r', 1), revision: [{ pregunta: 'x' }] })], miembro(99))[0];
  assert.deepEqual(Object.keys(resumen).sort(), [
    'autor', 'categoria', 'color', 'desbloqueado', 'faltan', 'icono', 'id', 'paginasTotal', 'requiereRetos', 'resumen',
    'soloMiembros', 'subtitulo', 'titulo'].sort());
  assert.equal(resumen.paginasTotal, 3);
  assert.equal(JSON.stringify(resumen).includes('Texto secreto'), false);
});

test('libroCompleto: páginas solo si está desbloqueado', () => {
  assert.equal(L.libroCompleto(libros[1], miembro(4)), null);
  assert.equal(L.libroCompleto(libros[1], { superados: 50, membresia: false }), null);
  const abierto = L.libroCompleto(libros[1], miembro(5));
  assert.equal(abierto.paginas.length, 3);
  assert.equal(abierto.desbloqueado, true);
  assert.equal(L.libroCompleto(libros[2], { superados: 0, membresia: true, esAdmin: true }).paginas.length, 3);
  assert.equal(L.libroCompleto(undefined, miembro(5)), null);
});

// ── librosNuevos ──
test('librosNuevos: solo los que cruzan su umbral en este avance', () => {
  const ids = (a, d) => L.librosNuevos(libros, a, d).map(l => l.id);
  assert.deepEqual(ids(0, 1), ['uno']);
  assert.deepEqual(ids(1, 2), []);
  assert.deepEqual(ids(4, 5), ['cinco']);
  assert.deepEqual(ids(5, 5), []);
  assert.deepEqual(ids(14, 15), ['quince']);
  assert.deepEqual(ids(15, 16), []);
  assert.deepEqual(ids(5, 4), [], 'retroceder no desbloquea');
});

test('librosNuevos: varios umbrales de una vez, del menor al mayor, con números o estados', () => {
  assert.deepEqual(L.librosNuevos(libros, 0, 20).map(l => l.id), ['uno', 'cinco', 'quince']);
  assert.deepEqual(L.librosNuevos(libros, { superados: 3 }, { superados: 15 }).map(l => l.id), ['cinco', 'quince']);
  assert.deepEqual(L.librosNuevos(libros, undefined, { superados: 1 }).map(l => l.id), ['uno']);
  assert.deepEqual(L.librosNuevos([], 0, 99), []);
  assert.deepEqual(L.librosNuevos(libros, 0, 1)[0], { id: 'uno', titulo: 'Libro uno', requiereRetos: 1 });
});

// ── Avisos ──
test('avisarLibros crea un aviso por libro ganado con el texto acordado y sin duplicar', async () => {
  const db = new FakeFirestore();
  assert.equal(await L.avisarLibros(db, 'ana', libros, miembro(5)), 2);
  const primero = db.value('avisos/ana/items/libro_uno');
  assert.equal(primero.tipo, 'libro');
  assert.equal(primero.titulo, '¡Desbloqueaste tu primer libro!');
  assert.equal(primero.texto, 'Superaste 5 retos: ya puedes leer «Libro uno» en PDFs y materiales.');
  assert.equal(primero.enlace, 'club-pdfs.html');
  assert.equal(db.value('avisos/ana/items/libro_cinco').titulo, '¡Desbloqueaste un nuevo libro!');
  assert.equal(db.value('avisos/ana/items/libro_quince'), undefined);
  // Repetir (o llamar varias veces a la vez) no duplica ni sobrescribe
  assert.equal(await L.avisarLibros(db, 'ana', libros, miembro(20)), 1, 'solo el nuevo');
  assert.equal(db.value('avisos/ana/items/libro_uno').texto, 'Superaste 5 retos: ya puedes leer «Libro uno» en PDFs y materiales.');
  assert.equal(await L.avisarLibros(db, 'ana', libros, miembro(20)), 0);
  db.lenta = true;
  const r = await Promise.all([1, 2, 3].map(() => L.avisarLibros(db, 'beto', libros, miembro(1))));
  assert.equal(r.reduce((a, b) => a + b, 0), 1);
});

test('avisarLibros: sin membresía y administrador no reciben avisos; nunca lanza', callar(async () => {
  const db = new FakeFirestore();
  assert.equal(await L.avisarLibros(db, 'ana', libros, { superados: 50, membresia: false }), 0);
  assert.equal(await L.avisarLibros(db, 'ana', libros, { superados: 50, membresia: true, esAdmin: true }), 0);
  assert.equal(await L.avisarLibros(db, 'ana', libros, undefined), 0);
  const roto = { collection() { throw new Error('Firestore caído'); } };
  assert.equal(await L.avisarLibros(roto, 'ana', libros, miembro(50)), 0);
}));

test('los avisos de libros aparecen en la campana (listarAvisos)', async () => {
  const db = new FakeFirestore();
  await L.avisarLibros(db, 'ana', libros, miembro(1));
  const lista = await avisos.listarAvisos(db, 'ana');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, 'libro_uno');
  assert.equal(lista[0].tipo, 'libro');
});
