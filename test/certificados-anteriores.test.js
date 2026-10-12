'use strict';

// Certificados anteriores (escritos por el navegador, sin firma): se verifican en público, se firman en su lugar
// cuando su titular consulta el progreso, dejan el curso completado y se reutilizan al completar el curso.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, uuid
} = require('./helpers/club');
const cert = require('../services/certificados');

const LLAVE = 'llave-de-prueba-para-certificados-0123456789';
const tokens = tokensDe('ana', 'beto', 'sinplan', 'admin');
const FOLIO = 'ZOO-2026-48213';

const leccion = (n, extra = {}) => ({ titulo: `Clase ${n}`, videoId: uuid(n), provider: 'bunny', ...extra });
const cursosBase = () => ({
  'cursos/c1': {
    title: 'Biología de tiburones', area: 'Fauna silvestre', duration: '6 horas', instructor: 'Dra. Pérez',
    lecciones: [leccion(11), leccion(12), leccion(13)]
  },
  'cursos/c2': { title: 'Etología aplicada', area: 'Manejo', lecciones: [leccion(21), leccion(22)] },
  'cursos/c3': {
    title: 'Primeros auxilios', area: 'Veterinaria',
    lecciones: [
      leccion(31, { preguntas: [{ pregunta: '¿Los reptiles son de sangre fría?', tipo: 'vof', correcta: 0 }] }),
      leccion(32)
    ]
  }
});

// EXACTAMENTE lo que escribía el navegador (sin firmaBackend, sin uid/cursoId/nombre/curso/emitido)
const delNavegador = (extra = {}) => ({
  folio: FOLIO, courseId: 'c1', courseTitle: 'Biología de tiburones', courseArea: 'Fauna silvestre', courseDuration: '6 horas',
  memberUid: 'ana', memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: '2026-03-04T15:00:00.000Z', totalClases: 3,
  ...extra
});
// Variante emitida por el administrador con los otros nombres
const delAdmin = (extra = {}) => ({
  folio: 'ZOO-2026-77001', uid: 'beto', cursoId: 'c2', nombre: 'Beto Ruiz', curso: 'Etología aplicada', emitido: '2026-05-01T10:00:00.000Z', ...extra
});

function servidor({ seed = {}, env = {}, sinLlave = false } = {}) {
  return cargarServidor({
    tokens,
    env: sinLlave ? env : { CERTIFICATE_SIGNING_KEY: LLAVE, ...env },
    seed: {
      ...cursosBase(),
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com' }),
      'miembros/beto': miembroConPlan({ name: 'Beto Ruiz' }),
      'miembros/sinplan': miembroSinPlan(),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin Zoorigen' }),
      ...seed
    }
  });
}

const get = (app, ruta, t = 'token-ana') => request(app).get(ruta).set(auth(t));
const post = (app, ruta, cuerpo, t = 'token-ana') => request(app).post(ruta).set(auth(t)).send(cuerpo);
const progreso = (app, cursoId, sessionIndex, t = 'token-ana') => post(app, `/api/cursos/${cursoId}/progreso`, { sessionIndex }, t);
const claves = (db, prefijo) => [...db._data.keys()].filter(k => k.startsWith(prefijo));
const foto = db => JSON.stringify([...db._data.entries()]);
const pausa = () => new Promise(resolver => setTimeout(resolver, 8));

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

const seedNavegador = (extra = {}) => ({ [`certificados/${FOLIO}`]: delNavegador(extra) });

// ── Verificación pública ──

