'use strict';

// Control de acceso del panel de administración: administrador (por ADMIN_EMAILS o por marca en Firestore) frente a
// miembro, a cuenta sin plan y a visitante sin sesión. Ninguna ruta /api/admin/* debe dar datos a quien no administra.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth } = require('./helpers/club');

const CORREO_ADMIN = 'duena.zoorigen@gmail.com';

const tokens = {
  'token-miembro': { uid: 'miembro1', email: 'miembro@example.com', email_verified: true },
  'token-sinplan': { uid: 'sinplan1', email: 'sinplan@example.com', email_verified: true },
  'token-marca': { uid: 'marca1', email: 'marca@example.com', email_verified: true },
  'token-correo': { uid: 'correo1', email: CORREO_ADMIN, email_verified: true },
  'token-correo-mayus': { uid: 'correo1', email: CORREO_ADMIN.toUpperCase(), email_verified: true },
  'token-correo-sinverificar': { uid: 'falso1', email: CORREO_ADMIN, email_verified: false },
  'token-correo-sinflag': { uid: 'falso2', email: CORREO_ADMIN }
};

function montar(seed = {}) {
  return cargarServidor({
    tokens,
    seed: {
      'miembros/miembro1': miembroConPlan({ name: 'Mónica Miembro', email: 'miembro@example.com' }),
      'miembros/sinplan1': miembroSinPlan({ name: 'Sara Sinplan' }),
      'miembros/marca1': miembroSinPlan({ name: 'Marca Manual', role: 'admin' }),
      'miembros/correo1': miembroSinPlan({ name: 'Dueña', email: CORREO_ADMIN }),
      'miembros/falso1': miembroSinPlan({ name: 'Intrusa' }),
      'miembros/falso2': miembroSinPlan({ name: 'Intrusa 2' }),
      ...seed
    }
  });
}

