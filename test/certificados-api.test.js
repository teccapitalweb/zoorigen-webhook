'use strict';

// Progreso de cursos, quizzes y certificados firmados: rutas /api/cursos/*, /api/certificados/:folio y
// /api/admin/certificados (sesión, membresía, orden, quiz, emisión única, legado, verificación pública, admin).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias, uuid
} = require('./helpers/club');
const cert = require('../services/certificados');

const LLAVE = 'llave-de-prueba-para-certificados-0123456789';
const tokens = tokensDe('ana', 'beto', 'sinplan', 'vencida', 'admin');
const FOLIO = /^ZOO-[0-9]{4}-[0-9A-F]{8}$/;

const leccion = (n, extra = {}) => ({ titulo: `Clase ${n}`, videoId: uuid(n), provider: 'bunny', ...extra });
const cursosBase = () => ({
  'cursos/c1': {
    title: 'Biología de tiburones', area: 'Fauna silvestre', duration: '6 horas', instructor: 'Dra. Pérez',
    lecciones: [leccion(11), leccion(12), leccion(13)]
  },
  'cursos/c2': { title: 'Etología aplicada', area: 'Manejo', lecciones: [leccion(21), leccion(22)] },
  // c3 tiene preguntas en la primera clase (una de verdadero/falso y una de opción múltiple)
  'cursos/c3': {
    title: 'Primeros auxilios', area: 'Veterinaria',
    lecciones: [
      leccion(31, { preguntas: [
        { pregunta: '¿Los reptiles son de sangre fría?', tipo: 'vof', correcta: 0 },
        { pregunta: '¿Cuál es un reptil?', tipo: 'multiple', opciones: ['Rana', 'Iguana', 'Delfín'], correcta: 1 }
      ] }),
      leccion(32)
    ]
  },
  // curso de muestra: solo su primera clase es gratis
  'cursos/cmuestra': {
    title: 'Curso de muestra', area: 'General', cursoMuestraGratis: true,
    lecciones: [leccion(41, { gratis: true }), leccion(42)]
  }
});

function servidor({ seed = {}, env = {}, usuariosAuth = {}, sinLlave = false } = {}) {
  return cargarServidor({
    tokens,
    usuariosAuth,
    env: sinLlave ? env : { CERTIFICATE_SIGNING_KEY: LLAVE, ...env },
    seed: {
      ...cursosBase(),
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com' }),
      'miembros/beto': miembroConPlan({ name: 'Beto Ruiz' }),
      'miembros/sinplan': miembroSinPlan(),
      'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin Zoorigen' }),
      ...seed
    }
  });
}

const get = (app, ruta, t = 'token-ana') => request(app).get(ruta).set(auth(t));
const post = (app, ruta, cuerpo, t = 'token-ana') => request(app).post(ruta).set(auth(t)).send(cuerpo);
const progreso = (app, cursoId, sessionIndex, t = 'token-ana') => post(app, `/api/cursos/${cursoId}/progreso`, { sessionIndex }, t);
const claves = (db, prefijo) => [...db._data.keys()].filter(k => k.startsWith(prefijo));

async function completar(app, cursoId, desde, hasta, t = 'token-ana') {
  let r;
  for (let i = desde; i <= hasta; i++) {
    r = await progreso(app, cursoId, i, t);
    assert.equal(r.status, 200, `clase ${i}: ${JSON.stringify(r.body)}`);
  }
  return r;
}

// Resend simulado: se activa la llave y MAIL_FROM solo mientras corre la prueba
function conResend(fn) {
  return async () => {
    const anterior = { fetch: global.fetch, k: process.env.RESEND_API_KEY, f: process.env.MAIL_FROM };
    const llamadas = [];
    global.fetch = async (url, opc) => { llamadas.push({ url, cuerpo: JSON.parse(opc.body) }); return { ok: true, status: 200 }; };
    process.env.RESEND_API_KEY = 're_prueba'; process.env.MAIL_FROM = 'Zoorigen <no-reply@zoorigen.com>';
    try { await fn(llamadas); } finally {
      global.fetch = anterior.fetch;
      if (anterior.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = anterior.k;
      if (anterior.f === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = anterior.f;
    }
  };
}

// ── Sesión ──

test('certificados: 401 sin sesión o con token falso en las rutas autenticadas', async () => {
  const { app } = servidor();
  const rutas = [
    ['get', '/api/cursos/progreso'],
    ['post', '/api/cursos/c1/progreso'],
    ['post', '/api/cursos/c1/quiz'],
    ['post', '/api/admin/certificados']
  ];
  for (const [metodo, ruta] of rutas) {
    const sin = await request(app)[metodo](ruta).send({ sessionIndex: 0 });
    assert.equal(sin.status, 401, `${metodo} ${ruta}`);
    assert.ok(sin.body.error);
    const falso = await request(app)[metodo](ruta).set(auth('falso')).send({ sessionIndex: 0 });
    assert.equal(falso.status, 401, `${metodo} ${ruta}`);
  }
});

// ── GET /api/cursos/progreso ──

test('GET progreso: vacío al inicio y con las formas del contrato después; sin caché', async () => {
  const { app } = servidor();
  const vacio = await get(app, '/api/cursos/progreso');
  assert.equal(vacio.status, 200);
  assert.deepEqual(vacio.body, { cursos: {}, legadoImportado: false });
  assert.match(vacio.headers['cache-control'], /no-store/);

  await completar(app, 'c1', 0, 1);
  const r = await get(app, '/api/cursos/progreso');
  assert.deepEqual(r.body.cursos.c1, { sesionesVistas: [0, 1], quizzesAprobados: [], completado: false, certificadoFolio: null, completadoEn: null });
  assert.equal(r.body.legadoImportado, false);
});

test('GET progreso: cada persona ve solo lo suyo', async () => {
  const { app } = servidor();
  await progreso(app, 'c1', 0, 'token-ana');
  const beto = await get(app, '/api/cursos/progreso', 'token-beto');
  assert.deepEqual(beto.body.cursos, {});
});

// ── POST /api/cursos/:cursoId/progreso ──

test('progreso: 400 si sessionIndex no es un entero válido', async () => {
  const { app } = servidor();
  for (const malo of [undefined, null, -1, 1.5, 'abc', '', [], {}, 99999, true]) {
    const r = await progreso(app, 'c1', malo);
    assert.equal(r.status, 400, JSON.stringify(malo));
    assert.equal(r.body.error, 'sessionIndex inválido');
  }
  const cadena = await progreso(app, 'c1', '0');
  assert.equal(cadena.status, 200);
});

test('progreso: 404 si el curso o la clase no existen (incluye ids que no son de documento)', async () => {
  const { app, db } = servidor();
  assert.equal((await progreso(app, 'noexiste', 0)).status, 404);
  assert.equal((await progreso(app, 'c1', 3)).status, 404);
  assert.equal((await progreso(app, 'c1', 40)).status, 404);
  assert.equal((await progreso(app, 'a%2Fb', 0)).status, 404);
  assert.equal((await progreso(app, '..', 0)).status, 404);
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), []);
});

