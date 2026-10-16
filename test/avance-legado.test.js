'use strict';

// Auditoría del avance anterior de los miembros (miembros/{uid}.courseProgress, escrito por el sitio VIEJO desde el
// navegador) frente a la importación única del servidor, con datos en el formato REAL del sitio viejo:
//   courseProgress[cursoId] = { completedLessons: [índice de clase, ...], isCompleted, completedAt, certificateFolio }
//   (cursoId = id del documento de `cursos`; el índice es la posición de la clase en `lecciones`)
//   certificados/{folio} = { folio, courseId, courseTitle, courseArea, courseDuration, memberUid, memberName,
//                            memberEmail, issuedAt, totalClases }   (sin firma)
// Demuestra: (a) lo que se importa coincide con lo que la persona tenía, (b) nunca se pierde avance (el resultado es
// una unión), (c) la importación es idempotente, (d) los certificados anteriores siguen verificándose en modo
// transición y (e) el ensayo del panel (GET /api/admin/progreso-legado) predice la importación sin escribir nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, uuid
} = require('./helpers/club');
const cert = require('../services/certificados');

const LLAVE = 'llave-de-prueba-para-certificados-0123456789';
const CORTE = '2026-10-16T00:00:00Z';
const ENV = { CERTIFICATE_SIGNING_KEY: LLAVE, LEGACY_PROGRESS_IMPORT_BEFORE: CORTE };
const ANTIGUA = '2026-03-01T12:00:00Z';
const POSTERIOR = '2026-10-20T08:00:00Z';

// Cursos como los dejó el sitio viejo: ids automáticos de Firestore, el de la sincronización de Bunny y uno de una sola
// clase con driveId (sin `lecciones`).
const TIBURONES = 'Xk3FtQ9aLm2VbN7cRd4Z';
const AVES = 'bunny-aves-rapaces';
const UNICA = 'Pq8WzY1nHs6JtU0eGa5B';
const CON_QUIZ = 'Qw4RtYu8iOpAsDf1GhJk';
const leccion = (n, extra = {}) => ({ titulo: `Clase ${n}`, videoId: uuid(n), provider: 'bunny', ...extra });
const cursosBase = () => ({
  [`cursos/${TIBURONES}`]: { title: 'Biología de tiburones y rayas', area: 'Fauna silvestre', duration: '6 horas', lecciones: [1, 2, 3, 4, 5].map(n => leccion(100 + n)) },
  [`cursos/${AVES}`]: { title: 'Aves rapaces', area: 'Fauna silvestre', duration: '3 horas', lecciones: [1, 2, 3].map(n => leccion(200 + n)) },
  [`cursos/${UNICA}`]: { title: 'Manejo de reptiles', area: 'Manejo', duration: '1 hora', driveId: 'DRIVE1234567890abcdef' },
  [`cursos/${CON_QUIZ}`]: {
    title: 'Primeros auxilios', area: 'Veterinaria', duration: '4 horas',
    lecciones: [
      leccion(301),
      leccion(302, { preguntas: [{ pregunta: '¿Los reptiles son de sangre fría?', tipo: 'vof', correcta: 0 }] }),
      leccion(303),
      leccion(304)
    ]
  }
});

// Certificado tal como lo escribía generarCertificado() del sitio viejo
const certificadoViejo = (folio, uid, cursoId, titulo, extra = {}) => ({
  folio, courseId: cursoId, courseTitle: titulo, courseArea: 'Fauna silvestre', courseDuration: '3 horas',
  memberUid: uid, memberName: 'Ana Pérez', memberEmail: `${uid}@example.com`,
  issuedAt: '2026-04-02T15:30:00.000Z', totalClases: 3, ...extra
});

const tokens = tokensDe('ana', 'beto', 'carla', 'dani', 'eli', 'fer', 'gus', 'admin', 'miembro');

function servidor({ seed = {}, env = ENV, usuariosAuth, conCursos = true } = {}) {
  const antiguas = {};
  for (const uid of ['ana', 'beto', 'carla', 'dani', 'eli', 'fer', 'gus']) antiguas[uid] = { creationTime: ANTIGUA };
  return cargarServidor({
    tokens, env, usuariosAuth: usuariosAuth || antiguas,
    seed: {
      ...(conCursos ? cursosBase() : {}),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Administración' }),
      'miembros/miembro': miembroConPlan({ name: 'Mónica Miembro' }),
      ...seed
    }
  });
}

const get = (app, ruta, t = 'token-ana') => request(app).get(ruta).set(auth(t));
const post = (app, ruta, cuerpo, t = 'token-ana') => request(app).post(ruta).set(auth(t)).send(cuerpo);
const progresoApi = (app, t = 'token-ana') => get(app, '/api/cursos/progreso', t);
const clone = v => JSON.parse(JSON.stringify(v));
const rutaProgreso = (uid, cursoId) => `miembros/${uid}/progresoCursos/${cursoId}`;
const claves = (db, prefijo) => [...db._data.keys()].filter(k => k.startsWith(prefijo)).sort();
const vistas = (db, uid, cursoId) => (db.value(rutaProgreso(uid, cursoId)) || {}).sesionesVistas;
const miembro = (extra = {}) => miembroConPlan({ name: 'Ana Pérez', email: 'ana@example.com', ...extra });

// ════════════════════════════════════════════════════════════
// (a) Lo que se importa coincide con lo que la persona tenía
// ════════════════════════════════════════════════════════════

