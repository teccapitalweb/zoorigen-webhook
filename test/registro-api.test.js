'use strict';

// Libro de registro de ejemplares: rutas /api/registro (sesión, membresía, aislamiento, validaciones, estado, informe, límites).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');
const logros = require('../services/logros');

const tokens = tokensDe('ana', 'beto', 'sinplan', 'vencida', 'admin');
const hoy = () => logros.fechaMexico(new Date());
const haceDias = n => logros.fechaMexico(new Date(Date.now() - n * 86400000));
const sumaDias = n => logros.fechaMexico(new Date(Date.now() + n * 86400000));

function servidor({ seed = {} } = {}) {
  return cargarServidor({
    tokens,
    seed: {
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
      'miembros/beto': miembroConPlan({ name: 'Beto Ruiz' }),
      'miembros/sinplan': miembroSinPlan(),
      'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
      'miembros/admin': miembroSinPlan({ role: 'admin' }),
      ...seed
    }
  });
}

const get = (app, ruta, t = 'token-ana') => request(app).get(ruta).set(auth(t));
const post = (app, ruta, cuerpo, t = 'token-ana') => request(app).post(ruta).set(auth(t)).send(cuerpo);
const patch = (app, ruta, cuerpo, t = 'token-ana') => request(app).patch(ruta).set(auth(t)).send(cuerpo);
const borrar = (app, ruta, t = 'token-ana') => request(app).delete(ruta).set(auth(t));

const ejemplarBase = (extra = {}) => ({
  nombreComun: 'Boa constrictor', nombreCientifico: 'Boa imperator', marca: 'ARETE-001', sexo: 'hembra',
  origen: 'Criadero autorizado', tipoIngreso: 'alta', fechaIngreso: haceDias(60), ...extra
});
async function crear(app, extra = {}, t = 'token-ana') {
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase(extra), t);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.ejemplar;
}
const claves = (db, prefijo) => [...db._data.keys()].filter(k => k.startsWith(prefijo));

// ── Sesión y membresía ──
const RUTAS = [
  ['get', '/api/registro'],
  ['post', '/api/registro/ejemplares'],
  ['patch', '/api/registro/ejemplares/abcdef012345'],
  ['delete', '/api/registro/ejemplares/abcdef012345'],
  ['post', '/api/registro/ejemplares/abcdef012345/eventos'],
  ['delete', '/api/registro/eventos/abcdef012345'],
  ['get', '/api/registro/informe?anio=2025']
];

test('registro: 401 sin sesión o con token falso, en todas las rutas', async () => {
  const { app } = servidor();
  for (const [metodo, ruta] of RUTAS) {
    const sin = await request(app)[metodo](ruta).send({});
    assert.equal(sin.status, 401, `${metodo} ${ruta}`);
    const falso = await request(app)[metodo](ruta).set(auth('falso')).send({});
    assert.equal(falso.status, 401, `${metodo} ${ruta}`);
  }
});

test('registro: 403 sin membresía (nunca tuvo o venció) en todas las rutas, y no escribe nada', async () => {
  const { app, db } = servidor();
  for (const t of ['token-sinplan', 'token-vencida']) {
    for (const [metodo, ruta] of RUTAS) {
      const res = await request(app)[metodo](ruta).set(auth(t)).send(ejemplarBase({ tipo: 'nota', fecha: hoy(), notas: 'x' }));
      assert.equal(res.status, 403, `${t} ${metodo} ${ruta}`);
      assert.equal(res.body.codigo, 'membresia-requerida');
      assert.match(res.headers['cache-control'], /no-store/);
    }
  }
  assert.deepEqual(claves(db, 'registrosUma/'), []);
});

test('registro: el administrador usa la herramienta aunque no tenga plan; sus datos son suyos', async () => {
  const { app, db } = servidor();
  const e = await crear(app, {}, 'token-admin');
  assert.equal((await get(app, '/api/registro', 'token-admin')).body.ejemplares.length, 1);
  assert.equal(db.value(`registrosUma/admin/ejemplares/${e.id}`).uid, 'admin');
});

