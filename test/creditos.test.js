'use strict';

// Créditos: regalo manual del administrador (100 fijos), canje por UN material sin curso y acceso a lo canjeado.
// Ejecutar: node --test test/creditos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias } = require('./helpers/club');
const { carpetaLibros, carpetaMateriales, libroValido, materialValido } = require('./helpers/materiales');
const creditos = require('../services/creditos');

const tokens = tokensDe('ana', 'sinplan', 'noverif', 'otra', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const DRIVE_ID = 'abcdefghij1234567890';

const catalogo = () => [
  materialValido('guia-miembros', 'miembros'),
  materialValido('plantilla-5', 'retos', 5, { tipo: 'plantilla' }),
  materialValido('presentacion-30', 'retos', 30, { tipo: 'presentacion' }),
  materialValido('guia-del-curso', 'curso', undefined, { cursoId: 'curso-uno', clase: 1 })
];

function servidor({ seed = {}, usuarios = {} } = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: { LIBROS_DIR: carpetaLibros([libroValido('libro-a', 5), libroValido('libro-b', 10)]), MATERIALES_DIR: carpetaMateriales(catalogo()) }, tokens,
      usuariosAuth: {
        ana: { emailVerified: true, email: 'ana@example.com' }, sinplan: { emailVerified: true, email: 'sinplan@example.com' },
        noverif: { emailVerified: false, email: 'noverif@example.com' }, otra: { emailVerified: true, email: 'otra@example.com' },
        admin: { emailVerified: true, email: 'admin@example.com' }, ...usuarios
      },
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com', createdAt: new Date(Date.now() - 5 * 86400000).toISOString() }),
        'miembros/sinplan': miembroSinPlan({ name: 'Sin Plan', email: 'sinplan@example.com', createdAt: new Date(Date.now() - 2 * 86400000).toISOString() }),
        'miembros/noverif': miembroSinPlan({ name: 'No Verificada', email: 'noverif@example.com', createdAt: new Date(Date.now() - 1 * 86400000).toISOString() }),
        'miembros/otra': miembroSinPlan({ name: 'Otra Persona', email: 'otra@example.com', createdAt: new Date(Date.now() - 9 * 86400000).toISOString() }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin' }),
        'cursos/curso-uno': { title: 'Curso Uno', lecciones: [{ title: 'A' }, { title: 'B' }] },
        'pdfs/drive-libre': { title: 'PDF de Drive sin curso', driveId: DRIVE_ID, pages: 4, createdAt: new Date().toISOString() },
        'pdfs/drive-de-curso': { title: 'PDF de Drive de un curso', driveId: DRIVE_ID, cursoId: 'curso-uno', clase: 1, createdAt: new Date().toISOString() },
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}

let n = 0;
const op = () => 'operacion-' + String(++n).padStart(6, '0');
const regalar = (app, uid, clave = op(), t = 'token-admin') => request(app).post('/api/admin/creditos/regalar').set(auth(t)).send({ uid, clave });
const estado = (app, t = 'token-ana') => request(app).get('/api/creditos/estado').set(auth(t));
const canjear = (app, materialId, t = 'token-ana') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const archivo = (app, id, t) => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t));
const movimientos = db => [...db._data.keys()].filter(k => k.startsWith('creditosMovimientos/')).map(k => db.value(k));

/* ───────────────────────── Reglas puras ───────────────────────── */

test('constantes: se regalan 100, cada material cuesta 100, sin caducidad y con tope diario', () => {
  assert.equal(creditos.REGALO, 100);
  assert.equal(creditos.COSTO_MATERIAL, 100);
  assert.equal(creditos.CADUCIDAD_DIAS, null);
  assert.ok(creditos.TOPE_REGALOS_POR_DIA >= 1);
});

test('catalogoCanjeable: libros y materiales sin curso; fuera lo ligado a un curso y lo de Drive con la liga mal escrita', () => {
  const lista = creditos.catalogoCanjeable({
    libros: [{ id: 'l1', titulo: 'Libro 1', categoria: 'Ley', paginas: [1, 2, 3] }],
    materiales: [{ id: 'm1', titulo: 'M1', area: 'A', acceso: 'miembros', tipo: 'guia', paginas: 2 }, { id: 'm2', titulo: 'M2', area: 'A', acceso: 'curso', cursoId: 'c1', clase: 2 }],
    drive: [{ id: 'd1', titulo: 'D1', area: 'G', paginas: 1 }, { id: 'd2', titulo: 'D2', cursoId: 'c1' }, { id: 'd3', titulo: 'D3', configuracionInvalida: true }]
  });
  assert.deepEqual(lista.map(x => x.clave), ['libro:l1', 'pdf:m1', 'drive:d1']);
});