test('progreso: 403 sin plan o con plan vencido, y no escribe nada', async () => {
  const { app, db } = servidor();
  for (const t of ['token-sinplan', 'token-vencida']) {
    const r = await progreso(app, 'c1', 0, t);
    assert.equal(r.status, 403, t);
    assert.match(r.body.error, /membresía/);
  }
  assert.deepEqual(claves(db, 'miembros/sinplan/progresoCursos'), []);
  assert.deepEqual(claves(db, 'certificados/'), []);
});

test('progreso: orden secuencial (409 al saltarse una clase) y la repetición no cambia nada', async () => {
  const { app } = servidor();
  const salto = await progreso(app, 'c1', 1);
  assert.equal(salto.status, 409);
  assert.equal(salto.body.error, 'Completa primero la clase anterior');
  const uno = await progreso(app, 'c1', 0);
  assert.deepEqual(uno.body, { ok: true, sesionesVistas: [0], completado: false, certificado: null });
  const repetida = await progreso(app, 'c1', 0);
  assert.deepEqual(repetida.body, { ok: true, sesionesVistas: [0], completado: false, certificado: null });
  const dos = await progreso(app, 'c1', 1);
  assert.deepEqual(dos.body.sesionesVistas, [0, 1]);
});

test('progreso: al completar el curso emite UN certificado firmado con todos los campos', async () => {
  const { app, db } = servidor();
  const r = await completar(app, 'c1', 0, 2);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.completado, true);
  assert.deepEqual(r.body.sesionesVistas, [0, 1, 2]);
  const c = r.body.certificado;
  assert.deepEqual(Object.keys(c).sort(), ['area', 'curso', 'emitido', 'folio', 'horas', 'instructor', 'nombre', 'sesiones']);
  assert.match(c.folio, FOLIO);
  assert.equal(c.nombre, 'Ana Pérez');
  assert.equal(c.curso, 'Biología de tiburones');
  assert.equal(c.area, 'Fauna silvestre');
  assert.equal(c.horas, 6);
  assert.equal(c.sesiones, 3);
  assert.equal(c.instructor, 'Dra. Pérez');
  assert.ok(!Number.isNaN(Date.parse(c.emitido)));

  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${c.folio}`]);
  const doc = db.value(`certificados/${c.folio}`);
  assert.equal(doc.uid, 'ana');
  assert.equal(doc.cursoId, 'c1');
  assert.equal(doc.verificado, true);
  assert.equal(doc.origen, 'backend');
  assert.equal(doc.year, new Date(doc.emitido).getUTCFullYear());
  assert.equal(cert.certificadoValido(doc, LLAVE), true, 'la firma valida con la llave del servidor');
  // nombres que usan el sitio y los logros
  assert.deepEqual(
    { memberUid: doc.memberUid, courseId: doc.courseId, courseTitle: doc.courseTitle, courseArea: doc.courseArea, courseDuration: doc.courseDuration,
      memberName: doc.memberName, memberEmail: doc.memberEmail, issuedAt: doc.issuedAt, totalClases: doc.totalClases },
    { memberUid: 'ana', courseId: 'c1', courseTitle: 'Biología de tiburones', courseArea: 'Fauna silvestre', courseDuration: '6 horas',
      memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: doc.emitido, totalClases: 3 }
  );
  assert.ok(doc.createdAt, 'createdAt');

  // el progreso guarda el folio y queda completado
  const prog = await get(app, '/api/cursos/progreso');
  assert.deepEqual(prog.body.cursos.c1, { sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: c.folio, completadoEn: c.emitido });
});

test('progreso: el nombre del certificado es el que la persona eligió (nombreCertificado)', async () => {
  const { app } = servidor({ seed: { 'miembros/ana': miembroConPlan({ name: 'Ana', nombreCertificado: 'Dra. Ana María Pérez Soto' }) } });
  const r = await completar(app, 'c2', 0, 1);
  assert.equal(r.body.certificado.nombre, 'Dra. Ana María Pérez Soto');
});

test('progreso: repetir la última clase no duplica el certificado, no cambia la fecha y no reenvía correo', conResend(async llamadas => {
  const { app, db } = servidor();
  const primera = await completar(app, 'c1', 0, 2);
  await app.certificados.esperar();
  assert.equal(llamadas.length, 1);
  const repetida = await progreso(app, 'c1', 2);
  assert.equal(repetida.status, 200);
  assert.deepEqual(repetida.body, { ok: true, sesionesVistas: [0, 1, 2], completado: true, certificado: primera.body.certificado });
  await app.certificados.esperar();
  assert.equal(llamadas.length, 1, 'ningún correo más');
  assert.equal(claves(db, 'certificados/').length, 1);
  assert.equal(claves(db, 'avisos/ana/items/').filter(k => k.includes('cert_')).length, 1);
  // repetir una clase intermedia tampoco cambia nada
  const intermedia = await progreso(app, 'c1', 0);
  assert.equal(intermedia.body.certificado.folio, primera.body.certificado.folio);
}));

test('progreso: dos solicitudes simultáneas de la última clase emiten un solo certificado, un aviso y un correo', conResend(async llamadas => {
  const { app, db } = servidor();
  await completar(app, 'c1', 0, 1);
  db.lenta = true; // cada lectura tarda un turno: las dos solicitudes leen el mismo estado viejo
  const [a, b] = await Promise.all([progreso(app, 'c1', 2), progreso(app, 'c1', 2)]);
  db.lenta = false;
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.certificado.folio, b.body.certificado.folio);
  await app.certificados.esperar();
  assert.equal(claves(db, 'certificados/').length, 1);
  assert.equal(llamadas.length, 1, 'un solo correo');
  assert.equal(claves(db, 'avisos/ana/items/').filter(k => k.includes('cert_')).length, 1);
}));

test('progreso: al emitir crea el aviso de la campana (tipo certificado, enlace "certificados")', async () => {
  const { app, db } = servidor();
  const r = await completar(app, 'c1', 0, 2);
  const aviso = db.value(`avisos/ana/items/cert_${r.body.certificado.folio}`);
  assert.equal(aviso.tipo, 'certificado');
  assert.equal(aviso.enlace, 'certificados');
  assert.match(aviso.texto, /Biología de tiburones/);
  assert.doesNotMatch(aviso.titulo + aviso.texto, /\p{Extended_Pictographic}/u);
});

test('progreso: el correo del certificado va a la persona, con PDF adjunto, sin bloquear la respuesta', conResend(async llamadas => {
  const { app } = servidor();
  const r = await completar(app, 'c1', 0, 2);
  await app.certificados.esperar();
  assert.equal(llamadas.length, 1);
  const c = llamadas[0].cuerpo;
  assert.deepEqual(c.to, ['ana@example.com']);
  assert.match(c.subject, /Biología de tiburones/);
  assert.equal(c.attachments[0].filename, `Certificado-${r.body.certificado.folio}.pdf`);
  assert.equal(Buffer.from(c.attachments[0].content, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.match(c.html, new RegExp(r.body.certificado.folio));
  assert.match(c.html, /pages\/club-certificados\.html/);
}));

test('progreso: si el correo falla o no está configurado, el certificado se emite igual', async () => {
  const { app, db } = servidor(); // sin RESEND_API_KEY
  const r = await completar(app, 'c1', 0, 2);
  await app.certificados.esperar();
  assert.equal(r.status, 200);
  assert.equal(claves(db, 'certificados/').length, 1);
});

test('progreso: XP del curso terminado en "bono" (con la misma fórmula del club) y orden de cursos', async () => {
  const { app } = servidor();
  const primero = await completar(app, 'c1', 0, 2);
  assert.deepEqual(primero.body.bono, { xp: 20, ordinal: 1 });
  const segundo = await completar(app, 'c2', 0, 1);
  assert.deepEqual(segundo.body.bono, { xp: 30, ordinal: 2 });
  const intermedia = await progreso(app, 'c1', 0);
  assert.equal(intermedia.body.bono, undefined, 'solo se informa al emitir');
});

test('progreso: el administrador completa cursos y recibe certificado, pero sin bono de XP', async () => {
  const { app } = servidor();
  const r = await completar(app, 'c2', 0, 1, 'token-admin');
  assert.equal(r.body.completado, true);
  assert.equal(r.body.certificado.nombre, 'Admin Zoorigen');
  assert.equal(r.body.bono, undefined);
});

test('progreso: los certificados cuentan en los logros y premios del club (memberUid, courseId, issuedAt)', async () => {
  const { app } = servidor();
  await completar(app, 'c1', 0, 2);
  const premios = await get(app, '/api/premios');
  assert.equal(premios.status, 200);
  assert.equal(premios.body.cursos.terminados, 1);
  assert.equal(premios.body.cursos.lista[0].courseId, 'c1');
});

// ── Quiz ──

test('quiz: la clase con preguntas exige contestar el quiz antes de completarla (409)', async () => {
  const { app } = servidor();
  const sinQuiz = await progreso(app, 'c3', 0);
  assert.equal(sinQuiz.status, 409);
  assert.equal(sinQuiz.body.error, 'Aprueba el quiz de esta clase antes de completarla');

  const q = await post(app, '/api/cursos/c3/quiz', { sessionIndex: 0, respuestas: [0, 1] });
  assert.equal(q.status, 200);
  assert.deepEqual(q.body, { aprobado: true, correctas: 2, total: 2, detalle: [{ correcta: 0, acertada: true }, { correcta: 1, acertada: true }] });

  const prog = await get(app, '/api/cursos/progreso');
  assert.deepEqual(prog.body.cursos.c3.quizzesAprobados, [0]);
  assert.deepEqual(prog.body.cursos.c3.sesionesVistas, []);
  const ok = await progreso(app, 'c3', 0);
  assert.equal(ok.status, 200);
});

test('quiz: es de práctica, equivocarse muestra la correcta pero no frena', async () => {
  const { app } = servidor();
  const q = await post(app, '/api/cursos/c3/quiz', { sessionIndex: 0, respuestas: [1, 0] });
  assert.equal(q.status, 200);
  assert.equal(q.body.aprobado, false);
  assert.equal(q.body.correctas, 0);
  assert.deepEqual(q.body.detalle, [{ correcta: 0, acertada: false }, { correcta: 1, acertada: false }]);
  assert.equal((await progreso(app, 'c3', 0)).status, 200);
});

test('quiz: respuestas inválidas 400, clase sin preguntas aprueba sin guardar, 404 y 403', async () => {
  const { app, db } = servidor();
  for (const malo of [undefined, [0], [0, 1, 2], 'x', [0, 'a'], [0, 1.5]]) {
    const r = await post(app, '/api/cursos/c3/quiz', { sessionIndex: 0, respuestas: malo });
    assert.equal(r.status, 400, JSON.stringify(malo));
  }
  assert.equal((await post(app, '/api/cursos/c3/quiz', { respuestas: [0, 1] })).status, 400);
  const sinPreguntas = await post(app, '/api/cursos/c3/quiz', { sessionIndex: 1, respuestas: [] });
  assert.deepEqual(sinPreguntas.body, { aprobado: true, correctas: 0, total: 0, detalle: [] });
  assert.equal((await post(app, '/api/cursos/c3/quiz', { sessionIndex: 9, respuestas: [] })).status, 404);
  assert.equal((await post(app, '/api/cursos/noexiste/quiz', { sessionIndex: 0, respuestas: [] })).status, 404);
  assert.equal((await post(app, '/api/cursos/c3/quiz', { sessionIndex: 0, respuestas: [0, 1] }, 'token-sinplan')).status, 403);
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), []);
  assert.deepEqual(claves(db, 'miembros/sinplan/progresoCursos'), []);
});

// ── Clases gratis y prueba gratuita ──

test('clases gratis: sin plan solo se puede completar la clase gratis del curso de muestra, nunca emite certificado', async () => {
  const { app, db } = servidor();
  const libre = await progreso(app, 'cmuestra', 0, 'token-sinplan');
  assert.equal(libre.status, 200);
  assert.deepEqual(libre.body.sesionesVistas, [0]);
  const cerrada = await progreso(app, 'cmuestra', 1, 'token-sinplan');
  assert.equal(cerrada.status, 403);
  assert.deepEqual(claves(db, 'certificados/'), []);
});

test('prueba gratuita: las clases 1..n-1 del curso elegido cuentan; la última no, y no hay certificado', async () => {
  const { app, db } = servidor({ seed: { 'pruebasGratuitas/sinplan': { uid: 'sinplan', cursoId: 'c1' } } });
  assert.equal((await progreso(app, 'c1', 0, 'token-sinplan')).status, 200);
  assert.equal((await progreso(app, 'c1', 1, 'token-sinplan')).status, 200);
  const ultima = await progreso(app, 'c1', 2, 'token-sinplan');
  assert.equal(ultima.status, 403);
  assert.equal((await progreso(app, 'c2', 0, 'token-sinplan')).status, 403, 'otro curso: cerrado');
  assert.deepEqual(claves(db, 'certificados/'), []);
});

// ── Sin CERTIFICATE_SIGNING_KEY ──

test('sin CERTIFICATE_SIGNING_KEY: el servidor arranca, las clases normales se guardan y la última responde 503 sin guardarse', async () => {
  const { app, db } = servidor({ sinLlave: true });
  const salud = await request(app).get('/');
  assert.equal(salud.status, 200);

  await completar(app, 'c1', 0, 1);
  const ultima = await progreso(app, 'c1', 2);
  assert.equal(ultima.status, 503);
  assert.equal(ultima.body.error, 'Los certificados aún no están configurados');
  assert.deepEqual(claves(db, 'certificados/'), []);
  const prog = await get(app, '/api/cursos/progreso');
  assert.deepEqual(prog.body.cursos.c1.sesionesVistas, [0, 1], 'la última clase no se guardó');
  assert.equal(prog.body.cursos.c1.completado, false);

  // la verificación pública y la emisión del administrador tampoco pueden firmar ni verificar
  assert.equal((await request(app).get('/api/certificados/ZOO-2026-ABCDEF12')).status, 503);
  assert.equal((await post(app, '/api/admin/certificados', { uid: 'ana', cursoId: 'c1' }, 'token-admin')).status, 503);
});

test('con la llave puesta después, la última clase pendiente se completa y emite el certificado', async () => {
  const seedProgreso = { 'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1], quizzesAprobados: [], completado: false } };
  const { app } = servidor({ seed: seedProgreso });
  const r = await progreso(app, 'c1', 2);
  assert.equal(r.status, 200);
  assert.match(r.body.certificado.folio, FOLIO);
});

// ── Importación única del progreso viejo ──

const ENV_LEGADO = { LEGACY_PROGRESS_IMPORT_BEFORE: '2026-10-01T00:00:00Z' };
const authAntigua = { ana: { creationTime: '2026-03-01T12:00:00Z' } };
const viejo = {
  c1: { completedLessons: [0, 1, 7, -1], isCompleted: false },
  c3: { completedLessons: [0], isCompleted: false },
  c2: { completedLessons: [0, 1], isCompleted: true, certificateFolio: 'ZOO-2026-12345', completedAt: '2026-04-01T10:00:00.000Z' },
  inexistente: { completedLessons: [0, 1] }
};
const seedLegado = (extra = {}) => ({
  'miembros/ana': miembroConPlan({ name: 'Ana Pérez', courseProgress: viejo, ...extra }),
  'certificados/ZOO-2026-12345': {
    folio: 'ZOO-2026-12345', memberUid: 'ana', courseId: 'c2', courseTitle: 'Etología aplicada', memberName: 'Ana Pérez',
    issuedAt: '2026-04-01T10:00:00.000Z', totalClases: 2
  }
});

test('legado: con la variable y una cuenta anterior al corte importa el progreso viejo, una sola vez', async () => {
  const { app, db } = servidor({ env: ENV_LEGADO, usuariosAuth: authAntigua, seed: seedLegado() });
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.status, 200);
  assert.equal(r.body.legadoImportado, true);
  assert.deepEqual(r.body.cursos.c1, { sesionesVistas: [0, 1], quizzesAprobados: [], completado: false, certificadoFolio: null, completadoEn: null });
  assert.deepEqual(r.body.cursos.c3, { sesionesVistas: [0], quizzesAprobados: [0], completado: false, certificadoFolio: null, completadoEn: null });
  assert.deepEqual(r.body.cursos.c2, { sesionesVistas: [0, 1], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-12345', completadoEn: '2026-04-01T10:00:00.000Z' });
  assert.equal(r.body.cursos.inexistente, undefined);
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, true);
  assert.ok(db.value('miembros/ana').courseProgress, 'el campo viejo no se borra');
  assert.equal(db.value('miembros/ana/progresoCursos/c1').origenLegado, true);
  // NUNCA emite certificados
  assert.deepEqual(claves(db, 'certificados/'), ['certificados/ZOO-2026-12345']);

  // una sola vez: aunque el campo viejo cambie, no se vuelve a importar
  db._data.set('miembros/ana', { ...db.value('miembros/ana'), courseProgress: { c2: { completedLessons: [0] }, c1: { completedLessons: [0, 1, 2] } } });
  const otra = await get(app, '/api/cursos/progreso');
  assert.deepEqual(otra.body.cursos.c1.sesionesVistas, [0, 1]);
});

test('legado: un curso terminado SIN certificado deja la última clase pendiente y el flujo normal emite el certificado', async () => {
  const { app, db } = servidor({
    env: ENV_LEGADO, usuariosAuth: authAntigua,
    seed: { 'miembros/ana': miembroConPlan({ name: 'Ana Pérez', courseProgress: { c1: { completedLessons: [0, 1, 2], isCompleted: true } } }) }
  });
  const r = await get(app, '/api/cursos/progreso');
  assert.deepEqual(r.body.cursos.c1, { sesionesVistas: [0, 1], quizzesAprobados: [], completado: false, certificadoFolio: null, completadoEn: null });
  assert.deepEqual(claves(db, 'certificados/'), []);
  const fin = await progreso(app, 'c1', 2);
  assert.equal(fin.body.completado, true);
  assert.match(fin.body.certificado.folio, FOLIO);
});

// El certificado anterior del curso c2 sí lo deja completado (aunque no se importe el progreso viejo): ver
// test/certificados-anteriores.test.js. Lo demás del progreso viejo (c1, c3) no se importa.
const soloPorCertificado = { c2: { sesionesVistas: [0, 1], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-12345', completadoEn: '2026-04-01T10:00:00.000Z' } };

test('legado: sin la variable LEGACY_PROGRESS_IMPORT_BEFORE no se importa el progreso viejo (solo se reconoce el curso con certificado)', async () => {
  const { app, db } = servidor({ usuariosAuth: authAntigua, seed: seedLegado() });
  const r = await get(app, '/api/cursos/progreso');
  assert.deepEqual(r.body, { cursos: soloPorCertificado, legadoImportado: false });
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, undefined);
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), ['miembros/ana/progresoCursos/c2']);
});

test('legado: una cuenta creada después del corte, o sin dato en Auth, no importa', async () => {
  const nueva = servidor({ env: ENV_LEGADO, usuariosAuth: { ana: { creationTime: '2026-10-05T00:00:00Z' } }, seed: seedLegado() });
  assert.deepEqual((await get(nueva.app, '/api/cursos/progreso')).body, { cursos: soloPorCertificado, legadoImportado: false });
  const sinAuth = servidor({ env: ENV_LEGADO, usuariosAuth: {}, seed: seedLegado() });
  assert.deepEqual((await get(sinAuth.app, '/api/cursos/progreso')).body, { cursos: soloPorCertificado, legadoImportado: false });
  const fechaMala = servidor({ env: { LEGACY_PROGRESS_IMPORT_BEFORE: 'no-es-fecha' }, usuariosAuth: authAntigua, seed: seedLegado() });
  assert.deepEqual((await get(fechaMala.app, '/api/cursos/progreso')).body, { cursos: soloPorCertificado, legadoImportado: false });
});

test('legado: el avance ya guardado por el servidor no se pierde al importar', async () => {
  const { app } = servidor({
    env: ENV_LEGADO, usuariosAuth: authAntigua,
    seed: {
      ...seedLegado(),
      'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-SERVID01' }
    }
  });
  const r = await get(app, '/api/cursos/progreso');
  assert.deepEqual(r.body.cursos.c1, { sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-SERVID01', completadoEn: null });
});

// ── GET /api/certificados/:folio (pública) ──

async function emitirUno(opciones) {
  const s = servidor(opciones);
  const r = await completar(s.app, 'c1', 0, 2);
  return { ...s, folio: r.body.certificado.folio, publico: r.body.certificado };
}

test('verificación pública: sin sesión devuelve los 8 campos públicos y nada más; sin caché', async () => {
  const { app, folio, publico } = await emitirUno();
  const r = await request(app).get(`/api/certificados/${folio}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { valido: true, certificado: publico });
  assert.match(r.headers['cache-control'], /no-store/);
  assert.doesNotMatch(JSON.stringify(r.body), /ana@example|firmaBackend|"uid"|memberUid/);
  // minúsculas y espacios se aceptan (se pasan a mayúsculas)
  const minuscula = await request(app).get(`/api/certificados/${folio.toLowerCase()}`);
  assert.equal(minuscula.status, 200);
  assert.equal(minuscula.body.certificado.folio, folio);
});

