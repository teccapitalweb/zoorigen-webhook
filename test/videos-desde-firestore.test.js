'use strict';

// embed-token reconoce videos y clases gratis que el panel admin guarda en la colección
// `cursos` de Firestore, además del catálogo estático. Todo con Firestore en memoria.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, ts, dias, VIDEO_GRATIS, VIDEO_PREMIUM } = require('./helpers/cargar-servidor');

const VIDEO_NUEVO = '11111111-2222-4333-8444-555555555555';
const VIDEO_NUEVO_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const VIDEO_FALSO = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; // con forma de UUID pero inexistente
const idFalso = i => `aaaaaaaa-0000-4000-8000-00000000000${i}`;

const tokens = {
  'token-ana': { uid: 'u1', email: 'ana@example.com' },
  'token-admin': { uid: 'adm', email: 'admin@example.com' }
};
const auth = t => ({ Authorization: `Bearer ${t}` });
const embed = (app, videoId, t = 'token-ana') =>
  request(app).post('/api/bunny/embed-token').set(auth(t)).send({ videoId });

const miembroActivo = { 'miembros/u1': { planActivo: true, planStatus: 'active', planVence: ts(dias(10)) } };
const curso = (extra = {}) => ({
  titulo: 'Curso de prueba',
  lecciones: [{ titulo: 'Clase 1', videoId: VIDEO_NUEVO, provider: 'bunny' }],
  ...extra
});

// Cuenta (y opcionalmente rompe) las lecturas a la colección `cursos`.
function vigilarCursos(db, { fallar = false } = {}) {
  const estado = { lecturas: 0, fallar };
  const original = db.collection.bind(db);
  db.collection = nombre => {
    const real = original(nombre);
    if (nombre !== 'cursos') return real;
    return {
      doc: id => real.doc(id),
      get: async () => {
        estado.lecturas++;
        if (estado.fallar) throw new Error('Firestore caído');
        return real.get();
      }
    };
  };
  return estado;
}

// Reloj controlable: sustituye Date.now y se restaura solo al terminar la prueba.
function relojFalso(t) {
  const base = Date.now();
  let desfase = 0;
  t.mock.method(Date, 'now', () => base + desfase);
  return { avanzar: ms => { desfase += ms; } };
}

function silenciarErrores(t) {
  return t.mock.method(console, 'error', () => {});
}

// ── Catálogo estático: sigue igual ─────────────────────────
test('video del catálogo estático sigue funcionando igual (miembro, no-miembro y gratis)', async () => {
  const { app } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 200);
  assert.equal((await embed(app, VIDEO_GRATIS, 'token-admin')).body.freePreview, true);
  const { app: app2 } = cargarServidor({ tokens });
  assert.equal((await embed(app2, VIDEO_PREMIUM)).status, 403);
  const gratis = await embed(app2, VIDEO_GRATIS);
  assert.equal(gratis.status, 200);
  assert.equal(gratis.body.freePreview, true);
});

// ── Video nuevo solo en Firestore ──────────────────────────
test('video solo en Firestore: miembro activo recibe el enlace firmado', async () => {
  const { app } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const res = await embed(app, VIDEO_NUEVO);
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, false);
  assert.ok(res.body.embedUrl.includes(`/${VIDEO_NUEVO}?token=`));
});

test('video solo en Firestore: administrador lo ve sin membresía', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'admins/adm': { activo: true }, 'cursos/c1': curso() } });
  assert.equal((await embed(app, VIDEO_NUEVO, 'token-admin')).status, 200);
});

test('video solo en Firestore: quien no es miembro recibe 403', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'cursos/c1': curso() } });
  const res = await embed(app, VIDEO_NUEVO);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Necesitas una membresía activa para ver esta clase');
});

test('video solo en Firestore: membresía vencida recibe 403', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'miembros/u1': { planActivo: true, planStatus: 'active', planVence: ts(dias(-1)) }, 'cursos/c1': curso() }
  });
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 403);
});

test('video desconocido (ni catálogo ni Firestore) recibe 404 con el mismo mensaje', async () => {
  const { app } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const res = await embed(app, VIDEO_FALSO);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Video no reconocido en el catálogo de Zoorigen');
});

test('el 404 por video desconocido se responde antes de pedir sesión (orden actual)', async () => {
  const { app } = cargarServidor({ tokens });
  assert.equal((await request(app).post('/api/bunny/embed-token').send({ videoId: VIDEO_FALSO })).status, 404);
  // y uno conocido sin sesión sigue pidiendo sesión
  assert.equal((await request(app).post('/api/bunny/embed-token').send({ videoId: VIDEO_PREMIUM })).status, 401);
});