test('analizarClave: solo libro:, pdf: y drive: con ids seguros', () => {
  assert.deepEqual(creditos.analizarClave('pdf:guia-1'), { tipo: 'pdf', id: 'guia-1', clave: 'pdf:guia-1' });
  for (const malo of ['guia-1', 'curso:abc', 'pdf:', 'pdf:../x', 'pdf:a b', 'pdf:' + 'a'.repeat(90), null, 5, {}]) assert.equal(creditos.analizarClave(malo), null, String(malo));
});

test('historialDeRegalos: el regalo n se empareja con el canje n de la misma persona y salen del más reciente al más antiguo', () => {
  const mov = [
    { id: 'r1', tipo: 'regalo', uid: 'a', cantidad: 100, enMs: 1000, en: new Date(1000), adminCorreo: 'x@y.z' },
    { id: 'r2', tipo: 'regalo', uid: 'a', cantidad: 100, enMs: 3000, en: new Date(3000) },
    { id: 'c1', tipo: 'canje', uid: 'a', cantidad: 100, enMs: 2000, en: new Date(2000), materialId: 'pdf:m1', materialTitulo: 'M1' },
    { id: 'r3', tipo: 'regalo', uid: 'b', cantidad: 100, enMs: 2500, en: new Date(2500) }
  ];
  const h = creditos.historialDeRegalos(mov);
  assert.deepEqual(h.map(x => [x.id, x.estado]), [['r2', 'pendiente'], ['r3', 'pendiente'], ['r1', 'canjeado']]);
  assert.equal(h[2].canje.titulo, 'M1');
});

test('metricas: regalados, canjeados, pendientes y canjes por material (de más a menos)', () => {
  const m = creditos.metricas([
    { tipo: 'regalo', cantidad: 100 }, { tipo: 'regalo', cantidad: 100 }, { tipo: 'regalo', cantidad: 100 },
    { tipo: 'canje', cantidad: 100, materialId: 'pdf:a', materialTitulo: 'A' }, { tipo: 'canje', cantidad: 100, materialId: 'pdf:b', materialTitulo: 'B' }, { tipo: 'canje', cantidad: 100, materialId: 'pdf:b', materialTitulo: 'B' }
  ]);
  assert.equal(m.regalados, 300); assert.equal(m.canjeados, 300); assert.equal(m.pendientes, 0);
  assert.deepEqual(m.materiales.map(x => [x.titulo, x.canjes]), [['B', 2], ['A', 1]]);
  assert.deepEqual(creditos.metricas([]), { regalados: 0, canjeados: 0, pendientes: 0, regalos: 0, canjes: 0, materiales: [] });
});

/* ───────────────────────── Regalar ───────────────────────── */

test('regalar: solo administración (401 sin sesión, 403 a una persona); no se puede elegir la cantidad', async () => {
  const { app, db } = servidor();
  assert.equal((await request(app).post('/api/admin/creditos/regalar').send({ uid: 'ana', clave: op() })).status, 401);
  assert.equal((await regalar(app, 'ana', op(), 'token-ana')).status, 403);
  assert.equal(db.value('creditosCuentas/ana'), undefined);
  const r = await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'ana', clave: op(), cantidad: 5000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.saldo, 100, 'siempre 100');
  assert.equal(r.body.cantidad, 100);
});

test('regalar: suma 100 a una cuenta con o sin membresía, anota el movimiento, la bitácora y deja el aviso pendiente', async () => {
  const { app, db } = servidor();
  assert.equal((await regalar(app, 'ana')).body.saldo, 100);
  assert.equal((await regalar(app, 'sinplan')).body.saldo, 100);
  const cuenta = db.value('creditosCuentas/sinplan');
  assert.equal(cuenta.saldo, 100); assert.equal(cuenta.avisoPendiente, 100); assert.equal(cuenta.regalados, 100);
  const movs = movimientos(db).filter(m => m.uid === 'sinplan');
  assert.equal(movs.length, 1);
  assert.equal(movs[0].tipo, 'regalo'); assert.equal(movs[0].cantidad, 100); assert.equal(movs[0].adminUid, 'admin'); assert.ok(movs[0].en);
  const acciones = [...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).map(k => db.value(k)).filter(a => a.accion === 'creditos-regalar');
  assert.equal(acciones.length, 2);
  assert.match(acciones[0].resumen, /Regaló 100 créditos a/);
});

