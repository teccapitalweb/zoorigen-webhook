'use strict';

// Reseñas de cursos: POST /api/resenas, GET /api/resenas/mias y GET /api/admin/resenas.
// Ejecutar: node --test test/resenas.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const { crearServicio, validarResena, crearLimitador, MAX_COMENTARIO } = require('../services/resenas');

const tokens = tokensDe('ana', 'otra', 'admin');
const CERT_NUEVO = { folio: 'ZOO-2026-AAAA1111', uid: 'ana', cursoId: 'curso-felinos', curso: 'Felinos de México', nombre: 'Ana', emitido: '2026-10-23T10:00:00.000Z' };
const CERT_VIEJO = { folio: 'ZOO-2026-BBBB2222', memberUid: 'otra', courseId: 'curso-aves', courseTitle: 'Aves rapaces', memberName: 'Otra', memberEmail: 'otra@example.com', issuedAt: '2026-10-23T10:00:00.000Z' };

function servidor(seed = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      tokens,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, otra: { emailVerified: true, email: 'otra@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }),
        'miembros/otra': miembroSinPlan({ name: 'Otra', email: 'otra@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin', email: 'admin@example.com' }),
        'certificados/ZOO-2026-AAAA1111': CERT_NUEVO,
        'certificados/ZOO-2026-BBBB2222': CERT_VIEJO,
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const publicar = (app, cuerpo, t = 'token-ana') => request(app).post('/api/resenas').set(auth(t)).send(cuerpo);
const mias = (app, t = 'token-ana') => request(app).get('/api/resenas/mias').set(auth(t));
const todas = (app, t = 'token-admin') => request(app).get('/api/admin/resenas').set(auth(t));

test('servicio: valida estrellas de 1 a 5, el curso y limpia el comentario', () => {
  assert.deepEqual(validarResena({ cursoId: 'curso-felinos', estrellas: 5, comentario: '  Muy bueno  ' }), { cursoId: 'curso-felinos', estrellas: 5, comentario: 'Muy bueno' });
  assert.equal(validarResena({ cursoId: 'a', estrellas: '4' }).estrellas, 4, 'acepta el número como texto');
  assert.equal(validarResena({ cursoId: 'a', estrellas: 3 }).comentario, '', 'el comentario es opcional');
  for (const mala of [0, 6, 2.5, 'x', null, undefined]) assert.throws(() => validarResena({ cursoId: 'a', estrellas: mala }), e => e.status === 400, 'estrellas ' + mala);
  for (const malo of ['', 'a/b', '../x', 'x'.repeat(81), null]) assert.throws(() => validarResena({ cursoId: malo, estrellas: 3 }), e => e.status === 400, 'curso ' + malo);
  assert.throws(() => validarResena({ cursoId: 'a', estrellas: 3, comentario: { x: 1 } }), e => e.status === 400);
  assert.equal(validarResena({ cursoId: 'a', estrellas: 3, comentario: 'x'.repeat(MAX_COMENTARIO + 200) }).comentario.length, MAX_COMENTARIO);
  assert.equal(validarResena({ cursoId: 'a', estrellas: 3, comentario: 'uno\r\n\n\n\n\ndos' }).comentario, 'uno\n\ndos');
});

test('servicio: el limitador frena el abuso pero no a una persona normal', () => {
  let t = 0;
  const limitar = crearLimitador({ ahora: () => t, max: 3 });
  limitar('u'); limitar('u'); limitar('u');
  assert.throws(() => limitar('u'), e => e.status === 429);
  limitar('otra');
  t = 3600001; limitar('u');
});

test('servicio: sin uid no guarda (401)', async () => {
  const { db } = servidor();
  await assert.rejects(() => crearServicio({ db }).guardar({ uid: '', cursoId: 'curso-felinos', estrellas: 5 }), e => e.status === 401);
});

test('sin sesión 401 en las tres rutas; una persona que no es administradora no lee todas (403)', async () => {
  const { app } = servidor();
  assert.equal((await request(app).post('/api/resenas').send({ cursoId: 'curso-felinos', estrellas: 5 })).status, 401);
  assert.equal((await request(app).get('/api/resenas/mias')).status, 401);
  assert.equal((await request(app).get('/api/admin/resenas')).status, 401);
  assert.equal((await todas(app, 'token-ana')).status, 403);
});

test('solo quien terminó el curso (tiene su certificado) lo puede calificar', async () => {
  const { app, db } = servidor();
  const sin = await publicar(app, { cursoId: 'curso-aves', estrellas: 5 });                  // Ana no tiene ese certificado
  assert.equal(sin.status, 403);
  assert.equal((await publicar(app, { cursoId: 'no-existe', estrellas: 5 })).status, 403);
  assert.equal((await publicar(app, { cursoId: 'curso-felinos', estrellas: 5 }, 'token-otra')).status, 403, 'el certificado es de otra persona');
  assert.equal(db.value('resenas/ana__curso-aves'), undefined);
  const ok = await publicar(app, { cursoId: 'curso-felinos', estrellas: 4, comentario: 'Buen curso' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.ok, ok.body.cursoId, ok.body.estrellas, ok.body.comentario, ok.body.actualizada], [true, 'curso-felinos', 4, 'Buen curso', false]);
});

test('los certificados anteriores (que escribía el navegador: memberUid y courseId) también valen', async () => {
  const { app, db } = servidor();
  const r = await publicar(app, { cursoId: 'curso-aves', estrellas: 5 }, 'token-otra');
  assert.equal(r.status, 200);
  const x = db.value('resenas/otra__curso-aves');
  assert.deepEqual([x.curso, x.estrellas, x.email], ['Aves rapaces', 5, 'otra@example.com']);
});

test('estrellas fuera de 1 a 5, curso raro o comentario que no es texto: 400 y nada se guarda', async () => {
  const { app, db } = servidor();
  for (const estrellas of [0, 6, 2.5, 'x', null]) assert.equal((await publicar(app, { cursoId: 'curso-felinos', estrellas })).status, 400, 'estrellas ' + estrellas);
  assert.equal((await publicar(app, { cursoId: '../x', estrellas: 3 })).status, 400);
  assert.equal((await publicar(app, { cursoId: 'curso-felinos', estrellas: 3, comentario: { a: 1 } })).status, 400);
  assert.equal(db.value('resenas/ana__curso-felinos'), undefined);
});

test('una reseña por persona y curso: volver a calificar la actualiza y conserva la fecha original; el comentario es opcional y de hasta 500', async () => {
  const { app, db } = servidor();
  const primera = await publicar(app, { cursoId: 'curso-felinos', estrellas: 3 });
  assert.equal(primera.body.comentario, '');
  const antes = db.value('resenas/ana__curso-felinos');
  await new Promise(r => setTimeout(r, 5));
  const segunda = await publicar(app, { cursoId: 'curso-felinos', estrellas: 5, comentario: 'x'.repeat(900) });
  assert.equal(segunda.status, 200);
  assert.equal(segunda.body.actualizada, true);
  assert.equal(segunda.body.comentario.length, MAX_COMENTARIO);
  const despues = db.value('resenas/ana__curso-felinos');
  assert.equal(despues.estrellas, 5);
  assert.equal(despues.creadaMs, antes.creadaMs);
  assert.ok(despues.actualizadaMs >= antes.actualizadaMs);
  assert.equal(despues.nombre, 'Ana');
  assert.equal(despues.email, 'ana@example.com');
  assert.equal(despues.curso, 'Felinos de México');
});

test('"mias": la persona ve solo lo que calificó ella; el administrador no se la pide a nadie', async () => {
  const { app } = servidor();
  assert.deepEqual((await mias(app)).body.resenas, []);
  await publicar(app, { cursoId: 'curso-felinos', estrellas: 2, comentario: 'Regular' });
  await publicar(app, { cursoId: 'curso-aves', estrellas: 5 }, 'token-otra');
  const r = await mias(app);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.resenas, [{ cursoId: 'curso-felinos', estrellas: 2, comentario: 'Regular' }]);
});

test('"mias" también trae los cursos que ya terminó (con el título del certificado), del más reciente al más antiguo, de los dos esquemas de certificado', async () => {
  const { app } = servidor({
    'certificados/ZOO-2026-CCCC3333': { folio: 'ZOO-2026-CCCC3333', uid: 'ana', cursoId: 'curso-aves', curso: 'Aves rapaces', emitido: '2026-10-25T10:00:00.000Z' },
    'certificados/ZOO-2026-DDDD4444': { folio: 'ZOO-2026-DDDD4444', memberUid: 'ana', courseId: 'curso-reptiles', courseTitle: 'Reptiles', issuedAt: '2026-09-01T10:00:00.000Z' },
    'certificados/ZOO-2026-EEEE5555': { folio: 'ZOO-2026-EEEE5555', uid: 'ana', cursoId: '../raro', curso: 'No debe salir', emitido: '2026-10-26T10:00:00.000Z' }
  });
  const r = await mias(app);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.terminados.map(x => [x.cursoId, x.curso]), [['curso-aves', 'Aves rapaces'], ['curso-felinos', 'Felinos de México'], ['curso-reptiles', 'Reptiles']]);
  assert.equal(r.body.terminados[0].emitidoMs, Date.parse('2026-10-25T10:00:00.000Z'));
  assert.deepEqual((await mias(app, 'token-admin')).body.terminados, [], 'cada quien ve solo lo suyo');
});