test('anterior: la verificación pública responde 200 con anterior:true, sin escribir nada y sin datos personales', async () => {
  const { app, db } = servidor({ seed: seedNavegador() });
  const antes = foto(db);
  const r = await request(app).get(`/api/certificados/${FOLIO}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    valido: true,
    anterior: true,
    certificado: {
      folio: FOLIO, nombre: 'Ana Pérez', curso: 'Biología de tiburones', area: 'Fauna silvestre', horas: 6, sesiones: 3,
      instructor: 'Equipo Zoorigen', emitido: '2026-03-04T15:00:00.000Z'
    }
  });
  assert.doesNotMatch(JSON.stringify(r.body), /ana@example|firmaBackend|"uid"|memberUid/);
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(foto(db), antes, 'la ruta pública no escribe en Firestore');
  // minúsculas se aceptan como en los firmados
  assert.equal((await request(app).get(`/api/certificados/${FOLIO.toLowerCase()}`)).status, 200);
});

test('anterior: también el emitido por el administrador con los otros nombres (uid, cursoId, nombre, curso, emitido)', async () => {
  const { app } = servidor({ seed: { 'certificados/ZOO-2026-77001': delAdmin() } });
  const r = await request(app).get('/api/certificados/ZOO-2026-77001');
  assert.equal(r.status, 200);
  assert.equal(r.body.anterior, true);
  assert.equal(r.body.certificado.nombre, 'Beto Ruiz');
  assert.equal(r.body.certificado.curso, 'Etología aplicada');
  assert.equal(r.body.certificado.emitido, '2026-05-01T10:00:00.000Z');
  assert.equal(r.body.certificado.area, 'General');
  assert.equal(r.body.certificado.horas, 0);
});

test('anterior: 404 si no pasa la revisión (curso, miembro, folio, nombre, fecha) y si el folio no existe', async () => {
  const casos = {
    'curso inexistente': delNavegador({ courseId: 'borrado' }),
    'miembro inexistente': delNavegador({ memberUid: 'fantasma' }),
    'folio distinto al id': delNavegador({ folio: 'ZOO-2026-99999' }),
    'sin folio': delNavegador({ folio: undefined }),
    'sin nombre': delNavegador({ memberName: '' }),
    'sin título de curso': delNavegador({ courseTitle: '' }),
    'fecha inválida': delNavegador({ issuedAt: 'ayer' }),
    'fecha futura': delNavegador({ issuedAt: '2099-01-01T00:00:00.000Z' }),
    'titulares distintos': delNavegador({ uid: 'beto' }),
    'cursos distintos': delNavegador({ cursoId: 'c2' })
  };
  for (const [nombre, doc] of Object.entries(casos)) {
    const { app } = servidor({ seed: { [`certificados/${FOLIO}`]: doc } });
    const r = await request(app).get(`/api/certificados/${FOLIO}`);
    assert.equal(r.status, 404, nombre);
    assert.equal(r.body.error, 'Certificado no encontrado', nombre);
  }
  const { app } = servidor();
  assert.equal((await request(app).get('/api/certificados/ZOO-2026-00000')).status, 404);
});

test('anterior: un miembro que solo existe en la colección usuarios (legado) también cuenta', async () => {
  const { app } = servidor({ seed: {
    'usuarios/viejo': { name: 'Persona Vieja' },
    'certificados/ZOO-2026-31416': delNavegador({ folio: 'ZOO-2026-31416', memberUid: 'viejo', memberName: 'Persona Vieja' })
  } });
  assert.equal((await request(app).get('/api/certificados/ZOO-2026-31416')).status, 200);
});

test('anterior: sigue el límite de 30 consultas cada 10 minutos por IP', async () => {
  const { app } = servidor({ seed: seedNavegador() });
  const consulta = () => request(app).get(`/api/certificados/${FOLIO}`).set('X-Forwarded-For', '203.0.113.20');
  for (let i = 0; i < 30; i++) assert.equal((await consulta()).status, 200, `consulta ${i + 1}`);
  assert.equal((await consulta()).status, 429);
});

test('anterior: dos certificados de la misma persona y curso se verifican los dos (duplicado legítimo, sin consultas extra)', async () => {
  const { app, db } = servidor({ seed: {
    'certificados/ZOO-2026-10001': delNavegador({ folio: 'ZOO-2026-10001', issuedAt: '2026-02-01T00:00:00.000Z' }),
    'certificados/ZOO-2026-10002': delNavegador({ folio: 'ZOO-2026-10002', issuedAt: '2026-03-01T00:00:00.000Z' })
  } });
  const antes = foto(db);
  for (const folio of ['ZOO-2026-10001', 'ZOO-2026-10002']) {
    const r = await request(app).get('/api/certificados/' + folio);
    assert.equal(r.status, 200, folio);
    assert.equal(r.body.anterior, true);
    assert.equal(r.body.certificado.folio, folio);
  }
  assert.equal(foto(db), antes);
  // sin consultas por titular: solo lecturas de documento (certificado, curso, miembro)
  const consultas = [];
  const original = db.collection.bind(db);
  db.collection = nombre => {
    const c = original(nombre);
    const where = c.where.bind(c);
    c.where = (...a) => { consultas.push(nombre); return where(...a); };
    return c;
  };
  try { assert.equal((await request(app).get('/api/certificados/ZOO-2026-10002')).status, 200); } finally { db.collection = original; }
  assert.deepEqual(consultas, []);
});

test('duplicados: GET progreso firma también los duplicados aceptables y el canónico del progreso no cambia', async () => {
  const { app, db } = servidor({ seed: {
    'certificados/ZOO-2026-10001': delNavegador({ folio: 'ZOO-2026-10001', issuedAt: '2026-02-01T00:00:00.000Z' }),
    'certificados/ZOO-2026-10002': delNavegador({ folio: 'ZOO-2026-10002', issuedAt: '2026-03-01T00:00:00.000Z' })
  } });
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.body.cursos.c1.certificadoFolio, 'ZOO-2026-10001', 'el más antiguo es el canónico');
  for (const folio of ['ZOO-2026-10001', 'ZOO-2026-10002']) {
    assert.equal(cert.certificadoValido(db.value('certificados/' + folio), LLAVE), true, folio);
  }
  assert.equal(db.value('miembros/ana/progresoCursos/c1').certificadoFolio, 'ZOO-2026-10001');
  // ahora los dos están firmados y el canónico sigue siendo el guardado
  const otra = await get(app, '/api/cursos/progreso');
  assert.equal(otra.body.cursos.c1.certificadoFolio, 'ZOO-2026-10001');
  // completar un curso con duplicados reutiliza el canónico y no bloquea
  const fin = await progreso(app, 'c1', 2);
  assert.equal(fin.status, 200);
  assert.equal(fin.body.certificado.folio, 'ZOO-2026-10001');
  assert.equal(claves(db, 'certificados/').length, 2);
});

// ── Firma automática en GET /api/cursos/progreso ──

test('firma automática: GET progreso firma el certificado anterior en su lugar (mismo folio, campos viejos intactos) y es idempotente', async () => {
  const { app, db } = servidor({ seed: seedNavegador() });
  const original = delNavegador();
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.status, 200);
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${FOLIO}`], 'no se creó otro documento');

  const doc = db.value(`certificados/${FOLIO}`);
  for (const [k, v] of Object.entries(original)) assert.deepEqual(doc[k], v, `campo viejo ${k}`);
  assert.deepEqual(
    {
      folio: doc.folio, uid: doc.uid, cursoId: doc.cursoId, nombre: doc.nombre, curso: doc.curso, area: doc.area, horas: doc.horas,
      sesiones: doc.sesiones, instructor: doc.instructor, emitido: doc.emitido, year: doc.year, verificado: doc.verificado,
      origen: doc.origen, validadoBackend: doc.validadoBackend, migradoAutomaticamente: doc.migradoAutomaticamente
    },
    {
      folio: FOLIO, uid: 'ana', cursoId: 'c1', nombre: 'Ana Pérez', curso: 'Biología de tiburones', area: 'Fauna silvestre', horas: 6,
      sesiones: 3, instructor: 'Equipo Zoorigen', emitido: '2026-03-04T15:00:00.000Z', year: 2026, verificado: true,
      origen: 'legacy-validado', validadoBackend: true, migradoAutomaticamente: true
    }
  );
  assert.ok(doc.validadoEn);
  assert.equal(cert.certificadoValido(doc, LLAVE), true, 'la firma valida con la llave del servidor');

  // la verificación pública ahora lo reconoce como firmado (sin la marca anterior)
  const publica = await request(app).get(`/api/certificados/${FOLIO}`);
  assert.equal(publica.status, 200);
  assert.equal(publica.body.anterior, undefined);
  assert.equal(publica.body.certificado.nombre, 'Ana Pérez');

  // idempotente: otra consulta no escribe nada
  await pausa();
  const antes = foto(db);
  const otra = await get(app, '/api/cursos/progreso');
  assert.deepEqual(otra.body, r.body);
  assert.equal(foto(db), antes);
});

