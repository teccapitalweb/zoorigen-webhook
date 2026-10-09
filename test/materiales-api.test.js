'use strict';

// Endpoints de materiales PDF: lista, descarga protegida y administración (solo lectura).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');
const { carpetaLibros, carpetaMateriales, materialValido, PDF_PRUEBA } = require('./helpers/materiales');

const tokens = tokensDe('ana', 'sinplan', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const PDF = fs.readFileSync(PDF_PRUEBA);

const entradas = () => [
  materialValido('guia-miembros', 'miembros'),
  materialValido('plantilla-5', 'retos', 5, { tipo: 'plantilla' }),
  materialValido('checklist-30', 'retos', 30, { tipo: 'checklist' })
];

function servidor({ seed = {}, catalogo = entradas(), dir } = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: { LIBROS_DIR: carpetaLibros([]), MATERIALES_DIR: dir || carpetaMateriales(catalogo) }, tokens,
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
        'miembros/sinplan': miembroSinPlan(),
        'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
        'miembros/admin': miembroSinPlan({ role: 'admin' }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const lista = (app, t = 'token-ana') => request(app).get('/api/materiales').set(auth(t));
const archivo = (app, id, t = 'token-ana') => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t))
  .buffer(true).parse((res, cb) => { const trozos = []; res.on('data', c => trozos.push(c)); res.on('end', () => cb(null, Buffer.concat(trozos))); });

// ── GET /api/materiales ──
test('GET /api/materiales: 401 sin sesión; sin caché', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/materiales')).status, 401);
  assert.equal((await lista(app, 'falso')).status, 401);
  assert.match((await lista(app)).headers['cache-control'], /no-store/);
});

test('GET /api/materiales: forma de la respuesta con membresía y 4 / 5 retos', async () => {
  const { app: app4 } = servidor({ seed: retosDe('ana', 4) });
  const r4 = await lista(app4);
  assert.equal(r4.status, 200);
  assert.deepEqual(r4.body, {
    ok: true, membresia: true, superados: 4,
    materiales: [
      { id: 'guia-miembros', titulo: 'Material guia-miembros', tipo: 'guia', area: 'Pruebas', descripcion: 'Descripción de guia-miembros.', paginas: 1,
        acceso: 'miembros', requiereRetos: 0, licencia: 'Uso interno de pruebas', desbloqueado: true, faltan: 0, soloMiembros: false },
      { id: 'plantilla-5', titulo: 'Material plantilla-5', tipo: 'plantilla', area: 'Pruebas', descripcion: 'Descripción de plantilla-5.', paginas: 1,
        acceso: 'retos', requiereRetos: 5, licencia: 'Uso interno de pruebas', desbloqueado: false, faltan: 1, soloMiembros: false },
      { id: 'checklist-30', titulo: 'Material checklist-30', tipo: 'checklist', area: 'Pruebas', descripcion: 'Descripción de checklist-30.', paginas: 1,
        acceso: 'retos', requiereRetos: 30, licencia: 'Uso interno de pruebas', desbloqueado: false, faltan: 26, soloMiembros: false }
    ]
  });
  const { app: app5 } = servidor({ seed: retosDe('ana', 5) });
  const r5 = await lista(app5);
  assert.deepEqual(r5.body.materiales.map(m => [m.id, m.desbloqueado, m.faltan]),
    [['guia-miembros', true, 0], ['plantilla-5', true, 0], ['checklist-30', false, 25]]);
  assert.equal(JSON.stringify(r4.body).includes('.pdf'), false, 'no se revela el nombre del archivo');
});

test('GET /api/materiales: administrador todo abierto; sin membresía nada abre', async () => {
  const { app } = servidor({ seed: { ...retosDe('sinplan', 99), ...retosDe('vencida', 99) } });
  const admin = await lista(app, 'token-admin');
  assert.equal(admin.body.membresia, true);
  assert.ok(admin.body.materiales.every(m => m.desbloqueado && m.faltan === 0 && !m.soloMiembros));
  for (const t of ['token-sinplan', 'token-vencida']) {
    const sin = await lista(app, t);
    assert.equal(sin.body.membresia, false);
    assert.equal(sin.body.superados, 0);
    assert.ok(sin.body.materiales.every(m => !m.desbloqueado && m.soloMiembros === true), t);
  }
});

test('GET /api/materiales: catálogo vacío', async () => {
  const { app } = servidor({ catalogo: [] });
  assert.deepEqual((await lista(app)).body, { ok: true, membresia: true, superados: 0, materiales: [] });
});

