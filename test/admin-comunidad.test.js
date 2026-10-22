'use strict';

// Panel de administración · comunidad: historial de retos, foro (borrar y publicar como Zoorigen), directorio completo y
// orden de miembros por fecha de registro. Todo es solo administrador y queda anotado en adminAcciones.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe
} = require('./helpers/club');
const { ts } = require('./helpers/cargar-servidor');
const com = require('../services/rutas-admin-comunidad');

const DIA = 86400000;
const tokens = {
  ...tokensDe('ana', 'beto', 'cata'),
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true }
};

function montar(extra = {}, opciones = {}) {
  return cargarServidor({
    tokens, usuariosAuth: opciones.usuariosAuth,
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com', createdAt: new Date(Date.now() - 2 * DIA).toISOString() }),
      'miembros/beto': miembroConPlan({ name: 'Beto Gómez', email: 'beto@example.com', createdAt: ts(Date.now() - 10 * DIA) }),
      'miembros/cata': miembroSinPlan({ name: 'Cata Sin Fecha', email: 'cata@example.com' }),
      ...extra
    }
  });
}
const get = (app, ruta, t = 'token-admin') => request(app).get(ruta).set(auth(t));
const post = (app, ruta, cuerpo, t = 'token-admin') => request(app).post(ruta).set(auth(t)).send(cuerpo || {});

const RUTAS_GET = ['/api/admin/retos/historial', '/api/admin/retos/usuarios', '/api/admin/foro', '/api/admin/directorio'];
const RUTAS_POST = ['/api/admin/foro/publicar', '/api/admin/foro/p1/eliminar', '/api/admin/foro/p1/respuestas/r1/eliminar', '/api/admin/directorio/ana/eliminar'];

const post1 = (extra = {}) => ({
  title: 'Duda sobre fauna', content: 'Texto del miembro', category: 'consulta', authorUid: 'ana', authorName: 'Ana Pérez',
  authorEmail: 'ana@example.com', createdAt: new Date(Date.now() - DIA).toISOString(), likes: ['beto'], views: 3, repliesCount: 2, ...extra
});
const foroSeed = () => ({
  'foroPosts/p1': post1(),
  'foroPosts/p1/replies/r1': { authorUid: 'beto', authorName: 'Beto Gómez', text: 'Primera', createdAt: new Date(Date.now() - 3600000).toISOString() },
  'foroPosts/p1/replies/r2': { authorUid: 'cata', authorName: 'Cata', text: 'Segunda', createdAt: new Date(Date.now() - 1800000).toISOString() },
  'foroPosts/p2': post1({ title: 'Otra', content: 'Algo inapropiado', repliesCount: 0, createdAt: new Date().toISOString() })
});

test('control de acceso: visitante 401, miembro 403 y nada cambia', async () => {
  const { app, db } = montar({ ...foroSeed(), 'directorio/ana': { nombre: 'Ana', publicado: true } });
  for (const r of RUTAS_GET) {
    assert.equal((await request(app).get(r)).status, 401, r);
    const m = await get(app, r, 'token-ana');
    assert.equal(m.status, 403, r);
    assert.deepEqual(Object.keys(m.body), ['error'], r);
  }
  for (const r of RUTAS_POST) {
    assert.equal((await request(app).post(r).send({ texto: 'hola' })).status, 401, r);
    assert.equal((await post(app, r, { texto: 'hola' }, 'token-ana')).status, 403, r);
  }
  assert.ok(db.value('foroPosts/p1'), 'la publicación sigue');
  assert.ok(db.value('directorio/ana'), 'la tarjeta sigue');
  assert.equal([...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).length, 0);
});

/* ───────── miembros: orden y fecha de registro real ───────── */

