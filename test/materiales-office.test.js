'use strict';

// Materiales de Excel (.xlsx) y PowerPoint (.pptx): catálogo ampliado, acceso por tipo (membresía, retos o créditos), descarga con su
// Content-Type correcto y como adjunto, y canje con créditos. Los materiales de un curso siguen sin poder canjearse.
// Ejecutar: node --test test/materiales-office.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe
} = require('./helpers/club');
const { carpetaLibros, carpetaMateriales, materialValido, OFFICE_PRUEBA } = require('./helpers/materiales');

const tokens = tokensDe('ana', 'sinplan', 'admin');
const retosDe = (uid, superados) => ({ [`retosUsuario/${uid}`]: { uid, xp: 0, xpPractica: 0, superados } });
const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TIPO_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const catalogo = () => [
  materialValido('hoja-miembros', 'miembros', 0, { tipo: 'excel', version: '1.0', fecha: '2026-10-22' }),
  materialValido('hoja-retos-4', 'retos', 4, { tipo: 'excel' }),
  materialValido('deck-miembros', 'miembros', 0, { tipo: 'powerpoint', version: '1.0', fecha: '2026-10-22' }),
  materialValido('deck-retos-12', 'retos', 12, { tipo: 'powerpoint' }),
  materialValido('guia-pdf', 'miembros'),
  materialValido('hoja-del-curso', 'curso', undefined, { tipo: 'excel', cursoId: 'curso-uno', clase: 1 })
];

function servidor({ seed = {} } = {}) {
  const silenciar = console.warn; console.warn = () => {};
  try {
    return cargarServidor({
      env: { LIBROS_DIR: carpetaLibros([]), MATERIALES_DIR: carpetaMateriales(catalogo()) }, tokens,
      usuariosAuth: { ana: { emailVerified: true, email: 'ana@example.com' }, sinplan: { emailVerified: true, email: 'sinplan@example.com' }, admin: { emailVerified: true, email: 'admin@example.com' } },
      seed: {
        'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com' }),
        'miembros/sinplan': miembroSinPlan({ name: 'Sin Plan', email: 'sinplan@example.com' }),
        'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin' }),
        'cursos/curso-uno': { title: 'Curso Uno', lecciones: [{ title: 'A' }, { title: 'B' }] },
        ...seed
      }
    });
  } finally { console.warn = silenciar; }
}
const bajar = (app, id, t = 'token-ana') => request(app).get(`/api/materiales/${id}/archivo`).set(auth(t))
  .buffer(true).parse((res, cb) => { const trozos = []; res.on('data', c => trozos.push(c)); res.on('end', () => cb(null, Buffer.concat(trozos))); });
const lista = (app, t = 'token-ana') => request(app).get('/api/materiales').set(auth(t));
const canjear = (app, materialId, t = 'token-sinplan') => request(app).post('/api/creditos/canjear').set(auth(t)).send({ materialId });
const conSaldo = (uid, saldo) => ({ [`creditosCuentas/${uid}`]: { saldo, regalados: saldo / 100, canjeados: 0, avisoPendiente: false } });

test('la lista dice el formato de cada material (pdf, excel, powerpoint) y su tamaño, versión y fecha', async () => {
  const { app } = servidor({ seed: retosDe('ana', 5) });
  const r = await lista(app);
  assert.equal(r.status, 200);
  const por = Object.fromEntries(r.body.materiales.map(m => [m.id, m]));
  assert.equal(por['hoja-miembros'].formato, 'excel');
  assert.equal(por['deck-miembros'].formato, 'powerpoint');
  assert.equal(por['guia-pdf'].formato, 'pdf');
  assert.equal(por['hoja-miembros'].tamanoKb, 1);
  assert.equal(por['hoja-miembros'].version, '1.0');
  assert.equal(por['hoja-miembros'].fecha, '2026-10-22');
  assert.equal(JSON.stringify(r.body).includes('.xlsx'), false, 'no se revela el nombre del archivo');
  assert.equal(JSON.stringify(r.body).includes('.pptx'), false);
});

test('descarga: un miembro recibe el .xlsx y el .pptx con su Content-Type, como adjunto y sin que el navegador adivine el tipo', async () => {
  const { app } = servidor({ seed: retosDe('ana', 20) });
  const hoja = await bajar(app, 'hoja-miembros');
  assert.equal(hoja.status, 200);
  assert.equal(hoja.headers['content-type'], TIPO_XLSX);
  assert.equal(hoja.headers['content-disposition'], 'attachment; filename="hoja-miembros.xlsx"');
  assert.equal(hoja.headers['x-content-type-options'], 'nosniff');
  assert.match(hoja.headers['cache-control'], /no-store/);
  assert.equal(Number(hoja.headers['content-length']), OFFICE_PRUEBA.length);
  assert.ok(hoja.body.equals(OFFICE_PRUEBA));
  const deck = await bajar(app, 'deck-miembros');
  assert.equal(deck.status, 200);
  assert.equal(deck.headers['content-type'], TIPO_PPTX);
  assert.equal(deck.headers['content-disposition'], 'attachment; filename="deck-miembros.pptx"');
  // El PDF sigue abriéndose en la página
  const pdf = await bajar(app, 'guia-pdf');
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.headers['content-disposition'], 'inline; filename="guia-pdf.pdf"');
});