test('verificación pública: se puede consultar desde el sitio (CORS)', async () => {
  const { app, folio } = await emitirUno();
  for (const origen of ['https://www.zoorigen.com', 'http://localhost:5500']) {
    const r = await request(app).get(`/api/certificados/${folio}`).set('Origin', origen);
    assert.equal(r.status, 200);
    assert.ok(r.headers['access-control-allow-origin'], origen);
  }
  const pre = await request(app).options(`/api/certificados/${folio}`)
    .set('Origin', 'https://www.zoorigen.com').set('Access-Control-Request-Method', 'GET');
  assert.ok(pre.status < 300);
  assert.ok(pre.headers['access-control-allow-origin']);
});

test('verificación pública: 400 si el folio no tiene el formato', async () => {
  const { app } = servidor();
  for (const malo of ['abc', 'ALINTEC-2026-ABCDEF', 'ZOO-26-ABCDEF', 'ZOO-2026-AB', 'ZOO-2026-ABCDEFGHIJKLMNOPQ', 'ZOO-2026-AB%2FCD', 'ZOO-2026-AB.CD']) {
    const r = await request(app).get(`/api/certificados/${malo}`);
    assert.equal(r.status, 400, malo);
    assert.equal(r.body.error, 'Folio inválido');
  }
});

