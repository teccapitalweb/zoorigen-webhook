'use strict';

// VISTA PREVIA PARA QUIEN NO ES MIEMBRO: el catálogo de libros y materiales se LISTA completo (portadas, títulos,
// tipo, área, descripción) para que la persona explore, pero NO se entrega ningún contenido: ni páginas, ni fuentes,
// ni rutas o nombres de archivo. Abrir un libro o bajar un PDF sigue exigiendo membresía (403 membresia-requerida).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');
const { libroValido, carpetaLibros, carpetaMateriales, materialValido } = require('./helpers/materiales');

const tokens = tokensDe('ana', 'sinplan', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });

const LIBROS = [libroValido('uno', 1), libroValido('cinco', 5), libroValido('quince', 15)];
const MATERIALES = [
  ...['m1', 'm2', 'm3', 'm4', 'm5'].map(id => materialValido(id, 'miembros')),
  ...['m6', 'm7', 'm8', 'm9'].map((id, i) => materialValido(id, 'retos', 5 + i, { tipo: i % 2 ? 'presentacion' : 'plantilla' }))
];

function servidor(env) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env, tokens,
      seed: {
        ...cursosSeed(3),
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
        'miembros/sinplan': miembroSinPlan(),
        'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
        'miembros/admin': miembroSinPlan({ role: 'admin' }),
        ...retosDe('sinplan', 99), ...retosDe('vencida', 99)
      }
    });
  } finally { console.warn = silenciar; }
}
const fixture = () => servidor({ LIBROS_DIR: carpetaLibros(LIBROS), MATERIALES_DIR: carpetaMateriales(MATERIALES) });
const libros = (app, t) => request(app).get('/api/libros').set(auth(t));
const materiales = (app, t) => request(app).get('/api/materiales').set(auth(t));
const archivo = (app, id, t) => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t))
  .buffer(true).parse((res, cb) => { const trozos = []; res.on('data', c => trozos.push(c)); res.on('end', () => cb(null, Buffer.concat(trozos))); });

// Campos que JAMÁS pueden aparecer en un listado. (En materiales `paginas` es solo la cantidad de páginas, un número;
// lo que no puede existir es una lista de páginas.)
const PROHIBIDOS = ['fuentes', 'revision', 'ruta', 'archivo', 'driveId', 'bytes', 'url', 'parrafos', 'lista'];
const sinContenido = it => Array.isArray(it.paginas) === false && PROHIBIDOS.every(p => !Object.prototype.hasOwnProperty.call(it, p));