test('GET /api/materiales se limita a 60 por minuto', async () => {
  const { app } = servidor();
  for (let i = 0; i < 60; i++) assert.equal((await lista(app)).status, 200);
  assert.equal((await lista(app)).status, 429);
});

// ── GET /api/materiales/:id/archivo ──
test('archivo: 401 sin sesión', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/materiales/guia-miembros/archivo')).status, 401);
  assert.equal((await archivo(app, 'guia-miembros', 'falso')).status, 401);
});

test('archivo: un miembro recibe el PDF con las cabeceras acordadas y el mismo contenido', async () => {
  const { app } = servidor();
  const res = await archivo(app, 'guia-miembros');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-disposition'], 'inline; filename="guia-miembros.pdf"');
  assert.match(res.headers['cache-control'], /private/);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(Number(res.headers['content-length']), PDF.length);
  assert.ok(Buffer.isBuffer(res.body));
  assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(res.body.equals(PDF));
});

test('archivo "retos": 403 con 4 retos (requiere, superados, faltan) y 200 con 5', async () => {
  const { app: app4 } = servidor({ seed: retosDe('ana', 4) });
  const no = await archivo(app4, 'plantilla-5');
  assert.equal(no.status, 403);
  const cuerpo = JSON.parse(no.body.toString('utf8'));
  assert.equal(cuerpo.requiere, 5);
  assert.equal(cuerpo.superados, 4);
  assert.equal(cuerpo.faltan, 1);
  assert.match(cuerpo.error, /te falta 1 reto/);
  assert.equal(cuerpo.codigo, 'retos-insuficientes');
  assert.match(no.headers['content-type'], /json/);
  const { app: app5 } = servidor({ seed: retosDe('ana', 5) });
  const si = await archivo(app5, 'plantilla-5');
  assert.equal(si.status, 200);
  assert.ok(si.body.equals(PDF));
  assert.equal((await archivo(app5, 'checklist-30')).status, 403);
});

test('archivo: sin membresía (nunca tuvo o venció) 403 aunque tenga retos; administrador abre todo', async () => {
  const { app } = servidor({ seed: { ...retosDe('vencida', 99), ...retosDe('sinplan', 99) } });
  for (const t of ['token-sinplan', 'token-vencida']) {
    for (const id of ['guia-miembros', 'plantilla-5']) {
      const res = await archivo(app, id, t);
      assert.equal(res.status, 403, `${t} ${id}`);
      const cuerpo = JSON.parse(res.body.toString('utf8'));
      assert.equal(cuerpo.codigo, 'membresia-requerida');
      assert.equal(cuerpo.superados, 0);
      assert.equal(res.headers['content-type'].includes('pdf'), false);
    }
  }
  for (const id of ['guia-miembros', 'plantilla-5', 'checklist-30']) assert.equal((await archivo(app, id, 'token-admin')).status, 200, id);
});

test('archivo: 404 si no existe', async () => {
  const { app } = servidor({ seed: retosDe('ana', 99) });
  const res = await archivo(app, 'no-existe');
  assert.equal(res.status, 404);
  assert.match(JSON.parse(res.body.toString('utf8')).error, /no existe/);
});

test('archivo: NO se puede pedir un PDF por ruta arbitraria (../, %2e%2e, separadores, extensiones, ids raros)', async () => {
  // Un PDF "secreto" junto a la carpeta de materiales y otro dentro de ella pero que NO está en el catálogo
  const dir = carpetaMateriales(entradas());
  fs.copyFileSync(PDF_PRUEBA, path.join(dir, 'fuera-del-catalogo.pdf'));
  fs.copyFileSync(PDF_PRUEBA, path.join(path.dirname(dir), 'secreto.pdf'));
  const raros = [
    '..%2Fsecreto', '..%2fsecreto.pdf', '%2e%2e%2fsecreto', '%2e%2e', '..', '.', '....//secreto', '..%5csecreto.pdf', '%252e%252e%252fsecreto',
    'fuera-del-catalogo', 'fuera-del-catalogo.pdf', 'guia-miembros.pdf', 'GUIA-MIEMBROS', 'guia-miembros%00', 'guia-miembros%0a',
    'catalogo', 'catalogo.json', 'guia miembros', 'a'.repeat(500), '%E2%80%AE', 'guia-miembros;x', 'guia-miembros%2f..%2fsecreto'
  ];
  let app;
  for (const [i, id] of raros.entries()) {
    if (i % 15 === 0) ({ app } = servidor({ dir, seed: retosDe('ana', 99) })); // el límite es 20 por minuto: servidor nuevo cada 15
    const res = await archivo(app, id);
    assert.ok([404].includes(res.status), `${id} -> ${res.status}`);
    assert.equal(String(res.headers['content-type']).includes('pdf'), false, id);
    const texto = res.body.toString('utf8');
    assert.equal(texto.includes('%PDF'), false, id);
    assert.equal(texto.includes(dir), false, 'no se filtran rutas del disco');
  }
  // Y ni siquiera el id válido del catálogo sirve otro archivo: solo el suyo
  ({ app } = servidor({ dir, seed: retosDe('ana', 99) }));
  assert.equal((await archivo(app, 'guia-miembros')).status, 200);
});