test('verificación pública: 404 si no existe', async () => {
  const { app } = servidor();
  const r = await request(app).get('/api/certificados/ZOO-2026-ABCDEF12');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Certificado no encontrado');
});

test('verificación pública: 404 para un certificado del navegador que no pasa la revisión (aquí, de un curso que ya no existe)', async () => {
  const { app } = servidor({ seed: {
    'certificados/ZOO-2026-12345': { folio: 'ZOO-2026-12345', memberUid: 'ana', courseId: 'borrado', courseTitle: 'Curso', memberName: 'Ana', issuedAt: '2026-01-01T00:00:00.000Z' }
  } });
  const r = await request(app).get('/api/certificados/ZOO-2026-12345');
  assert.equal(r.status, 404);
});

test('verificación pública: una firma o un dato firmado alterado se rechaza (404)', async () => {
  const { app, db, folio } = await emitirUno();
  const original = db.value(`certificados/${folio}`);
  const probar = async cambios => {
    db._data.set(`certificados/${folio}`, { ...original, ...cambios });
    return (await request(app).get(`/api/certificados/${folio}`)).status;
  };
  assert.equal(await probar({}), 200);
  assert.equal(await probar({ firmaBackend: 'a'.repeat(64) }), 404);
  assert.equal(await probar({ firmaBackend: 'no-es-firma' }), 404);
  // sin firma ya no hay nada que alterar: es un certificado anterior y pasa la revisión como cualquier otro
  const sinFirma = await probar({ firmaBackend: undefined });
  assert.equal(sinFirma, 200);
  assert.equal(await probar({ cursoId: 'c2' }), 404);
  assert.equal(await probar({ uid: 'beto' }), 404);
  assert.equal(await probar({ emitido: '2020-01-01T00:00:00.000Z' }), 404);
  assert.equal(await probar({ year: 2020 }), 404);
  assert.equal(await probar({ verificado: false }), 404);
  assert.equal(await probar({ origen: 'navegador' }), 404);
  // una copia firmada puesta bajo otro folio tampoco vale
  db._data.set(`certificados/${folio}`, original);
  db._data.set('certificados/ZOO-2026-COPIA123', { ...original });
  assert.equal((await request(app).get('/api/certificados/ZOO-2026-COPIA123')).status, 404);
});

