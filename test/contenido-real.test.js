'use strict';
// El contenido REAL que se entrega (data/libros y data/materiales) pasa las mismas validaciones que el servidor aplica al arrancar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const libros = require('../services/libros');
const materiales = require('../services/materiales');

const RAIZ = path.join(__dirname, '..', 'data');

test('los 3 libros reales cargan sin errores y con los umbrales 5 / 15 / 30', () => {
  const r = libros.cargarLibros(path.join(RAIZ, 'libros'));
  assert.deepEqual(r.errores, []);
  const lista = r.libros || r;
  assert.deepEqual(lista.map(l => [l.id, l.requiereRetos]).sort(), [['bienestar-cautiverio', 15], ['conservacion-mx', 30], ['ley-fauna-mx', 5]]);
  for (const l of lista) {
    assert.ok(l.paginas.length >= 16, l.id + ' tiene pocas páginas');
    assert.equal(l.paginas[l.paginas.length - 1].titulo, 'Aviso importante', l.id + ' debe cerrar con el aviso');
    assert.ok(l.fuentes && l.fuentes.length >= 5, l.id + ' sin fuentes suficientes');
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(JSON.stringify(l.paginas)), l.id + ' trae emojis');
  }
});

test('el catálogo real de materiales carga sin errores; los PDF existen y son PDF', () => {
  const r = materiales.cargarMateriales(path.join(RAIZ, 'materiales'));
  assert.deepEqual(r.errores, []);
  const lista = r.materiales || r.catalogo || r;
  assert.equal(lista.length, 9);
  const porId = Object.fromEntries(lista.map(m => [m.id, m]));
  assert.deepEqual(['intro-nom-059', 'bienestar-cinco-dominios', 'polinizadores-abejas'].map(id => porId[id].requiereRetos), [3, 10, 20]);
  for (const id of ['checklist-bioseguridad', 'ficha-registro-ejemplar', 'fauna-herida', 'calendario-colmenas', 'glosario-vida-silvestre', 'marco-normativo-uno']) assert.equal(porId[id].acceso, 'miembros', id);
  for (const m of lista) {
    const archivo = path.join(RAIZ, 'materiales', m.archivo);
    const inicio = fs.readFileSync(archivo).subarray(0, 5).toString('latin1');
    assert.equal(inicio, '%PDF-', m.id + ' no es un PDF');
    assert.ok(m.paginas >= 1, m.id + ' sin páginas');
    assert.equal(m.licencia, 'Original Zoorigen');
  }
});

test('ningún libro ni material real quedó marcado como prueba', () => {
  for (const f of fs.readdirSync(path.join(RAIZ, 'libros')).filter(x => x.endsWith('.json'))) {
    assert.ok(!JSON.parse(fs.readFileSync(path.join(RAIZ, 'libros', f), 'utf8')).prueba, f);
  }
});