test('firma automática: también firma el emitido por el administrador con los otros nombres, solo el del titular', async () => {
  const { app, db } = servidor({ seed: { ...seedNavegador(), 'certificados/ZOO-2026-77001': delAdmin() } });
  const r = await get(app, '/api/cursos/progreso', 'token-beto');
  assert.equal(r.status, 200);
  const beto = db.value('certificados/ZOO-2026-77001');
  assert.equal(cert.certificadoValido(beto, LLAVE), true);
  assert.equal(beto.nombre, 'Beto Ruiz');
  assert.equal(db.value(`certificados/${FOLIO}`).firmaBackend, undefined, 'el de Ana no se toca desde la sesión de Beto');
  assert.equal(r.body.cursos.c2.completado, true);
  assert.equal(r.body.cursos.c1, undefined);
});

test('firma automática: sin CERTIFICATE_SIGNING_KEY no firma, pero el progreso responde bien y el curso aparece completado', async () => {
  const { app, db } = servidor({ sinLlave: true, seed: seedNavegador() });
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.status, 200);
  assert.equal(r.body.cursos.c1.completado, true);
  assert.equal(r.body.cursos.c1.certificadoFolio, FOLIO);
  assert.equal(db.value(`certificados/${FOLIO}`).firmaBackend, undefined);
});