test('avance parcial: se importan exactamente las clases que tenía y el campo viejo queda intacto', async () => {
  const viejo = {
    [TIBURONES]: { completedLessons: [0, 1, 2], isCompleted: false },
    [AVES]: { completedLessons: [0], isCompleted: false }
  };
  const copia = clone(viejo);
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: viejo }) } });
  const r = await progresoApi(app);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cursos[TIBURONES], { sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: false, certificadoFolio: null, completadoEn: null });
  assert.deepEqual(r.body.cursos[AVES].sesionesVistas, [0]);
  assert.equal(r.body.legadoImportado, true);
  assert.deepEqual(db.value('miembros/ana').courseProgress, copia, 'courseProgress no se toca');
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, true);
  assert.deepEqual(claves(db, 'certificados/'), [], 'importar nunca emite certificados');
});

test('curso completo con certificado ya emitido por el sitio viejo: queda completado con el MISMO folio, sin certificado nuevo', async () => {
  const folio = 'ZOO-2026-48213';
  const { app, db } = servidor({
    seed: {
      'miembros/ana': miembro({
        courseProgress: { [AVES]: { completedLessons: [0, 1, 2], isCompleted: true, completedAt: '2026-04-02T15:30:00.000Z', certificateFolio: folio } }
      }),
      [`certificados/${folio}`]: certificadoViejo(folio, 'ana', AVES, 'Aves rapaces')
    }
  });
  const r = await progresoApi(app);
  assert.deepEqual(r.body.cursos[AVES], {
    sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: folio, completadoEn: '2026-04-02T15:30:00.000Z'
  });
  assert.deepEqual(claves(db, 'certificados/'), [`certificados/${folio}`], 'no se crea otro certificado');
});

test('clases fuera de rango (el curso hoy tiene menos clases): se importan las que existen y el ensayo avisa de las demás', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [AVES]: { completedLessons: [0, 1, 7, 50, 499, -1], isCompleted: false } } }) } });
  const r = await progresoApi(app);
  assert.deepEqual(r.body.cursos[AVES].sesionesVistas, [0, 1]);
  assert.deepEqual(vistas(db, 'ana', AVES), [0, 1]);
});

test('curso eliminado: no se inventa nada, el resto del avance sí se importa', async () => {
  const { app, db } = servidor({
    seed: { 'miembros/ana': miembro({ courseProgress: { cursoQueYaNoExiste123: { completedLessons: [0, 1, 2, 3] }, [AVES]: { completedLessons: [0, 1] } } }) }
  });
  const r = await progresoApi(app);
  assert.equal(r.body.cursos.cursoQueYaNoExiste123, undefined);
  assert.deepEqual(r.body.cursos[AVES].sesionesVistas, [0, 1]);
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, true);
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), [rutaProgreso('ana', AVES)]);
});

test('clase con quiz ya vista en el sitio viejo: queda como vista y contestada, y se puede seguir con la siguiente sin repetir el quiz', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [CON_QUIZ]: { completedLessons: [0, 1] } } }) } });
  const r = await progresoApi(app);
  assert.deepEqual(r.body.cursos[CON_QUIZ].sesionesVistas, [0, 1]);
  assert.deepEqual(r.body.cursos[CON_QUIZ].quizzesAprobados, [1]);
  const siguiente = await post(app, `/api/cursos/${CON_QUIZ}/progreso`, { sessionIndex: 2 });
  assert.equal(siguiente.status, 200, JSON.stringify(siguiente.body));
  assert.deepEqual(vistas(db, 'ana', CON_QUIZ), [0, 1, 2]);
});

test('clases salteadas en el sitio viejo ([0, 2, 3]): no se pierde ninguna y la que faltó se puede completar después', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [3, 0, 2] } } }) } });
  await progresoApi(app);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 2, 3]);
  const falta = await post(app, `/api/cursos/${TIBURONES}/progreso`, { sessionIndex: 1 });
  assert.equal(falta.status, 200);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2, 3]);
});

test('identificadores repetidos y desordenados se limpian sin perder ninguno', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [2, 0, 0, 1, 2, 1, 1] } } }) } });
  await progresoApi(app);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2]);
});

test('objeto vacío o sin cursos: no hay nada que importar y no se escribe nada', async () => {
  for (const courseProgress of [{}, { [AVES]: { completedLessons: [], isCompleted: false } }, { [AVES]: null }]) {
    const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress }) } });
    const r = await progresoApi(app);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cursos, {});
    assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), []);
  }
});

test('valores mal formados (tipos erróneos): se ignoran sin romper nada y sin tocar lo bueno', async () => {
  const feo = {
    [TIBURONES]: { completedLessons: ['0', '1', 1.5, null, {}, [], true, NaN, Infinity, -3, 2, 99999] },
    [AVES]: 'texto',
    [UNICA]: { completedLessons: 'no es lista' },
    [CON_QUIZ]: { completedLessons: { 0: 1 } },
    '': { completedLessons: [0] },
    'id con espacios y ñ': { completedLessons: [0] },
    '../../etc': { completedLessons: [0] }
  };
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: feo }) } });
  const r = await progresoApi(app);
  assert.equal(r.status, 200);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [2], 'solo el entero 2 es una clase válida');
  assert.deepEqual(Object.keys(r.body.cursos), [TIBURONES]);
  for (const mala of ['texto', 5, [1, 2], true]) {
    const s = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: mala }) } });
    const rr = await progresoApi(s.app);
    assert.equal(rr.status, 200);
    assert.deepEqual(rr.body.cursos, {});
  }
});

