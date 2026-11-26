'use strict';

// Clases en vivo: crear (Meet manual, sin Google configurado), listar, unirse (ventana + membresía),
// clases de prueba (solo superadmin), video manual + token de Bunny, migración de enlaces anteriores.
// Ejecutar: node --test test/webinars.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth } = require('./helpers/club');

// El superadmin necesita email_verified:true en el token (igual que ADMIN_EMAILS): tokensDe() no lo pone, así que aquí se arma a mano.
const tokens = {
  'token-ana': { uid: 'ana', email: 'ana@example.com' },
  'token-admin': { uid: 'admin', email: 'admin@example.com' },
  'token-superadmin': { uid: 'superadmin', email: 'super@example.com', email_verified: true }
};
const USUARIOS_AUTH = {
  ana: { emailVerified: true, email: 'ana@example.com' },
  admin: { emailVerified: true, email: 'admin@example.com' },
  superadmin: { emailVerified: true, email: 'super@example.com' }
};

function servidor(seed = {}, env = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      tokens,
      usuariosAuth: USUARIOS_AUTH,
      env: { SUPERADMIN_EMAILS: 'super@example.com', BUNNY_STREAM_LIBRARY_ID: '999', BUNNY_API_KEY: 'clave-gestion', BUNNY_TOKEN_AUTH_KEY: 'clave-token', BUNNY_WEBINARS_COLLECTION_ID: 'col-clases-en-vivo', ...env },
      seed: {
        'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin', email: 'admin@example.com' }),
        'miembros/superadmin': miembroSinPlan({ name: 'Super', email: 'super@example.com' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}

const crear = (app, cuerpo, t = 'token-admin') => request(app).post('/api/admin/webinars').set(auth(t)).send(cuerpo);
const listarAdmin = (app, t = 'token-admin') => request(app).get('/api/admin/webinars').set(auth(t));
const listar = (app, t = 'token-ana') => request(app).get('/api/webinars').set(auth(t));
const unirse = (app, id, t = 'token-ana', prueba = false) => request(app).get(`/api/webinars/${id}/unirse${prueba ? '?prueba=1' : ''}`).set(auth(t));
const eliminar = (app, id, t = 'token-admin') => request(app).delete('/api/admin/webinars/' + id).set(auth(t));
const videoManual = (app, id, body, t = 'token-admin') => request(app).post(`/api/admin/webinars/${id}/video-manual`).set(auth(t)).send(body);
const embedToken = (app, body, t = 'token-ana') => request(app).post('/api/bunny/webinar-embed-token').set(auth(t)).send(body);
const inscribirme = (app, id, t = 'token-ana') => request(app).post(`/api/webinars/${id}/inscribirme`).set(auth(t)).send({});

const futuraISO = (minutos = 60 * 24) => new Date(Date.now() + minutos * 60000).toISOString();
const datosBase = (extra = {}) => ({ titulo: 'Fauna ponzoñosa 101', instructor: 'Dra. López', duracionMin: 60, inicioISO: futuraISO(), crearMeet: false, meetManual: 'https://meet.google.com/abc-defg-hij', ...extra });

test('listar admin sin ninguna clase todavía: responde 200 con lista vacía (regresión: Firestore.getAll() no acepta cero documentos)', async () => {
  const { app } = servidor();
  const r = await listarAdmin(app);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sesiones, []);
});

test('sin sesión 401; quien no es administrador no programa clases (403)', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/admin/webinars')).status, 401);
  assert.equal((await crear(app, datosBase(), 'token-ana')).status, 403);
  assert.equal((await request(app).get('/api/webinars')).status, 401);
});

