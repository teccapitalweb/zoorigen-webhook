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
  'token-correo-sinflag': { uid: 'falso2', email: CORREO_ADMIN },
  // Las dos cuentas del dueño (valor exacto de ADMIN_EMAILS en Railway: ver CORREOS_DUENO)
  'token-zoo': { uid: 'dueno1', email: 'zooorigen@gmail.com', email_verified: true },
  'token-tec': { uid: 'dueno2', email: 'teccapitalweb@gmail.com', email_verified: true },
  'token-tec-mayus': { uid: 'dueno2', email: '  TecCapitalWeb@Gmail.com ', email_verified: true },
  'token-zoo-sinverificar': { uid: 'dueno3', email: 'zooorigen@gmail.com', email_verified: false },
  'token-parecido': { uid: 'falso3', email: 'zooorigen@gmail.com.mx', email_verified: true },
  'token-parecido2': { uid: 'falso4', email: 'zoorigen@gmail.com', email_verified: true }
};
const CORREOS_DUENO = 'zooorigen@gmail.com,teccapitalweb@gmail.com';

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
  '/api/admin/referidos', '/api/admin/retos', '/api/admin/estado', '/api/admin/progreso-legado',
  '/api/admin/metricas', '/api/admin/pruebas', '/api/admin/eliminados', '/api/admin/encuesta/detalle',
  '/api/admin/chatbot/sin-respuesta/detalle', '/api/admin/config'
];
const RUTAS_POST = ['/api/admin/miembros/miembro1/activar', '/api/admin/miembros/miembro1/cancelar', '/api/admin/progreso-legado/miembro1/importar',
  '/api/admin/miembros/miembro1/regalar', '/api/admin/eliminados/miembro1/restaurar', '/api/admin/config', '/api/admin/encuesta/atender', '/api/admin/encuesta/borrar'];

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

// ── Valor exacto que se pone en Railway ──
test('ADMIN_EMAILS = zooorigen@gmail.com,teccapitalweb@gmail.com: las dos cuentas del dueño administran; nadie más ni sin verificar', conAdminEmails(CORREOS_DUENO, async () => {
  const { app } = montar();
  for (const t of ['token-zoo', 'token-tec', 'token-tec-mayus']) {
    const r = await request(app).get('/api/admin/yo').set(auth(t));
    assert.equal(r.status, 200, t);
    assert.equal(r.body.via, 'correo');
  }
  for (const t of ['token-zoo-sinverificar', 'token-parecido', 'token-parecido2', 'token-miembro']) {
    assert.equal((await request(app).get('/api/admin/yo').set(auth(t))).status, 403, t);
  }
}));

test('ADMIN_EMAILS tolera espacios alrededor de las comas y mayúsculas en la lista', conAdminEmails(' ZooOrigen@Gmail.com , TECCAPITALWEB@gmail.com ', async () => {
  const { app } = montar();
  assert.equal((await request(app).get('/api/admin/yo').set(auth('token-zoo'))).status, 200);
  assert.equal((await request(app).get('/api/admin/yo').set(auth('token-tec'))).status, 200);
}));

// ── Variante suave: la usa el Club para decidir si va al panel, sin errores 403 en la consola del navegador ──
test('GET /api/admin/yo?suave=1: administrador 200 con admin true; miembro y sin plan 200 con admin false; sin sesión 401', conAdminEmails(CORREO_ADMIN, async () => {
  const { app } = montar();
  const admin = await request(app).get('/api/admin/yo?suave=1').set(auth('token-correo'));
  assert.equal(admin.status, 200);
  assert.equal(admin.body.admin, true);
  assert.equal(admin.headers['cache-control'], 'no-store');
  for (const t of ['token-miembro', 'token-sinplan', 'token-correo-sinverificar']) {
    const r = await request(app).get('/api/admin/yo?suave=1').set(auth(t));
    assert.equal(r.status, 200, t);
    assert.deepEqual(r.body, { ok: true, admin: false }, t + ': sin datos');
  }
  assert.equal((await request(app).get('/api/admin/yo?suave=1')).status, 401);
  assert.equal((await request(app).get('/api/admin/yo?suave=1').set(auth('token-que-no-existe'))).status, 401);
  // sin ?suave=1 la ruta sigue siendo estricta
  assert.equal((await request(app).get('/api/admin/yo').set(auth('token-miembro'))).status, 403);
}));

test('la variante suave respeta la marca de ADMIN_EMAILS que ya no vale (se retira y responde admin false)', async () => {
  const { app, db } = montar();
  process.env.ADMIN_EMAILS = CORREO_ADMIN;
  try {
    assert.equal((await request(app).get('/api/admin/yo?suave=1').set(auth('token-correo'))).body.admin, true);
    process.env.ADMIN_EMAILS = 'otra.persona@example.com';
    const r = await request(app).get('/api/admin/yo?suave=1').set(auth('token-correo'));
    assert.equal(r.status, 200);
    assert.equal(r.body.admin, false);
    assert.equal(db.value('miembros/correo1').role, 'member');
  } finally { delete process.env.ADMIN_EMAILS; }
});