// ── Clases gratis marcadas en el panel ─────────────────────
test('clase marcada gratis en un curso con cursoMuestraGratis es accesible sin membresía', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'cursos/c1': curso({ cursoMuestraGratis: true, lecciones: [{ titulo: 'Clase 1', videoId: VIDEO_NUEVO, gratis: true }] }) }
  });
  const res = await embed(app, VIDEO_NUEVO);
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, true);
});

test('lección gratis en un curso SIN cursoMuestraGratis NO es gratis (403)', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'cursos/c1': curso({ lecciones: [{ titulo: 'Clase 1', videoId: VIDEO_NUEVO, gratis: true }] }) }
  });
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 403);
});

test('cursoMuestraGratis sin marcar la lección como gratis tampoco la libera', async () => {
  const { app } = cargarServidor({ tokens, seed: { 'cursos/c1': curso({ cursoMuestraGratis: true }) } });
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 403);
});

test('solo cuenta gratis === true exacto (no texto ni número)', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: { 'cursos/c1': curso({ cursoMuestraGratis: true, lecciones: [{ videoId: VIDEO_NUEVO, gratis: 'true' }, { videoId: VIDEO_NUEVO_2, gratis: 1 }] }) }
  });
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 403);
  assert.equal((await embed(app, VIDEO_NUEVO_2)).status, 403);
});

test('cursos mal formados (sin lecciones, videoId vacío o no UUID) no rompen nada', async () => {
  const { app } = cargarServidor({
    tokens,
    seed: {
      ...miembroActivo,
      'cursos/c0': { titulo: 'Sin lecciones' },
      'cursos/c1': { lecciones: 'no es lista' },
      'cursos/c2': { lecciones: [null, {}, { videoId: '' }, { videoId: 42 }, { videoId: 'no-es-uuid', gratis: true }] },
      'cursos/c3': curso()
    }
  });
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
});

// ── Si Firestore falla, todo lo existente sigue igual ──────
test('el video gratis fijo sigue siendo gratis aunque Firestore falle', async t => {
  const error = silenciarErrores(t);
  const { app, db } = cargarServidor({ tokens });
  const cursos = vigilarCursos(db, { fallar: true });
  // El gratis fijo no necesita ni consultar Firestore.
  const res = await embed(app, VIDEO_GRATIS);
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, true);
  assert.equal(cursos.lecturas, 0);
  // Tras un fallo registrado (video desconocido fuerza la lectura) sigue igual.
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 404);
  assert.ok(error.mock.callCount() >= 1, 'el fallo se registra con console.error');
  const otra = await embed(app, VIDEO_GRATIS);
  assert.equal(otra.status, 200);
  assert.equal(otra.body.freePreview, true);
});

test('con Firestore caído el catálogo estático funciona igual (miembro 200, no-miembro 403)', async t => {
  silenciarErrores(t);
  const { app, db } = cargarServidor({ tokens, seed: miembroActivo });
  vigilarCursos(db, { fallar: true });
  assert.equal((await embed(app, VIDEO_PREMIUM)).status, 200);
  const { app: app2, db: db2 } = cargarServidor({ tokens });
  vigilarCursos(db2, { fallar: true });
  assert.equal((await embed(app2, VIDEO_PREMIUM)).status, 403);
});

test('con Firestore caído un video desconocido da 404 (no 500) y se registra el error', async t => {
  const error = silenciarErrores(t);
  const { app, db } = cargarServidor({ tokens, seed: miembroActivo });
  vigilarCursos(db, { fallar: true });
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 404);
  assert.ok(error.mock.callCount() >= 1);
});

test('con Firestore caído no se vuelve a leer en cada petición', async t => {
  silenciarErrores(t);
  const { app, db } = cargarServidor({ tokens, seed: miembroActivo });
  const cursos = vigilarCursos(db, { fallar: true });
  for (let i = 0; i < 5; i++) await embed(app, idFalso(i));
  await embed(app, VIDEO_PREMIUM);
  assert.equal(cursos.lecturas, 1);
});

test('si Firestore se cae después de cargar el índice, se conserva el último índice bueno', async t => {
  silenciarErrores(t);
  const reloj = relojFalso(t);
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  cursos.fallar = true;
  reloj.avanzar(61_000); // caché vencido, el refresco falla
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
});

// ── Formato inválido ───────────────────────────────────────
test('videoId con formato inválido da 404 sin tocar Firestore', async () => {
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  const invalidos = ['', 'no-existe', '../../etc/passwd', `${VIDEO_NUEVO}x`, VIDEO_NUEVO.replace(/-/g, ''), '<script>', undefined, 123, { a: 1 }];
  for (const videoId of invalidos) {
    const res = await request(app).post('/api/bunny/embed-token').set(auth('token-ana')).send({ videoId });
    assert.equal(res.status, 404, `videoId ${JSON.stringify(videoId)}`);
    assert.equal(res.body.error, 'Video no reconocido en el catálogo de Zoorigen');
  }
  assert.equal(cursos.lecturas, 0);
});