test('archivo: el PDF se lee SOLO de la ruta validada al arrancar (cambiar el catálogo después no abre nada nuevo)', async () => {
  const dir = carpetaMateriales(entradas());
  const { app } = servidor({ dir, seed: retosDe('ana', 99) });
  fs.copyFileSync(PDF_PRUEBA, path.join(dir, 'nuevo.pdf'));
  fs.writeFileSync(path.join(dir, 'catalogo.json'), JSON.stringify([...entradas(), materialValido('nuevo', 'miembros')]));
  assert.equal((await archivo(app, 'nuevo')).status, 404);
});

test('archivo: si el PDF desaparece del disco después de arrancar, 404 amable sin rutas', async () => {
  const dir = carpetaMateriales(entradas());
  const { app } = servidor({ dir });
  fs.unlinkSync(path.join(dir, 'guia-miembros.pdf'));
  const res = await archivo(app, 'guia-miembros');
  assert.equal(res.status, 404);
  const cuerpo = JSON.parse(res.body.toString('utf8'));
  assert.match(cuerpo.error, /no está disponible/);
  assert.equal(JSON.stringify(cuerpo).includes(dir), false);
});

test('archivo: la descarga se limita a 20 por minuto por persona', async () => {
  const { app } = servidor();
  for (let i = 0; i < 20; i++) assert.equal((await archivo(app, 'guia-miembros')).status, 200, `descarga ${i + 1}`);
  const exceso = await archivo(app, 'guia-miembros');
  assert.equal(exceso.status, 429);
  assert.match(JSON.parse(exceso.body.toString('utf8')).error, /Demasiadas solicitudes/);
  assert.equal((await archivo(app, 'guia-miembros', 'token-admin')).status, 200, 'el límite es por persona');
  // La lista tiene su propio contador
  assert.equal((await lista(app)).status, 200);
});

// ── Admin ──
test('GET /api/admin/materiales: solo administradores; lista lo cargado y los errores sin rutas', async () => {
  const dir = carpetaMateriales([...entradas(), materialValido('mal', 'miembros', 0, { tipo: 'zip' }), materialValido('ruta', 'miembros', 0, { archivo: '../x.pdf' })]);
  const { app } = servidor({ dir });
  assert.equal((await request(app).get('/api/admin/materiales')).status, 401);
  assert.equal((await request(app).get('/api/admin/materiales').set(auth('token-ana'))).status, 403);
  const res = await request(app).get('/api/admin/materiales').set(auth('token-admin'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.materiales.map(m => m.id), ['guia-miembros', 'plantilla-5', 'checklist-30']);
  assert.ok(res.body.materiales.every(m => m.kb >= 1));
  assert.equal(res.body.errores.length, 2);
  assert.ok(res.body.errores.every(e => e.referencia && e.error));
  const texto = JSON.stringify(res.body);
  assert.equal(texto.includes(dir), false);
  assert.equal(/guia-miembros.pdf|plantilla-5.pdf|checklist-30.pdf/.test(texto), false, 'ni nombres de archivo');
});

test('GET /api/admin/libros y /api/admin/materiales responden 401 con token falso', async () => {
  const { app } = servidor();
  for (const ruta of ['/api/admin/libros', '/api/admin/materiales']) {
    assert.equal((await request(app).get(ruta).set(auth('falso'))).status, 401, ruta);
  }
});

test('el servidor arranca aunque el catálogo de materiales no exista', async () => {
  const dir = carpetaLibros([]); // carpeta sin catalogo.json
  const { app } = servidor({ dir });
  const res = await lista(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.materiales, []);
  const admin = await request(app).get('/api/admin/materiales').set(auth('token-admin'));
  assert.equal(admin.body.errores.length, 1);
});