test('regalar: la misma operación repetida (doble clic) no regala dos veces; otra operación sí suma', async () => {
  const { app, db } = servidor();
  const clave = op();
  const [a, b] = await Promise.all([regalar(app, 'ana', clave), regalar(app, 'ana', clave)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(db.value('creditosCuentas/ana').saldo, 100, 'solo un regalo');
  assert.equal(movimientos(db).filter(m => m.tipo === 'regalo').length, 1);
  assert.ok([a.body.repetido, b.body.repetido].includes(true));
  assert.equal((await regalar(app, 'ana', op())).body.saldo, 200, 'otro regalo, otra operación');
});

test('regalar: tope de regalos por cuenta y por día', async () => {
  const { app, db } = servidor();
  for (let i = 0; i < creditos.TOPE_REGALOS_POR_DIA; i++) assert.equal((await regalar(app, 'ana')).status, 200);
  const r = await regalar(app, 'ana');
  assert.equal(r.status, 429);
  assert.equal(r.body.codigo, 'tope-diario');
  assert.equal(db.value('creditosCuentas/ana').saldo, creditos.TOPE_REGALOS_POR_DIA * 100);
  assert.equal((await regalar(app, 'otra')).status, 200, 'el tope es por cuenta');
});

test('regalar: rechaza cuenta sin correo confirmado, cuenta inexistente, administradores, id raro y clave faltante', async () => {
  const { app, db } = servidor();
  const nv = await regalar(app, 'noverif');
  assert.equal(nv.status, 409); assert.equal(nv.body.codigo, 'correo-no-verificado');
  assert.equal(db.value('creditosCuentas/noverif'), undefined);
  assert.equal((await regalar(app, 'fantasma')).status, 404);
  assert.equal((await regalar(app, 'admin')).status, 409);
  assert.equal((await regalar(app, '../x')).status, 400);
  assert.equal((await regalar(app, 'ana', 'corta')).status, 400);
  assert.equal((await request(app).post('/api/admin/creditos/regalar').set(auth('token-admin')).send({ uid: 'ana' })).status, 400);
  assert.equal(movimientos(db).length, 0);
});

/* ───────────────────────── Estado de la persona ───────────────────────── */

test('estado: sin sesión 401; sin regalos saldo 0; con regalo, saldo, aviso pendiente y materiales canjeables sin los de curso', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/creditos/estado')).status, 401);
  const e0 = await estado(app, 'token-sinplan');
  assert.equal(e0.body.saldo, 0); assert.equal(e0.body.avisoPendiente, 0); assert.equal(e0.body.costo, 100);
  await regalar(app, 'sinplan');
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.saldo, 100); assert.equal(e.body.avisoPendiente, 100);
  assert.match(e.headers['cache-control'], /no-store/);
  assert.deepEqual(e.body.materiales.map(m => m.clave).sort(), ['drive:drive-libre', 'libro:libro-a', 'libro:libro-b', 'pdf:guia-miembros', 'pdf:plantilla-5', 'pdf:presentacion-30']);
  assert.ok(e.body.materiales.every(m => m.costo === 100 && m.desbloqueado === false));
  assert.ok(!JSON.stringify(e.body).includes('guia-del-curso') && !JSON.stringify(e.body).includes('drive-de-curso'), 'lo de un curso nunca se ofrece');
  assert.doesNotMatch(JSON.stringify(e.body), new RegExp(DRIVE_ID), 'sin ids ni enlaces de Drive');
});

test('estado: lo que la persona ya abre por membresía o retos NO se ofrece para canjear', async () => {
  const { app } = servidor({ seed: retosDe('ana', 6) });
  const e = await estado(app, 'token-ana');
  const claves = e.body.materiales.map(m => m.clave);
  assert.ok(!claves.includes('pdf:guia-miembros'), 'con membresía ya abre los de miembros');
  assert.ok(!claves.includes('pdf:plantilla-5') && !claves.includes('libro:libro-a'), 'con 6 retos ya abre lo de 5');
  assert.ok(claves.includes('pdf:presentacion-30') && claves.includes('libro:libro-b'), 'lo que todavía le pide más retos sí se puede canjear');
});