test('firma automática: un error al revisar los certificados no rompe el progreso', async () => {
  const { app, db } = servidor({ seed: { ...seedNavegador(), 'miembros/ana/progresoCursos/c2': { cursoId: 'c2', uid: 'ana', sesionesVistas: [0], quizzesAprobados: [], completado: false } } });
  const original = db.collection.bind(db);
  db.collection = nombre => {
    if (nombre === 'certificados') throw new Error('Firestore caído (simulado)');
    return original(nombre);
  };
  const advertencias = [];
  const warn = console.warn;
  console.warn = (...a) => advertencias.push(a.join(' '));
  try {
    const r = await get(app, '/api/cursos/progreso');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cursos.c2.sesionesVistas, [0]);
    assert.equal(r.body.cursos.c1, undefined);
  } finally {
    console.warn = warn;
    db.collection = original;
  }
  assert.ok(advertencias.some(a => /certificados anteriores/.test(a)));
});

// ── Progreso coherente ──

test('progreso: el curso con certificado aparece completado aunque no se haya importado el progreso viejo ni exista la variable', async () => {
  const { app, db } = servidor({ seed: {
    ...seedNavegador(),
    'certificados/ZOO-2026-20202': delNavegador({ folio: 'ZOO-2026-20202', courseId: 'c3', courseTitle: 'Primeros auxilios', issuedAt: '2026-04-10T09:00:00.000Z', totalClases: 2 }),
    // courseProgress viejo presente, pero sin LEGACY_PROGRESS_IMPORT_BEFORE: no se importa
    'miembros/ana': miembroConPlan({ name: 'Ana Pérez', courseProgress: { c1: { completedLessons: [0] } } })
  } });
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.status, 200);
  assert.equal(r.body.legadoImportado, false);
  assert.deepEqual(r.body.cursos.c1, {
    sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: FOLIO, completadoEn: '2026-03-04T15:00:00.000Z'
  });
  assert.deepEqual(r.body.cursos.c3, {
    sesionesVistas: [0, 1], quizzesAprobados: [0], completado: true, certificadoFolio: 'ZOO-2026-20202', completadoEn: '2026-04-10T09:00:00.000Z'
  });
  const guardado = db.value('miembros/ana/progresoCursos/c1');
  assert.equal(guardado.origenLegado, true);
  assert.equal(guardado.completado, true);
  assert.equal(guardado.certificadoFolio, FOLIO);
  assert.deepEqual(guardado.sesionesVistas, [0, 1, 2]);
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, undefined);

  // idempotente: no vuelve a escribir y responde igual
  await pausa();
  const antes = foto(db);
  const otra = await get(app, '/api/cursos/progreso');
  assert.deepEqual(otra.body, r.body);
  assert.equal(foto(db), antes);
});