test('crear con enlace manual: el doc público NUNCA lleva meetUrl; el privado sí', async () => {
  const { app, db } = servidor();
  const r = await crear(app, datosBase());
  assert.equal(r.status, 200);
  const { id } = r.body.sesion;
  assert.equal(r.body.sesion.meetUrl, 'https://meet.google.com/abc-defg-hij'); // la respuesta al ADMIN sí lo incluye
  const pub = db.value('sesiones/' + id);
  assert.ok(pub);
  assert.equal(pub.meetUrl, undefined, 'el documento público no debe guardar meetUrl');
  assert.equal(pub.tieneGrabacion, false);
  const priv = db.value('sesionesPrivadas/' + id);
  assert.equal(priv.meetUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(priv.videoManual, false);
  // Se avisó a todos (campana global, tipo "clase")
  const avisos = [...db._data.keys()].filter(k => k.startsWith('notificacionesGlobales/')).map(k => db.value(k));
  assert.ok(avisos.some(a => a.tipo === 'clase' && a.titulo.includes('Nueva clase en vivo')));
});

test('crear: sin "crearMeet" y sin enlace manual, 400; con crearMeet pero sin Google configurado, 503', async () => {
  const { app } = servidor();
  const sinEnlace = await crear(app, { ...datosBase(), meetManual: '' });
  assert.equal(sinEnlace.status, 400);
  assert.equal(sinEnlace.body.codigo, 'enlace-invalido');
  const conMeetAuto = await crear(app, { ...datosBase(), crearMeet: true, meetManual: undefined });
  assert.equal(conMeetAuto.status, 503);
  assert.equal(conMeetAuto.body.codigo, 'google-no-configurado');
});

test('crear: valida título, instructor, duración (15 a 240) y fecha', async () => {
  const { app } = servidor();
  for (const cuerpo of [
    { ...datosBase(), titulo: 'ab' }, { ...datosBase(), instructor: 'x' },
    { ...datosBase(), duracionMin: 10 }, { ...datosBase(), duracionMin: 300 }, { ...datosBase(), duracionMin: 'mucho' },
    { ...datosBase(), inicioISO: 'no-es-fecha' }
  ]) assert.equal((await crear(app, cuerpo)).status, 400, JSON.stringify(cuerpo));
});

test('listar: un miembro ve las clases reales sin meetUrl; GET admin trae todo con su estado de automatización', async () => {
  const { app } = servidor();
  const { body } = await crear(app, datosBase({ titulo: 'Rescate de fauna silvestre' }));
  const l = await listar(app);
  assert.equal(l.status, 200);
  assert.equal(l.body.sesiones.length, 1);
  assert.equal(l.body.sesiones[0].titulo, 'Rescate de fauna silvestre');
  assert.equal(l.body.sesiones[0].meetUrl, undefined);
  assert.equal(l.body.sesiones[0].inscrito, false);

  const la = await listarAdmin(app);
  assert.equal(la.status, 200);
  assert.equal(la.body.sesiones[0].automatizacion, 'programada');
  assert.equal(la.body.sesiones[0].id, body.sesion.id);
});

test('unirse: sin membresía 403; fuera de la ventana 409; con membresía y dentro de la ventana 200 con meetUrl', async () => {
  const { app } = servidor({ 'miembros/ana': miembroSinPlan({ name: 'Ana', email: 'ana@example.com' }) });
  const futura = await crear(app, datosBase({ inicioISO: futuraISO(60 * 24) })); // en un día: fuera de ventana
  const sinMembresia = await unirse(app, futura.body.sesion.id);
  assert.equal(sinMembresia.status, 403);
  assert.equal(sinMembresia.body.codigo, 'sin-membresia');

  const { app: app2 } = servidor({ 'miembros/ana': miembroConPlan({ name: 'Ana', email: 'ana@example.com' }) });
  const r2 = await crear(app2, datosBase({ inicioISO: futuraISO(60 * 24) }));
  const fueraVentana = await unirse(app2, r2.body.sesion.id);
  assert.equal(fueraVentana.status, 409);
  assert.equal(fueraVentana.body.codigo, 'fuera-de-ventana');

  const r3 = await crear(app2, datosBase({ inicioISO: futuraISO(2), duracionMin: 60 })); // en 2 min: dentro de la ventana (10 min antes)
  const dentro = await unirse(app2, r3.body.sesion.id);
  assert.equal(dentro.status, 200);
  assert.equal(dentro.body.meetUrl, 'https://meet.google.com/abc-defg-hij');

  // El administrador siempre puede entrar, tenga o no membresía.
  const { app: app3 } = servidor();
  const r4 = await crear(app3, datosBase({ inicioISO: futuraISO(2) }));
  assert.equal((await unirse(app3, r4.body.sesion.id, 'token-admin')).status, 200);
});

test('clases de prueba: invisibles para un miembro normal; visibles y accesibles solo para el superadmin/admin', async () => {
  const { app } = servidor();
  const r = await crear(app, datosBase({ esPrueba: true, titulo: 'Prueba interna' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.sesion.esPrueba, true);

  const comoAna = await listar(app, 'token-ana');
  assert.equal(comoAna.body.sesiones.length, 0, 'la clase de prueba no debe salir en el listado de un miembro normal');

  const comoSuper = await listar(app, 'token-superadmin');
  assert.equal(comoSuper.body.sesiones.length, 1);
  assert.equal(comoSuper.body.sesiones[0].esPrueba, true);

  // Un miembro normal no puede "unirse" a la prueba (404, sin filtrar que exista)
  const intento = await unirse(app, r.body.sesion.id, 'token-ana', true);
  assert.equal(intento.status, 404);

  // La campana de "clase de prueba programada" solo le llegó al superadmin (su uid), no a todos.
  const { app: app2, db } = servidor();
  await crear(app2, datosBase({ esPrueba: true }));
  const personales = [...db._data.keys()].filter(k => k.startsWith('avisos/'));
  assert.ok(personales.some(k => k.includes('/superadmin/')));
  assert.ok(!personales.some(k => k.includes('/ana/')));
});

test('eliminar: borra los documentos público y privado', async () => {
  const { app, db } = servidor();
  const r = await crear(app, datosBase());
  const id = r.body.sesion.id;
  assert.equal((await eliminar(app, id)).status, 200);
  assert.equal(db.value('sesiones/' + id), undefined);
  assert.equal(db.value('sesionesPrivadas/' + id), undefined);
});

test('video manual + token de Bunny: solo con membresía (o admin), y solo si ya se fijó un video', async () => {
  const { app } = servidor();
  const r = await crear(app, datosBase());
  const id = r.body.sesion.id;

  const sinVideo = await embedToken(app, { sesionId: id }, 'token-admin');
  assert.equal(sinVideo.status, 404);

  assert.equal((await videoManual(app, id, { bunnyVideoId: 'vid-123' })).status, 200);

  const sinMembresia = await embedToken(app, { sesionId: id });
  assert.equal(sinMembresia.status, 403);

  const { app: app2 } = servidor({ 'miembros/ana': miembroConPlan({ name: 'Ana', email: 'ana@example.com' }) });
  const r2 = await crear(app2, datosBase());
  await videoManual(app2, r2.body.sesion.id, { bunnyVideoId: 'vid-456' });
  const conMembresia = await embedToken(app2, { sesionId: r2.body.sesion.id });
  assert.equal(conMembresia.status, 200);
  // Misma librería que los cursos (731751, el valor por omisión cuando no se define BUNNY_STREAM_LIBRARY_ID).
  assert.match(conMembresia.body.embedUrl, /^https:\/\/iframe\.mediadelivery\.net\/embed\/731751\/vid-456\?token=/);
});

test('inscribirme: queda marcada en el siguiente listado', async () => {
  const { app } = servidor({ 'miembros/ana': miembroConPlan({ name: 'Ana', email: 'ana@example.com' }) });
  const r = await crear(app, datosBase());
  assert.equal((await inscribirme(app, r.body.sesion.id)).status, 200);
  const l = await listar(app);
  assert.equal(l.body.sesiones[0].inscrito, true);
});

test('proteger enlaces: migra un meetUrl que haya quedado en el documento público (clases creadas antes de este cambio)', async () => {
  const { app, db } = servidor({
    'sesiones/legado1': { title: 'Webinar viejo', date: '2026-01-10', time: '19:00', duration: '60 min', meetUrl: 'https://meet.google.com/legado-1' }
  });
  const pend = await request(app).get('/api/admin/webinars/legado-pendiente').set(auth('token-admin'));
  assert.equal(pend.body.total, 1);
  const r = await request(app).post('/api/admin/webinars/proteger-enlaces').set(auth('token-admin')).send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.migradas, 1);
  assert.equal(db.value('sesiones/legado1').meetUrl, null); // el "delete" de la fake de Firestore se representa como null (igual que adminOrigen en admin-acceso.test.js)
  assert.equal(db.value('sesionesPrivadas/legado1').meetUrl, 'https://meet.google.com/legado-1');
  const pend2 = await request(app).get('/api/admin/webinars/legado-pendiente').set(auth('token-admin'));
  assert.equal(pend2.body.total, 0);
});