test('administración: recibe todas, las más recientes primero, con nombre, correo y curso; los comentarios llegan como texto', async () => {
  const { app } = servidor();
  await publicar(app, { cursoId: 'curso-felinos', estrellas: 2, comentario: '<img src=x onerror=alert(1)>' });
  await new Promise(r => setTimeout(r, 5));
  await publicar(app, { cursoId: 'curso-aves', estrellas: 5 }, 'token-otra');
  const r = await todas(app);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.resenas.map(x => x.uid), ['otra', 'ana']);
  assert.deepEqual(Object.keys(r.body.resenas[1]).sort(), ['actualizadaMs', 'comentario', 'creadaMs', 'curso', 'cursoId', 'email', 'estrellas', 'nombre', 'uid']);
  assert.equal(r.body.resenas[1].comentario, '<img src=x onerror=alert(1)>', 'se guarda tal cual: el panel lo escapa al mostrarlo');
  assert.equal((await todas(app, 'token-admin')).body.resenas.length, 2);
});

test('límite de 20 reseñas por hora por persona (429) sin afectar a otra', async () => {
  const { app } = servidor();
  let ultimo;
  for (let i = 0; i < 21; i++) ultimo = await publicar(app, { cursoId: 'curso-felinos', estrellas: 3 });
  assert.equal(ultimo.status, 429);
  assert.equal((await publicar(app, { cursoId: 'curso-aves', estrellas: 4 }, 'token-otra')).status, 200);
});