test('GET /api/admin/miembros: más recientes primero, con fecha de la cuenta de Firebase para quien no tiene createdAt', async () => {
  const alta = new Date(Date.now() - 1 * DIA).toUTCString();
  const { app } = montar({}, { usuariosAuth: { cata: { emailVerified: true, creationTime: alta }, ana: { emailVerified: true }, beto: { emailVerified: true } } });
  const r = await get(app, '/api/admin/miembros');
  assert.equal(r.status, 200);
  const ids = r.body.miembros.filter(m => m.uid !== 'admin').map(m => m.uid);
  assert.deepEqual(ids, ['cata', 'ana', 'beto'], 'cata (cuenta de ayer) > ana (2 días) > beto (10 días)');
  const cata = r.body.miembros.find(m => m.uid === 'cata');
  assert.equal(cata.registroOrigen, 'cuenta');
  assert.equal(new Date(cata.registro).getTime(), Date.parse(alta));
  assert.equal(r.body.miembros.find(m => m.uid === 'ana').registroOrigen, 'perfil');
  // createdAt como Timestamp y como texto ISO dan fechas ISO homogéneas
  for (const m of r.body.miembros.filter(m => m.registro)) assert.match(m.registro, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // quien no tiene fecha en ningún lado queda al final y se cuenta
  assert.equal(r.body.sinFechaDeRegistro, 1, 'admin no tiene createdAt ni cuenta');
  assert.equal(r.body.miembros[r.body.miembros.length - 1].registro, null);
});

/* ───────── retos: historial ───────── */

const quiz = (puntaje = 4, total = 5) => ({ retoId: 'quiz', puntaje, total });
const resultado = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/resultado').set(auth(t)).send(cuerpo);
const camino = (app, cuerpo, t = 'token-ana') => request(app).post('/api/retos/camino').set(auth(t)).send(cuerpo);
const eventos = db => [...db._data.entries()].filter(([k]) => k.startsWith('retosHistorial/')).map(([, v]) => v);

test('cada reto superado deja un renglón en retosHistorial en la misma operación que el XP; lo reprobado y lo repetido no', async () => {
  const { app, db } = montar();
  assert.equal((await resultado(app, quiz(2, 5))).body.aprobado, false);
  assert.equal(eventos(db).length, 0, 'reprobado: sin renglón');
  const a = await resultado(app, quiz(5, 5));
  assert.equal(a.status, 200);
  assert.equal(eventos(db).length, 1);
  assert.equal((await resultado(app, quiz(5, 5))).body.xpGanado, 0, 'repetido el mismo día no da XP');
  assert.equal(eventos(db).length, 1, 'ni renglón');
  const c = await camino(app, { modo: 'detective', indice: 3, puntaje: 4, total: 5 });
  assert.equal(c.body.aceptado, true);
  assert.equal((await camino(app, { modo: 'detective', indice: 3, puntaje: 4, total: 5 })).body.aceptado, false);
  const ev = eventos(db);
  assert.equal(ev.length, 2);
  const prac = ev.find(e => e.tipo === 'practica'); const cam = ev.find(e => e.tipo === 'camino');
  assert.deepEqual([prac.uid, prac.retoId, prac.puntaje, prac.total, prac.perfecto, prac.xp], ['ana', 'quiz', 5, 5, true, 10]);
  assert.deepEqual([cam.uid, cam.retoId, cam.indice, cam.perfecto, cam.xp], ['ana', 'detective', 3, false, 6]);
  assert.match(cam.dia, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(cam.fecha && typeof cam.fecha.toDate === 'function', 'fecha del servidor');
  // el XP guardado coincide con la suma del historial
  assert.equal(db.value('retosUsuario/ana').xp, ev.reduce((t, e) => t + e.xp, 0));
});

test('sin membresía no se guarda nada ni historial', async () => {
  const { app, db } = montar();
  assert.equal((await resultado(app, quiz(5, 5), 'token-cata')).status, 403);
  assert.equal(eventos(db).length, 0);
});

const histSeed = () => {
  const s = {};
  const base = Date.now();
  [
    ['h1', 'ana', 'practica', 'quiz', null, 5, 5, true, 10, 1],
    ['h2', 'ana', 'camino', 'detective', 4, 4, 5, false, 6, 3],
    ['h3', 'beto', 'camino', 'orden', 7, 5, 5, true, 10, 5],
    ['h4', 'beto', 'practica', 'quiz', null, 3, 5, false, 6, 40]
  ].forEach(([id, uid, tipo, retoId, indice, puntaje, total, perfecto, xp, haceDias]) => {
    s[`retosHistorial/${id}`] = { uid, tipo, retoId, indice, puntaje, total, perfecto, xp, fecha: ts(base - haceDias * DIA), dia: '2026-01-01' };
  });
  return s;
};

test('GET /api/admin/retos/historial: quién, qué reto, tipo, fecha y XP, de lo más nuevo a lo más viejo, con totales', async () => {
  const { app } = montar(histSeed());
  const r = await get(app, '/api/admin/retos/historial');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.eventos.map(e => e.id), ['h1', 'h2', 'h3', 'h4']);
  const e = r.body.eventos[1];
  assert.equal(e.nombre, 'Ana Pérez');
  assert.equal(e.reto, 'Detective de campo');
  assert.equal(e.tipo, 'camino');
  assert.equal(e.indice, 4);
  assert.equal(e.xp, 6);
  assert.match(e.en, /T/);
  assert.deepEqual(r.body.totales, { eventos: 4, personas: 2, xp: 32 });
  assert.equal(r.body.historialDesde, r.body.eventos[3].en, 'desde cuándo existe el historial detallado');
  assert.equal(r.body.pagina, 1); assert.equal(r.body.paginas, 1);
  assert.equal(JSON.stringify(r.body).includes('@example.com'), false, 'sin correos');
});

test('historial: filtros por tipo, persona, texto y fechas; paginación; entradas inválidas dan 400', async () => {
  const { app } = montar(histSeed());
  assert.deepEqual((await get(app, '/api/admin/retos/historial?tipo=camino')).body.eventos.map(e => e.id), ['h2', 'h3']);
  assert.deepEqual((await get(app, '/api/admin/retos/historial?uid=beto')).body.eventos.map(e => e.id), ['h3', 'h4']);
  assert.deepEqual((await get(app, '/api/admin/retos/historial?q=ana')).body.eventos.map(e => e.id), ['h1', 'h2']);
  assert.deepEqual((await get(app, '/api/admin/retos/historial?q=DETECTIVE')).body.eventos.map(e => e.id), ['h2']);
  const hoy = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  const hace = n => new Date(Date.now() - 6 * 3600 * 1000 - n * DIA).toISOString().slice(0, 10);
  assert.deepEqual((await get(app, `/api/admin/retos/historial?desde=${hace(6)}&hasta=${hoy}`)).body.eventos.map(e => e.id), ['h1', 'h2', 'h3']);
  assert.deepEqual((await get(app, `/api/admin/retos/historial?hasta=${hace(30)}`)).body.eventos.map(e => e.id), ['h4']);
  const p = await get(app, '/api/admin/retos/historial?limite=2&pagina=2');
  assert.deepEqual(p.body.eventos.map(e => e.id), ['h3', 'h4']);
  assert.equal(p.body.paginas, 2);
  assert.equal((await get(app, '/api/admin/retos/historial?pagina=99&limite=2')).body.pagina, 2, 'una página fuera de rango cae en la última');
  for (const mala of ['tipo=otro', 'uid=a%20b', 'desde=ayer', 'hasta=2026-13-45x']) assert.equal((await get(app, '/api/admin/retos/historial?' + mala)).status, 400, mala);
});

test('historial vacío: dice desde cuándo existirá y no inventa nada', async () => {
  const { app } = montar();
  const r = await get(app, '/api/admin/retos/historial');
  assert.equal(r.body.historialDesde, null);
  assert.deepEqual(r.body.eventos, []);
  assert.deepEqual(r.body.totales, { eventos: 0, personas: 0, xp: 0 });
});

test('GET /api/admin/retos/usuarios: totales reales por persona de retosUsuario (también de antes del historial)', async () => {
  const { app } = montar({
    'retosUsuario/ana': { uid: 'ana', xp: 120, superados: 8, dias: ['2026-01-01', '2026-01-02'], porReto: { quiz: { veces: 6, superados: 4, perfectos: 1 }, raro: { veces: 9 } }, actualizadoEn: ts(Date.now() - DIA) },
    'retosUsuario/beto': { uid: 'beto', xp: 300, superados: 20, dias: [], porReto: {} },
    'retosUsuario/cata': { uid: 'cata', xp: 0, superados: 0 }
  });
  const r = await get(app, '/api/admin/retos/usuarios');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.usuarios.map(u => u.uid), ['beto', 'ana'], 'ordenados por XP y sin quien no ha jugado');
  const ana = r.body.usuarios[1];
  assert.equal(ana.nombre, 'Ana Pérez');
  assert.deepEqual(ana.porReto, { quiz: { veces: 6, superados: 4, perfectos: 1 } }, 'solo retos conocidos');
  assert.equal(ana.dias, 2);
  assert.ok(ana.ultimaVez);
});