for (const quien of ['token-sinplan', 'token-vencida']) {
  test(`vista previa (${quien}): lista los 3 libros con metadatos completos, cerrados y solo para miembros`, async () => {
    const { app } = fixture();
    const res = await libros(app, quien);
    assert.equal(res.status, 200);
    assert.equal(res.body.membresia, false);
    assert.equal(res.body.libros.length, 3);
    for (const l of res.body.libros) {
      for (const c of ['id', 'titulo', 'subtitulo', 'autor', 'categoria', 'color', 'icono', 'resumen', 'paginasTotal', 'requiereRetos']) {
        assert.ok(l[c] !== undefined && l[c] !== '', `${l.id} lleva ${c}`);
      }
      assert.equal(l.desbloqueado, false);
      assert.equal(l.soloMiembros, true);
      assert.equal(l.paginasTotal, 3, 'solo la cantidad de páginas, nunca las páginas');
      assert.equal(Object.prototype.hasOwnProperty.call(l, 'paginas'), false, `${l.id} no lleva paginas`);
      assert.ok(sinContenido(l), l.id);
    }
    const texto = JSON.stringify(res.body);
    assert.equal(texto.includes('Texto secreto'), false);
    assert.equal(texto.includes('example.org'), false);
  });

  test(`vista previa (${quien}): lista los 9 materiales con metadatos, sin ruta ni archivo`, async () => {
    const { app } = fixture();
    const res = await materiales(app, quien);
    assert.equal(res.status, 200);
    assert.equal(res.body.membresia, false);
    assert.equal(res.body.materiales.length, 9);
    for (const m of res.body.materiales) {
      for (const c of ['id', 'titulo', 'tipo', 'area', 'descripcion', 'paginas']) assert.ok(m[c] !== undefined && m[c] !== '', `${m.id} lleva ${c}`);
      assert.equal(m.desbloqueado, false);
      assert.equal(m.soloMiembros, true);
      assert.equal(typeof m.paginas, 'number', `${m.id}: paginas es solo la cantidad`);
      assert.ok(sinContenido(m), m.id);
    }
    const texto = JSON.stringify(res.body);
    assert.equal(texto.includes('.pdf'), false);
    assert.equal(texto.includes(path.sep + 'zoo-'), false, 'ninguna ruta del disco');
  });

  test(`vista previa (${quien}): el contenido sigue cerrado (403 membresia-requerida, sin una sola página ni byte de PDF)`, async () => {
    const { app } = fixture();
    for (const id of ['uno', 'cinco', 'quince']) {
      const res = await request(app).get(`/api/libros/${id}`).set(auth(quien));
      assert.equal(res.status, 403, id);
      assert.equal(res.body.codigo, 'membresia-requerida');
      assert.equal(res.body.libro, undefined);
      assert.equal(JSON.stringify(res.body).includes('Texto secreto'), false);
    }
    for (const id of ['m1', 'm6']) {
      const res = await archivo(app, id, quien);
      assert.equal(res.status, 403, id);
      assert.equal(JSON.parse(res.body.toString('utf8')).codigo, 'membresia-requerida');
      assert.equal(String(res.headers['content-type']).includes('pdf'), false);
    }
  });
}

test('vista previa: un miembro y el administrador conservan su comportamiento (desbloqueo y contenido)', async () => {
  const { app } = fixture();
  const ana = await libros(app, 'token-ana');
  assert.equal(ana.body.membresia, true);
  assert.ok(ana.body.libros.every(l => l.soloMiembros === false));
  const admin = await materiales(app, 'token-admin');
  assert.ok(admin.body.materiales.every(m => m.desbloqueado && !m.soloMiembros));
  assert.equal((await request(app).get('/api/libros/quince').set(auth('token-admin'))).status, 200);
  assert.equal((await archivo(app, 'm1', 'token-ana')).status, 200);
});

// El catálogo REAL que se publica (data/libros y data/materiales): 3 libros y 9 materiales, y nada de contenido en el listado.
test('vista previa con el catálogo real: quien no es miembro ve todo el catálogo y nada de su contenido', async () => {
  const dirLibros = path.join(__dirname, '..', 'data', 'libros');
  const catalogo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'materiales', 'catalogo.json'), 'utf8'));
  const esperadosLibros = fs.readdirSync(dirLibros).filter(n => n.endsWith('.json')).length;
  const { app } = servidor({});
  const l = await libros(app, 'token-sinplan');
  const m = await materiales(app, 'token-sinplan');
  assert.equal(l.status, 200);
  assert.equal(m.status, 200);
  assert.equal(l.body.libros.length, esperadosLibros);
  assert.equal(m.body.materiales.length, catalogo.length);
  assert.ok(l.body.libros.length >= 3 && m.body.materiales.length >= 9);
  for (const it of [...l.body.libros, ...m.body.materiales]) {
    assert.equal(it.soloMiembros, true);
    assert.equal(it.desbloqueado, false);
    assert.ok(sinContenido(it), it.id);
  }
  const texto = JSON.stringify([l.body, m.body]);
  assert.equal(/\.pdf|drive\.google|[A-Za-z]:\\\\/.test(texto), false);
  const primero = l.body.libros[0].id;
  const cerrado = await request(app).get(`/api/libros/${primero}`).set(auth('token-sinplan'));
  assert.equal(cerrado.status, 403);
  assert.equal(cerrado.body.codigo, 'membresia-requerida');
});