test('miles de claves basura no desplazan a los cursos reales (el tope se aplica después de descartar las inválidas)', async () => {
  const courseProgress = {};
  for (let i = 0; i < 3000; i++) courseProgress[`basura ${i}!`] = { completedLessons: [0] };
  for (let i = 0; i < 150; i++) courseProgress[`cursoFantasma${i}`] = { completedLessons: [0] };
  courseProgress[AVES] = { completedLessons: [0, 1] };
  courseProgress[TIBURONES] = { completedLessons: Array.from({ length: 6000 }, (_, i) => i) };
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress }) } });
  const r = await progresoApi(app);
  assert.equal(r.status, 200);
  assert.deepEqual(vistas(db, 'ana', AVES), [0, 1]);
  // 6000 índices: solo valen los 5 que existen, y como no hay certificado queda pendiente la última
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2, 3]);
});

test('curso de una sola clase (driveId, sin lecciones) terminado sin certificado: queda pendiente y al completarla el servidor emite el certificado', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [UNICA]: { completedLessons: [0], isCompleted: false } } }) } });
  const r = await progresoApi(app);
  assert.equal(r.status, 200);
  assert.equal(r.body.cursos[UNICA], undefined, 'nada que mostrar todavía');
  const fin = await post(app, `/api/cursos/${UNICA}/progreso`, { sessionIndex: 0 }, 'token-ana');
  // la clase gratis/membresía la decide el acceso: ana tiene plan
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.completado, true);
  assert.match(fin.body.certificado.folio, /^ZOO-[0-9]{4}-[0-9A-F]{8}$/);
  assert.equal(claves(db, 'certificados/').length, 1);
});

test('el curso ganó clases después de que la persona se certificó: sigue completado gracias a su certificado anterior', async () => {
  const folio = 'ZOO-2026-77001';
  const { app } = servidor({
    seed: {
      'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2], isCompleted: true, certificateFolio: folio, completedAt: '2026-03-20T10:00:00.000Z' } } }),
      [`certificados/${folio}`]: certificadoViejo(folio, 'ana', TIBURONES, 'Biología de tiburones y rayas', { issuedAt: '2026-03-20T10:00:00.000Z', totalClases: 3 })
    }
  });
  const r = await progresoApi(app);
  assert.equal(r.body.cursos[TIBURONES].completado, true);
  assert.equal(r.body.cursos[TIBURONES].certificadoFolio, folio);
});

// ════════════════════════════════════════════════════════════
// (b) Nunca se pierde avance: el resultado es una unión
// ════════════════════════════════════════════════════════════

test('unión: el avance que el servidor ya tenía no se reduce y el viejo se suma', async () => {
  const { app, db } = servidor({
    seed: {
      'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1] }, [AVES]: { completedLessons: [0] } } }),
      [rutaProgreso('ana', TIBURONES)]: { cursoId: TIBURONES, uid: 'ana', sesionesVistas: [0, 1, 2, 3], quizzesAprobados: [], completado: false },
      [rutaProgreso('ana', AVES)]: { cursoId: AVES, uid: 'ana', sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-NUEVO001' }
    }
  });
  await progresoApi(app);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2, 3]);
  assert.deepEqual(vistas(db, 'ana', AVES), [0, 1, 2]);
  assert.equal(db.value(rutaProgreso('ana', AVES)).completado, true);
  assert.equal(db.value(rutaProgreso('ana', AVES)).certificadoFolio, 'ZOO-2026-NUEVO001');
});

test('propiedad (500 casos al azar): unirProgreso nunca da menos que lo previo ni que lo importado, y repetirla no cambia nada', () => {
  let semilla = 20261016;
  const azar = () => { semilla = (semilla * 1664525 + 1013904223) % 4294967296; return semilla / 4294967296; };
  const entero = (max) => Math.floor(azar() * max);
  const lista = () => Array.from({ length: entero(8) }, () => entero(10));
  const cursos = new Map([
    ['c1', { lecciones: Array.from({ length: 5 }, (_, i) => leccion(i)) }],
    ['c2', { lecciones: Array.from({ length: 3 }, (_, i) => leccion(10 + i)) }],
    ['c3', { driveId: 'abc' }]
  ]);
  for (let caso = 0; caso < 500; caso++) {
    const viejo = {};
    for (const id of ['c1', 'c2', 'c3', 'fantasma']) {
      if (azar() < 0.7) viejo[id] = { completedLessons: lista(), isCompleted: azar() < 0.3 };
    }
    const certificados = azar() < 0.4 ? [{ id: 'ZOO-2026-ABCDE', memberUid: 'u', courseId: 'c1' }, { id: 'ZOO-2026-FGHIJ', memberUid: 'u', courseId: 'c2' }] : [];
    const plan = cert.planearImportacionLegado({ uid: 'u', courseProgress: viejo, cursos, certificados, llave: LLAVE });
    const diag = cert.diagnosticarLegado({
      uid: 'u', miembro: { courseProgress: viejo }, creacion: ANTIGUA, corte: cert.corteLegado(CORTE), cursos, certificados, llave: LLAVE
    });
    assert.equal(diag.clasesImportables, plan.importadas, 'el ensayo coincide con la importación real');
    for (const item of plan.items) {
      const previoCrudo = azar() < 0.6 ? { sesionesVistas: lista().filter(n => n < 5), quizzesAprobados: lista().filter(n => n < 5), completado: azar() < 0.2, certificadoFolio: 'ZOO-2026-PREVIO1' } : null;
      const previo = cert.normalizarProgreso(previoCrudo);
      const una = cert.unirProgreso(previoCrudo, item.doc);
      for (const n of previo.sesionesVistas) assert.ok(una.sesionesVistas.includes(n));
      for (const n of item.doc.sesionesVistas) assert.ok(una.sesionesVistas.includes(n));
      for (const n of previo.quizzesAprobados) assert.ok(una.quizzesAprobados.includes(n));
      if (previo.completado) assert.equal(una.completado, true);
      if (item.doc.completado) assert.equal(una.completado, true);
      // idempotente
      const dos = cert.unirProgreso(una, item.doc);
      assert.deepEqual(dos, una);
      // lo importado coincide con lo que tenía: solo clases que él tenía y que existen
      const tenia = cert.clasesViejasDe(viejo[item.cursoId]);
      for (const n of item.doc.sesionesVistas) assert.ok(tenia.includes(n));
    }
  }
});