test('descarga por retos: con 3 retos no se entrega la hoja de 4; con 4 sí. El PowerPoint de 12 pide 12', async () => {
  const { app: a3 } = servidor({ seed: retosDe('ana', 3) });
  const no = await bajar(a3, 'hoja-retos-4');
  assert.equal(no.status, 403);
  const cuerpo = JSON.parse(no.body.toString('utf8'));
  assert.equal(cuerpo.codigo, 'retos-insuficientes');
  assert.equal(cuerpo.faltan, 1);
  assert.equal(no.headers['content-type'].includes('openxml'), false, 'el rechazo no entrega ni el tipo del archivo');
  const { app: a4 } = servidor({ seed: retosDe('ana', 4) });
  assert.equal((await bajar(a4, 'hoja-retos-4')).status, 200);
  assert.equal((await bajar(a4, 'deck-retos-12')).status, 403);
  const { app: a12 } = servidor({ seed: retosDe('ana', 12) });
  assert.equal((await bajar(a12, 'deck-retos-12')).status, 200);
});

test('descarga: sin membresía no se entrega nada, ni con retos; sin sesión 401; el administrador abre todo', async () => {
  const { app } = servidor({ seed: retosDe('sinplan', 99) });
  const sin = await bajar(app, 'hoja-miembros', 'token-sinplan');
  assert.equal(sin.status, 403);
  assert.equal(JSON.parse(sin.body.toString('utf8')).codigo, 'membresia-requerida');
  assert.equal((await request(app).get('/api/materiales/hoja-miembros/archivo')).status, 401);
  assert.equal((await bajar(app, 'deck-retos-12', 'token-admin')).status, 200);
  assert.equal((await bajar(app, 'hoja-retos-4', 'token-admin')).headers['content-type'], TIPO_XLSX);
});

test('descarga: el nombre del archivo no se puede manipular (solo ids del catálogo, nunca rutas ni extensiones)', async () => {
  const { app } = servidor();
  for (const id of ['hoja-miembros.xlsx', '..%2Fhoja-miembros', 'hoja-miembros%00.pdf', 'HOJA-MIEMBROS', 'catalogo.json']) {
    const r = await bajar(app, id);
    assert.ok([400, 404].includes(r.status), id + ' => ' + r.status);
  }
});

test('créditos: sin membresía se canjea una hoja de Excel y un PowerPoint, uno por uno, y se abre SOLO lo canjeado', async () => {
  const { app, db } = servidor({ seed: conSaldo('sinplan', 200) });
  // Antes de canjear: cerrado
  assert.equal((await bajar(app, 'hoja-miembros', 'token-sinplan')).status, 403);
  assert.equal((await bajar(app, 'deck-miembros', 'token-sinplan')).status, 403);
  const a = await canjear(app, 'pdf:hoja-miembros');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const abierta = await bajar(app, 'hoja-miembros', 'token-sinplan');
  assert.equal(abierta.status, 200);
  assert.equal(abierta.headers['content-type'], TIPO_XLSX);
  assert.equal((await bajar(app, 'deck-miembros', 'token-sinplan')).status, 403, 'lo no canjeado sigue cerrado');
  assert.equal((await bajar(app, 'hoja-retos-4', 'token-sinplan')).status, 403);
  const b = await canjear(app, 'pdf:deck-miembros');
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const deck = await bajar(app, 'deck-miembros', 'token-sinplan');
  assert.equal(deck.status, 200);
  assert.equal(deck.headers['content-type'], TIPO_PPTX);
  assert.equal(db.value('creditosCuentas/sinplan').saldo, 0);
  // Sin saldo ya no se puede canjear más
  assert.equal((await canjear(app, 'pdf:deck-retos-12')).status, 402);
});

test('créditos: en la lista, lo canjeado se marca porCreditos y lo demás sigue bloqueado', async () => {
  const { app } = servidor({ seed: conSaldo('sinplan', 100) });
  await canjear(app, 'pdf:hoja-retos-4');
  const por = Object.fromEntries((await lista(app, 'token-sinplan')).body.materiales.map(m => [m.id, m]));
  assert.equal(por['hoja-retos-4'].porCreditos, true);
  assert.equal(por['hoja-retos-4'].desbloqueado, true);
  assert.equal(por['hoja-retos-4'].formato, 'excel');
  assert.equal(por['deck-retos-12'].desbloqueado, false);
});

test('créditos: el estado ofrece los Excel y PowerPoint sin curso para canjear (con su formato) y deja fuera el ligado a un curso', async () => {
  const { app } = servidor({ seed: conSaldo('sinplan', 100) });
  const r = await request(app).get('/api/creditos/estado').set(auth('token-sinplan'));
  assert.equal(r.status, 200);
  const claves = r.body.materiales.map(m => m.clave);
  for (const c of ['pdf:hoja-miembros', 'pdf:hoja-retos-4', 'pdf:deck-miembros', 'pdf:deck-retos-12', 'pdf:guia-pdf']) assert.ok(claves.includes(c), c);
  assert.equal(claves.includes('pdf:hoja-del-curso'), false, 'un material de curso no se canjea');
  assert.equal(r.body.materiales.find(m => m.clave === 'pdf:hoja-miembros').formato, 'excel');
  assert.equal(r.body.materiales.find(m => m.clave === 'pdf:deck-miembros').formato, 'powerpoint');
  const curso = await canjear(app, 'pdf:hoja-del-curso');
  assert.ok([400, 404, 409].includes(curso.status), 'status ' + curso.status);
  assert.equal(curso.body.ok === true, false);
});

test('descarga de un material de curso en Excel: se abre solo al terminar la clase, nunca con créditos', async () => {
  const { app } = servidor({ seed: conSaldo('sinplan', 500) });
  const r = await bajar(app, 'hoja-del-curso', 'token-sinplan');
  assert.equal(r.status, 403);
});