function conAdminEmails(valor, fn) {
  return async () => {
    const previo = process.env.ADMIN_EMAILS;
    if (valor === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = valor;
    try { await fn(); } finally {
      if (previo === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previo;
    }
  };
}

const RUTAS_GET = [
  '/api/admin/yo', '/api/admin/resumen', '/api/admin/miembros', '/api/admin/miembros/miembro1', '/api/admin/comunidad',
  '/api/admin/referidos', '/api/admin/retos', '/api/admin/estado'
];
const RUTAS_POST = ['/api/admin/miembros/miembro1/activar', '/api/admin/miembros/miembro1/cancelar'];

test('sin sesión: todas las rutas del panel responden 401 y no devuelven datos', conAdminEmails(CORREO_ADMIN, async () => {
  const { app } = montar();
  for (const ruta of RUTAS_GET) {
    const r = await request(app).get(ruta);
    assert.equal(r.status, 401, ruta);
    assert.deepEqual(Object.keys(r.body), ['error'], ruta);
  }
  for (const ruta of RUTAS_POST) {
    const r = await request(app).post(ruta).send({ tipo: 'mensual' });
    assert.equal(r.status, 401, ruta);
  }
  const falso = await request(app).get('/api/admin/yo').set(auth('token-que-no-existe'));
  assert.equal(falso.status, 401);
}));

test('miembro con plan y cuenta sin plan: 403 en todas las rutas, sin ningún dato', conAdminEmails(CORREO_ADMIN, async () => {
  const { app, db } = montar();
  for (const t of ['token-miembro', 'token-sinplan']) {
    for (const ruta of RUTAS_GET) {
      const r = await request(app).get(ruta).set(auth(t));
      assert.equal(r.status, 403, `${t} ${ruta}`);
      assert.deepEqual(Object.keys(r.body), ['error'], `${t} ${ruta}`);
    }
    for (const ruta of RUTAS_POST) {
      const r = await request(app).post(ruta).set(auth(t)).send({ tipo: 'mensual' });
      assert.equal(r.status, 403, `${t} ${ruta}`);
    }
  }
  // El miembro no cambió: ninguna acción se ejecutó.
  assert.equal(db.value('miembros/miembro1').planCancelado, false);
  assert.equal(db.value('miembros/sinplan1').planActivo, false);
}));

test('administrador por marca en Firestore (role admin): 200 en /yo y en las lecturas', conAdminEmails('', async () => {
  const { app } = montar();
  const yo = await request(app).get('/api/admin/yo').set(auth('token-marca'));
  assert.equal(yo.status, 200);
  assert.equal(yo.body.admin, true);
  assert.equal(yo.body.via, 'documento');
  assert.equal(yo.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(yo.body).includes('@'), false, '/yo no devuelve correos');
  for (const ruta of RUTAS_GET) {
    const r = await request(app).get(ruta).set(auth('token-marca'));
    assert.equal(r.status, 200, ruta);
  }
}));

test('administrador por ADMIN_EMAILS: entra con correo verificado (sin importar mayúsculas) y queda marcado en Firestore', conAdminEmails(`otro@example.com, ${CORREO_ADMIN}`, async () => {
  const { app, db } = montar();
  const yo = await request(app).get('/api/admin/yo').set(auth('token-correo'));
  assert.equal(yo.status, 200);
  assert.equal(yo.body.via, 'correo');
  const marca = db.value('miembros/correo1');
  assert.equal(marca.role, 'admin');
  assert.equal(marca.adminOrigen, 'ADMIN_EMAILS');
  const mayus = await request(app).get('/api/admin/miembros').set(auth('token-correo-mayus'));
  assert.equal(mayus.status, 200);
}));

test('ADMIN_EMAILS no basta con un correo sin verificar ni con un token sin la bandera email_verified', conAdminEmails(CORREO_ADMIN, async () => {
  const { app, db } = montar();
  for (const t of ['token-correo-sinverificar', 'token-correo-sinflag']) {
    const r = await request(app).get('/api/admin/yo').set(auth(t));
    assert.equal(r.status, 403, t);
  }
  assert.equal(db.value('miembros/falso1').role, 'member');
  assert.equal(db.value('miembros/falso2').role, 'member');
}));

test('sin ADMIN_EMAILS definida, ningún correo es administrador y el resto de reglas siguen igual', conAdminEmails(undefined, async () => {
  const { app } = montar();
  assert.equal((await request(app).get('/api/admin/yo').set(auth('token-correo'))).status, 403);
  assert.equal((await request(app).get('/api/admin/yo').set(auth('token-marca'))).status, 200);
}));

test('un administrador por documento admins/{uid} también pasa', conAdminEmails('', async () => {
  const { app } = montar({ 'admins/sinplan1': { creado: true } });
  const r = await request(app).get('/api/admin/yo').set(auth('token-sinplan'));
  assert.equal(r.status, 200);
}));

test('si el correo sale de ADMIN_EMAILS se quita la marca que puso el servidor, pero no la puesta a mano', async () => {
  const { app, db } = montar();
  process.env.ADMIN_EMAILS = CORREO_ADMIN;
  try {
    assert.equal((await request(app).get('/api/admin/yo').set(auth('token-correo'))).status, 200);
    assert.equal(db.value('miembros/correo1').role, 'admin');
    process.env.ADMIN_EMAILS = 'otra.persona@example.com';
    const r = await request(app).get('/api/admin/yo').set(auth('token-correo'));
    assert.equal(r.status, 403);
    assert.equal(db.value('miembros/correo1').role, 'member');
    assert.equal(db.value('miembros/correo1').adminOrigen, null);
    // La marca puesta a mano no se toca aunque ADMIN_EMAILS no tenga ese correo
    assert.equal((await request(app).get('/api/admin/yo').set(auth('token-marca'))).status, 200);
    assert.equal(db.value('miembros/marca1').role, 'admin');
  } finally { delete process.env.ADMIN_EMAILS; }
});

test('un correo de ADMIN_EMAILS que pega a rutas del club no rompe nada y queda sincronizado', conAdminEmails(CORREO_ADMIN, async () => {
  const { app, db } = montar();
  const r = await request(app).get('/api/prueba-gratuita').set(auth('token-correo'));
  assert.equal(r.status, 200);
  assert.equal(db.value('miembros/correo1').role, 'admin');
}));

test('las rutas de administración ya existentes (encuesta, noticias, avisos) aceptan al administrador por ADMIN_EMAILS y rechazan al miembro', conAdminEmails(CORREO_ADMIN, async () => {
  const { app } = montar();
  for (const ruta of ['/api/admin/encuesta', '/api/admin/noticias', '/api/admin/avisos', '/api/admin/libros']) {
    assert.equal((await request(app).get(ruta).set(auth('token-correo'))).status, 200, ruta);
    assert.equal((await request(app).get(ruta).set(auth('token-miembro'))).status, 403, ruta);
  }
}));