// ════════════════════════════════════════════════════════════
// (c) Idempotencia, interrupciones y concurrencia
// ════════════════════════════════════════════════════════════

test('idempotente: consultar muchas veces deja exactamente el mismo estado; una sola importación', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2] }, [CON_QUIZ]: { completedLessons: [0, 1] } } }) } });
  await progresoApi(app);
  const foto = () => JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('miembros/ana')).map(([k, v]) => [k, { ...v, actualizadoEn: undefined, progresoLegadoImportadoEn: undefined }]));
  const primera = foto();
  for (let i = 0; i < 3; i++) await progresoApi(app);
  assert.equal(foto(), primera);
});

test('importación interrumpida (la base falla a mitad) y reintento: no queda nada a medias y la siguiente consulta la completa', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2] }, [AVES]: { completedLessons: [0, 1] } } }) } });
  const original = db.runTransaction.bind(db);
  let fallos = 1;
  db.runTransaction = async fn => {
    if (fallos > 0) {
      fallos -= 1;
      // la función se ejecuta (lee) pero se corta antes de confirmar: ninguna escritura se aplica
      await original(async tx => { await fn(tx); throw new Error('conexión interrumpida'); });
    }
    return original(fn);
  };
  const silencio = console.error; console.error = () => {};
  let primera;
  try { primera = await progresoApi(app); } finally { console.error = silencio; }
  assert.equal(primera.status, 200, 'la consulta del miembro no se rompe');
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, undefined, 'sin marca de importado');
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), [], 'nada escrito a medias');
  const segunda = await progresoApi(app);
  assert.equal(segunda.body.legadoImportado, true);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2]);
  assert.deepEqual(vistas(db, 'ana', AVES), [0, 1]);
});

test('concurrencia: varias consultas simultáneas importan una sola vez y el resultado es el correcto', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2, 3] }, [CON_QUIZ]: { completedLessons: [0, 1] } } }) } });
  db.lenta = true; // cada lectura toma su foto y tarda un turno: todas leen el estado viejo, como en producción
  const respuestas = await Promise.all([progresoApi(app), progresoApi(app), progresoApi(app), progresoApi(app)]);
  for (const r of respuestas) assert.equal(r.status, 200);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2, 3]);
  assert.deepEqual(vistas(db, 'ana', CON_QUIZ), [0, 1]);
  assert.equal(db.value('miembros/ana').progresoLegadoImportado, true);
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), [rutaProgreso('ana', CON_QUIZ), rutaProgreso('ana', TIBURONES)]);
  db.lenta = false;
  const despues = await progresoApi(app);
  assert.deepEqual(despues.body.cursos[TIBURONES].sesionesVistas, [0, 1, 2, 3]);
});

test('concurrencia: completar una clase justo mientras se importa no pierde ni lo viejo ni lo nuevo', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1] } } }) } });
  db.lenta = true;
  const [a, b] = await Promise.all([progresoApi(app), post(app, `/api/cursos/${TIBURONES}/progreso`, { sessionIndex: 2 })]);
  db.lenta = false;
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2]);
});

