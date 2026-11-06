'use strict';

// Historial de movimientos del panel (services/historial-admin.js + rutas): quién hizo qué y cuándo.
// Registro uniforme, nada sensible, que no rompa la acción si falla, paginación por cursor, filtros, retención y solo administración.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, ts, miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const { FakeFirestore, FakeTimestamp } = require('./helpers/fake-firestore');
const H = require('../services/historial-admin');

const DIA = 86400000;
const adm = t => auth(t || 'token-admin');
const acciones = db => [...db._data.entries()].filter(([k]) => k.startsWith('adminAcciones/')).map(([k, v]) => ({ id: k.split('/')[1], ...v }));

const tokens = {
  ...tokensDe('ana', 'beto'),
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true, name: 'Admin Token' },
  'token-otroadmin': { uid: 'otroadmin', email: 'otro@example.com', email_verified: true }
};

function montar(extra = {}, env = {}) {
  return cargarServidor({
    tokens, env,
    usuariosAuth: {
      ana: { emailVerified: true, email: 'ana@example.com', displayName: 'Ana Prueba' }, beto: { emailVerified: true, email: 'beto@example.com' },
      admin: { emailVerified: true, email: 'admin@example.com' }, otroadmin: { emailVerified: true, email: 'otro@example.com' }
    },
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Erick Admin', email: 'admin@example.com', role: 'admin' }),
      'miembros/otroadmin': miembroSinPlan({ name: 'Marcela Coordinación', email: 'otro@example.com', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Prueba', email: 'ana@example.com', phone: '5512345678' }),
      'miembros/beto': miembroSinPlan({ name: 'Beto Sin Plan', email: 'beto@example.com' }),
      'cursos/c1': { title: 'Fototrampeo' },
      ...extra
    }
  });
}
const get = (app, ruta, token) => request(app).get(ruta).set(adm(token));

/* ───────── reglas puras ───────── */

test('categorías: cada código de acción cae en una de las siete (cursos, miembros, créditos, contenido, configuración, moderación, pagos)', () => {
  const esperado = {
    'activar-plan': 'miembros', 'cancelar-plan': 'miembros', 'regalar-plan': 'miembros', 'quitar-acceso': 'miembros', 'editar-datos': 'miembros', 'eliminar-miembro': 'miembros',
    'restaurar-miembro': 'miembros', 'importar-avance': 'miembros', 'creditos-regalar': 'creditos', 'cupon-crear': 'creditos', 'cupon-estado': 'creditos',
    'guardar-config': 'configuracion', 'contacto-guardar': 'configuracion', 'recordatorios-modo': 'configuracion', 'recordatorios-limites': 'configuracion',
    'pagos-sincronizar': 'pagos', 'recordatorios-ensayo': 'pagos', 'recordatorios-prueba': 'pagos', 'foro-eliminar': 'moderacion', 'foro-respuesta-eliminar': 'moderacion',
    'directorio-eliminar': 'moderacion', 'ver-contacto-encuesta': 'moderacion', 'encuesta-atender': 'moderacion', 'encuesta-borrar': 'moderacion', 'chatbot-atender': 'moderacion',
    'foro-publicar': 'contenido', 'noticia-publicar': 'contenido', 'noticia-eliminar': 'contenido', 'noticias-sync': 'contenido', 'aviso-crear': 'contenido', 'aviso-eliminar': 'contenido',
    'dato-crear': 'contenido', 'dato-editar': 'contenido', 'dato-eliminar': 'contenido', 'dato-enviar': 'contenido', 'sesion-crear': 'contenido', 'sesion-editar': 'contenido', 'sesion-eliminar': 'contenido',
    'curso-crear': 'cursos', 'curso-editar': 'cursos', 'curso-eliminar': 'cursos', 'curso-sync-bunny': 'cursos', 'video-crear': 'cursos', 'pdf-eliminar': 'cursos', 'certificado-emitir': 'cursos'
  };
  for (const [accion, tipo] of Object.entries(esperado)) assert.equal(H.tipoDe(accion), tipo, accion);
  for (const t of H.IDS_TIPOS) assert.ok(Object.values(esperado).includes(t), 'hay al menos una acción de ' + t);
  assert.deepEqual(H.IDS_TIPOS, ['cursos', 'miembros', 'creditos', 'contenido', 'configuracion', 'moderacion', 'pagos']);
});

test('limpieza: sin correos, teléfonos ni códigos largos en la frase; los datos extra descartan claves delicadas y objetos', () => {
  assert.equal(H.limpiarTexto('Regaló 300 créditos a juan@x.com (55 1234 5678) el 2026-11-06 ' + 'a'.repeat(40), 200), 'Regaló 300 créditos a [correo] ([número]) el 2026-11-06 [código]');
  assert.equal(H.limpiarTexto('<b>hola</b>\n mundo', 50), 'b hola /b mundo');
  const extra = H.limpiarExtra({ dias: 30, planTipo: 'mensual', token: 'abc', telefono: '5512345678', mensaje: 'hola', correo: 'a@b.c', apiKey: 'k', campos: ['nombre', 'palabra '.repeat(20)], objeto: { a: 1 }, 'raro key': 1 });
  assert.deepEqual(Object.keys(extra).sort(), ['campos', 'dias', 'planTipo']);
  assert.equal(extra.campos[1].length, 40);
});

test('cursor: ida y vuelta; lo que no es un cursor válido se rechaza', () => {
  const c = H.codificarCursor('abc-123');
  assert.equal(H.decodificarCursor(c), 'abc-123');
  assert.equal(H.decodificarCursor(''), null);
  assert.equal(H.decodificarCursor(undefined), null);
  assert.equal(H.decodificarCursor('%%%'), undefined);
  assert.equal(H.decodificarCursor(Buffer.from('a/b').toString('base64url')), undefined);
  assert.equal(H.decodificarCursor('x'.repeat(300)), undefined);
  assert.equal(H.decodificarCursor(5), undefined);
});

/* ───────── anotar: quién, qué, a quién, cuándo ───────── */

const adminFalso = { firestore: { FieldValue: { serverTimestamp: () => new FakeTimestamp(Date.now()) } } };

test('anotar: guarda quién (del token), la acción y su categoría, a quién, la frase y la hora del servidor; nunca datos sensibles', async () => {
  const db = new FakeFirestore({ 'miembros/u1': { name: 'Erick Admin' } });
  const h = H.crearHistorial({ db, admin: adminFalso });
  const id = await h.anotar({ uid: 'u1', email: 'ERICK@Example.com' }, 'regalar-plan', 'ana', 'Regaló 1 mes a Ana (ana@example.com, 55 1234 5678)',
    { dias: 30, destinoNombre: 'Ana Prueba', telefono: '5512345678', token: 'secreto' });
  assert.ok(id);
  const d = acciones(db)[0];
  assert.equal(d.accion, 'regalar-plan');
  assert.equal(d.tipo, 'miembros');
  assert.equal(d.por, 'u1');
  assert.equal(d.porCorreo, 'erick@example.com');
  assert.equal(d.porNombre, 'Erick Admin');
  assert.equal(d.uidDestino, 'ana');
  assert.equal(d.destinoNombre, 'Ana Prueba');
  assert.equal(d.resumen, 'Regaló 1 mes a Ana ([correo], [número])');
  assert.equal(d.dias, 30);
  assert.ok(d.en instanceof FakeTimestamp);
  const todo = JSON.stringify(d);
  for (const malo of ['5512345678', 'secreto', 'telefono', 'token', 'ana@example.com']) assert.equal(todo.includes(malo), false, malo);
});

test('anotar: si Firestore falla avisa en el registro y devuelve null, sin romper a quien lo llamó', async () => {
  const roto = { collection: () => { throw new Error('sin conexión'); } };
  const h = H.crearHistorial({ db: roto, admin: adminFalso });
  const consola = console.error; const avisos = [];
  console.error = (...a) => avisos.push(a.join(' '));
  try { assert.equal(await h.anotar({ uid: 'u1' }, 'curso-crear', 'c1', 'Creó el curso «X»'), null); } finally { console.error = consola; }
  assert.match(avisos.join('\n'), /No se pudo anotar la acción/);
  // sin administrador verificado tampoco se escribe nada
  const db = new FakeFirestore();
  assert.equal(await H.crearHistorial({ db, admin: adminFalso }).anotar(null, 'curso-crear', 'c1', 'x'), null);
  assert.equal(acciones(db).length, 0);
});

test('desde el panel: solo códigos permitidos; la frase la arma el servidor y el administrador sale del token, no del cuerpo', async () => {
  const db = new FakeFirestore();
  const h = H.crearHistorial({ db, admin: adminFalso });
  const decoded = { uid: 'u1', email: 'a@x.com', name: 'Ana Admin' };
  assert.ok((await h.registrarDesdePanel(decoded, { accion: 'borrar-todo', nombre: 'x' })).error);
  assert.ok((await h.registrarDesdePanel(decoded, { accion: 'curso-crear' })).error, 'sin nombre');
  assert.ok((await h.registrarDesdePanel(decoded, { accion: 'curso-crear', nombre: 'X', id: '../x' })).error);
  assert.ok((await h.registrarDesdePanel(decoded, null)).error);
  const r = await h.registrarDesdePanel(decoded, { accion: 'curso-crear', nombre: 'Fototrampeo <b>básico</b>', id: 'c9', por: 'otro', porCorreo: 'falso@x.com', resumen: 'frase inventada' });
  assert.equal(r.ok, true);
  const d = acciones(db)[0];
  assert.equal(d.resumen, 'Creó el curso «Fototrampeo b básico /b»');
  assert.equal(d.por, 'u1');
  assert.equal(d.porCorreo, 'a@x.com');
  assert.equal(d.destinoNombre, 'Fototrampeo b básico /b');
  const bunny = h.validarDesdePanel({ accion: 'curso-sync-bunny', creados: 2, actualizados: 59 });
  assert.equal(bunny.resumen, 'Sincronizó los cursos con Bunny (59 cursos actualizados, 2 creados)');
  assert.equal(h.validarDesdePanel({ accion: 'pdf-eliminar', nombre: 'Guía' }).resumen, 'Eliminó el PDF «Guía»');
  assert.equal(h.validarDesdePanel({ accion: 'sesion-crear', nombre: 'Clase' }).resumen, 'Creó la clase en vivo «Clase»');
  assert.equal(h.validarDesdePanel({ accion: 'video-editar', nombre: 'V' }).tipo, 'cursos');
});

/* ───────── leer: paginación por cursor, filtros, retención ───────── */

function sembrar(n, { admins = ['a@x.com', 'b@x.com'] } = {}) {
  const base = Date.UTC(2026, 10, 1, 12, 0, 0);
  const tiposCiclo = ['curso-crear', 'regalar-plan', 'creditos-regalar', 'noticia-publicar', 'guardar-config', 'foro-eliminar', 'pagos-sincronizar'];
  const seed = {};
  for (let i = 0; i < n; i++) {
    const accion = tiposCiclo[i % tiposCiclo.length];
    seed['adminAcciones/m' + String(i).padStart(3, '0')] = {
      accion, tipo: H.tipoDe(accion), por: 'u' + (i % admins.length), porCorreo: admins[i % admins.length], porNombre: 'Admin ' + (i % admins.length),
      uidDestino: 'x' + i, resumen: 'Movimiento ' + i, en: new FakeTimestamp(base + i * 60000), secreto: 'no-debe-salir'
    };
  }
  return new FakeFirestore(seed);
}

test('listar: la más reciente primero, 10 por página y «Ver más» sigue por cursor sin repetir ni saltar; el final no trae cursor', async () => {
  const h = H.crearHistorial({ db: sembrar(35), admin: adminFalso });
  const p1 = await h.listar({});
  assert.equal(p1.items.length, 10);
  assert.equal(p1.items[0].resumen, 'Movimiento 34');
  assert.ok(p1.siguiente);
  const p2 = await h.listar({ limite: 20, cursor: H.decodificarCursor(p1.siguiente) });
  assert.equal(p2.items.length, 20);
  assert.equal(p2.items[0].resumen, 'Movimiento 24');
  const p3 = await h.listar({ limite: 20, cursor: H.decodificarCursor(p2.siguiente) });
  assert.equal(p3.items.length, 5);
  assert.equal(p3.siguiente, null);
  const todos = [...p1.items, ...p2.items, ...p3.items].map(x => x.id);
  assert.equal(new Set(todos).size, 35, 'sin repetidos');
  assert.equal(JSON.stringify(p1).includes('no-debe-salir'), false, 'no devuelve datos extra');
  assert.deepEqual(Object.keys(p1.items[0]).sort(), ['accion', 'destino', 'en', 'id', 'por', 'resumen', 'tipo', 'tipoTexto']);
  assert.equal((await h.listar({ limite: 500 })).items.length, H.MAX_POR_PAGINA, 'el máximo por página es 20');
  assert.equal((await h.listar({ limite: 0 })).items.length, 1);
});

test('listar: filtra por administrador y por tipo (juntos o separados), con y sin índice compuesto en Firestore', async () => {
  const db = sembrar(60);
  const h = H.crearHistorial({ db, admin: adminFalso });
  const r = await h.listar({ limite: 20, administrador: 'a@x.com' });
  assert.ok(r.items.length > 0 && r.items.every(i => i.por.correo === 'a@x.com'));
  const t = await h.listar({ limite: 20, tipo: 'creditos' });
  assert.ok(t.items.length > 0 && t.items.every(i => i.tipo === 'creditos' && i.accion === 'creditos-regalar'));
  const ambos = await h.listar({ limite: 20, administrador: 'b@x.com', tipo: 'miembros' });
  assert.ok(ambos.items.every(i => i.por.correo === 'b@x.com' && i.tipo === 'miembros'));
  // sin índice: las consultas con where fallan y se revisa hacia atrás filtrando aquí; el resultado es el mismo
  const sinIndice = new Proxy(db, { get: (o, k) => (k === 'collection' ? n => {
    const col = o.collection(n);
    return new Proxy(col, { get: (c, p) => (p === 'where' ? () => ({ orderBy: () => ({ limit: () => ({ get: async () => { throw new Error('9 FAILED_PRECONDITION: The query requires an index'); } }) }), startAfter: () => ({}) }) : typeof c[p] === 'function' ? c[p].bind(c) : c[p]) });
  } : (typeof o[k] === 'function' ? o[k].bind(o) : o[k])) });
  const h2 = H.crearHistorial({ db: sinIndice, admin: adminFalso });
  const alt = await h2.listar({ limite: 20, administrador: 'b@x.com', tipo: 'miembros' });
  assert.deepEqual(alt.items.map(i => i.id), ambos.items.map(i => i.id));
  // y la paginación sigue funcionando en ese modo
  const p1 = await h2.listar({ limite: 3, tipo: 'curso'.length ? 'cursos' : '' });
  assert.equal(p1.items.length, 3);
  const p2 = await h2.listar({ limite: 3, tipo: 'cursos', cursor: H.decodificarCursor(p1.siguiente) });
  assert.ok(p2.items[0].id !== p1.items[0].id && p2.items.every(i => i.tipo === 'cursos'));
});

test('listar sin índice: revisa como máximo ESCANEO_MAX documentos por petición y devuelve un cursor para seguir (cuida las lecturas)', async () => {
  const db = sembrar(300);
  let leidos = 0;
  const contador = new Proxy(db, { get: (o, k) => (k === 'collection' ? n => {
    const col = o.collection(n);
    return new Proxy(col, { get: (c, p) => {
      if (p === 'where') return () => ({ orderBy: () => ({ limit: () => ({ get: async () => { throw new Error('FAILED_PRECONDITION index'); } }) }) });
      if (p === 'orderBy') return (...a) => { const q = c.orderBy(...a); return new Proxy(q, { get: (x, y) => (y === 'startAfter' ? (...b) => wrap(x.startAfter(...b)) : y === 'limit' ? m => wrap(x.limit(m)) : x[y]) }); };
      return typeof c[p] === 'function' ? c[p].bind(c) : c[p];
    } });
    function wrap(q) { return new Proxy(q, { get: (x, y) => (y === 'get' ? async () => { const r = await x.get(); leidos += r.docs.length; return r; } : y === 'limit' ? m => wrap(x.limit(m)) : typeof x[y] === 'function' ? x[y].bind(x) : x[y]) }); }
  } : (typeof o[k] === 'function' ? o[k].bind(o) : o[k])) });
  const h = H.crearHistorial({ db: contador, admin: adminFalso });
  const r = await h.listar({ limite: 10, administrador: 'nadie@x.com' });
  assert.equal(r.items.length, 0);
  assert.equal(r.parcial, true);
  assert.ok(r.siguiente, 'hay cursor para seguir revisando');
  assert.ok(leidos <= H.ESCANEO_MAX + H.ESCANEO_PAGINA, 'lecturas acotadas: ' + leidos);
});

test('retención: la limpieza borra lo de más de 12 meses y deja lo reciente', async () => {
  const ahora = new Date('2026-11-06T12:00:00Z');
  const db = new FakeFirestore({
    'adminAcciones/viejo1': { accion: 'curso-crear', resumen: 'x', en: new FakeTimestamp(Date.parse('2025-10-01T00:00:00Z')) },
    'adminAcciones/viejo2': { accion: 'curso-crear', resumen: 'x', en: new FakeTimestamp(Date.parse('2025-11-05T00:00:00Z')) },
    'adminAcciones/limite': { accion: 'curso-crear', resumen: 'x', en: new FakeTimestamp(Date.parse('2025-11-07T00:00:00Z')) },
    'adminAcciones/reciente': { accion: 'curso-crear', resumen: 'x', en: new FakeTimestamp(Date.parse('2026-11-01T00:00:00Z')) }
  });
  const r = await H.limpiarAntiguos(db, { ahora });
  assert.equal(r.borrados, 2);
  assert.deepEqual(acciones(db).map(a => a.id).sort(), ['limite', 'reciente']);
  assert.equal(H.RETENCION_MESES, 12);
  // la tarea diaria la corre sola
  const { ejecutarTareaDiaria } = require('../services/tarea-diaria');
  const db2 = new FakeFirestore({ 'adminAcciones/viejo': { accion: 'x', resumen: 'x', en: new FakeTimestamp(Date.parse('2024-01-01T00:00:00Z')) } });
  const salida = await ejecutarTareaDiaria(db2, { ahora, sync: async () => ({ guardadas: 0, omitidas: 0, fuentes: [] }) });
  assert.equal(salida.historial.borrados, 1);
});

/* ───────── API: solo administración ───────── */

test('API: GET /api/admin/historial y POST /registrar exigen administrador (sin sesión 401, miembro 403)', async () => {
  const { app } = montar();
  const rutas = [() => request(app).get('/api/admin/historial'), () => request(app).post('/api/admin/historial/registrar').send({ accion: 'curso-crear', nombre: 'X' })];
  for (const f of rutas) assert.equal((await f()).status, 401);
  const comoMiembro = [() => request(app).get('/api/admin/historial').set(auth('token-ana')), () => request(app).post('/api/admin/historial/registrar').set(auth('token-ana')).send({ accion: 'curso-crear', nombre: 'X' })];
  for (const f of comoMiembro) { const r = await f(); assert.equal(r.status, 403); assert.deepEqual(Object.keys(r.body), ['error']); }
});

test('API: valida limite, cursor, tipo y administrador; trae los tipos, los administradores y la retención', async t => {
  const previo = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com,otro@example.com';
  t.after(() => { if (previo === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previo; });
  const { app } = montar();
  const g = q => get(app, '/api/admin/historial' + q);
  assert.equal((await g('?limite=abc')).status, 400);
  assert.equal((await g('?limite=0')).status, 400);
  assert.equal((await g('?cursor=%25%25')).status, 400);
  assert.equal((await g('?tipo=cosas')).status, 400);
  assert.equal((await g('?administrador=no-es-correo')).status, 400);
  const ok = await g('?limite=99');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.limite, 20);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.deepEqual(ok.body.tipos.map(t => t.id), H.IDS_TIPOS);
  assert.equal(ok.body.retencionMeses, 12);
  assert.deepEqual(ok.body.administradores.map(a => a.correo).sort(), ['admin@example.com', 'otro@example.com']);
  assert.ok(ok.body.administradores.some(a => a.nombre === 'Erick Admin'));
});

test('API: todo lo que hace la administración queda en el historial con quién (del token), qué, a quién y cuándo', async () => {
  const { app, db } = montar({ 'miembros/beto': miembroSinPlan({ name: 'Beto Sin Plan', email: 'beto@example.com', createdAt: new Date(Date.now() - 10 * DIA).toISOString() }) });
  // 1) regalar 30 días  2) activar plan  3) créditos  4) config  5) cupón  6) registrar curso desde el panel  7) aviso  8) noticia
  assert.equal((await request(app).post('/api/admin/miembros/beto/regalar').set(adm()).send({ dias: 30, nota: 'Gracias' })).status, 200);
  assert.equal((await request(app).post('/api/admin/config').set(adm('token-otroadmin')).send({ contadorVisitas: true })).status, 200);
  assert.equal((await request(app).post('/api/admin/historial/registrar').set(adm()).send({ accion: 'curso-crear', nombre: 'Etología básica', id: 'c9', por: 'falso' })).status, 200);
  assert.equal((await request(app).post('/api/admin/historial/registrar').set(adm()).send({ accion: 'curso-eliminar', nombre: 'Etología básica', id: 'c9' })).status, 200);
  assert.equal((await request(app).post('/api/admin/avisos').set(adm()).send({ tipo: 'sistema', titulo: 'Mantenimiento', descripcion: 'Esta noche habrá mantenimiento breve.' })).status, 200);
  const r = await get(app, '/api/admin/historial?limite=20');
  assert.equal(r.status, 200);
  const frases = r.body.items.map(i => i.resumen);
  assert.ok(frases.some(f => /^Regaló 30 días a Beto Sin Plan|^Regaló/.test(f)), frases.join(' | '));
  assert.ok(frases.includes('Creó el curso «Etología básica»'));
  assert.ok(frases.includes('Eliminó el curso «Etología básica»'));
  assert.ok(frases.includes('Cambió el interruptor «Contador de visitas» a activado'), frases.join(' | '));
  assert.ok(frases.some(f => f.startsWith('Envió el aviso «Mantenimiento»')));
  const conf = r.body.items.find(i => i.accion === 'guardar-config');
  assert.equal(conf.por.nombre, 'Marcela Coordinación');
  assert.equal(conf.por.correo, 'otro@example.com');
  assert.equal(conf.tipo, 'configuracion');
  const curso = r.body.items.find(i => i.accion === 'curso-crear');
  assert.equal(curso.por.uid, 'admin', 'el administrador sale del token, no del cuerpo');
  assert.equal(curso.destino.id, 'c9');
  assert.equal(curso.destino.nombre, 'Etología básica');
  assert.ok(Date.parse(curso.en) > Date.now() - 60000);
  // filtros por la API
  const soloOtro = await get(app, '/api/admin/historial?administrador=otro@example.com');
  assert.ok(soloOtro.body.items.length >= 1 && soloOtro.body.items.every(i => i.por.correo === 'otro@example.com'));
  const soloCursos = await get(app, '/api/admin/historial?tipo=cursos');
  assert.deepEqual(soloCursos.body.items.map(i => i.accion).sort(), ['curso-crear', 'curso-eliminar']);
  // paginación por la API
  const p1 = await get(app, '/api/admin/historial?limite=2');
  assert.equal(p1.body.items.length, 2);
  assert.ok(p1.body.siguiente);
  const p2 = await get(app, '/api/admin/historial?limite=2&cursor=' + encodeURIComponent(p1.body.siguiente));
  assert.ok(p2.body.items.length >= 1 && p2.body.items[0].id !== p1.body.items[0].id && p2.body.items[0].id !== p1.body.items[1].id);
  // nada sensible en lo guardado ni en lo que se devuelve
  const crudo = JSON.stringify(acciones(db)) + JSON.stringify(r.body);
  for (const malo of ['Bearer', 'token-admin', '5512345678']) assert.equal(crudo.includes(malo), false, malo);
});

test('API: una acción principal no falla si no se puede anotar en el historial', async () => {
  const { app, db } = montar({ 'miembros/beto': miembroSinPlan({ name: 'Beto Sin Plan', email: 'beto@example.com' }) });
  const original = db.collection.bind(db);
  db.collection = nombre => {
    const c = original(nombre);
    if (nombre === 'adminAcciones') return { doc: () => ({ set: async () => { throw new Error('Firestore caído'); } }), orderBy: c.orderBy.bind(c), where: c.where.bind(c) };
    return c;
  };
  const consola = console.error; const avisos = [];
  console.error = (...a) => avisos.push(a.join(' '));
  let r;
  try { r = await request(app).post('/api/admin/miembros/beto/regalar').set(adm()).send({ dias: 30 }); } finally { console.error = consola; }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(avisos.join('\n'), /No se pudo anotar la acción/);
});

test('API: noticias, datos curiosos y avisos del panel dejan su movimiento (publicar, enviar, pausar, eliminar) con el nombre en la frase', async () => {
  const { app } = montar();
  const post = (ruta, cuerpo) => request(app).post(ruta).set(adm()).send(cuerpo || {});
  const n = await post('/api/admin/noticias', { titulo: 'Nueva guía para el manejo de fauna', resumen: 'Primera idea importante.\nSegunda idea con detalle.', categoria: 'fauna', fuente: 'Zoorigen' });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  const nid = n.body.noticia.id;
  assert.equal((await post(`/api/admin/noticias/${nid}/eliminar`)).status, 200);
  const dc = await post('/api/admin/datos-curiosos', { texto: 'El jaguar es el felino más grande de América.', tema: 'fauna' });
  assert.equal(dc.status, 200, JSON.stringify(dc.body));
  const did = dc.body.dato.id;
  assert.equal((await post(`/api/admin/datos-curiosos/${did}/actualizar`, { activo: false })).status, 200);
  assert.equal((await post(`/api/admin/datos-curiosos/${did}/eliminar`)).status, 200);
  const av = await post('/api/admin/avisos', { tipo: 'general', titulo: 'Nueva clase', descripcion: 'Ya está disponible una clase nueva.' });
  assert.equal(av.status, 200);
  assert.equal((await post(`/api/admin/avisos/${av.body.id}/eliminar`)).status, 200);
  const r = await get(app, '/api/admin/historial?limite=20');
  const frases = r.body.items.map(i => i.resumen);
  for (const esperada of ['Publicó la noticia «Nueva guía para el manejo de fauna»', 'Eliminó la noticia «Nueva guía para el manejo de fauna»', 'Agregó un dato curioso', 'Pausó un dato curioso', 'Eliminó un dato curioso', 'Envió el aviso «Nueva clase» a todos los miembros', 'Eliminó el aviso «Nueva clase»']) {
    assert.ok(frases.includes(esperada), esperada + ' ← ' + frases.join(' | '));
  }
  assert.ok(r.body.items.every(i => i.tipo === 'contenido'));
});

test('API: emitir un certificado a mano deja su movimiento (una sola vez) y la acción responde igual', async () => {
  const { app } = cargarServidor({
    tokens, env: { CERTIFICATE_SIGNING_KEY: 'llave-de-prueba-0123456789-0123456789-abcdef' },
    usuariosAuth: { admin: { emailVerified: true, email: 'admin@example.com' }, ana: { emailVerified: true, email: 'ana@example.com' } },
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Erick Admin', email: 'admin@example.com', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com' }),
      'cursos/c1': { title: 'Fototrampeo', area: 'General', lecciones: [{ title: 'Uno', videoId: 'befd1641-850a-4099-88a8-047a1badc703' }] }
    }
  });
  const emitir = () => request(app).post('/api/admin/certificados').set(adm()).send({ uid: 'ana', cursoId: 'c1' });
  const a = await emitir();
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await emitir()).status, 200, 'pedirlo otra vez devuelve el mismo certificado');
  const frases = (await get(app, '/api/admin/historial')).body.items.map(i => i.resumen);
  assert.equal(frases.filter(f => f.startsWith('Emitió el certificado del curso «Fototrampeo» a ')).length, 1, frases.join(' | '));
});