test('progreso: con documento previo sin completar, el certificado lo completa sin perder el avance ni los quizzes', async () => {
  const { app, db } = servidor({ seed: {
    ...seedNavegador(),
    'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0], quizzesAprobados: [], completado: false }
  } });
  const r = await get(app, '/api/cursos/progreso');
  assert.deepEqual(r.body.cursos.c1, {
    sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: FOLIO, completadoEn: '2026-03-04T15:00:00.000Z'
  });
  const guardado = db.value('miembros/ana/progresoCursos/c1');
  assert.equal(guardado.completado, true);
  assert.equal(guardado.certificadoFolio, FOLIO);
  assert.ok(guardado.completadoEn);
});

test('progreso: un certificado que no pasa la revisión no completa el curso', async () => {
  const { app, db } = servidor({ seed: seedNavegador({ memberName: '' }) });
  const r = await get(app, '/api/cursos/progreso');
  assert.deepEqual(r.body.cursos, {});
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), []);
  assert.equal(db.value(`certificados/${FOLIO}`).firmaBackend, undefined);
});

// ── Completar un curso que ya tiene certificado anterior ──

test('completar: con certificado anterior aceptable reutiliza su folio, lo firma en su lugar y no crea documento, aviso ni correo', conResend(async llamadas => {
  const { app, db } = servidor({ seed: {
    ...seedNavegador(),
    'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1], quizzesAprobados: [], completado: false }
  } });
  const r = await progreso(app, 'c1', 2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.completado, true);
  assert.deepEqual(r.body.certificado, {
    folio: FOLIO, nombre: 'Ana Pérez', curso: 'Biología de tiburones', area: 'Fauna silvestre', horas: 6, sesiones: 3,
    instructor: 'Equipo Zoorigen', emitido: '2026-03-04T15:00:00.000Z'
  });
  assert.equal(r.body.bono, undefined);
  await app.certificados.esperar();
  assert.equal(llamadas.length, 0, 'ningún correo');
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${FOLIO}`], 'ningún documento nuevo');
  assert.deepEqual(claves(db, 'avisos/ana/items/').filter(k => k.includes('cert_')), [], 'ningún aviso');
  assert.equal(cert.certificadoValido(db.value(`certificados/${FOLIO}`), LLAVE), true);
  assert.equal(db.value(`certificados/${FOLIO}`).memberName, 'Ana Pérez', 'campos viejos intactos');
  const prog = db.value('miembros/ana/progresoCursos/c1');
  assert.equal(prog.completado, true);
  assert.equal(prog.certificadoFolio, FOLIO);

  // repetir la última clase devuelve lo mismo
  const otra = await progreso(app, 'c1', 2);
  assert.deepEqual(otra.body.certificado, r.body.certificado);
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${FOLIO}`]);
}));

test('completar: aunque el progreso se haga desde cero, el curso termina con el folio anterior (nunca un folio nuevo)', async () => {
  const { app, db } = servidor({ seed: seedNavegador() });
  let r;
  for (let i = 0; i <= 2; i++) {
    r = await progreso(app, 'c1', i);
    assert.equal(r.status, 200, `clase ${i}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(r.body.certificado.folio, FOLIO);
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${FOLIO}`]);
});

test('completar: certificado anterior con firma alterada -> 404 público, 409 al completar y la última clase no se guarda', async () => {
  const { app, db } = servidor({ seed: {
    ...seedNavegador({ firmaBackend: 'a'.repeat(64) }),
    'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1], quizzesAprobados: [], completado: false }
  } });
  assert.equal((await request(app).get(`/api/certificados/${FOLIO}`)).status, 404);
  const antes = db.value(`certificados/${FOLIO}`);
  const fin = await progreso(app, 'c1', 2);
  assert.equal(fin.status, 409);
  assert.match(fin.body.error, /requiere auditoría/);
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${FOLIO}`]);
  assert.deepEqual(db.value(`certificados/${FOLIO}`), antes, 'no se toca el documento');
  assert.deepEqual(db.value('miembros/ana/progresoCursos/c1').sesionesVistas, [0, 1]);
  // y el progreso tampoco lo da por completado
  const prog = await get(app, '/api/cursos/progreso');
  assert.equal(prog.body.cursos.c1.completado, false);
});

test('completar: un anterior no aceptable (sin nombre) también responde 409 y no emite un folio paralelo', async () => {
  const { app, db } = servidor({ seed: {
    ...seedNavegador({ memberName: '' }),
    'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1], quizzesAprobados: [], completado: false }
  } });
  const fin = await progreso(app, 'c1', 2);
  assert.equal(fin.status, 409);
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${FOLIO}`]);
});

