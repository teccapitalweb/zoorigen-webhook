'use strict';

// Script scripts/auditar-certificados.js: dry-run por defecto; con --apply y una lista aprobada firma solo esos folios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proxyquire = require('proxyquire').noCallThru();
const { FakeFirestore, FakeTimestamp } = require('./helpers/fake-firestore');
const c = require('../services/certificados');

const LLAVE = 'llave-de-prueba-para-certificados-0123456789';

function viejo(extra = {}) {
  return {
    folio: 'ZOO-2026-11111', courseId: 'c1', courseTitle: 'Curso 1', courseArea: 'Manejo', courseDuration: '4 horas',
    memberUid: 'ana', memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: '2026-03-04T15:00:00.000Z', totalClases: 3, ...extra
  };
}

function entorno(seed) {
  const db = new FakeFirestore(seed);
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => new FakeTimestamp(Date.now()) };
  const admin = { apps: [], credential: { cert: v => v }, initializeApp() {}, firestore };
  const script = proxyquire('../scripts/auditar-certificados.js', { 'firebase-admin': admin });
  return { db, script };
}

async function ejecutar(script, args) {
  const antes = process.env.CERTIFICATE_SIGNING_KEY;
  const escribir = process.stdout.write;
  let salida = '';
  process.env.CERTIFICATE_SIGNING_KEY = LLAVE;
  process.stdout.write = trozo => { salida += trozo; return true; };
  try {
    const resultado = await script.main(['node', 'auditar-certificados.js', ...args]);
    return { resultado, salida };
  } finally {
    process.stdout.write = escribir;
    if (antes === undefined) delete process.env.CERTIFICATE_SIGNING_KEY; else process.env.CERTIFICATE_SIGNING_KEY = antes;
  }
}

const seed = () => ({
  'miembros/ana': { name: 'Ana' },
  'miembros/beto': { name: 'Beto' },
  'cursos/c1': { title: 'Curso 1' },
  'certificados/ZOO-2026-11111': viejo(),
  'certificados/ZOO-2026-22222': viejo({ folio: 'ZOO-2026-22222', memberUid: 'beto' }),
  'certificados/ZOO-2026-33333': viejo({ folio: 'ZOO-2026-33333', memberUid: 'fantasma' })
});

test('script: requerirlo no ejecuta nada y exporta main', () => {
  const { script } = entorno({});
  assert.equal(typeof script.main, 'function');
  assert.equal(script.argumento('allowlist', ['--apply', '--allowlist=x.json']), 'x.json');
  assert.equal(script.argumento('allowlist', ['--apply']), null);
});

test('script: por defecto solo audita; no escribe nada', async () => {
  const { db, script } = entorno(seed());
  const antes = JSON.stringify([...db._data.entries()]);
  const { resultado, salida } = await ejecutar(script, []);
  assert.equal(resultado.modo, 'solo-auditoria');
  assert.equal(resultado.validados, 0);
  const por = Object.fromEntries(resultado.certificados.map(f => [f.folio, f]));
  assert.equal(por['ZOO-2026-11111'].accion, 'revisar-manualmente');
  assert.equal(por['ZOO-2026-22222'].accion, 'revisar-manualmente');
  assert.equal(por['ZOO-2026-33333'].accion, 'rechazar');
  assert.deepEqual(por['ZOO-2026-33333'].razones, ['miembro-no-encontrado']);
  assert.equal(JSON.stringify([...db._data.entries()]), antes);
  assert.doesNotMatch(salida, /Ana Pérez|ana@example/, 'el reporte no trae nombres ni correos');
});

test('script: --apply sin lista aprobada se rechaza', async () => {
  const { script } = entorno(seed());
  await assert.rejects(() => ejecutar(script, ['--apply']), /allowlist/);
});

test('script: sin CERTIFICATE_SIGNING_KEY no hace nada', async () => {
  const { script } = entorno(seed());
  const antes = process.env.CERTIFICATE_SIGNING_KEY;
  delete process.env.CERTIFICATE_SIGNING_KEY;
  try { await assert.rejects(() => script.main(['node', 'x']), /CERTIFICATE_SIGNING_KEY/); } finally {
    if (antes !== undefined) process.env.CERTIFICATE_SIGNING_KEY = antes;
  }
});

test('script: --apply firma solo los folios de la lista, conserva los campos viejos y el resultado valida', async () => {
  const { db, script } = entorno(seed());
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-cert-')), 'folios.json');
  // 22222 no está en la lista; 33333 está pero no pasó la revisión; 99999 no existe
  fs.writeFileSync(archivo, JSON.stringify(['zoo-2026-11111', 'ZOO-2026-33333', 'ZOO-2026-99999']));
  const { resultado } = await ejecutar(script, ['--apply', `--allowlist=${archivo}`]);
  assert.equal(resultado.modo, 'aplicar-allowlist');
  assert.equal(resultado.validados, 1);
  const por = Object.fromEntries(resultado.certificados.map(f => [f.folio, f.accion]));
  assert.deepEqual(por, { 'ZOO-2026-11111': 'validado', 'ZOO-2026-22222': 'revisar-manualmente', 'ZOO-2026-33333': 'rechazar' });

  const firmado = db.value('certificados/ZOO-2026-11111');
  assert.equal(firmado.origen, 'legacy-validado');
  assert.equal(firmado.validadoBackend, true);
  assert.equal(firmado.verificado, true);
  assert.equal(firmado.uid, 'ana');
  assert.equal(firmado.cursoId, 'c1');
  assert.equal(firmado.nombre, 'Ana Pérez');
  assert.equal(firmado.memberName, 'Ana Pérez', 'los campos viejos se conservan');
  assert.equal(firmado.courseTitle, 'Curso 1');
  assert.ok(firmado.validadoEn);
  assert.equal(c.certificadoValido(firmado, LLAVE), true);
  assert.equal(c.certificadoValido(db.value('certificados/ZOO-2026-22222'), LLAVE), false);
  assert.equal(db.value('certificados/ZOO-2026-33333').firmaBackend, undefined);
});