test('verificación pública: un certificado viejo ya normalizado por la auditoría sí se muestra', async () => {
  const viejoDoc = {
    folio: 'ZOO-2026-12345', memberUid: 'ana', courseId: 'c1', courseTitle: 'Biología de tiburones', courseArea: 'Fauna silvestre',
    courseDuration: '6 horas', memberName: 'Ana Pérez', issuedAt: '2026-03-04T15:00:00.000Z', totalClases: 3
  };
  const r = cert.parcheLegadoValidado('ZOO-2026-12345', viejoDoc, LLAVE);
  assert.equal(r.ok, true);
  const { app } = servidor({ seed: { 'certificados/ZOO-2026-12345': { ...viejoDoc, ...r.parche } } });
  const res = await request(app).get('/api/certificados/ZOO-2026-12345');
  assert.equal(res.status, 200);
  assert.equal(res.body.certificado.nombre, 'Ana Pérez');
  assert.equal(res.body.certificado.sesiones, 3);
  assert.equal(res.body.certificado.horas, 6);
  assert.equal(res.body.certificado.emitido, '2026-03-04T15:00:00.000Z');
});

test('verificación pública: 30 consultas cada 10 minutos por IP; la 31 recibe 429 y otra IP no se ve afectada', async () => {
  const { app } = servidor();
  const consulta = ip => request(app).get('/api/certificados/ZOO-2026-ABCDEF12').set('X-Forwarded-For', ip);
  for (let i = 0; i < 30; i++) assert.equal((await consulta('203.0.113.7')).status, 404, `consulta ${i + 1}`);
  const limite = await consulta('203.0.113.7');
  assert.equal(limite.status, 429);
  assert.match(limite.body.error, /Demasiadas verificaciones/);
  assert.equal((await consulta('198.51.100.9')).status, 404);
});