/* ───────────────────────── Canjear ───────────────────────── */

test('canjear: sin saldo 402 (te faltan créditos) y no se crea nada', async () => {
  const { app, db } = servidor();
  const r = await canjear(app, 'pdf:plantilla-5', 'token-sinplan');
  assert.equal(r.status, 402);
  assert.equal(r.body.codigo, 'saldo-insuficiente');
  assert.match(r.body.error, /faltan créditos/);
  assert.equal(db.value('creditosDesbloqueos/sinplan__pdf__plantilla-5'), undefined);
});

test('canjear: descuenta 100, desbloquea SOLO ese material para esa cuenta y anota el movimiento', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan');
  // antes: sin membresía no abre nada
  assert.equal((await archivo(app, 'plantilla-5', 'token-sinplan')).status, 403);
  const r = await canjear(app, 'pdf:plantilla-5', 'token-sinplan');
  assert.equal(r.status, 200);
  assert.equal(r.body.saldo, 0); assert.equal(r.body.titulo, 'Material plantilla-5');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  assert.equal(db.value('creditosCuentas/sinplan').canjeados, 100);
  assert.ok(db.value('creditosDesbloqueos/sinplan__pdf__plantilla-5'));
  const canje = movimientos(db).find(m => m.tipo === 'canje');
  assert.equal(canje.uid, 'sinplan'); assert.equal(canje.cantidad, 100); assert.equal(canje.materialId, 'pdf:plantilla-5');
  // después: ESE material abre (aunque no tenga membresía ni retos); los demás siguen cerrados
  const abre = await archivo(app, 'plantilla-5', 'token-sinplan');
  assert.equal(abre.status, 200);
  assert.match(abre.headers['content-type'], /pdf/);
  assert.equal((await archivo(app, 'presentacion-30', 'token-sinplan')).status, 403);
  assert.equal((await archivo(app, 'guia-miembros', 'token-sinplan')).status, 403);
  // otra persona sin ese canje sigue sin abrirlo
  assert.equal((await archivo(app, 'plantilla-5', 'token-otra')).status, 403);
  // la lista lo marca desbloqueado, sin candado de «solo miembros», y no lo ofrece otra vez
  const lista = await request(app).get('/api/materiales').set(auth('token-sinplan'));
  const m = lista.body.materiales.find(x => x.id === 'plantilla-5');
  assert.equal(m.desbloqueado, true); assert.equal(m.soloMiembros, false); assert.equal(m.porCreditos, true);
  assert.equal(lista.body.materiales.find(x => x.id === 'presentacion-30').desbloqueado, false);
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.materiales.find(x => x.clave === 'pdf:plantilla-5').desbloqueado, true);
});

test('canjear: un libro y un PDF de Drive también se abren con lo canjeado, y solo ellos', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan');
  assert.equal((await request(app).get('/api/libros/libro-a').set(auth('token-sinplan'))).status, 403);
  assert.equal((await canjear(app, 'libro:libro-a', 'token-sinplan')).status, 200);
  const libro = await request(app).get('/api/libros/libro-a').set(auth('token-sinplan'));
  assert.equal(libro.status, 200);
  assert.match(JSON.stringify(libro.body), /Texto secreto 1 de libro-a/);
  assert.equal((await request(app).get('/api/libros/libro-b').set(auth('token-sinplan'))).status, 403);
  assert.equal((await request(app).get('/api/materiales/drive/drive-libre/enlace').set(auth('token-sinplan'))).status, 403);
  assert.equal((await canjear(app, 'drive:drive-libre', 'token-sinplan')).status, 200);
  const enlace = await request(app).get('/api/materiales/drive/drive-libre/enlace').set(auth('token-sinplan'));
  assert.equal(enlace.status, 200);
  assert.match(enlace.body.url, /drive\.google\.com/);
  assert.equal((await request(app).get('/api/materiales/drive/drive-de-curso/enlace').set(auth('token-sinplan'))).status, 403, 'el de un curso sigue por la clase');
});