test('la ficha del miembro trae su historial de retos (con total) y no el de otros', async () => {
  const { app } = montar(histSeed());
  const f = await get(app, '/api/admin/miembros/ana');
  assert.equal(f.body.retos.historialTotal, 2);
  assert.deepEqual(f.body.retos.historial.map(e => e.id), ['h1', 'h2']);
  assert.equal(f.body.retos.historial[1].retoId, 'detective');
});

/* ───────── foro ───────── */

test('GET /api/admin/foro: publicaciones recientes con autor, fecha, texto, respuestas y sin correos de los miembros', async () => {
  const { app } = montar(foroSeed());
  const r = await get(app, '/api/admin/foro');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.publicaciones.map(p => p.id), ['p2', 'p1']);
  const p1 = r.body.publicaciones[1];
  assert.equal(p1.autor, 'Ana Pérez');
  assert.equal(p1.texto, 'Texto del miembro');
  assert.equal(p1.respuestas, 2);
  assert.deepEqual(p1.respuestasLista.map(x => x.texto), ['Primera', 'Segunda']);
  assert.equal(r.body.limiteTexto, 1500);
  assert.equal(JSON.stringify(r.body).includes('ana@example.com'), false);
});

test('POST /api/admin/foro/publicar: publica como Zoorigen (oficial, sin uid de persona), valida el texto y se anota', async () => {
  const { app, db } = montar();
  assert.equal((await post(app, '/api/admin/foro/publicar', {})).status, 400);
  assert.equal((await post(app, '/api/admin/foro/publicar', { texto: '   ' })).status, 400);
  assert.equal((await post(app, '/api/admin/foro/publicar', { texto: 5 })).status, 400);
  const largo = await post(app, '/api/admin/foro/publicar', { texto: 'a'.repeat(1501) });
  assert.equal(largo.status, 400);
  assert.match(largo.body.error, /1,?500/);
  const ok = await post(app, '/api/admin/foro/publicar', { texto: 'Mantenimiento esta noche​.\nDetalles aquí.', imagen: 'https://x.test/a.png' });
  assert.equal(ok.status, 200);
  const doc = db.value('foroPosts/' + ok.body.id);
  assert.equal(doc.authorName, 'Zoorigen');
  assert.equal(doc.authorUid, 'zoorigen-oficial');
  assert.equal(doc.oficial, true);
  assert.equal(doc.title, 'Mantenimiento esta noche.');
  assert.equal(doc.content, 'Mantenimiento esta noche.\nDetalles aquí.');
  assert.deepEqual([doc.likes, doc.views, doc.repliesCount], [[], 0, 0]);
  assert.equal('imagen' in doc, false, 'sin imágenes: no existe un mecanismo seguro de subida');
  assert.notEqual(doc.authorUid, 'admin');
  const exacto = await post(app, '/api/admin/foro/publicar', { texto: 'b'.repeat(1500) });
  assert.equal(exacto.status, 200);
  assert.equal(db.value('foroPosts/' + exacto.body.id).title.length <= 90, true);
  const acc = [...db._data.values()].filter(v => v && v.accion === 'foro-publicar');
  assert.equal(acc.length, 2);
  // la publicación aparece en el listado como oficial
  const lista = await get(app, '/api/admin/foro');
  assert.equal(lista.body.publicaciones.find(p => p.id === ok.body.id).oficial, true);
});

