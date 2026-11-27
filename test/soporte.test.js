'use strict';

// Soporte privado: abrir un ticket, verlo (solo el dueño), responder (miembro y admin), cerrarlo/reabrirlo,
// y que un miembro nunca pueda ver el ticket de otro.
// Ejecutar: node --test test/soporte.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroSinPlan, auth } = require('./helpers/club');

const tokens = {
  'token-ana': { uid: 'ana', email: 'ana@example.com' },
  'token-beto': { uid: 'beto', email: 'beto@example.com' },
  'token-admin': { uid: 'admin', email: 'admin@example.com' }
};
const USUARIOS_AUTH = {
  ana: { emailVerified: true, email: 'ana@example.com' },
  beto: { emailVerified: true, email: 'beto@example.com' },
  admin: { emailVerified: true, email: 'admin@example.com' }
};

function servidor(seed = {}, env = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      tokens,
      usuariosAuth: USUARIOS_AUTH,
      env: { ADMIN_EMAILS: 'admin@example.com', ...env },
      seed: {
        'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }),
        'miembros/beto': miembroSinPlan({ name: 'Beto', email: 'beto@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin', email: 'admin@example.com' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}

const crear = (app, cuerpo, t = 'token-ana') => request(app).post('/api/soporte/tickets').set(auth(t)).send(cuerpo);
const misTickets = (app, t = 'token-ana') => request(app).get('/api/soporte/tickets').set(auth(t));
const obtener = (app, id, t = 'token-ana') => request(app).get('/api/soporte/tickets/' + id).set(auth(t));
const responder = (app, id, cuerpo, t = 'token-ana') => request(app).post(`/api/soporte/tickets/${id}/mensajes`).set(auth(t)).send(cuerpo);
const listarAdmin = (app, t = 'token-admin') => request(app).get('/api/admin/soporte/tickets').set(auth(t));
const obtenerAdmin = (app, id, t = 'token-admin') => request(app).get('/api/admin/soporte/tickets/' + id).set(auth(t));
const responderAdmin = (app, id, cuerpo, t = 'token-admin') => request(app).post(`/api/admin/soporte/tickets/${id}/mensajes`).set(auth(t)).send(cuerpo);
const cerrar = (app, id, t = 'token-admin') => request(app).post(`/api/admin/soporte/tickets/${id}/cerrar`).set(auth(t)).send({});
const reabrir = (app, id, t = 'token-admin') => request(app).post(`/api/admin/soporte/tickets/${id}/reabrir`).set(auth(t)).send({});

test('sin sesión 401; abrir un ticket de un tema inválido 400; mensaje vacío 400', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/soporte/tickets')).status, 401);
  const malTema = await crear(app, { tema: 'inventado', mensaje: 'Hola' });
  assert.equal(malTema.status, 400);
  assert.equal(malTema.body.codigo, 'tema-invalido');
  const sinMensaje = await crear(app, { tema: 'otro', mensaje: '  ' });
  assert.equal(sinMensaje.status, 400);
  assert.equal(sinMensaje.body.codigo, 'mensaje-vacio');
});

test('abrir un ticket: queda abierto, con el primer mensaje, y avisa a los administradores (no a todos los miembros)', async () => {
  const { app, db } = servidor();
  const r = await crear(app, { tema: 'cobros', mensaje: 'No me llegó el recibo de este mes.' });
  assert.equal(r.status, 200);
  const { id } = r.body.ticket;
  assert.equal(r.body.ticket.estado, 'abierto');
  assert.equal(r.body.ticket.temaLabel, 'Cobros y pagos');

  const fila = db.value('soporteTickets/' + id);
  assert.equal(fila.uid, 'ana');
  assert.equal(fila.mensajesCount, 1);
  assert.equal(fila.ultimoAutor, 'miembro');

  // El aviso quedó en la campana PERSONAL del admin (avisos/{adminUid}/items), nunca en la global (a todos).
  const avisosAdmin = [...db._data.keys()].filter(k => k.startsWith('avisos/admin/items/')).map(k => db.value(k));
  assert.ok(avisosAdmin.some(a => a.tipo === 'soporte'));
  const avisosGlobales = [...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/'));
  assert.deepEqual(avisosGlobales, []);
});

test('un miembro solo ve sus propios tickets; no puede leer ni responder el de otro (403)', async () => {
  const { app } = servidor();
  const r = await crear(app, { tema: 'otro', mensaje: 'Pregunta de Ana' }, 'token-ana');
  const { id } = r.body.ticket;

  const propio = await obtener(app, id, 'token-ana');
  assert.equal(propio.status, 200);
  assert.equal(propio.body.mensajes.length, 1);

  const ajeno = await obtener(app, id, 'token-beto');
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.codigo, 'no-autorizado');

  const respuestaAjena = await responder(app, id, { texto: 'Intento de Beto' }, 'token-beto');
  assert.equal(respuestaAjena.status, 403);

  const soloDeAna = await misTickets(app, 'token-ana');
  assert.equal(soloDeAna.body.tickets.length, 1);
  const soloDeBeto = await misTickets(app, 'token-beto');
  assert.equal(soloDeBeto.body.tickets.length, 0);
});

test('el miembro responde en su hilo: sube el contador y no cierra el ticket', async () => {
  const { app, db } = servidor();
  const { body } = await crear(app, { tema: 'acceso', mensaje: 'No puedo entrar a mi cuenta.' });
  const { id } = body.ticket;
  const r = await responder(app, id, { texto: 'Sigo sin poder entrar.' });
  assert.equal(r.status, 200);
  const fila = db.value('soporteTickets/' + id);
  assert.equal(fila.mensajesCount, 2);
  assert.equal(fila.estado, 'abierto');
});

test('el administrador ve el ticket y responde: el miembro recibe un aviso personal; cualquier admin puede atenderlo', async () => {
  const { app, db } = servidor();
  const { body } = await crear(app, { tema: 'cursos', mensaje: '¿Cómo descargo mi certificado?' });
  const { id } = body.ticket;

  const listado = await listarAdmin(app);
  assert.equal(listado.status, 200);
  assert.equal(listado.body.tickets.length, 1);
  assert.equal(listado.body.tickets[0].id, id);

  const vistaAdmin = await obtenerAdmin(app, id);
  assert.equal(vistaAdmin.status, 200);
  assert.equal(vistaAdmin.body.ticket.nombre, 'Ana');

  const r = await responderAdmin(app, id, { texto: 'Lo encuentras en Mis certificados.' });
  assert.equal(r.status, 200);
  const fila = db.value('soporteTickets/' + id);
  assert.equal(fila.mensajesCount, 2);
  assert.equal(fila.ultimoAutor, 'admin');

  const avisosAna = [...db._data.keys()].filter(k => k.startsWith('avisos/ana/items/')).map(k => db.value(k));
  assert.ok(avisosAna.some(a => a.tipo === 'soporte' && a.titulo.includes('Respondieron')));
});

test('un miembro no puede usar las rutas de administración; cerrar y reabrir cambian el estado', async () => {
  const { app, db } = servidor();
  const { body } = await crear(app, { tema: 'otro', mensaje: 'Mensaje de prueba' });
  const { id } = body.ticket;

  assert.equal((await listarAdmin(app, 'token-ana')).status, 403);

  const cerrado = await cerrar(app, id);
  assert.equal(cerrado.status, 200);
  assert.equal(db.value('soporteTickets/' + id).estado, 'cerrado');

  const reabierto = await reabrir(app, id);
  assert.equal(reabierto.status, 200);
  assert.equal(db.value('soporteTickets/' + id).estado, 'abierto');

  // Responder un ticket cerrado como admin lo reabre automáticamente.
  await cerrar(app, id);
  await responderAdmin(app, id, { texto: 'Seguimos aquí' });
  assert.equal(db.value('soporteTickets/' + id).estado, 'abierto');
});

test('si el admin cerró el ticket y el miembro vuelve a escribir, se reabre solo', async () => {
  const { app, db } = servidor();
  const { body } = await crear(app, { tema: 'otro', mensaje: 'Primer mensaje' });
  const { id } = body.ticket;
  await cerrar(app, id);
  assert.equal(db.value('soporteTickets/' + id).estado, 'cerrado');
  await responder(app, id, { texto: 'Sigo con el mismo problema' });
  assert.equal(db.value('soporteTickets/' + id).estado, 'abierto');
});

test('un ticket que no existe responde 404 (miembro y admin)', async () => {
  const { app } = servidor();
  assert.equal((await obtener(app, 'no-existe')).status, 404);
  assert.equal((await obtenerAdmin(app, 'no-existe')).status, 404);
});