test('completar una clase SIN haber pedido antes el progreso: igual se trae primero el avance anterior (no se pide repetir clases)', async () => {
  const { app, db } = servidor({ seed: { 'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2] } } }) } });
  const r = await post(app, `/api/cursos/${TIBURONES}/progreso`, { sessionIndex: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2, 3]);
});

// ════════════════════════════════════════════════════════════
// Elegibilidad por fecha de la cuenta
// ════════════════════════════════════════════════════════════

test('cuenta creada DESPUÉS del corte (aunque traiga courseProgress): no se importa sola, el dato viejo queda y el ensayo lo marca', async () => {
  const s = servidor({
    usuariosAuth: { ana: { creationTime: POSTERIOR }, admin: { creationTime: ANTIGUA } },
    seed: { 'miembros/ana': miembro({ courseProgress: { [AVES]: { completedLessons: [0, 1] } } }) }
  });
  const r = await progresoApi(s.app);
  assert.deepEqual(r.body, { cursos: {}, legadoImportado: false });
  assert.equal(s.db.value('miembros/ana').progresoLegadoImportado, undefined);
  assert.ok(s.db.value('miembros/ana').courseProgress);
  const ensayo = await get(s.app, '/api/admin/progreso-legado', 'token-admin');
  const fila = ensayo.body.miembros.find(m => m.uid === 'ana');
  assert.equal(fila.veredicto, 'no-elegible');
  assert.equal(fila.motivoNoElegible, 'cuenta-posterior');
  assert.equal(fila.clasesViejas, 2);
  assert.equal(fila.clasesImportables, 2, 'el ensayo dice qué se importaría si el administrador lo decide');
});

// ════════════════════════════════════════════════════════════
// (d) Certificados anteriores en modo transición
// ════════════════════════════════════════════════════════════

test('certificados anteriores (sin firma): se verifican en público y se firman en su lugar al abrir el progreso', async () => {
  const folio = 'ZOO-2026-48213';
  const { app, db } = servidor({
    seed: {
      'miembros/ana': miembro({ courseProgress: { [AVES]: { completedLessons: [0, 1, 2], isCompleted: true, certificateFolio: folio, completedAt: '2026-04-02T15:30:00.000Z' } } }),
      [`certificados/${folio}`]: certificadoViejo(folio, 'ana', AVES, 'Aves rapaces')
    }
  });
  const publico = await request(app).get(`/api/certificados/${folio}`);
  assert.equal(publico.status, 200, JSON.stringify(publico.body));
  assert.equal(publico.body.certificado.folio, folio);
  assert.equal(publico.body.certificado.curso, 'Aves rapaces');
  assert.equal(publico.body.anterior, true);
  assert.equal(JSON.stringify(publico.body).includes('ana@example.com'), false, 'sin datos privados');
  await progresoApi(app);
  const firmado = db.value(`certificados/${folio}`);
  assert.equal(firmado.origen, 'legacy-validado');
  assert.ok(cert.certificadoValido(firmado, LLAVE), 'queda firmado en su lugar, mismo folio');
  assert.equal(firmado.courseTitle, 'Aves rapaces', 'los campos viejos no se borran');
  const otra = await request(app).get(`/api/certificados/${folio}`);
  assert.equal(otra.status, 200);
});

test('certificados anteriores: con CERTIFICADOS_ANTERIORES_HASTA anterior a su emisión dejan de aceptarse (el modo transición lo decide el dueño)', async () => {
  const folio = 'ZOO-2026-48213';
  const { app } = servidor({
    env: { ...ENV, CERTIFICADOS_ANTERIORES_HASTA: '2026-01-01T00:00:00Z' },
    seed: { [`certificados/${folio}`]: certificadoViejo(folio, 'ana', AVES, 'Aves rapaces'), 'miembros/ana': miembro() }
  });
  const publico = await request(app).get(`/api/certificados/${folio}`);
  assert.equal(publico.status, 404);
});

// ════════════════════════════════════════════════════════════
// Ningún código borra ni modifica courseProgress
// ════════════════════════════════════════════════════════════

test('ningún archivo del servidor escribe, borra ni reemplaza courseProgress (solo se lee)', () => {
  const raiz = path.join(__dirname, '..');
  const archivos = [path.join(raiz, 'server.js'), ...fs.readdirSync(path.join(raiz, 'services')).map(f => path.join(raiz, 'services', f)),
    ...fs.readdirSync(path.join(raiz, 'scripts')).map(f => path.join(raiz, 'scripts', f)),
    ...['audit-memberships.js', 'normalize-membership-dates.js', 'sync-memberships.js'].map(f => path.join(raiz, f))]
    .filter(f => f.endsWith('.js') && fs.existsSync(f));
  const lineas = [];
  for (const f of archivos) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((linea, i) => {
      if (!linea.includes('courseProgress')) return;
      const t = linea.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      lineas.push(`${path.relative(raiz, f)}:${i + 1}: ${t}`);
    });
  }
  // Solo se permite LEER (miembro.courseProgress) o pasarlo a las funciones puras; nada de propiedades escritas ni borrados
  assert.ok(lineas.length > 0, 'se esperaban lecturas de courseProgress');
  for (const l of lineas) {
    const codigo = l.replace(/^.*?:\d+:\s*/, '');
    assert.ok(!/FieldValue\.delete|\.set\(|\.update\(|\.delete\(/.test(codigo), `courseProgress junto a una escritura: ${l}`);
    const sinPermitidos = codigo.replace(/courseProgress: viejo/g, '').replace(/\.courseProgress\b/g, '');
    assert.ok(!/courseProgress['"]?\s*:/.test(sinPermitidos), `courseProgress como propiedad escrita: ${l}`);
  }
});

test('importar (automática, por reintento o con el administrador) deja courseProgress idéntico', async () => {
  const viejo = { [TIBURONES]: { completedLessons: [0, 1, 2], isCompleted: false }, [AVES]: { completedLessons: [0, 1, 2], isCompleted: true, certificateFolio: 'ZOO-2026-48213', completedAt: '2026-04-02T15:30:00.000Z' }, raro: 'x' };
  const copia = clone(viejo);
  const { app, db } = servidor({
    seed: { 'miembros/ana': miembro({ courseProgress: viejo }), 'certificados/ZOO-2026-48213': certificadoViejo('ZOO-2026-48213', 'ana', AVES, 'Aves rapaces') }
  });
  await progresoApi(app);
  assert.deepEqual(db.value('miembros/ana').courseProgress, copia);
  const r1 = await post(app, '/api/admin/progreso-legado/ana/importar', { reintentar: true }, 'token-admin');
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(db.value('miembros/ana').courseProgress, copia);
});

// ════════════════════════════════════════════════════════════
// Ensayo del panel: GET /api/admin/progreso-legado
// ════════════════════════════════════════════════════════════

// Siete miembros reales de ejemplo, cada uno con un caso distinto
function plantel() {
  const folio = 'ZOO-2026-48213';
  return {
    'miembros/ana': miembro({ courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2], isCompleted: false }, [AVES]: { completedLessons: [0] } } }),
    'miembros/beto': miembroConPlan({ name: 'Beto Ruiz', email: 'beto@example.com', planTipo: 'anual', courseProgress: { [AVES]: { completedLessons: [0, 1, 2], isCompleted: true, certificateFolio: folio, completedAt: '2026-04-02T15:30:00.000Z' } } }),
    [`certificados/${folio}`]: certificadoViejo(folio, 'beto', AVES, 'Aves rapaces'),
    'miembros/carla': miembroConPlan({ name: 'Carla Soto', email: 'carla@example.com', courseProgress: { [AVES]: { completedLessons: [0, 1, 9] }, borrado: { completedLessons: [0, 1] } } }),
    'miembros/dani': miembroConPlan({ name: 'Dani Luna', email: 'dani@example.com', courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2, 3, 4], isCompleted: true } } }),
    'miembros/eli': miembroConPlan({ name: 'Eli Vega', email: 'eli@example.com', courseProgress: {} }),
    'miembros/fer': miembroConPlan({ name: 'Fer Mora', email: 'fer@example.com', progresoLegadoImportado: true, courseProgress: { [AVES]: { completedLessons: [0, 1] } } }),
    'miembros/gus': miembroSinPlan({ name: 'Gus Rey', email: 'gus@example.com', courseProgress: 'cadena rara' }),
    [rutaProgreso('fer', AVES)]: { cursoId: AVES, uid: 'fer', sesionesVistas: [0, 1], quizzesAprobados: [], completado: false, origenLegado: true }
  };
}

test('ensayo: exige administrador (401 sin sesión, 403 a un miembro) y no devuelve ningún dato a quien no lo es', async () => {
  const { app } = servidor({ seed: plantel() });
  for (const [metodo, ruta] of [['get', '/api/admin/progreso-legado'], ['post', '/api/admin/progreso-legado/ana/importar']]) {
    const sin = await request(app)[metodo](ruta).send({});
    assert.equal(sin.status, 401, ruta);
    const miembroNormal = await request(app)[metodo](ruta).set(auth('token-miembro')).send({});
    assert.equal(miembroNormal.status, 403, ruta);
    assert.deepEqual(Object.keys(miembroNormal.body), ['error']);
  }
});

test('ensayo: no escribe NADA y da un veredicto claro por miembro (completo, parcial, ya importado, sin progreso)', async () => {
  const { app, db } = servidor({ seed: plantel() });
  const antes = JSON.stringify([...db._data.entries()]);
  const r = await get(app, '/api/admin/progreso-legado', 'token-admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.stringify([...db._data.entries()]), antes, 'el ensayo no escribió nada');
  assert.match(r.headers['cache-control'], /no-store/);

  const fila = uid => r.body.miembros.find(m => m.uid === uid);
  assert.equal(fila('ana').veredicto, 'completo');
  assert.equal(fila('ana').clasesViejas, 4);
  assert.equal(fila('ana').clasesImportables, 4);
  assert.equal(fila('ana').cursosConAvance, 2);

  assert.equal(fila('beto').veredicto, 'completo');
  assert.equal(fila('beto').cursosCompletadosViejos, 1);
  assert.deepEqual(fila('beto').certificados, { total: 1, firmados: 0, aceptables: 1, noAceptables: 0 });
  assert.equal(fila('beto').cursos[0].certificado, 'aceptable');

  assert.equal(fila('carla').veredicto, 'parcial');
  assert.equal(fila('carla').clasesViejas, 5);
  assert.equal(fila('carla').clasesImportables, 2);
  assert.equal(fila('carla').clasesPerdidas, 3);
  const estados = Object.fromEntries(fila('carla').cursos.map(c => [c.cursoId, c.estado]));
  assert.deepEqual(estados, { [AVES]: 'fuera-de-rango', borrado: 'curso-eliminado' });

  // curso terminado sin certificado: queda la última clase para que el servidor emita el certificado; no se considera pérdida
  assert.equal(fila('dani').veredicto, 'completo');
  assert.equal(fila('dani').clasesViejas, 5);
  assert.equal(fila('dani').clasesImportables, 4);
  assert.equal(fila('dani').clasesPerdidas, 0);
  assert.equal(fila('dani').listosParaCertificado, 1);
  assert.equal(fila('dani').cursos[0].estado, 'listo-para-certificado');

  assert.equal(fila('fer').veredicto, 'ya-importado');
  assert.equal(fila('fer').verificado, true);
  assert.equal(fila('eli'), undefined, 'un courseProgress vacío no es avance: no sale en la tabla');
  assert.equal(fila('gus').veredicto, 'sin-progreso-viejo');
  assert.equal(fila('gus').formatoInvalido, true);

  assert.equal(r.body.resumen.miembros, 9);
  assert.equal(r.body.resumen.conAvanceViejo, 5);
  assert.equal(r.body.resumen.completos, 3);
  assert.equal(r.body.resumen.parciales, 1);
  assert.equal(r.body.resumen.yaImportadosVerificados, 1);
  assert.equal(r.body.resumen.verificados, 4);
  assert.equal(r.body.resumen.requierenRevision, 1);
  assert.equal(r.body.configuracion.importacionActiva, true);
  assert.equal(r.body.configuracion.corte, '2026-10-16T00:00:00.000Z');
  assert.equal(r.body.configuracion.certificados, 'transicion');
  // primero lo que pide atención
  assert.equal(r.body.miembros[0].uid, 'carla');
});

test('ensayo: datos mínimos (correos enmascarados, sin firmas ni ids de Stripe) y lo que predice es lo que la importación hace', async () => {
  const { app, db } = servidor({ seed: plantel() });
  const r = await get(app, '/api/admin/progreso-legado', 'token-admin');
  const texto = JSON.stringify(r.body);
  for (const correo of ['ana@example.com', 'beto@example.com', 'carla@example.com']) assert.equal(texto.includes(correo), false, correo);
  assert.match(r.body.miembros.find(m => m.uid === 'ana').correo, /^a\*+@example\.com$/);
  assert.equal(/sub_x|firmaBackend|stripe/i.test(texto), false);

  // lo que el ensayo predijo es lo que escribe la importación real (miembros sin certificados que se completen por firma)
  for (const uid of ['ana', 'carla', 'dani']) {
    const prediccion = r.body.miembros.find(m => m.uid === uid).clasesImportables;
    await progresoApi(app, `token-${uid}`);
    const escritas = claves(db, `miembros/${uid}/progresoCursos/`).reduce((n, k) => n + db.value(k).sesionesVistas.length, 0);
    assert.equal(escritas, prediccion, uid);
  }
  // y después del hecho, el ensayo los muestra como importados y verificados
  const despues = await get(app, '/api/admin/progreso-legado?refrescar=1', 'token-admin');
  for (const uid of ['ana', 'carla', 'dani']) {
    const f = despues.body.miembros.find(m => m.uid === uid);
    assert.equal(f.veredicto, 'ya-importado', uid);
    assert.equal(f.clasesFaltantes, 0, uid);
  }
});

test('ensayo: paginado (25 por página, tope 50) y con parámetros inválidos no falla', async () => {
  const seed = {};
  for (let i = 0; i < 60; i++) {
    seed[`miembros/m${i}`] = miembroConPlan({ name: `Miembro ${String(i).padStart(2, '0')}`, email: `m${i}@example.com`, courseProgress: { [AVES]: { completedLessons: [0] } } });
  }
  const ant = {}; for (let i = 0; i < 60; i++) ant[`m${i}`] = { creationTime: ANTIGUA };
  const { app } = servidor({ seed, usuariosAuth: { ...ant, admin: { creationTime: ANTIGUA } } });
  const p1 = await get(app, '/api/admin/progreso-legado', 'token-admin');
  assert.equal(p1.body.miembros.length, 25);
  assert.equal(p1.body.total, 60);
  assert.equal(p1.body.paginas, 3);
  const p3 = await get(app, '/api/admin/progreso-legado?pagina=3', 'token-admin');
  assert.equal(p3.body.miembros.length, 10);
  const todos = new Set([...p1.body.miembros, ...(await get(app, '/api/admin/progreso-legado?pagina=2', 'token-admin')).body.miembros, ...p3.body.miembros].map(m => m.uid));
  assert.equal(todos.size, 60, 'ninguno se repite ni falta');
  const grande = await get(app, '/api/admin/progreso-legado?limite=9999', 'token-admin');
  assert.equal(grande.body.miembros.length, 50);
  const raro = await get(app, '/api/admin/progreso-legado?pagina=abc&limite=-4', 'token-admin');
  assert.equal(raro.status, 200);
  assert.equal(raro.body.pagina, 1);
  const fuera = await get(app, '/api/admin/progreso-legado?pagina=99', 'token-admin');
  assert.equal(fuera.body.pagina, 3);
});

test('ensayo: sin la variable LEGACY_PROGRESS_IMPORT_BEFORE avisa que la importación está apagada y marca "no elegible: sin corte"', async () => {
  const { app } = servidor({ env: { CERTIFICATE_SIGNING_KEY: LLAVE }, seed: plantel() });
  const r = await get(app, '/api/admin/progreso-legado', 'token-admin');
  assert.equal(r.body.configuracion.importacionActiva, false);
  assert.equal(r.body.configuracion.corte, null);
  const ana = r.body.miembros.find(m => m.uid === 'ana');
  assert.equal(ana.veredicto, 'no-elegible');
  assert.equal(ana.motivoNoElegible, 'sin-corte');
});

// ════════════════════════════════════════════════════════════
// Importación desde el panel: POST /api/admin/progreso-legado/:uid/importar
// ════════════════════════════════════════════════════════════

test('importar desde el panel: misma importación segura, se anota en adminAcciones y devuelve la fila actualizada; repetirla no cambia nada', async () => {
  const { app, db } = servidor({ seed: plantel() });
  const r = await post(app, '/api/admin/progreso-legado/ana/importar', {}, 'token-admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resultado.estado, 'importado');
  assert.equal(r.body.resultado.clasesImportadas, 4);
  assert.equal(r.body.resultado.cursosImportados, 2);
  assert.equal(r.body.miembro.veredicto, 'ya-importado');
  assert.equal(r.body.miembro.clasesFaltantes, 0);
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2]);
  const acciones = claves(db, 'adminAcciones/').map(k => db.value(k));
  assert.equal(acciones.length, 1);
  assert.equal(acciones[0].accion, 'importar-avance');
  assert.equal(acciones[0].uidDestino, 'ana');
  assert.equal(acciones[0].por, 'admin');
  assert.equal(/ana@example\.com/.test(JSON.stringify(acciones[0])), false);

  const foto = JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('miembros/ana')).map(([k, v]) => [k, { ...v, actualizadoEn: 0, progresoLegadoImportadoEn: 0 }]));
  const otra = await post(app, '/api/admin/progreso-legado/ana/importar', {}, 'token-admin');
  assert.equal(otra.status, 200);
  assert.equal(otra.body.resultado.estado, 'ya-importado');
  assert.equal(claves(db, 'adminAcciones/').length, 1, 'lo que no cambia nada no se anota');
  assert.equal(JSON.stringify([...db._data.entries()].filter(([k]) => k.startsWith('miembros/ana')).map(([k, v]) => [k, { ...v, actualizadoEn: 0, progresoLegadoImportadoEn: 0 }])), foto);
});