test('POST /api/admin/foro/:id/eliminar: borra la publicación y sus respuestas, anota quién, y avisa si no existe', async () => {
  const { app, db } = montar(foroSeed());
  assert.equal((await post(app, '/api/admin/foro/noexiste/eliminar')).status, 404);
  assert.equal((await post(app, '/api/admin/foro/a%20b/eliminar')).status, 400);
  const r = await post(app, '/api/admin/foro/p1/eliminar');
  assert.equal(r.status, 200);
  assert.equal(r.body.respuestasBorradas, 2);
  assert.equal(db.value('foroPosts/p1'), undefined);
  assert.equal(db.value('foroPosts/p1/replies/r1'), undefined);
  assert.ok(db.value('foroPosts/p2'), 'las demás se quedan');
  const acc = [...db._data.values()].find(v => v && v.accion === 'foro-eliminar');
  assert.equal(acc.por, 'admin');
  assert.match(acc.resumen, /Duda sobre fauna/);
  assert.equal(JSON.stringify(acc).includes('ana@example.com'), false);
});

test('POST /api/admin/foro/:id/respuestas/:rid/eliminar: borra la respuesta y corrige el contador', async () => {
  const { app, db } = montar(foroSeed());
  assert.equal((await post(app, '/api/admin/foro/p1/respuestas/nada/eliminar')).status, 404);
  const r = await post(app, '/api/admin/foro/p1/respuestas/r1/eliminar');
  assert.equal(r.status, 200);
  assert.equal(r.body.respuestas, 1);
  assert.equal(db.value('foroPosts/p1/replies/r1'), undefined);
  assert.ok(db.value('foroPosts/p1/replies/r2'));
  assert.equal(db.value('foroPosts/p1').repliesCount, 1);
  assert.ok([...db._data.values()].some(v => v && v.accion === 'foro-respuesta-eliminar'));
});