// ── Caché y límite de refresco ─────────────────────────────
test('el caché evita lecturas repetidas dentro de los 60 s', async t => {
  const reloj = relojFalso(t);
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  for (let i = 0; i < 4; i++) assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  reloj.avanzar(30_000);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  assert.equal(cursos.lecturas, 1);
  reloj.avanzar(31_000); // pasan los 60 s del caché
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  assert.equal(cursos.lecturas, 2);
});

test('un miembro viendo el catálogo estático lee Firestore a lo sumo una vez por minuto', async () => {
  const { app, db } = cargarServidor({ tokens, seed: miembroActivo });
  const cursos = vigilarCursos(db);
  for (let i = 0; i < 3; i++) assert.equal((await embed(app, VIDEO_PREMIUM)).status, 200);
  assert.ok(cursos.lecturas <= 1);
});

test('un video agregado después se reconoce al instante si el caché tiene más de 10 s', async t => {
  const reloj = relojFalso(t);
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  assert.equal(cursos.lecturas, 1);
  // El admin agrega otra clase en el panel.
  await db.collection('cursos').doc('c2').set(curso({ lecciones: [{ titulo: 'Clase 2', videoId: VIDEO_NUEVO_2 }] }));
  reloj.avanzar(15_000);
  assert.equal((await embed(app, VIDEO_NUEVO_2)).status, 200);
  assert.equal(cursos.lecturas, 2);
});

test('con el caché de menos de 10 s no se refresca: el video nuevo espera', async t => {
  const reloj = relojFalso(t);
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  await db.collection('cursos').doc('c2').set(curso({ lecciones: [{ videoId: VIDEO_NUEVO_2 }] }));
  reloj.avanzar(5_000);
  assert.equal((await embed(app, VIDEO_NUEVO_2)).status, 404);
  assert.equal(cursos.lecturas, 1);
  reloj.avanzar(6_000); // ya pasaron 10 s desde la última lectura
  assert.equal((await embed(app, VIDEO_NUEVO_2)).status, 200);
  assert.equal(cursos.lecturas, 2);
});

test('una ráfaga de IDs falsos no provoca una lectura por petición', async t => {
  const reloj = relojFalso(t);
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  await embed(app, VIDEO_NUEVO); // carga inicial (1 lectura)
  reloj.avanzar(20_000);
  for (let i = 0; i < 10; i++) assert.equal((await embed(app, idFalso(i))).status, 404);
  assert.equal(cursos.lecturas, 2, 'solo un refresco para toda la ráfaga');
  reloj.avanzar(3_000);
  for (let i = 0; i < 10; i++) await embed(app, idFalso(i));
  assert.equal(cursos.lecturas, 2);
  reloj.avanzar(10_000);
  await embed(app, idFalso(0));
  assert.equal(cursos.lecturas, 3);
});

test('peticiones simultáneas comparten una sola lectura', async () => {
  const { app, db } = cargarServidor({ tokens, seed: { ...miembroActivo, 'cursos/c1': curso() } });
  const cursos = vigilarCursos(db);
  const respuestas = await Promise.all(Array.from({ length: 6 }, () => embed(app, VIDEO_NUEVO)));
  assert.ok(respuestas.every(r => r.status === 200));
  assert.equal(cursos.lecturas, 1);
});

test('una clase recién marcada gratis se libera al no-miembro sin esperar 60 s', async t => {
  const reloj = relojFalso(t);
  const { app, db } = cargarServidor({ tokens, seed: { 'cursos/c1': curso({ cursoMuestraGratis: true }) } });
  vigilarCursos(db);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 403);
  await db.collection('cursos').doc('c1').set(curso({ cursoMuestraGratis: true, lecciones: [{ videoId: VIDEO_NUEVO, gratis: true }] }));
  reloj.avanzar(15_000);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
});

test('una clase que se deja de marcar gratis vuelve a pedir membresía tras vencer el caché', async t => {
  const reloj = relojFalso(t);
  const gratisSeed = curso({ cursoMuestraGratis: true, lecciones: [{ videoId: VIDEO_NUEVO, gratis: true }] });
  const { app, db } = cargarServidor({ tokens, seed: { 'cursos/c1': gratisSeed } });
  vigilarCursos(db);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 200);
  await db.collection('cursos').doc('c1').set(curso({ cursoMuestraGratis: true }));
  reloj.avanzar(61_000);
  assert.equal((await embed(app, VIDEO_NUEVO)).status, 403);
});

test('el módulo conserva su export de app y expone el índice para pruebas', () => {
  const { app } = cargarServidor({ tokens });
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');
  assert.equal(app.videosFirestore.INDICE_VIDEOS_TTL_MS, 60_000);
  assert.equal(app.videosFirestore.INDICE_VIDEOS_REFRESCO_MIN_MS, 10_000);
});