test('canjear: un material ligado a un curso, uno que no existe o una clave rara no se pueden canjear', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan');
  for (const [clave, status] of [['pdf:guia-del-curso', 404], ['drive:drive-de-curso', 404], ['pdf:no-existe', 404], ['oficial:nom-059', 400], ['pdf:../x', 400], ['', 400]]) {
    const r = await canjear(app, clave, 'token-sinplan');
    assert.equal(r.status, status, clave);
  }
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 100, 'no se gastó nada');
  assert.equal((await request(app).post('/api/creditos/canjear').set(auth('token-sinplan')).send({})).status, 400);
});

test('canjear: si ya lo abre por membresía o retos, no gasta créditos (409 ya-accesible)', async () => {
  const { app, db } = servidor({ seed: retosDe('ana', 6) });
  await regalar(app, 'ana');
  const r = await canjear(app, 'pdf:plantilla-5', 'token-ana');
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'ya-accesible');
  assert.equal(db.value('creditosCuentas/ana').saldo, 100);
  assert.equal((await canjear(app, 'pdf:presentacion-30', 'token-ana')).status, 200, 'lo que aún le pide más retos sí');
});

test('canjear: el mismo material dos veces no cobra dos veces; un segundo regalo permite canjear otro material', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan');
  assert.equal((await canjear(app, 'pdf:guia-miembros', 'token-sinplan')).status, 200);
  const otra = await canjear(app, 'pdf:guia-miembros', 'token-sinplan');
  assert.equal(otra.status, 409); assert.equal(otra.body.codigo, 'ya-desbloqueado');
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 100, 'solo se descontó una vez');
  assert.equal((await canjear(app, 'pdf:plantilla-5', 'token-sinplan')).status, 200);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  assert.equal((await canjear(app, 'pdf:presentacion-30', 'token-sinplan')).status, 402);
});

