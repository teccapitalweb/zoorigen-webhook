'use strict';

// Materiales ligados a un curso y a una clase (services/materiales-curso.js + rutas): se abren cuando la persona
// TERMINA esa clase; los generales se abren con membresía o con retos. El archivo y el enlace los entrega SOLO el servidor.
// Matriz: miembro con / sin la clase vista, no miembro (sin plan y vencido), administrador, material del catálogo de archivos,
// PDF de Drive del panel, material general, material por retos y ligas mal capturadas.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');
const { carpetaLibros, carpetaMateriales, materialValido } = require('./helpers/materiales');
const porCurso = require('../services/materiales-curso');
const catalogoArchivos = require('../services/materiales');

const tokens = tokensDe('ana', 'beto', 'nuevo', 'sinplan', 'vencida', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const progresoDe = (uid, cursoId, vistas) => ({ [`miembros/${uid}/progresoCursos/${cursoId}`]: { cursoId, uid, sesionesVistas: vistas, quizzesAprobados: [], completado: false } });
const DRIVE = n => `1DriveDePrueba${String(n).padStart(10, '0')}`;
const pdf = (titulo, extra = {}, n = 1) => ({ title: titulo, area: 'Manejo', pages: 4, driveId: DRIVE(n), createdAt: '2026-10-01T00:00:00.000Z', ...extra });

// Catálogo de archivos: uno general, uno por retos y dos ligados al curso c1 (clase 2 y todo el curso)
const entradas = () => [
  materialValido('guia-miembros', 'miembros'),
  materialValido('plantilla-5', 'retos', 5),
  materialValido('ficha-clase-2', 'curso', undefined, { cursoId: 'c1', clase: 2 }),
  materialValido('manual-del-curso', 'curso', undefined, { cursoId: 'c1' })
];

function servidor({ seed = {}, catalogo = entradas(), conPdfs = true } = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: { LIBROS_DIR: carpetaLibros([]), MATERIALES_DIR: carpetaMateriales(catalogo) }, tokens,
      seed: {
        ...cursosSeed(3),
        'miembros/ana': miembroConPlan({ name: 'Ana' }),
        'miembros/beto': miembroConPlan({ name: 'Beto' }),
        'miembros/nuevo': miembroConPlan({ name: 'Nuevo' }),
        'miembros/sinplan': miembroSinPlan(),
        'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
        'miembros/admin': miembroSinPlan({ role: 'admin' }),
        // ana terminó la clase 1; beto las clases 1 y 2; "nuevo" ninguna
        ...progresoDe('ana', 'c1', [0]),
        ...progresoDe('beto', 'c1', [0, 1]),
        // PDF de Drive del panel
        ...(!conPdfs ? {} : {
        'pdfs/dClase1': pdf('Guía de la clase 1', { cursoId: 'c1', clase: 1 }, 1),
        'pdfs/dClase2': pdf('Hoja de trabajo de la clase 2', { cursoId: 'c1', clase: 2 }, 2),
        'pdfs/dCurso': pdf('Bibliografía del curso', { cursoId: 'c1' }, 3),
        'pdfs/dGeneral': pdf('Formato general', {}, 4),
        'pdfs/dRetos': pdf('Atlas por retos', { requiereRetos: 3 }, 5),
        'pdfs/dSinCurso': pdf('Curso que no existe', { cursoId: 'no-existe', clase: 1 }, 6),
        'pdfs/dClaseFuera': pdf('Clase que el curso no tiene', { cursoId: 'c1', clase: 9 }, 7),
        'pdfs/dRota': { title: 'Sin enlace', area: 'Manejo' }
        }),
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const listaDrive = (app, t = 'token-ana') => request(app).get('/api/materiales/drive').set(auth(t));
const enlace = (app, id, t = 'token-ana') => request(app).get(`/api/materiales/drive/${id}/enlace`).set(auth(t));
const porCursos = (app, t = 'token-ana') => request(app).get('/api/materiales/cursos').set(auth(t));
const catalogo = (app, t = 'token-ana') => request(app).get('/api/materiales').set(auth(t));
const archivo = (app, id, t = 'token-ana') => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t)).buffer(true)
  .parse((res, cb) => { const trozos = []; res.on('data', c => trozos.push(c)); res.on('end', () => { const todo = Buffer.concat(trozos); cb(null, /json/.test(res.headers['content-type'] || '') ? JSON.parse(todo.toString('utf8')) : todo); }); });
const estadoDrive = r => Object.fromEntries(r.body.materiales.map(m => [m.id, m.desbloqueado]));

// ───────────── funciones puras ─────────────
test('numeroClase / idCurso / retosRequeridos: solo valores válidos', () => {
  assert.equal(porCurso.numeroClase(2), 2);
  assert.equal(porCurso.numeroClase('3'), 3);
  for (const malo of [0, -1, 1.5, 501, 'x', null, undefined, '', {}, [], true]) assert.equal(porCurso.numeroClase(malo), 0, String(malo));
  assert.equal(porCurso.idCurso('c1'), 'c1');
  assert.equal(porCurso.idCurso(' tiburones-y-rayas '), 'tiburones-y-rayas');
  for (const malo of ['', '../x', 'a b', '/', 'a/b', null, 5, 'x'.repeat(151)]) assert.equal(porCurso.idCurso(malo), '', String(malo));
  assert.equal(porCurso.retosRequeridos(5), 5);
  assert.equal(porCurso.retosRequeridos(0), 0);
  assert.equal(porCurso.retosRequeridos(201), 0);
});

test('normalizarPdfDrive: exige título y enlace válido; una liga mal escrita no deja el material abierto', () => {
  assert.equal(porCurso.normalizarPdfDrive('x', { title: 'Sin enlace' }), null);
  assert.equal(porCurso.normalizarPdfDrive('x', { driveId: DRIVE(1) }), null);
  assert.equal(porCurso.normalizarPdfDrive('x', { title: 'Malo', driveId: '../../etc' }), null);
  const bueno = porCurso.normalizarPdfDrive('x', pdf('Bueno', { cursoId: 'c1', clase: '2' }));
  assert.equal(bueno.cursoId, 'c1');
  assert.equal(bueno.clase, 2);
  assert.equal(bueno.configuracionInvalida, false);
  const roto = porCurso.normalizarPdfDrive('x', pdf('Roto', { cursoId: '../x', clase: 1 }));
  assert.equal(roto.cursoId, '');
  assert.equal(roto.configuracionInvalida, true, 'un curso mal escrito queda marcado, no abierto');
  const claseRota = porCurso.normalizarPdfDrive('x', pdf('Clase rota', { cursoId: 'c1', clase: 'dos' }));
  assert.equal(claseRota.configuracionInvalida, true);
  assert.equal(porCurso.normalizarPdfDrive('x', pdf('Retos con curso', { cursoId: 'c1', requiereRetos: 5 })).requiereRetos, 0, 'con curso mandan las clases, no los retos');
});

test('acceso (puro): clase vista abre; clase pendiente, sin membresía y curso inexistente no', () => {
  const m = { cursoId: 'c1', clase: 2, requiereRetos: 0 };
  const cursos = new Map([['c1', { titulo: 'Curso 1', total: 3 }]]);
  const base = { membresia: true, superados: 0, cursos };
  assert.equal(porCurso.acceso(m, { ...base, vistas: new Map([['c1', new Set([0, 1])]]) }).desbloqueado, true);
  assert.equal(porCurso.acceso(m, { ...base, vistas: new Map([['c1', new Set([0])]]) }).desbloqueado, false);
  assert.equal(porCurso.acceso(m, { ...base, vistas: new Map([['c1', new Set([1])]]) }).desbloqueado, true, 'cuenta la clase 2 (índice 1), no una anterior');
  assert.equal(porCurso.acceso(m, { ...base, membresia: false, vistas: new Map([['c1', new Set([0, 1])]]) }).desbloqueado, false);
  assert.equal(porCurso.acceso(m, { ...base, esAdmin: true, vistas: new Map() }).desbloqueado, true);
  assert.equal(porCurso.acceso(m, { ...base, cursos: new Map([['c1', null]]), vistas: new Map() }).pendiente, true);
  assert.equal(porCurso.acceso({ ...m, clase: 4 }, { ...base, vistas: new Map([['c1', new Set([0, 1, 2, 3])]]) }).desbloqueado, false, 'clase fuera de rango');
});

// ───────────── catálogo de archivos con acceso "curso" ─────────────
test('catálogo de archivos: "curso" necesita cursoId válido; clase opcional 1..500; no mezcla con retos', () => {
  const ok = catalogoArchivos.normalizarMaterial(materialValido('ficha', 'curso', undefined, { cursoId: 'c1', clase: 2 }));
  assert.equal(ok.cursoId, 'c1'); assert.equal(ok.clase, 2);
  assert.equal(catalogoArchivos.normalizarMaterial(materialValido('manual', 'curso', undefined, { cursoId: 'c1' })).clase, 0);
  assert.throws(() => catalogoArchivos.normalizarMaterial(materialValido('sin-curso', 'curso')), /cursoId/);
  assert.throws(() => catalogoArchivos.normalizarMaterial(materialValido('curso-malo', 'curso', undefined, { cursoId: '../x' })), /cursoId/);
  assert.throws(() => catalogoArchivos.normalizarMaterial(materialValido('clase-mala', 'curso', undefined, { cursoId: 'c1', clase: 0 })), /clase/);
  assert.throws(() => catalogoArchivos.normalizarMaterial(materialValido('con-retos', 'curso', undefined, { cursoId: 'c1', requiereRetos: 3 })), /requiereRetos/);
  assert.throws(() => catalogoArchivos.normalizarMaterial(materialValido('miembros-con-curso', 'miembros', undefined, { cursoId: 'c1' })), /curso/);
});

test('GET /api/materiales: los ligados a curso suman cursoId, clase y condición; los demás conservan su forma', async () => {
  const { app } = servidor();
  const r = await catalogo(app);
  assert.equal(r.status, 200);
  const por = Object.fromEntries(r.body.materiales.map(m => [m.id, m]));
  assert.equal(por['ficha-clase-2'].cursoId, 'c1');
  assert.equal(por['ficha-clase-2'].clase, 2);
  assert.equal(por['ficha-clase-2'].condicion, 'clase');
  assert.equal(por['ficha-clase-2'].cursoTitulo, 'Curso 1');
  assert.equal(por['ficha-clase-2'].desbloqueado, false, 'ana solo terminó la clase 1');
  assert.equal(por['manual-del-curso'].condicion, 'curso');
  assert.equal(por['manual-del-curso'].desbloqueado, true);
  assert.equal('cursoId' in por['guia-miembros'], false);
  assert.equal('condicion' in por['plantilla-5'], false);
  assert.equal(JSON.stringify(r.body).includes('.pdf'), false);
});

test('GET /api/materiales/:id/archivo (ligado a clase): 403 sin la clase vista, 200 con ella, 403 sin membresía, 200 administrador', async () => {
  const { app } = servidor();
  const sin = await archivo(app, 'ficha-clase-2', 'token-ana');
  assert.equal(sin.status, 403);
  assert.equal(sin.body.codigo, 'clase-pendiente');
  assert.match(sin.body.error, /Se desbloquea al terminar la clase 2 del curso «Curso 1»/);
  const con = await archivo(app, 'ficha-clase-2', 'token-beto');
  assert.equal(con.status, 200);
  assert.equal(con.headers['content-type'], 'application/pdf');
  assert.equal((await archivo(app, 'ficha-clase-2', 'token-nuevo')).status, 403);
  for (const t of ['token-sinplan', 'token-vencida']) {
    const x = await archivo(app, 'ficha-clase-2', t);
    assert.equal(x.status, 403, t);
    assert.equal(x.body.codigo, 'membresia-requerida', t);
  }
  assert.equal((await archivo(app, 'ficha-clase-2', 'token-admin')).status, 200);
  assert.equal((await request(app).get('/api/materiales/ficha-clase-2/archivo')).status, 401);
  // el del curso completo se abre con membresía, también sin avance
  assert.equal((await archivo(app, 'manual-del-curso', 'token-nuevo')).status, 200);
  assert.equal((await archivo(app, 'manual-del-curso', 'token-sinplan')).status, 403);
});

test('catálogo ligado a un curso que no existe: queda cerrado para miembros (solo el administrador lo abre) y se avisa como pendiente', async () => {
  const { app } = servidor({ catalogo: [materialValido('huerfano', 'curso', undefined, { cursoId: 'no-existe', clase: 1 })] });
  const r = await catalogo(app);
  assert.equal(r.body.materiales[0].desbloqueado, false);
  assert.equal(r.body.materiales[0].pendiente, true);
  const x = await archivo(app, 'huerfano', 'token-ana');
  assert.equal(x.status, 403);
  assert.equal(x.body.codigo, 'material-no-disponible');
  assert.equal((await archivo(app, 'huerfano', 'token-admin')).status, 200);
});

// ───────────── PDF de Drive (panel) ─────────────
test('GET /api/materiales/drive: 401 sin sesión; sin caché; nunca entrega el enlace de Drive ni el id', async () => {
  const { app } = servidor();
  assert.equal((await request(app).get('/api/materiales/drive')).status, 401);
  assert.equal((await listaDrive(app, 'falso')).status, 401);
  const r = await listaDrive(app);
  assert.equal(r.status, 200);
  assert.match(r.headers['cache-control'], /no-store/);
  const texto = JSON.stringify(r.body);
  assert.equal(texto.includes('DriveDePrueba'), false);
  assert.equal(texto.includes('drive.google.com'), false);
  assert.equal(texto.includes('driveId'), false);
  assert.equal(r.body.materiales.some(m => m.id === 'dRota'), false, 'sin enlace válido no se lista');
});

test('matriz de PDF de Drive para un miembro que terminó la clase 1 (ana)', async () => {
  const { app } = servidor({ seed: retosDe('ana', 2) });
  const r = await listaDrive(app);
  assert.deepEqual(estadoDrive(r), {
    dClase1: true,        // terminó la clase 1
    dClase2: false,       // le falta la clase 2
    dCurso: true,         // material de todo el curso: abierto con membresía
    dGeneral: true,       // general: abierto con membresía
    dRetos: false,        // pide 3 retos y lleva 2
    dSinCurso: false,     // curso que no existe
    dClaseFuera: false    // clase que el curso no tiene (el curso tiene 3)
  });
  const por = Object.fromEntries(r.body.materiales.map(m => [m.id, m]));
  assert.equal(por.dClase2.condicion, 'clase');
  assert.equal(por.dClase2.clase, 2);
  assert.equal(por.dClase2.cursoTitulo, 'Curso 1');
  assert.equal(por.dRetos.condicion, 'retos');
  assert.equal(por.dRetos.faltan, 1);
  assert.equal(por.dGeneral.condicion, 'miembros');
  assert.equal(por.dSinCurso.pendiente, true);
  assert.equal(por.dClaseFuera.pendiente, true);
});

test('matriz para beto (clases 1 y 2), "nuevo" (ninguna) y con 3 retos', async () => {
  const { app } = servidor({ seed: { ...retosDe('beto', 3) } });
  const beto = estadoDrive(await listaDrive(app, 'token-beto'));
  assert.equal(beto.dClase1, true); assert.equal(beto.dClase2, true); assert.equal(beto.dRetos, true);
  const nuevo = estadoDrive(await listaDrive(app, 'token-nuevo'));
  assert.equal(nuevo.dClase1, false, 'sin ninguna clase vista nada de clase se abre');
  assert.equal(nuevo.dClase2, false);
  assert.equal(nuevo.dCurso, true);
  assert.equal(nuevo.dGeneral, true);
});

test('no miembro (sin plan y vencido): ve el catálogo con soloMiembros y nada abre, ni con avance ni con retos', async () => {
  const { app } = servidor({ seed: { ...retosDe('sinplan', 99), ...retosDe('vencida', 99), ...progresoDe('sinplan', 'c1', [0, 1, 2]), ...progresoDe('vencida', 'c1', [0, 1, 2]) } });
  for (const t of ['token-sinplan', 'token-vencida']) {
    const r = await listaDrive(app, t);
    assert.equal(r.status, 200);
    assert.equal(r.body.membresia, false);
    assert.ok(r.body.materiales.length >= 7, t);
    assert.ok(r.body.materiales.every(m => !m.desbloqueado && m.soloMiembros === true), t);
    const id = 'dClase1';
    const e = await enlace(app, id, t);
    assert.equal(e.status, 403, t);
    assert.equal(e.body.codigo, 'membresia-requerida', t);
    assert.equal(JSON.stringify(e.body).includes('drive.google.com'), false);
    assert.equal((await enlace(app, 'dGeneral', t)).status, 403, t);
  }
});

test('administrador: todo abierto, incluso lo mal ligado', async () => {
  const { app } = servidor();
  const r = await listaDrive(app, 'token-admin');
  assert.ok(r.body.materiales.every(m => m.desbloqueado && !m.soloMiembros));
  assert.equal((await enlace(app, 'dSinCurso', 'token-admin')).status, 200);
});

test('GET /api/materiales/drive/:id/enlace: entrega la dirección solo a quien terminó la clase', async () => {
  const { app } = servidor();
  const sin = await enlace(app, 'dClase2', 'token-ana');
  assert.equal(sin.status, 403);
  assert.equal(sin.body.codigo, 'clase-pendiente');
  assert.match(sin.body.error, /Se desbloquea al terminar la clase 2 del curso «Curso 1»/);
  assert.equal(JSON.stringify(sin.body).includes('drive.google.com'), false, 'el rechazo no filtra el enlace');
  assert.match(sin.headers['cache-control'], /no-store/);
  const con = await enlace(app, 'dClase2', 'token-beto');
  assert.equal(con.status, 200);
  assert.equal(con.body.url, `https://drive.google.com/file/d/${DRIVE(2)}/view`);
  assert.equal(con.body.vista, `https://drive.google.com/file/d/${DRIVE(2)}/preview`);
  assert.equal((await enlace(app, 'dClase1', 'token-ana')).status, 200);
  assert.equal((await request(app).get('/api/materiales/drive/dClase1/enlace')).status, 401);
});

test('enlace de Drive: retos, curso inexistente, clase fuera de rango, ids raros e inexistentes', async () => {
  const { app } = servidor({ seed: retosDe('ana', 2) });
  const retos = await enlace(app, 'dRetos', 'token-ana');
  assert.equal(retos.status, 403);
  assert.equal(retos.body.codigo, 'retos-insuficientes');
  assert.match(retos.body.error, /te falta 1 reto/);
  const { app: app3 } = servidor({ seed: retosDe('ana', 3) });
  assert.equal((await enlace(app3, 'dRetos', 'token-ana')).status, 200);
  for (const id of ['dSinCurso', 'dClaseFuera']) {
    const x = await enlace(app, id, 'token-ana');
    assert.equal(x.status, 403, id);
    assert.equal(x.body.codigo, 'material-no-disponible', id);
  }
  assert.equal((await enlace(app, 'noExiste', 'token-ana')).status, 404);
  assert.equal((await enlace(app, 'dRota', 'token-ana')).status, 404, 'sin enlace válido no existe');
  assert.equal((await enlace(app, '..%2F..%2Fx', 'token-ana')).status, 404);
  assert.equal((await enlace(app, 'a'.repeat(200), 'token-ana')).status, 404);
});

test('marcar la clase como vista (POST /api/cursos/:id/progreso) abre el material de esa clase', async () => {
  const { app } = servidor();
  assert.equal((await enlace(app, 'dClase2', 'token-ana')).status, 403);
  assert.equal((await archivo(app, 'ficha-clase-2', 'token-ana')).status, 403);
  const marca = await request(app).post('/api/cursos/c1/progreso').set(auth('token-ana')).send({ sessionIndex: 1 });
  assert.equal(marca.status, 200);
  assert.equal((await enlace(app, 'dClase2', 'token-ana')).status, 200);
  assert.equal((await archivo(app, 'ficha-clase-2', 'token-ana')).status, 200);
  // la clase 3 todavía no
  const { app: otra } = servidor({ seed: { 'pdfs/dClase3': pdf('Clase 3', { cursoId: 'c1', clase: 3 }, 8) } });
  await request(otra).post('/api/cursos/c1/progreso').set(auth('token-ana')).send({ sessionIndex: 1 });
  assert.equal((await enlace(otra, 'dClase3', 'token-ana')).status, 403);
});

test('el avance anterior (miembros.courseProgress del sitio viejo) también cuenta, sin que la persona abra antes Cursos', async () => {
  const antiguas = { ana: { creationTime: '2026-03-01T12:00:00Z' } };
  const silenciar = console.warn; console.warn = () => {};
  let app;
  try {
    ({ app } = cargarServidor({
      env: { LIBROS_DIR: carpetaLibros([]), MATERIALES_DIR: carpetaMateriales([]), LEGACY_PROGRESS_IMPORT_BEFORE: '2026-10-16T00:00:00Z' },
      tokens, usuariosAuth: antiguas,
      seed: {
        ...cursosSeed(3),
        'miembros/ana': miembroConPlan({ name: 'Ana', courseProgress: { c1: { completedLessons: [0, 1], isCompleted: false } } }),
        'pdfs/dClase2': pdf('Hoja de la clase 2', { cursoId: 'c1', clase: 2 }, 2)
      }
    }));
  } finally { console.warn = silenciar; }
  assert.equal((await enlace(app, 'dClase2', 'token-ana')).status, 200);
});

// ───────────── materiales por curso (pantalla del curso) ─────────────
test('GET /api/materiales/cursos: agrupa por curso las dos fuentes, ordenado por clase, con el estado de cada uno', async () => {
  const { app } = servidor();
  const r = await porCursos(app, 'token-ana');
  assert.equal(r.status, 200);
  const c1 = r.body.cursos.c1;
  assert.deepEqual(Object.keys(r.body.cursos), ['c1'].concat(Object.keys(r.body.cursos).filter(k => k !== 'c1')));
  const claves = c1.map(m => m.clase || 999);
  assert.deepEqual(claves, [...claves].sort((a, b) => a - b), 'ordenado por clase (los del curso completo al final)');
  assert.deepEqual(c1.map(m => m.id).sort(), ['dClase1', 'dClase2', 'dClaseFuera', 'dCurso', 'dSinCurso'].filter(id => id !== 'dSinCurso').concat(['ficha-clase-2', 'manual-del-curso']).sort());
  assert.deepEqual(c1.find(m => m.id === 'ficha-clase-2').fuente, 'catalogo');
  assert.deepEqual(c1.find(m => m.id === 'dClase1').fuente, 'drive');
  const por = Object.fromEntries(c1.map(m => [m.id, m]));
  assert.equal(por.dClase1.desbloqueado, true);
  assert.equal(por.dClase2.desbloqueado, false);
  assert.equal(por['ficha-clase-2'].desbloqueado, false);
  assert.equal(por['manual-del-curso'].desbloqueado, true);
  assert.equal(por.dCurso.desbloqueado, true);
  assert.equal(r.body.cursos.c1.some(m => m.id === 'dGeneral' || m.id === 'plantilla-5'), false, 'los generales no son del curso');
  assert.equal(JSON.stringify(r.body).includes('drive.google.com'), false);
  assert.equal(JSON.stringify(r.body).includes('.pdf'), false);
  assert.equal((await request(app).get('/api/materiales/cursos')).status, 401);
});

test('GET /api/materiales/cursos: no miembro ve la lista bloqueada; administrador, abierta', async () => {
  const { app } = servidor({ seed: progresoDe('sinplan', 'c1', [0, 1, 2]) });
  const sin = await porCursos(app, 'token-sinplan');
  assert.equal(sin.body.membresia, false);
  assert.ok(sin.body.cursos.c1.length >= 4);
  assert.ok(sin.body.cursos.c1.every(m => !m.desbloqueado && m.soloMiembros));
  const admin = await porCursos(app, 'token-admin');
  assert.ok(admin.body.cursos.c1.every(m => m.desbloqueado));
});

test('sin ningún material ligado a cursos: lista vacía y todo lo demás sigue igual (libros por retos y generales)', async () => {
  const { app } = servidor({ catalogo: [materialValido('guia-miembros', 'miembros'), materialValido('plantilla-5', 'retos', 5)], conPdfs: false });
  const r = await porCursos(app);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cursos, {});
  const cat = await catalogo(app);
  assert.deepEqual(cat.body.materiales.map(m => [m.id, m.desbloqueado]), [['guia-miembros', true], ['plantilla-5', false]]);
});

// ───────────── administrador ─────────────
test('GET /api/admin/materiales: suma los PDF de Drive con su liga y avisa de los mal ligados', async () => {
  const { app } = servidor();
  const r = await request(app).get('/api/admin/materiales').set(auth('token-admin'));
  assert.equal(r.status, 200);
  const por = Object.fromEntries(r.body.drive.map(m => [m.id, m]));
  assert.equal(por.dClase2.ligaValida, true);
  assert.equal(por.dClase2.cursoId, 'c1');
  assert.equal(por.dSinCurso.ligaValida, false);
  assert.equal(por.dClaseFuera.ligaValida, false);
  assert.equal(por.dGeneral.ligaValida, true);
  assert.equal(JSON.stringify(r.body).includes('DriveDePrueba'), false);
  assert.equal((await request(app).get('/api/admin/materiales').set(auth('token-ana'))).status, 403);
});