test('completar: un curso sin certificado anterior sigue emitiendo su certificado nuevo como siempre', async () => {
  const { app, db } = servidor({ seed: seedNavegador() }); // el anterior es de c1; se completa c2
  let r;
  for (let i = 0; i <= 1; i++) r = await progreso(app, 'c2', i);
  assert.equal(r.status, 200);
  assert.match(r.body.certificado.folio, /^ZOO-[0-9]{4}-[0-9A-F]{8}$/);
  assert.equal(claves(db, 'certificados/').length, 2);
});

// ── Límite de fecha: CERTIFICADOS_ANTERIORES_HASTA ──

test('límite: un anterior emitido después de CERTIFICADOS_ANTERIORES_HASTA no se acepta, ni se firma, ni completa el curso', async () => {
  const env = { CERTIFICADOS_ANTERIORES_HASTA: '2026-03-01T00:00:00Z' };
  const { app, db } = servidor({ env, seed: {
    ...seedNavegador(), // emitido el 4 de marzo: después del límite
    'certificados/ZOO-2026-30303': delNavegador({ folio: 'ZOO-2026-30303', courseId: 'c2', courseTitle: 'Etología aplicada', issuedAt: '2026-02-15T10:00:00.000Z', totalClases: 2 })
  } });
  assert.equal((await request(app).get(`/api/certificados/${FOLIO}`)).status, 404);
  assert.equal((await request(app).get('/api/certificados/ZOO-2026-30303')).status, 200, 'el anterior al límite sí');
  const r = await get(app, '/api/cursos/progreso');
  assert.equal(r.body.cursos.c1, undefined);
  assert.equal(r.body.cursos.c2.completado, true);
  assert.equal(db.value(`certificados/${FOLIO}`).firmaBackend, undefined, 'el posterior al límite no se firma');
  assert.equal(cert.certificadoValido(db.value('certificados/ZOO-2026-30303'), LLAVE), true);
});

test('límite: la fecha de corte es inclusiva y una variable inválida no acepta ningún anterior', async () => {
  const exacto = servidor({ env: { CERTIFICADOS_ANTERIORES_HASTA: '2026-03-04T15:00:00.000Z' }, seed: seedNavegador() });
  assert.equal((await request(exacto.app).get(`/api/certificados/${FOLIO}`)).status, 200);
  const invalido = servidor({ env: { CERTIFICADOS_ANTERIORES_HASTA: 'no-es-fecha' }, seed: seedNavegador() });
  const aviso = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await request(invalido.app).get(`/api/certificados/${FOLIO}`)).status, 404);
  } finally { console.warn = aviso; }
});

test('límite: los certificados firmados por el servidor no dependen de CERTIFICADOS_ANTERIORES_HASTA', async () => {
  const { app } = servidor({ env: { CERTIFICADOS_ANTERIORES_HASTA: '2000-01-01T00:00:00Z' } });
  let r;
  for (let i = 0; i <= 2; i++) r = await progreso(app, 'c1', i);
  assert.equal(r.status, 200);
  assert.equal((await request(app).get(`/api/certificados/${r.body.certificado.folio}`)).status, 200);
});

// ── Administrador: GET /api/admin/certificados/pendientes ──

test('pendientes: 401 sin sesión y 403 a quien no es administrador', async () => {
  const { app } = servidor({ seed: seedNavegador() });
  assert.equal((await request(app).get('/api/admin/certificados/pendientes')).status, 401);
  for (const t of ['token-ana', 'token-sinplan']) {
    const r = await get(app, '/api/admin/certificados/pendientes', t);
    assert.equal(r.status, 403, t);
  }
});