test('canjear: concurrencia — dos canjes del mismo material a la vez cobran una sola vez; con 100 de saldo, solo uno de dos materiales distintos', async () => {
  const { app, db } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan');
  const [a, b] = await Promise.all([canjear(app, 'pdf:guia-miembros', 'token-sinplan'), canjear(app, 'pdf:guia-miembros', 'token-sinplan')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 100);
  const { app: app2, db: db2 } = servidor();
  await regalar(app2, 'otra');
  const [c, d] = await Promise.all([canjear(app2, 'pdf:plantilla-5', 'token-otra'), canjear(app2, 'pdf:presentacion-30', 'token-otra')]);
  assert.deepEqual([c.status, d.status].sort(), [200, 402]);
  assert.equal(db2.value('creditosCuentas/otra').saldo, 0);
  assert.equal(movimientos(db2).filter(m => m.tipo === 'canje').length, 1);
});

test('canjear: no se puede canjear en nombre de otra cuenta ni con la cuenta de otro (el uid sale de la sesión)', async () => {
  const { app, db } = servidor();
  await regalar(app, 'ana');
  const r = await request(app).post('/api/creditos/canjear').set(auth('token-sinplan')).send({ materialId: 'pdf:plantilla-5', uid: 'ana' });
  assert.equal(r.status, 402, 'sinplan no tiene saldo; el uid del cuerpo se ignora');
  assert.equal(db.value('creditosCuentas/ana').saldo, 100);
});

/* ───────────────────────── Aviso de felicitación ───────────────────────── */

test('aviso-visto: marca la felicitación como vista en el servidor; un regalo nuevo vuelve a avisar', async () => {
  const { app } = servidor();
  assert.equal((await request(app).post('/api/creditos/aviso-visto')).status, 401);
  await regalar(app, 'sinplan');
  assert.equal((await estado(app, 'token-sinplan')).body.avisoPendiente, 100);
  assert.equal((await request(app).post('/api/creditos/aviso-visto').set(auth('token-sinplan')).send({})).status, 200);
  const e = await estado(app, 'token-sinplan');
  assert.equal(e.body.avisoPendiente, 0); assert.equal(e.body.saldo, 100, 'ver el aviso no cambia el saldo');
  await regalar(app, 'sinplan');
  assert.equal((await estado(app, 'token-sinplan')).body.avisoPendiente, 100);
  // sin cuenta de créditos no falla
  assert.equal((await request(app).post('/api/creditos/aviso-visto').set(auth('token-otra')).send({})).status, 200);
});

/* ───────────────────────── Panel ───────────────────────── */

test('admin: miembros con saldo, de la cuenta más reciente a la más antigua, sin administradores; las personas no entran', async () => {
  const { app } = servidor();
  await regalar(app, 'otra');
  assert.equal((await request(app).get('/api/admin/creditos/miembros')).status, 401);
  assert.equal((await request(app).get('/api/admin/creditos/miembros').set(auth('token-ana'))).status, 403);
  const r = await request(app).get('/api/admin/creditos/miembros').set(auth('token-admin'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.miembros.map(m => m.uid), ['noverif', 'sinplan', 'ana', 'otra']);
  const otra = r.body.miembros.find(m => m.uid === 'otra');
  assert.equal(otra.saldo, 100); assert.ok(otra.ultimoRegalo); assert.equal(otra.correo, 'otra@example.com');
  assert.equal(r.body.miembros.find(m => m.uid === 'ana').saldo, 0);
  assert.equal(r.body.regalo, 100);
});

test('admin: historial de regalos con Pendiente / Canjeado, el material y la fecha de canje; filtros, búsqueda y paginación', async () => {
  const { app } = servidor();
  await regalar(app, 'sinplan'); await regalar(app, 'sinplan'); await regalar(app, 'otra');
  await canjear(app, 'pdf:plantilla-5', 'token-sinplan');
  const h = await request(app).get('/api/admin/creditos/historial').set(auth('token-admin'));
  assert.equal(h.status, 200);
  assert.equal(h.body.total, 3);
  assert.deepEqual(h.body.totales, { todos: 3, pendientes: 2, canjeados: 1 });
  const canjeado = h.body.regalos.find(r => r.estado === 'canjeado');
  assert.equal(canjeado.uid, 'sinplan'); assert.equal(canjeado.canje.titulo, 'Material plantilla-5'); assert.ok(canjeado.canje.en);
  assert.equal(canjeado.regaladoPor, 'admin@example.com');
  assert.equal(canjeado.nombre, 'Sin Plan');
  assert.deepEqual(h.body.regalos.map(r => r.en), [...h.body.regalos.map(r => r.en)].sort().reverse(), 'más reciente primero');
  assert.equal((await request(app).get('/api/admin/creditos/historial?estado=pendientes').set(auth('token-admin'))).body.total, 2);
  assert.equal((await request(app).get('/api/admin/creditos/historial?estado=canjeados').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/creditos/historial?q=PLANTILLA').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/creditos/historial?q=otra%20persona').set(auth('token-admin'))).body.total, 1);
  assert.equal((await request(app).get('/api/admin/creditos/historial?pagina=2').set(auth('token-admin'))).body.regalos.length, 0);
  assert.equal((await request(app).get('/api/admin/creditos/historial').set(auth('token-ana'))).status, 403);
});

test('admin: métricas con totales y canjes por material para la gráfica; sin datos todo en cero', async () => {
  const { app } = servidor();
  const vacio = await request(app).get('/api/admin/creditos/metricas').set(auth('token-admin'));
  assert.equal(vacio.body.regalados, 0); assert.deepEqual(vacio.body.materiales, []);
  await regalar(app, 'sinplan'); await regalar(app, 'otra'); await regalar(app, 'ana');
  await canjear(app, 'pdf:plantilla-5', 'token-sinplan'); await canjear(app, 'pdf:plantilla-5', 'token-otra');
  const m = await request(app).get('/api/admin/creditos/metricas').set(auth('token-admin'));
  assert.equal(m.body.regalados, 300); assert.equal(m.body.canjeados, 200); assert.equal(m.body.pendientes, 100);
  assert.deepEqual(m.body.materiales, [{ clave: 'pdf:plantilla-5', titulo: 'Material plantilla-5', canjes: 2 }]);
  assert.equal((await request(app).get('/api/admin/creditos/metricas').set(auth('token-ana'))).status, 403);
});

test('el libro de movimientos es append-only: ningún camino del servidor edita o borra un movimiento', () => {
  const t = ['services/creditos.js', 'services/rutas-creditos.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  const usos = [...t.matchAll(/COL_MOVIMIENTOS[^;\n]*/g)].map(m => m[0]);
  assert.ok(usos.length >= 3);
  assert.doesNotMatch(t, /movRef\.(update|delete)|tx\.(update|delete)\(/);
  assert.doesNotMatch(t, /creditosMovimientos[^\n]*\.(delete|update)\(/);
});