test('borrar es limitado a 10 por minuto', async () => {
  const seed = {};
  for (let i = 0; i < 14; i++) seed[`foroPosts/m${i}`] = post1({ repliesCount: 0 });
  const { app } = montar(seed);
  const estados = [];
  for (let i = 0; i < 14; i++) estados.push((await post(app, `/api/admin/foro/m${i}/eliminar`)).status);
  assert.equal(estados.filter(s => s === 200).length, 10);
  assert.equal(estados.filter(s => s === 429).length, 4);
});

/* ───────── directorio ───────── */

const dirSeed = () => ({
  'directorio/ana': { uid: 'ana', nombre: 'Ana Pérez', profesion: 'Bióloga', institucion: 'UMA Sol', sector: 'Conservación', ciudad: 'Mérida', estado: 'activo', cedula: '1234567', cedulaVisible: false, publicado: true, contacto: { whatsapp: '+52 999 123 4567', email: 'ana.contacto@example.com' }, actualizado: ts(Date.now() - DIA) },
  'directorio/beto': { uid: 'beto', nombre: 'Beto Gómez', profesion: 'Veterinario', sector: 'Veterinaria', publicado: false, contacto: {}, actualizado: ts(Date.now() - 5 * DIA) },
  'directorio/huerfano': { uid: 'huerfano', nombre: 'Persona Sin Cuenta', publicado: true, contacto: { web: 'https://ejemplo.mx' }, actualizado: ts(Date.now() - 9 * DIA) }
});

test('GET /api/admin/directorio: TODAS las tarjetas (publicadas y privadas) con contacto completo, sello calculado por el servidor', async () => {
  const { app } = montar(dirSeed());
  const r = await get(app, '/api/admin/directorio');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.totales, { total: 3, publicadas: 2, privadas: 1, verificadas: 2 });
  assert.deepEqual(r.body.tarjetas.map(t => t.uid), ['ana', 'beto', 'huerfano'], 'más recientes primero');
  const ana = r.body.tarjetas[0];
  assert.equal(ana.contacto.whatsapp, '+52 999 123 4567');
  assert.equal(ana.contacto.email, 'ana.contacto@example.com');
  assert.equal(ana.cedula, '1234567', 'el administrador ve la cédula aunque no la muestre al público');
  assert.equal(ana.verificado, true);
  assert.equal(ana.publicado, true);
  assert.equal(r.body.tarjetas[1].publicado, false);
  assert.equal(r.body.tarjetas[1].verificado, true);
  assert.equal(r.body.tarjetas[2].verificado, false, 'sin cuenta de miembro no hay sello');
  assert.equal(r.body.tarjetas[2].miembro, false);
});

test('POST /api/admin/directorio/:uid/eliminar: borra la tarjeta y lo anota; 404 si no existe', async () => {
  const { app, db } = montar(dirSeed());
  assert.equal((await post(app, '/api/admin/directorio/nadie/eliminar')).status, 404);
  const r = await post(app, '/api/admin/directorio/ana/eliminar');
  assert.equal(r.status, 200);
  assert.equal(db.value('directorio/ana'), undefined);
  assert.ok(db.value('directorio/beto'));
  const lista = await get(app, '/api/admin/directorio');
  assert.equal(lista.body.totales.total, 2);
  const acc = [...db._data.values()].find(v => v && v.accion === 'directorio-eliminar');
  assert.match(acc.resumen, /Ana Pérez/);
});

/* ───────── reglas puras ───────── */

test('validarPublicacionOficial, limpiarTextoLibre y filtros de fecha', () => {
  assert.equal(com.validarPublicacionOficial(null).error !== undefined, true);
  const v = com.validarPublicacionOficial({ texto: '  ‮Hola\u0007 mundo\r\nsegunda  ' });
  assert.equal(v.datos.contenido, 'Hola mundo\nsegunda');
  assert.equal(v.datos.titulo, 'Hola mundo');
  const largo = com.validarPublicacionOficial({ texto: 'palabra '.repeat(30) });
  assert.ok(largo.datos.titulo.length <= 90 && largo.datos.titulo.endsWith('…'));
  assert.equal(com.limpiarTextoLibre(undefined), '');
  assert.equal(com.filtrosHistorial({}).tipo, '');
  assert.equal(com.filtrosHistorial({ desde: '2026-10-01' }).desde, Date.parse('2026-10-01T06:00:00Z'));
  assert.equal(com.filtrosHistorial({ hasta: '2026-10-01' }).hasta, Date.parse('2026-10-02T06:00:00Z') - 1);
});