test('importar desde el panel a una cuenta posterior al corte: 409 sin escribir; solo con aceptarCuentaPosterior lo importa', async () => {
  const { app, db } = servidor({
    usuariosAuth: { ana: { creationTime: POSTERIOR }, admin: { creationTime: ANTIGUA } },
    seed: { 'miembros/ana': miembro({ courseProgress: { [AVES]: { completedLessons: [0, 1] } } }) }
  });
  const no = await post(app, '/api/admin/progreso-legado/ana/importar', {}, 'token-admin');
  assert.equal(no.status, 409);
  assert.equal(no.body.resultado.estado, 'no-elegible');
  assert.equal(no.body.resultado.motivo, 'cuenta-posterior');
  assert.deepEqual(claves(db, 'miembros/ana/progresoCursos'), []);
  assert.equal(claves(db, 'adminAcciones/').length, 0);
  const si = await post(app, '/api/admin/progreso-legado/ana/importar', { aceptarCuentaPosterior: true }, 'token-admin');
  assert.equal(si.status, 200, JSON.stringify(si.body));
  assert.deepEqual(vistas(db, 'ana', AVES), [0, 1]);
  const accion = db.value(claves(db, 'adminAcciones/')[0]);
  assert.equal(accion.cuentaPosterior, true);
});