test('registro: sin caché en todas las respuestas', async () => {
  const { app } = servidor();
  for (const r of [await get(app, '/api/registro'), await get(app, '/api/registro/informe?anio=2025'), await post(app, '/api/registro/ejemplares', {})]) {
    assert.match(r.headers['cache-control'], /no-store/);
  }
});

// ── GET /api/registro ──
test('GET /api/registro: vacío al principio, con límites', async () => {
  const { app } = servidor();
  const r = await get(app, '/api/registro');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.ejemplares, []);
  assert.deepEqual(r.body.eventos, []);
  assert.equal(r.body.resumen.activos, 0);
  assert.deepEqual(r.body.resumen.porEspecie, []);
  assert.deepEqual(r.body.limites, { maxEjemplares: 500, maxEventos: 5000 });
  assert.match(r.body.hoy, /^\d{4}-\d{2}-\d{2}$/);
});

// ── POST /api/registro/ejemplares ──
test('crear ejemplar: guarda con el uid del token, devuelve estado activo y aparece en el inventario', async () => {
  const { app, db } = servidor();
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase());
  assert.equal(r.status, 201);
  const e = r.body.ejemplar;
  assert.match(e.id, /^[0-9a-f]{24}$/);
  assert.equal(e.estado, 'activo');
  assert.equal(e.fechaSalida, null);
  assert.equal(e.nombreComun, 'Boa constrictor');
  assert.equal('uid' in e, false);
  const doc = db.value(`registrosUma/ana/ejemplares/${e.id}`);
  assert.equal(doc.uid, 'ana');
  assert.equal(doc.origen, 'Criadero autorizado');
  assert.equal(typeof doc.creado, 'string');

  const lista = await get(app, '/api/registro');
  assert.equal(lista.body.ejemplares.length, 1);
  assert.deepEqual(lista.body.resumen.porEspecie.map(f => [f.especie, f.activos, f.hembras]), [['Boa constrictor', 1, 1]]);
});

test('crear ejemplar: JAMÁS toma el uid (ni id, estado o creado) del cuerpo', async () => {
  const { app, db } = servidor();
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase({ uid: 'beto', id: 'robado-0001', estado: 'muerte', creado: 'x', 'uid ': 'beto' }));
  assert.equal(r.status, 201);
  assert.notEqual(r.body.ejemplar.id, 'robado-0001');
  assert.equal(r.body.ejemplar.estado, 'activo');
  assert.deepEqual(claves(db, 'registrosUma/beto'), []);
  const doc = db.value(`registrosUma/ana/ejemplares/${r.body.ejemplar.id}`);
  assert.equal(doc.uid, 'ana');
  assert.equal('estado' in doc, false);
  assert.equal(db.value('registrosUma/ana/ejemplares/robado-0001'), undefined);
});

test('crear ejemplar: validaciones con mensaje y campo', async () => {
  const { app, db } = servidor();
  const casos = [
    [{ nombreComun: '' }, 'nombreComun'], [{ origen: '' }, 'origen'], [{ tipoIngreso: 'compra' }, 'tipoIngreso'],
    [{ fechaIngreso: '2026-02-30' }, 'fechaIngreso'], [{ fechaIngreso: sumaDias(1) }, 'fechaIngreso'], [{ fechaIngreso: 'hoy' }, 'fechaIngreso'],
    [{ sexo: 'quizá' }, 'sexo'], [{ marca: 'm'.repeat(301) }, 'marca'], [{ notas: 'n'.repeat(1001) }, 'notas'], [{ nombreComun: 123 }, 'nombreComun']
  ];
  for (const [extra, campo] of casos) {
    const r = await post(app, '/api/registro/ejemplares', ejemplarBase(extra));
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.body.campo, campo);
    assert.ok(r.body.error);
  }
  for (const cuerpo of [{}, [], 'texto']) {
    const r = await request(app).post('/api/registro/ejemplares').set(auth('token-ana')).send(cuerpo);
    assert.equal(r.status, 400);
  }
  assert.deepEqual(claves(db, 'registrosUma/'), []);
});