test('pendientes: lista los certificados sin firma con su diagnóstico y un resumen, sin modificar nada', async () => {
  const firmado = cert.construirCertificado({
    uid: 'beto', cursoId: 'c1', curso: cursosBase()['cursos/c1'], nombre: 'Beto Ruiz', emitido: new Date('2026-05-05T10:00:00Z'), llave: LLAVE
  });
  const { app, db } = servidor({ seed: {
    [`certificados/${firmado.folio}`]: firmado,
    [`certificados/${FOLIO}`]: delNavegador(),
    'certificados/ZOO-2026-40001': delNavegador({ folio: 'ZOO-2026-40001', courseId: 'borrado', memberUid: 'beto' }),
    'certificados/ZOO-2026-40002': delNavegador({ folio: 'ZOO-2026-40002', memberUid: 'fantasma' }),
    'certificados/ZOO-2026-40003': delNavegador({ folio: 'ZOO-2026-99999', memberUid: 'beto', courseId: 'c3' }),
    'certificados/ZOO-2026-40004': delNavegador({ folio: 'ZOO-2026-40004', memberUid: 'beto', courseId: 'c2', issuedAt: '2026-04-01T00:00:00.000Z' }),
    'certificados/ZOO-2026-40005': delNavegador({ folio: 'ZOO-2026-40005', memberUid: 'beto', courseId: 'c2', issuedAt: '2026-04-02T00:00:00.000Z' })
  } });
  const antes = foto(db);
  const r = await get(app, '/api/admin/certificados/pendientes', 'token-admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(foto(db), antes, 'solo lectura');
  assert.equal(r.body.modoTransicion, true);
  assert.equal(r.body.truncado, false);
  assert.deepEqual(
    { total: r.body.resumen.total, firmados: r.body.resumen.firmados, aceptables: r.body.resumen.aceptables, noAceptables: r.body.resumen.noAceptables },
    { total: 7, firmados: 1, aceptables: 3, noAceptables: 3 }
  );
  assert.equal(r.body.resumen.duplicados, 1);
  assert.deepEqual(r.body.resumen.porRazon, {
    'curso-no-encontrado': 1, 'miembro-no-encontrado': 1, 'folio-inconsistente': 1
  });
  const por = Object.fromEntries(r.body.certificados.map(c => [c.folio, c]));
  assert.equal(por[firmado.folio], undefined, 'los firmados no se listan como pendientes');
  assert.equal(por[FOLIO].aceptable, true);
  assert.deepEqual(por[FOLIO].razones, []);
  assert.deepEqual(por['ZOO-2026-40001'].razones, ['curso-no-encontrado']);
  assert.deepEqual(por['ZOO-2026-40002'].razones, ['miembro-no-encontrado']);
  assert.ok(por['ZOO-2026-40003'].razones.includes('folio-inconsistente'));
  assert.equal(por['ZOO-2026-40004'].aceptable, true);
  assert.deepEqual(por['ZOO-2026-40005'].razones, []);
  assert.equal(por['ZOO-2026-40005'].aceptable, true, 'un duplicado es aceptable');
  assert.deepEqual(por['ZOO-2026-40005'].notas, ['duplicado-de:ZOO-2026-40004']);
  assert.deepEqual(por['ZOO-2026-40004'].notas, []);
  assert.doesNotMatch(JSON.stringify(r.body), /ana@example|firmaBackend|memberEmail/);
});

test('pendientes: informa la fecha límite configurada y responde 503 sin la llave de firma', async () => {
  const con = servidor({ env: { CERTIFICADOS_ANTERIORES_HASTA: '2026-03-01T00:00:00Z' }, seed: seedNavegador() });
  const r = await get(con.app, '/api/admin/certificados/pendientes', 'token-admin');
  assert.equal(r.body.modoTransicion, false);
  assert.equal(r.body.limiteAnteriores, '2026-03-01T00:00:00Z');
  assert.ok(r.body.certificados[0].razones.includes('posterior-al-limite'));
  const sin = servidor({ sinLlave: true });
  assert.equal((await get(sin.app, '/api/admin/certificados/pendientes', 'token-admin')).status, 503);
});