test('importar desde el panel: ya importado con clases que faltan se repara con reintentar (solo une, nunca quita)', async () => {
  const { app, db } = servidor({
    seed: {
      'miembros/ana': miembro({ progresoLegadoImportado: true, courseProgress: { [TIBURONES]: { completedLessons: [0, 1, 2] }, [AVES]: { completedLessons: [0, 1] } } }),
      [rutaProgreso('ana', AVES)]: { cursoId: AVES, uid: 'ana', sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: false }
    }
  });
  const antes = await get(app, '/api/admin/progreso-legado', 'token-admin');
  const f = antes.body.miembros.find(m => m.uid === 'ana');
  assert.equal(f.veredicto, 'ya-importado');
  assert.equal(f.clasesFaltantes, 3);
  assert.equal(f.verificado, false);
  assert.equal(antes.body.resumen.yaImportadosConFaltantes, 1);
  // sin reintentar no hace nada
  const nada = await post(app, '/api/admin/progreso-legado/ana/importar', {}, 'token-admin');
  assert.equal(nada.body.resultado.estado, 'ya-importado');
  assert.equal(vistas(db, 'ana', TIBURONES), undefined);
  const rep = await post(app, '/api/admin/progreso-legado/ana/importar', { reintentar: true }, 'token-admin');
  assert.equal(rep.status, 200);
  assert.equal(rep.body.resultado.estado, 'importado');
  assert.deepEqual(vistas(db, 'ana', TIBURONES), [0, 1, 2]);
  assert.deepEqual(vistas(db, 'ana', AVES), [0, 1, 2], 'lo que ya tenía de más se conserva');
  assert.equal(rep.body.miembro.clasesFaltantes, 0);
});

test('importar desde el panel: persona inexistente 404, identificador inválido 400, cuerpo inválido 400, y límite de peticiones 429', async () => {
  const { app } = servidor({ seed: plantel() });
  const noExiste = await post(app, '/api/admin/progreso-legado/nadie/importar', {}, 'token-admin');
  assert.equal(noExiste.status, 404);
  const malId = await post(app, '/api/admin/progreso-legado/a%20b%2Fc/importar', {}, 'token-admin');
  assert.ok([400, 404].includes(malId.status));
  const malCuerpo = await post(app, '/api/admin/progreso-legado/ana/importar', { reintentar: 'si' }, 'token-admin');
  assert.equal(malCuerpo.status, 400);
  let ultimo;
  for (let i = 0; i < 25; i++) ultimo = await post(app, '/api/admin/progreso-legado/gus/importar', {}, 'token-admin');
  assert.equal(ultimo.status, 429);
});