test('crear ejemplar: JSON dañado o demasiado grande da un error claro, no un 500 ni HTML', async () => {
  const { app } = servidor();
  const dañado = await request(app).post('/api/registro/ejemplares').set(auth('token-ana')).set('Content-Type', 'application/json').send('{"nombreComun": ');
  assert.equal(dañado.status, 400);
  assert.match(dañado.headers['content-type'], /json/);
  assert.ok(dañado.body.error);
  const grande = await post(app, '/api/registro/ejemplares', ejemplarBase({ notas: 'x'.repeat(30000) }));
  assert.equal(grande.status, 413);
  assert.match(grande.headers['content-type'], /json/);
});

test('crear ejemplar: acepta nacimiento con su origen y 300 / 1000 caracteres exactos', async () => {
  const { app } = servidor();
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase({
    tipoIngreso: 'nacimiento', origen: 'Nacido en la unidad', nombreComun: 'n'.repeat(300), notas: 'z'.repeat(1000), fechaIngreso: hoy()
  }));
  assert.equal(r.status, 201);
  assert.equal(r.body.ejemplar.tipoIngreso, 'nacimiento');
  assert.equal(r.body.ejemplar.fechaIngreso, hoy());
});

test('crear ejemplar: los textos se guardan tal cual (el sitio los escapa) pero sin caracteres de control', async () => {
  const { app } = servidor();
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase({ nombre: '<img src=x onerror=alert(1)>', marca: 'A\u0000-1' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.ejemplar.nombre, '<img src=x onerror=alert(1)>');
  assert.equal(r.body.ejemplar.marca, 'A-1');
});

// ── Aislamiento entre personas ──
test('aislamiento: cada persona ve solo lo suyo y no puede tocar lo de otra (404)', async () => {
  const { app, db } = servidor();
  const deAna = await crear(app, { nombreComun: 'Boa de Ana' });
  const deBeto = await crear(app, { nombreComun: 'Iguana de Beto' }, 'token-beto');
  await post(app, `/api/registro/ejemplares/${deAna.id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'nota de Ana' });

  const verAna = await get(app, '/api/registro');
  assert.deepEqual(verAna.body.ejemplares.map(e => e.nombreComun), ['Boa de Ana']);
  assert.equal(verAna.body.eventos.length, 1);
  const verBeto = await get(app, '/api/registro', 'token-beto');
  assert.deepEqual(verBeto.body.ejemplares.map(e => e.nombreComun), ['Iguana de Beto']);
  assert.equal(verBeto.body.eventos.length, 0);
  assert.equal(JSON.stringify(verBeto.body).includes('Ana'), false);

  // Beto intenta usar el id de Ana por todas las rutas
  const antes = JSON.stringify([...db._data.entries()]);
  assert.equal((await patch(app, `/api/registro/ejemplares/${deAna.id}`, { nombreComun: 'Hackeada' }, 'token-beto')).status, 404);
  assert.equal((await post(app, `/api/registro/ejemplares/${deAna.id}/eventos`, { tipo: 'muerte', fecha: hoy() }, 'token-beto')).status, 404);
  assert.equal((await borrar(app, `/api/registro/ejemplares/${deAna.id}`, 'token-beto')).status, 404);
  const eventoAna = (await get(app, '/api/registro')).body.eventos[0];
  assert.equal((await borrar(app, `/api/registro/eventos/${eventoAna.id}`, 'token-beto')).status, 404);
  assert.equal(JSON.stringify([...db._data.entries()]), antes, 'nada cambió');

  // Y el informe de Beto no incluye lo de Ana
  const inf = await get(app, `/api/registro/informe?anio=${hoy().slice(0, 4)}`, 'token-beto');
  assert.deepEqual(inf.body.porEspecie.map(f => f.especie), ['Iguana de Beto']);
  assert.equal(deBeto.estado, 'activo');
});

test('ids de la URL: nada con separadores o rutas llega a Firestore', async () => {
  const { app, db } = servidor();
  const a = await crear(app);
  await crear(app, {}, 'token-beto');
  const antes = JSON.stringify([...db._data.entries()]);
  const raros = ['..%2Fbeto%2Fejemplares%2Fx', '%2e%2e%2fbeto', 'a%2Fb%2Fc%2Fdefgh', 'x', encodeURIComponent('ñandú1234'), 'a'.repeat(200), '%00abcdef1234', 'abcdef 123456'];
  for (const id of raros) {
    assert.equal((await patch(app, `/api/registro/ejemplares/${id}`, { marca: 'x' })).status, 404, id);
    assert.equal((await borrar(app, `/api/registro/ejemplares/${id}`)).status, 404, id);
    assert.equal((await post(app, `/api/registro/ejemplares/${id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'x' })).status, 404, id);
    assert.equal((await borrar(app, `/api/registro/eventos/${id}`)).status, 404, id);
  }
  assert.equal(JSON.stringify([...db._data.entries()]), antes);
  assert.equal(a.estado, 'activo');
});