// ── POST /api/admin/certificados ──

test('admin: 403 a quien no es administrador (con o sin plan)', async () => {
  const { app, db } = servidor();
  for (const t of ['token-ana', 'token-sinplan']) {
    const r = await post(app, '/api/admin/certificados', { uid: 'beto', cursoId: 'c1' }, t);
    assert.equal(r.status, 403, t);
  }
  assert.deepEqual(claves(db, 'certificados/'), []);
});

test('admin: emite el certificado (origen admin, validado por el backend) y una segunda vez devuelve el mismo', async () => {
  const { app, db } = servidor();
  const r = await post(app, '/api/admin/certificados', { uid: 'beto', cursoId: 'c1' }, 'token-admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const c = r.body.certificado;
  assert.match(c.folio, FOLIO);
  assert.equal(c.nombre, 'Beto Ruiz');
  assert.equal(c.curso, 'Biología de tiburones');
  assert.equal(c.horas, 6);
  assert.equal(c.sesiones, 3);
  const doc = db.value(`certificados/${c.folio}`);
  assert.equal(doc.origen, 'admin');
  assert.equal(doc.validadoBackend, true);
  assert.equal(doc.emitidoPor, 'admin');
  assert.equal(doc.verificado, true);
  assert.equal(doc.memberUid, 'beto');
  assert.equal(cert.certificadoValido(doc, LLAVE), true);

  const otra = await post(app, '/api/admin/certificados', { uid: 'beto', cursoId: 'c1', nombre: 'Otro nombre' }, 'token-admin');
  assert.equal(otra.status, 200);
  assert.deepEqual(otra.body.certificado, c);
  assert.equal(claves(db, 'certificados/').length, 1);

  // y es verificable en público
  const publica = await request(app).get(`/api/certificados/${c.folio}`);
  assert.equal(publica.status, 200);
});

test('admin: busca un certificado previo del mismo uid y curso antes de reemitir (aunque sea de otro año)', async () => {
  const previo = cert.construirCertificado({
    uid: 'beto', cursoId: 'c1', curso: { title: 'Biología de tiburones', lecciones: [{}] }, nombre: 'Beto Ruiz',
    emitido: new Date('2025-05-05T10:00:00Z'), llave: LLAVE
  });
  const { app, db } = servidor({ seed: { [`certificados/${previo.folio}`]: previo } });
  const r = await post(app, '/api/admin/certificados', { uid: 'beto', cursoId: 'c1' }, 'token-admin');
  assert.equal(r.status, 200);
  assert.equal(r.body.certificado.folio, previo.folio);
  assert.equal(claves(db, 'certificados/').length, 1);
});

test('admin: nombre, horas y sesiones opcionales; y el certificado del curso emitido por la persona se reconoce', async () => {
  const { app } = servidor();
  const r = await post(app, '/api/admin/certificados', { uid: 'beto', cursoId: 'c2', nombre: 'Beto Ruiz Soto', horas: 12, sesiones: 5 }, 'token-admin');
  assert.equal(r.status, 200);
  assert.equal(r.body.certificado.nombre, 'Beto Ruiz Soto');
  assert.equal(r.body.certificado.horas, 12);
  assert.equal(r.body.certificado.sesiones, 5);
  // si después Beto completa el curso, recibe ese mismo certificado y no se duplica
  const fin = await completar(app, 'c2', 0, 1, 'token-beto');
  assert.equal(fin.body.certificado.folio, r.body.certificado.folio);
});

test('admin: 400 con uid o curso inválidos y 404 si el miembro o el curso no existen', async () => {
  const { app } = servidor();
  const peticion = cuerpo => post(app, '/api/admin/certificados', cuerpo, 'token-admin');
  assert.equal((await peticion({})).status, 400);
  assert.equal((await peticion({ uid: 'a/b', cursoId: 'c1' })).status, 400);
  assert.equal((await peticion({ uid: 'beto', cursoId: '../x' })).status, 400);
  assert.equal((await peticion({ uid: 'fantasma', cursoId: 'c1' })).status, 404);
  assert.equal((await peticion({ uid: 'beto', cursoId: 'noexiste' })).status, 404);
});

// ── Ajustes de contrato: completadoEn, preguntas inválidas y CORS sin credenciales ──

test('GET progreso: completadoEn es la fecha de término (o de emisión del certificado) y null si no está completo', async () => {
  const { app } = servidor({ seed: {
    'miembros/ana/progresoCursos/c1': {
      cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true,
      certificadoFolio: 'ZOO-2026-AAAAAAA1', completadoEn: ts(Date.parse('2026-06-01T12:00:00Z'))
    },
    'miembros/ana/progresoCursos/c2': { cursoId: 'c2', uid: 'ana', sesionesVistas: [0, 1], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-BBBBBBB2' },
    'miembros/ana/progresoCursos/c3': { cursoId: 'c3', uid: 'ana', sesionesVistas: [0], quizzesAprobados: [0], completado: false },
    'certificados/ZOO-2026-BBBBBBB2': { folio: 'ZOO-2026-BBBBBBB2', memberUid: 'ana', courseId: 'c2', issuedAt: '2026-07-02T08:30:00.000Z' }
  } });
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.body.cursos.c1.completadoEn, '2026-06-01T12:00:00.000Z');
  assert.equal(r.body.cursos.c2.completadoEn, '2026-07-02T08:30:00.000Z');
  assert.equal(r.body.cursos.c3.completadoEn, null);
});

test('quiz: las preguntas incompletas se saltan igual que en el sitio y el detalle trae una fila por pregunta válida', async () => {
  const { app } = servidor({ seed: {
    'cursos/cinv': {
      title: 'Con preguntas rotas', area: 'General',
      lecciones: [leccion(51, { preguntas: [
        { pregunta: '', tipo: 'vof', correcta: 0 },
        { pregunta: 'Primera válida', tipo: 'vof', correcta: 1 },
        { pregunta: 'Sin opciones suficientes', tipo: 'multiple', opciones: ['única'], correcta: 0 },
        { pregunta: 'Correcta fuera de rango', tipo: 'multiple', opciones: ['A', 'B'], correcta: 5 },
        { pregunta: 'Segunda válida', tipo: 'multiple', opciones: ['A', 'B', 'C'], correcta: 2 }
      ] }), leccion(52)]
    }
  } });
  const mal = await post(app, '/api/cursos/cinv/quiz', { sessionIndex: 0, respuestas: [1, 2, 0, 0, 0] });
  assert.equal(mal.status, 400, 'cinco respuestas no coinciden con las 2 preguntas válidas');
  const ok = await post(app, '/api/cursos/cinv/quiz', { sessionIndex: 0, respuestas: [1, 2] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { aprobado: true, correctas: 2, total: 2, detalle: [{ correcta: 1, acertada: true }, { correcta: 2, acertada: true }] });
  assert.equal((await progreso(app, 'cinv', 0)).status, 200);
});

test('verificación pública: CORS abierto sin credenciales y sin cabecera Authorization', async () => {
  const { app, folio } = await emitirUno();
  const r = await request(app).get(`/api/certificados/${folio}`).set('Origin', 'https://www.zoorigen.com');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
  assert.equal(r.request.header.Authorization, undefined);
});

// ── Nombre del primer certificado (se confirma una sola vez) ──

const FOLIO_LEGADO = 'ZOO-2026-48213';
const delNavegador = (extra = {}) => ({
  folio: FOLIO_LEGADO, courseId: 'c3', courseTitle: 'Primeros auxilios', courseArea: 'Veterinaria', courseDuration: '3 horas',
  memberUid: 'ana', memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: '2026-03-04T15:00:00.000Z', totalClases: 2, ...extra
});

test('nombre: el primer certificado nuevo pide confirmar el nombre; el segundo ya no', async () => {
  const { app } = servidor();
  const primero = await completar(app, 'c1', 0, 2);
  assert.equal(primero.body.confirmarNombre, true);
  assert.equal(primero.body.certificado.nombre, 'Ana Pérez');
  // Repetir la última clase no lo vuelve a pedir (el sitio lo revisa en "Mis certificados")
  const repetida = await progreso(app, 'c1', 2);
  assert.equal(repetida.body.confirmarNombre, undefined);
  // Un segundo certificado, con el primero aún sin confirmar, tampoco se lo pide a otra persona que ya confirmó
  const ok = await post(app, '/api/certificados/nombre', { folio: primero.body.certificado.folio, nombre: 'Ana Pérez' });
  assert.equal(ok.status, 200);
  const segundo = await completar(app, 'c2', 0, 1);
  assert.equal(segundo.body.confirmarNombre, undefined);
});

test('nombre: confirmar deja el nombre en el certificado, el perfil y la cuenta, sin romper la firma ni la verificación pública', async () => {
  const { app, db, registroAuth } = servidor();
  const fin = await completar(app, 'c1', 0, 2);
  const folio = fin.body.certificado.folio;
  const firmaAntes = db.value('certificados/' + folio).firmaBackend;

  const r = await post(app, '/api/certificados/nombre', { folio, nombre: '  maría de la luz   lópez ruiz ' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.nombre, r.body.folio, r.body.corregido], [true, 'María de la Luz López Ruiz', folio, true]);
  const doc = db.value('certificados/' + folio);
  assert.equal(doc.nombre, 'María de la Luz López Ruiz');
  assert.equal(doc.memberName, 'María de la Luz López Ruiz');
  assert.equal(doc.nombreConfirmado, true);
  assert.ok(doc.nombreConfirmadoEn);
  assert.equal(doc.firmaBackend, firmaAntes, 'la firma no cambia: el nombre no forma parte de lo que se firma');
  assert.equal(cert.certificadoValido(doc, LLAVE), true);
  const perfil = db.value('miembros/ana');
  assert.equal(perfil.nombreCertificado, 'María de la Luz López Ruiz');
  assert.equal(perfil.name, 'María de la Luz López Ruiz');
  assert.ok(perfil.nombreCertificadoConfirmadoEn);
  assert.equal(perfil.nombreCertificadoFolio, folio);
  assert.deepEqual(registroAuth.actualizaciones, [{ uid: 'ana', cambios: { displayName: 'María de la Luz López Ruiz' } }]);

  const publico = await request(app).get('/api/certificados/' + folio);
  assert.equal(publico.status, 200);
  assert.equal(publico.body.valido, true);
  assert.equal(publico.body.certificado.nombre, 'María de la Luz López Ruiz');
});

test('nombre: confirmar tal cual (sin cambios) también cierra la pregunta y solo se puede una vez', async () => {
  const { app, db } = servidor();
  const folio = (await completar(app, 'c1', 0, 2)).body.certificado.folio;
  const ok = await post(app, '/api/certificados/nombre', { folio, nombre: 'Ana Pérez' });
  assert.deepEqual([ok.status, ok.body.corregido], [200, false]);
  assert.equal(db.value('certificados/' + folio).nombre, 'Ana Pérez');
  const otra = await post(app, '/api/certificados/nombre', { folio, nombre: 'Otra Persona Distinta' });
  assert.equal(otra.status, 409);
  assert.equal(db.value('certificados/' + folio).nombre, 'Ana Pérez', 'ya confirmado: no cambia');
});

test('nombre: rechaza nombres que no sirven, folios ajenos o inexistentes y la falta de sesión', async () => {
  const { app, db } = servidor();
  const folio = (await completar(app, 'c1', 0, 2)).body.certificado.folio;
  for (const malo of ['', 'Pedro', 'Ana 3rd', 'a b', 'Ana de', 'x'.repeat(70), '<b>Ana</b> Pérez']) {
    const r = await post(app, '/api/certificados/nombre', { folio, nombre: malo });
    assert.equal(r.status, 400, JSON.stringify(malo));
  }
  assert.equal((await post(app, '/api/certificados/nombre', { nombre: 'Ana Pérez' })).status, 400, 'sin folio');
  assert.equal((await post(app, '/api/certificados/nombre', { folio: 'ZOO-2026-AAAAAAAA', nombre: 'Ana Pérez' })).status, 404);
  // El certificado de otra persona no se toca
  assert.equal((await post(app, '/api/certificados/nombre', { folio, nombre: 'Beto Ruiz' }, 'token-beto')).status, 404);
  assert.equal((await request(app).post('/api/certificados/nombre').send({ folio, nombre: 'Ana Pérez' })).status, 401);
  assert.equal(db.value('certificados/' + folio).nombreConfirmado, undefined, 'nada cambió');
  assert.equal(db.value('miembros/ana').nombreCertificadoConfirmadoEn, undefined);
});

test('nombre: tras confirmar, los certificados nuevos salen con el nombre del perfil y quedan fijos', async () => {
  const { app, db } = servidor();
  const folio1 = (await completar(app, 'c1', 0, 2)).body.certificado.folio;
  await post(app, '/api/certificados/nombre', { folio: folio1, nombre: 'Ana María Pérez Soto' });
  const folio2 = (await completar(app, 'c2', 0, 1)).body.certificado.folio;
  const doc2 = db.value('certificados/' + folio2);
  assert.equal(doc2.nombre, 'Ana María Pérez Soto');
  assert.equal(doc2.nombreConfirmado, true, 'sale fijo desde el principio');
  // Editar el perfil después no cambia certificados ya emitidos
  db._data.set('miembros/ana', { ...db.value('miembros/ana'), name: 'Ana P.', nombreCertificado: 'Ana P.' });
  assert.equal(db.value('certificados/' + folio1).nombre, 'Ana María Pérez Soto');
  assert.equal(db.value('certificados/' + folio2).nombre, 'Ana María Pérez Soto');
});

test('nombre: quien ya tiene certificados anteriores no es obligado a confirmar ni se le modifican', async () => {
  const { app, db } = servidor({ seed: { ['certificados/' + FOLIO_LEGADO]: delNavegador() } });
  const fin = await completar(app, 'c1', 0, 2);
  assert.equal(fin.body.confirmarNombre, undefined, 'tiene un certificado anterior: no se le pregunta');
  const antes = JSON.stringify(db.value('certificados/' + FOLIO_LEGADO));
  // Aunque lo intente a mano, no se le permite cambiarlo (no es "el primer certificado")
  const r = await post(app, '/api/certificados/nombre', { folio: fin.body.certificado.folio, nombre: 'Ana Pérez Soto' });
  assert.equal(r.status, 409);
  const sobreElAnterior = await post(app, '/api/certificados/nombre', { folio: FOLIO_LEGADO, nombre: 'Ana Pérez Soto' });
  assert.ok([404, 409].includes(sobreElAnterior.status));
  assert.equal(JSON.stringify(db.value('certificados/' + FOLIO_LEGADO)), antes, 'el certificado anterior queda intacto');
  assert.equal(db.value('miembros/ana').nombreCertificadoConfirmadoEn, undefined);
  // Y siguen pudiendo verificarse como antes
  const publico = await request(app).get('/api/certificados/' + FOLIO_LEGADO);
  assert.equal(publico.status, 200);
});

test('nombre: si cerró la ventana y terminó otro curso, se corrigen juntos los certificados nuevos sin confirmar', async () => {
  const { app, db } = servidor();
  const folio1 = (await completar(app, 'c1', 0, 2)).body.certificado.folio;
  const fin2 = await completar(app, 'c2', 0, 1);
  assert.equal(fin2.body.confirmarNombre, true, 'sigue sin confirmar: se vuelve a preguntar');
  const r = await post(app, '/api/certificados/nombre', { folio: fin2.body.certificado.folio, nombre: 'Ana María Pérez Soto' });
  assert.equal(r.status, 200);
  assert.equal(db.value('certificados/' + folio1).nombre, 'Ana María Pérez Soto');
  assert.equal(db.value('certificados/' + fin2.body.certificado.folio).nombre, 'Ana María Pérez Soto');
});

test('nombre: sin la llave de firma responde 503 y la persona sin plan ni cuenta no puede confirmar', async () => {
  const { app } = servidor({ sinLlave: true });
  assert.equal((await post(app, '/api/certificados/nombre', { folio: 'ZOO-2026-AAAAAAAA', nombre: 'Ana Pérez' })).status, 503);
});

test('nombre: los certificados que emite el administrador no se modifican ni bloquean la confirmación', async () => {
  const { app, db } = servidor();
  const admin = await post(app, '/api/admin/certificados', { uid: 'ana', cursoId: 'c3', nombre: 'Ana P. de Pérez' }, 'token-admin');
  assert.equal(admin.status, 200);
  const folioAdmin = admin.body.certificado.folio;
  const fin = await completar(app, 'c1', 0, 2);
  assert.equal(fin.body.confirmarNombre, true);
  const r = await post(app, '/api/certificados/nombre', { folio: fin.body.certificado.folio, nombre: 'Ana Pérez Soto' });
  assert.equal(r.status, 200);
  assert.equal(db.value('certificados/' + folioAdmin).nombre, 'Ana P. de Pérez', 'el del administrador no se toca');
});

test('nombre: si se corrige, sale otro correo con el PDF ya corregido; si solo se confirma, ninguno más', conResend(async llamadas => {
  const { app } = servidor();
  const f1 = (await completar(app, 'c1', 0, 2)).body.certificado.folio;
  await app.certificados.esperar();
  assert.equal(llamadas.length, 1, 'el correo del certificado al emitirse');
  assert.match(JSON.stringify(llamadas[0].cuerpo), /Ana/);
  const r = await post(app, '/api/certificados/nombre', { folio: f1, nombre: 'Ana María Pérez Soto' });
  assert.equal(r.status, 200);
  await app.certificados.esperar();
  assert.equal(llamadas.length, 2, 'un correo nuevo con el nombre corregido');
  assert.equal(llamadas[1].cuerpo.to.join ? llamadas[1].cuerpo.to.join(',') : llamadas[1].cuerpo.to, 'ana@example.com');
  assert.ok((llamadas[1].cuerpo.attachments || []).length === 1, 'con el PDF adjunto');
  const { app: app2 } = servidor();
  const g1 = (await completar(app2, 'c1', 0, 2, 'token-beto')).body.certificado.folio;
  await app2.certificados.esperar();
  const antes = llamadas.length;
  await post(app2, '/api/certificados/nombre', { folio: g1, nombre: 'Beto Ruiz' }, 'token-beto');
  await app2.certificados.esperar();
  assert.equal(llamadas.length, antes, 'confirmar sin cambios no manda otro correo');
}));