// ── PATCH ──
test('editar ejemplar: cambia solo lo que se manda y conserva el uid', async () => {
  const { app, db } = servidor();
  const e = await crear(app);
  const r = await patch(app, `/api/registro/ejemplares/${e.id}`, { marca: 'ARETE-777', sexo: 'macho', uid: 'beto', estado: 'muerte', id: 'otro' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ejemplar.marca, 'ARETE-777');
  assert.equal(r.body.ejemplar.sexo, 'macho');
  assert.equal(r.body.ejemplar.nombreComun, 'Boa constrictor');
  assert.equal(r.body.ejemplar.estado, 'activo');
  assert.equal(r.body.ejemplar.id, e.id);
  const doc = db.value(`registrosUma/ana/ejemplares/${e.id}`);
  assert.equal(doc.uid, 'ana');
  assert.equal(doc.origen, 'Criadero autorizado');
  assert.deepEqual(claves(db, 'registrosUma/beto'), []);
});

test('editar ejemplar: validaciones, sin cambios y 404', async () => {
  const { app } = servidor();
  const e = await crear(app);
  const url = `/api/registro/ejemplares/${e.id}`;
  assert.equal((await patch(app, url, {})).status, 400);
  assert.equal((await patch(app, url, { uid: 'beto' })).status, 400, 'solo uid = sin cambios válidos');
  assert.equal((await patch(app, url, { nombreComun: '' })).status, 400);
  assert.equal((await patch(app, url, { origen: null })).status, 400);
  assert.equal((await patch(app, url, { fechaIngreso: sumaDias(2) })).status, 400);
  assert.equal((await patch(app, url, { marca: 'x'.repeat(301) })).status, 400);
  assert.equal((await patch(app, '/api/registro/ejemplares/aaaaaaaaaaaa', { marca: 'x' })).status, 404);
});

test('editar ejemplar: la fecha de ingreso no puede quedar después de un evento ya registrado', async () => {
  const { app } = servidor();
  const e = await crear(app, { fechaIngreso: haceDias(60) });
  await post(app, `/api/registro/ejemplares/${e.id}/eventos`, { tipo: 'nota', fecha: haceDias(30), notas: 'Revisión' });
  const mal = await patch(app, `/api/registro/ejemplares/${e.id}`, { fechaIngreso: haceDias(10) });
  assert.equal(mal.status, 400);
  assert.equal(mal.body.campo, 'fechaIngreso');
  const bien = await patch(app, `/api/registro/ejemplares/${e.id}`, { fechaIngreso: haceDias(45) });
  assert.equal(bien.status, 200);
  assert.equal(bien.body.ejemplar.fechaIngreso, haceDias(45));
});

// ── Eventos: estado ──
test('eventos: muerte, baja y traslado cambian el estado; la nota no', async () => {
  const { app } = servidor();
  for (const [tipo, extra] of [['muerte', {}], ['baja', { causa: 'Donación' }], ['traslado', { destino: 'UMA Norte' }]]) {
    const e = await crear(app, { nombreComun: `Especie ${tipo}` });
    const nota = await post(app, `/api/registro/ejemplares/${e.id}/eventos`, { tipo: 'nota', fecha: haceDias(5), notas: 'Control' });
    assert.equal(nota.status, 201);
    assert.equal(nota.body.ejemplar.estado, 'activo');
    const r = await post(app, `/api/registro/ejemplares/${e.id}/eventos`, { tipo, fecha: haceDias(2), ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.evento.tipo, tipo);
    assert.equal(r.body.ejemplar.estado, tipo);
    assert.equal(r.body.ejemplar.fechaSalida, haceDias(2));
  }
  const todo = await get(app, '/api/registro');
  assert.deepEqual(todo.body.ejemplares.map(e => e.estado).sort(), ['baja', 'muerte', 'traslado']);
  assert.equal(todo.body.resumen.activos, 0);
  assert.equal(todo.body.resumen.bajas, 1); assert.equal(todo.body.resumen.muertes, 1); assert.equal(todo.body.resumen.traslados, 1);
  assert.equal(todo.body.eventos.length, 6);
});

test('eventos: el evento guarda el uid del token y el ejemplar de la URL, sin importar el cuerpo', async () => {
  const { app, db } = servidor();
  const a = await crear(app);
  const otro = await crear(app, { nombreComun: 'Otro' });
  const r = await post(app, `/api/registro/ejemplares/${a.id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'hola', uid: 'beto', ejemplarId: otro.id, id: 'forzado-001' });
  assert.equal(r.status, 201);
  assert.equal(r.body.evento.ejemplarId, a.id);
  const doc = db.value(`registrosUma/ana/eventos/${r.body.evento.id}`);
  assert.equal(doc.uid, 'ana');
  assert.equal(doc.ejemplarId, a.id);
  assert.equal(db.value('registrosUma/ana/eventos/forzado-001'), undefined);
  assert.deepEqual(claves(db, 'registrosUma/beto'), []);
});

test('eventos: validaciones (tipo, nacimiento, fechas, obligatorios, largos)', async () => {
  const { app, db } = servidor();
  const e = await crear(app, { fechaIngreso: haceDias(60) });
  const url = `/api/registro/ejemplares/${e.id}/eventos`;
  const casos = [
    [{ tipo: 'nacimiento', fecha: hoy() }, 'tipo', /ejemplar nuevo/],
    [{ tipo: 'alta', fecha: hoy() }, 'tipo', /ejemplar nuevo/],
    [{ tipo: 'fuga', fecha: hoy() }, 'tipo'],
    [{ fecha: hoy(), notas: 'x' }, 'tipo'],
    [{ tipo: 'nota', fecha: sumaDias(1), notas: 'x' }, 'fecha', /futura/],
    [{ tipo: 'nota', fecha: '2026-02-30', notas: 'x' }, 'fecha'],
    [{ tipo: 'nota', fecha: haceDias(61), notas: 'x' }, 'fecha', /anterior al ingreso/],
    [{ tipo: 'nota', fecha: hoy() }, 'notas'],
    [{ tipo: 'baja', fecha: hoy() }, 'causa'],
    [{ tipo: 'traslado', fecha: hoy() }, 'destino'],
    [{ tipo: 'nota', fecha: hoy(), notas: 'n'.repeat(1001) }, 'notas'],
    [{ tipo: 'traslado', fecha: hoy(), destino: 'd'.repeat(301) }, 'destino']
  ];
  for (const [cuerpo, campo, texto] of casos) {
    const r = await post(app, url, cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
    assert.equal(r.body.campo, campo, JSON.stringify(cuerpo));
    if (texto) assert.match(r.body.error, texto);
  }
  assert.deepEqual(claves(db, 'registrosUma/ana/eventos/'), []);
  // el mismo día del ingreso y hoy sí
  assert.equal((await post(app, url, { tipo: 'nota', fecha: haceDias(60), notas: 'a' })).status, 201);
  assert.equal((await post(app, url, { tipo: 'nota', fecha: hoy(), notas: 'b' })).status, 201);
});

test('eventos: solo UNA salida por ejemplar (409); deshacerla permite registrar otra', async () => {
  const { app } = servidor();
  const e = await crear(app);
  const url = `/api/registro/ejemplares/${e.id}/eventos`;
  const muerte = await post(app, url, { tipo: 'muerte', fecha: haceDias(3), causa: 'Neumonía' });
  assert.equal(muerte.status, 201);
  const otra = await post(app, url, { tipo: 'traslado', fecha: haceDias(1), destino: 'Zoo' });
  assert.equal(otra.status, 409);
  assert.equal(otra.body.codigo, 'ya-tiene-salida');
  assert.equal((await post(app, url, { tipo: 'nota', fecha: haceDias(1), notas: 'Necropsia hecha' })).status, 201, 'las notas siguen permitidas');

  const quitar = await borrar(app, `/api/registro/eventos/${muerte.body.evento.id}`);
  assert.equal(quitar.status, 200);
  assert.equal(quitar.body.ejemplarId, e.id);
  const estado = (await get(app, '/api/registro')).body.ejemplares[0];
  assert.equal(estado.estado, 'activo');
  assert.equal((await post(app, url, { tipo: 'traslado', fecha: haceDias(1), destino: 'Zoo' })).status, 201);
});

test('eventos: dos salidas a la vez guardan solo una', async () => {
  const { app, db } = servidor();
  const e = await crear(app);
  const url = `/api/registro/ejemplares/${e.id}/eventos`;
  const [a, b] = await Promise.all([
    post(app, url, { tipo: 'muerte', fecha: hoy() }),
    post(app, url, { tipo: 'baja', fecha: hoy(), causa: 'Venta' })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(claves(db, 'registrosUma/ana/eventos/').length, 1);
});

// ── DELETE ejemplar ──
test('borrar ejemplar: se van también sus eventos y NO los de otros ejemplares ni de otras personas', async () => {
  const { app, db } = servidor();
  const a = await crear(app, { nombreComun: 'A' });
  const b = await crear(app, { nombreComun: 'B' });
  const deBeto = await crear(app, { nombreComun: 'C' }, 'token-beto');
  for (const e of [a, b]) {
    await post(app, `/api/registro/ejemplares/${e.id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'n1' });
    await post(app, `/api/registro/ejemplares/${e.id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'n2' });
  }
  await post(app, `/api/registro/ejemplares/${a.id}/eventos`, { tipo: 'muerte', fecha: hoy() });
  await post(app, `/api/registro/ejemplares/${deBeto.id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'de beto' }, 'token-beto');
  assert.equal(claves(db, 'registrosUma/ana/eventos/').length, 5);

  const r = await borrar(app, `/api/registro/ejemplares/${a.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.eventosEliminados, 3);
  assert.equal(db.value(`registrosUma/ana/ejemplares/${a.id}`), undefined);
  const resto = await get(app, '/api/registro');
  assert.deepEqual(resto.body.ejemplares.map(e => e.nombreComun), ['B']);
  assert.equal(resto.body.eventos.length, 2);
  assert.ok(resto.body.eventos.every(e => e.ejemplarId === b.id));
  assert.equal(claves(db, 'registrosUma/beto/eventos/').length, 1);
  assert.equal((await borrar(app, `/api/registro/ejemplares/${a.id}`)).status, 404);
});

test('borrar ejemplar con muchos eventos (más de un lote)', async () => {
  const seed = { 'registrosUma/ana/ejemplares/muchos-0001': { uid: 'ana', nombreComun: 'Pez', origen: 'x', tipoIngreso: 'alta', fechaIngreso: '2024-01-01', sexo: 'indeterminado' } };
  for (let i = 0; i < 850; i++) seed[`registrosUma/ana/eventos/ev-${String(i).padStart(6, '0')}`] = { uid: 'ana', ejemplarId: 'muchos-0001', tipo: 'nota', fecha: '2024-02-01', notas: String(i) };
  seed['registrosUma/ana/eventos/ev-ajeno-0001'] = { uid: 'ana', ejemplarId: 'otro-ejemplar', tipo: 'nota', fecha: '2024-02-01', notas: 'otro' };
  const { app, db } = servidor({ seed });
  const r = await borrar(app, '/api/registro/ejemplares/muchos-0001');
  assert.equal(r.status, 200);
  assert.equal(r.body.eventosEliminados, 850);
  assert.deepEqual(claves(db, 'registrosUma/ana/eventos/'), ['registrosUma/ana/eventos/ev-ajeno-0001']);
});

// ── Orphans ──
test('los eventos de un ejemplar que ya no existe no aparecen', async () => {
  const { app } = servidor({ seed: { 'registrosUma/ana/eventos/huerfano-001': { uid: 'ana', ejemplarId: 'no-existe-001', tipo: 'muerte', fecha: '2024-01-01' } } });
  const r = await get(app, '/api/registro');
  assert.deepEqual(r.body.eventos, []);
});

// ── Informe ──
const SEED_INFORME = (() => {
  const e = (id, nombreComun, fechaIngreso, tipoIngreso = 'alta') => [`registrosUma/ana/ejemplares/${id}`,
    { uid: 'ana', nombreComun, nombreCientifico: '', nombre: '', marca: '', sexo: 'indeterminado', origen: 'Criadero', tipoIngreso, fechaIngreso, notas: '', creado: `${fechaIngreso}T10:00:00.000Z`, actualizado: '' }];
  const v = (id, ejemplarId, tipo, fecha, extra = {}) => [`registrosUma/ana/eventos/${id}`,
    { uid: 'ana', ejemplarId, tipo, fecha, causa: '', destino: '', notas: '', creado: `${fecha}T12:00:00.000Z`, ...extra }];
  return Object.fromEntries([
    e('boa-e1-0001', 'Boa', '2023-05-10'),
    e('boa-e2-0002', 'Boa', '2024-12-31'),
    e('boa-e3-0003', 'Boa', '2025-03-01', 'nacimiento'),
    e('boa-e4-0004', 'Boa', '2025-04-01', 'nacimiento'),
    e('ig-e5-00005', 'Iguana', '2025-01-01'),
    e('ig-e6-00006', 'Iguana', '2025-12-31'),
    e('tor-e8-0008', 'Tortuga', '2020-01-01'),
    e('tor-e9-0009', 'Tortuga', '2020-01-01'),
    v('sal_boa-e2-0002', 'boa-e2-0002', 'traslado', '2025-01-01', { destino: 'UMA Norte' }),
    v('sal_boa-e4-0004', 'boa-e4-0004', 'muerte', '2025-06-01', { causa: 'Neumonía' }),
    v('sal_ig-e5-00005', 'ig-e5-00005', 'baja', '2025-12-31', { causa: 'Donación', destino: 'Zoo X' }),
    v('sal_tor-e8-0008', 'tor-e8-0008', 'muerte', '2024-06-01'),
    v('sal_tor-e9-0009', 'tor-e9-0009', 'baja', '2025-07-07', { causa: 'Venta' }),
    v('nota-0000001', 'boa-e1-0001', 'nota', '2025-02-02', { notas: 'Revisión' })
  ]);
})();
const numeros = f => [f.existenciasInicio, f.altas, f.nacimientos, f.bajas, f.muertes, f.traslados, f.existenciasFin];

test('informe: año completo por especie y total', async () => {
  const { app } = servidor({ seed: SEED_INFORME });
  const r = await get(app, '/api/registro/informe?anio=2025');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.anio, 2025);
  assert.equal(r.body.desde, '2025-01-01');
  assert.equal(r.body.hasta, '2025-12-31');
  assert.equal(r.body.enCurso, false);
  assert.deepEqual(r.body.porEspecie.map(f => f.especie), ['Boa', 'Iguana', 'Tortuga']);
  assert.deepEqual(numeros(r.body.porEspecie[0]), [2, 0, 2, 0, 1, 1, 2]);
  assert.deepEqual(numeros(r.body.porEspecie[1]), [0, 2, 0, 1, 0, 0, 1]);
  assert.deepEqual(numeros(r.body.porEspecie[2]), [1, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(numeros(r.body.total), [3, 2, 2, 2, 1, 1, 3]);
  assert.equal(r.body.movimientos.length, 8);
  assert.equal(r.body.movimientos[0].fecha, '2025-01-01');
});

test('informe: otro año usa los mismos datos con otras fechas de corte', async () => {
  const { app } = servidor({ seed: SEED_INFORME });
  const r = await get(app, '/api/registro/informe?anio=2024');
  assert.deepEqual(numeros(r.body.porEspecie.find(f => f.especie === 'Boa')), [1, 1, 0, 0, 0, 0, 2]);
  assert.deepEqual(numeros(r.body.porEspecie.find(f => f.especie === 'Tortuga')), [2, 0, 0, 0, 1, 0, 1]);
  const antes = await get(app, '/api/registro/informe?anio=2010');
  assert.deepEqual(antes.body.porEspecie, []);
  assert.deepEqual(numeros(antes.body.total), [0, 0, 0, 0, 0, 0, 0]);
});

test('informe: el año en curso se marca y corta en hoy', async () => {
  const { app } = servidor();
  const e = await crear(app, { fechaIngreso: haceDias(3) });
  await post(app, `/api/registro/ejemplares/${e.id}/eventos`, { tipo: 'nota', fecha: hoy(), notas: 'x' });
  const r = await get(app, `/api/registro/informe?anio=${hoy().slice(0, 4)}`);
  assert.equal(r.body.enCurso, true);
  assert.equal(r.body.corte, hoy());
});

test('informe: valida el año', async () => {
  const { app } = servidor();
  const anioFuturo = String(Number(hoy().slice(0, 4)) + 1);
  for (const q of ['', '?anio=', '?anio=abc', '?anio=1999', `?anio=${anioFuturo}`, '?anio=25', '?anio=2025&anio=2024', '?anio[a]=1', '?anio=2025%20OR%201=1', '?anio=20250']) {
    const r = await get(app, `/api/registro/informe${q}`);
    assert.equal(r.status, 400, q);
    assert.ok(r.body.error, q);
  }
});

// ── Límites ──
test('límite de ejemplares: 500 por persona; otra persona no se ve afectada', async () => {
  const seed = {};
  for (let i = 0; i < 500; i++) {
    seed[`registrosUma/ana/ejemplares/lleno-${String(i).padStart(5, '0')}`] = { uid: 'ana', nombreComun: `Especie ${i % 10}`, origen: 'x', tipoIngreso: 'alta', fechaIngreso: '2024-01-01', sexo: 'indeterminado' };
  }
  const { app } = servidor({ seed });
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase());
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'limite-ejemplares');
  assert.match(r.body.error, /500/);
  assert.equal((await post(app, '/api/registro/ejemplares', ejemplarBase(), 'token-beto')).status, 201);
  // al borrar uno vuelve a caber
  assert.equal((await borrar(app, '/api/registro/ejemplares/lleno-00000')).status, 200);
  assert.equal((await post(app, '/api/registro/ejemplares', ejemplarBase())).status, 201);
});

test('límite de eventos: 5000 por persona', async () => {
  const seed = { 'registrosUma/ana/ejemplares/evmax-00001': { uid: 'ana', nombreComun: 'Pez', origen: 'x', tipoIngreso: 'alta', fechaIngreso: '2024-01-01', sexo: 'indeterminado' } };
  for (let i = 0; i < 5000; i++) seed[`registrosUma/ana/eventos/n-${String(i).padStart(6, '0')}`] = { uid: 'ana', ejemplarId: 'evmax-00001', tipo: 'nota', fecha: '2024-02-01', notas: 'x', creado: '2024-02-01T00:00:00.000Z' };
  const { app } = servidor({ seed });
  const r = await post(app, '/api/registro/ejemplares/evmax-00001/eventos', { tipo: 'nota', fecha: hoy(), notas: 'una más' });
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'limite-eventos');
  const lista = await get(app, '/api/registro');
  assert.equal(lista.body.eventos.length, 5000);
  assert.equal(lista.body.ejemplares[0].estado, 'activo');
});

test('limitación por minuto: 30 lecturas y 40 escrituras por persona', async () => {
  const { app } = servidor();
  for (let i = 0; i < 30; i++) assert.equal((await get(app, '/api/registro')).status, 200, `lectura ${i}`);
  assert.equal((await get(app, '/api/registro')).status, 429);
  assert.equal((await get(app, '/api/registro', 'token-beto')).status, 200, 'otra persona no se ve afectada');
  for (let i = 0; i < 40; i++) assert.equal((await post(app, '/api/registro/ejemplares', {}, 'token-beto')).status, 400, `escritura ${i}`);
  const r = await post(app, '/api/registro/ejemplares', ejemplarBase(), 'token-beto');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Demasiadas solicitudes/);
});
