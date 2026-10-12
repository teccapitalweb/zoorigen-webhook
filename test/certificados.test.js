'use strict';

// Certificados: reglas puras (folio, firma, validez, vista pública, nombre, horas, quiz, avance, legado y auditoría).
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../services/certificados');

const LLAVE = 'llave-de-prueba-para-certificados-0123456789';
const OTRA = 'otra-llave-de-prueba-distinta-9876543210';
const ANA = 'ana-uid-123';

const curso = (extra = {}) => ({
  title: 'Biología de tiburones', area: 'Fauna silvestre', duration: '6 horas', instructor: 'Dra. Pérez',
  lecciones: [{ titulo: 'Clase 1' }, { titulo: 'Clase 2' }, { titulo: 'Clase 3' }], ...extra
});

function emitir(extra = {}) {
  return c.construirCertificado({
    uid: ANA, cursoId: 'c1', curso: curso(), nombre: 'Ana Pérez', email: 'ana@example.com',
    emitido: new Date('2026-10-12T18:30:00Z'), llave: LLAVE, ...extra
  });
}

// ── Folio ──

test('folio: determinista, ZOO-AÑO-8 hex en mayúsculas y distinto por persona o curso', () => {
  const f = c.folioCertificado(ANA, 'c1', new Date('2026-10-12T00:00:00Z'));
  assert.match(f, /^ZOO-2026-[0-9A-F]{8}$/);
  assert.equal(f, c.folioCertificado(ANA, 'c1', new Date('2026-01-01T00:00:00Z')));
  assert.notEqual(f, c.folioCertificado('otra', 'c1', new Date('2026-10-12T00:00:00Z')));
  assert.notEqual(f, c.folioCertificado(ANA, 'c2', new Date('2026-10-12T00:00:00Z')));
  // el año es el de UTC
  assert.match(c.folioCertificado(ANA, 'c1', new Date('2026-12-31T23:59:59Z')), /^ZOO-2026-/);
  assert.match(c.folioCertificado(ANA, 'c1', new Date('2027-01-01T00:00:00Z')), /^ZOO-2027-/);
});

test('normalizarFolio: acepta el formato nuevo y el viejo, en mayúsculas; rechaza lo demás', () => {
  assert.equal(c.normalizarFolio(' zoo-2026-ab12cd34 '), 'ZOO-2026-AB12CD34');
  assert.equal(c.normalizarFolio('ZOO-2026-12345'), 'ZOO-2026-12345');
  for (const malo of ['', 'ZOO-26-12345', 'ALINTEC-2026-ABCDEF', 'ZOO-2026-ABC', 'ZOO-2026-ABCDEFGHIJKLMNOPQ', 'ZOO-2026-AB_CD', '../etc', null, undefined]) {
    assert.equal(c.normalizarFolio(malo), '', String(malo));
  }
});

// ── Firma ──

test('construirCertificado: campos del esquema nuevo Y los nombres que ya usa el sitio', () => {
  const d = emitir();
  assert.match(d.folio, /^ZOO-2026-[0-9A-F]{8}$/);
  assert.deepEqual(
    { uid: d.uid, nombre: d.nombre, cursoId: d.cursoId, curso: d.curso, area: d.area, horas: d.horas, sesiones: d.sesiones, instructor: d.instructor,
      emitido: d.emitido, year: d.year, verificado: d.verificado, origen: d.origen },
    { uid: ANA, nombre: 'Ana Pérez', cursoId: 'c1', curso: 'Biología de tiburones', area: 'Fauna silvestre', horas: 6, sesiones: 3,
      instructor: 'Dra. Pérez', emitido: '2026-10-12T18:30:00.000Z', year: 2026, verificado: true, origen: 'backend' }
  );
  assert.match(d.firmaBackend, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    { memberUid: d.memberUid, courseId: d.courseId, courseTitle: d.courseTitle, courseArea: d.courseArea, courseDuration: d.courseDuration,
      memberName: d.memberName, memberEmail: d.memberEmail, issuedAt: d.issuedAt, totalClases: d.totalClases },
    { memberUid: ANA, courseId: 'c1', courseTitle: 'Biología de tiburones', courseArea: 'Fauna silvestre', courseDuration: '6 horas',
      memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: '2026-10-12T18:30:00.000Z', totalClases: 3 }
  );
});

test('construirCertificado: instructor por defecto, horas 0 y área General si el curso no los trae', () => {
  const d = emitir({ curso: { title: 'Curso mínimo', lecciones: [{}] } });
  assert.equal(d.instructor, 'Equipo Zoorigen');
  assert.equal(d.horas, 0);
  assert.equal(d.area, 'General');
  assert.equal(d.courseDuration, '');
  assert.equal(d.sesiones, 1);
});

test('firma: el HMAC cubre folio, uid, cursoId, emitido y year', () => {
  const d = emitir();
  assert.equal(c.datosFirma(d), `${d.folio}\n${ANA}\nc1\n2026-10-12T18:30:00.000Z\n2026`);
  assert.equal(c.firmaValida(d, LLAVE), true);
  assert.equal(c.certificadoValido(d, LLAVE), true);
});

test('firma: cualquier campo firmado alterado, otra llave o firma mal formada se rechazan', () => {
  const d = emitir();
  for (const cambio of [{ folio: 'ZOO-2026-00000000' }, { uid: 'otra-persona' }, { cursoId: 'c2' }, { emitido: '2026-10-13T18:30:00.000Z' }, { year: 2025 }]) {
    assert.equal(c.certificadoValido({ ...d, ...cambio }, LLAVE), false, JSON.stringify(cambio));
  }
  assert.equal(c.certificadoValido(d, OTRA), false, 'otra llave');
  assert.equal(c.certificadoValido(d, ''), false, 'sin llave');
  assert.equal(c.certificadoValido({ ...d, firmaBackend: 'a'.repeat(64) }, LLAVE), false);
  assert.equal(c.certificadoValido({ ...d, firmaBackend: 'xyz' }, LLAVE), false);
  assert.equal(c.certificadoValido({ ...d, firmaBackend: '' }, LLAVE), false);
  assert.equal(c.certificadoValido({ ...d, firmaBackend: undefined }, LLAVE), false);
  assert.equal(c.certificadoValido({ ...d, verificado: false }, LLAVE), false);
  assert.equal(c.certificadoValido(null, LLAVE), false);
});

test('firma: emitido como Timestamp de Firestore firma igual que el texto ISO', () => {
  const d = emitir();
  const comoTimestamp = { ...d, emitido: { toDate: () => new Date(d.emitido) } };
  assert.equal(c.certificadoValido(comoTimestamp, LLAVE), true);
});

test('validez por origen: backend; admin y legacy-validado solo con validadoBackend', () => {
  assert.equal(c.certificadoValido(emitir(), LLAVE), true);
  assert.equal(c.certificadoValido(emitir({ origen: 'admin' }), LLAVE), true);
  const admin = emitir({ origen: 'admin' });
  assert.equal(admin.validadoBackend, true);
  assert.equal(admin.emitidoPor, 'admin');
  assert.equal(c.certificadoValido({ ...admin, validadoBackend: false }, LLAVE), false);
  // un origen desconocido nunca vale, aunque la firma sea correcta
  const raro = emitir();
  raro.origen = 'navegador';
  raro.firmaBackend = c.firmar(raro, LLAVE);
  assert.equal(c.certificadoValido(raro, LLAVE), false);
  // legacy-validado con la marca de auditoría
  const legado = { ...emitir(), origen: 'legacy-validado', validadoBackend: true };
  assert.equal(c.certificadoValido(legado, LLAVE), true);
});

test('firmar sin llave lanza (nunca firma con una llave vacía)', () => {
  assert.throws(() => c.firmar(emitir(), ''), /CERTIFICATE_SIGNING_KEY/);
});

test('certificadoPublico: solo los 8 campos públicos, sin uid, correo ni firma', () => {
  const p = c.certificadoPublico(emitir());
  assert.deepEqual(Object.keys(p).sort(), ['area', 'curso', 'emitido', 'folio', 'horas', 'instructor', 'nombre', 'sesiones']);
  assert.equal(p.nombre, 'Ana Pérez');
  assert.equal(p.emitido, '2026-10-12T18:30:00.000Z');
  assert.doesNotMatch(JSON.stringify(p), /ana@example|firma|ana-uid/);
});

test('certificadoValidoDeCurso: el válido de esa persona y curso; ignora los de otros y los sin firma', () => {
  const mio = emitir();
  const otroCurso = emitir({ cursoId: 'c2' });
  const ajeno = emitir({ uid: 'otro' });
  const sinFirma = { ...emitir({ cursoId: 'c3' }), firmaBackend: '' };
  const lista = [otroCurso, ajeno, sinFirma, mio];
  assert.equal(c.certificadoValidoDeCurso(lista, ANA, 'c1', LLAVE).folio, mio.folio);
  assert.equal(c.certificadoValidoDeCurso(lista, ANA, 'c3', LLAVE), null);
  assert.equal(c.certificadoValidoDeCurso([], ANA, 'c1', LLAVE), null);
});

// ── Datos del curso y de la persona ──

test('horasDeTexto: horas, minutos, reloj y lo que no se entiende', () => {
  assert.equal(c.horasDeTexto('6 horas'), 6);
  assert.equal(c.horasDeTexto('1 hora'), 1);
  assert.equal(c.horasDeTexto('4h 30m'), 4.5);
  assert.equal(c.horasDeTexto('90 min'), 1.5);
  assert.equal(c.horasDeTexto('2:30'), 2.5);
  assert.equal(c.horasDeTexto('2,5 horas'), 2.5);
  assert.equal(c.horasDeTexto(''), 0);
  assert.equal(c.horasDeTexto('Varias semanas'), 0);
  assert.equal(c.horasDeTexto(null), 0);
});

test('horasDeCurso: el campo horas manda; si no, la duración en texto; si no, 0', () => {
  assert.equal(c.horasDeCurso({ horas: 8, duration: '2 horas' }), 8);
  assert.equal(c.horasDeCurso({ duration: '3 horas' }), 3);
  assert.equal(c.horasDeCurso({ horas: -4, duration: '' }), 0);
  assert.equal(c.horasDeCurso({}), 0);
  assert.equal(c.horasDeCurso(null), 0);
});

test('nombreParaCertificado: nombre elegido > name > nombre > token > correo > respaldo', () => {
  assert.equal(c.nombreParaCertificado({ miembro: { nombreCertificado: ' Ana  María Pérez ', name: 'Ana' } }), 'Ana María Pérez');
  assert.equal(c.nombreParaCertificado({ miembro: { name: 'Ana Pérez' } }), 'Ana Pérez');
  assert.equal(c.nombreParaCertificado({ miembro: { nombre: 'Beto' } }), 'Beto');
  assert.equal(c.nombreParaCertificado({ miembro: {}, token: { name: 'Del Token', email: 'x@y.com' } }), 'Del Token');
  assert.equal(c.nombreParaCertificado({ token: { email: 'x@y.com' } }), 'x@y.com');
  assert.equal(c.nombreParaCertificado({}), 'Miembro VIP');
  assert.equal(c.nombreParaCertificado({ miembro: { nombreCertificado: '   ', name: 'Ana' } }), 'Ana');
  assert.equal(c.nombreParaCertificado({ miembro: { name: 'x'.repeat(300) } }).length, 80);
});

test('leccionesDe: usa lecciones; un curso viejo con driveId cuenta como una sola clase; si no, ninguna', () => {
  assert.equal(c.leccionesDe(curso()).length, 3);
  const viejo = c.leccionesDe({ title: 'Curso viejo', driveId: ' abc123 ', duration: '1 hora' });
  assert.deepEqual(viejo, [{ titulo: 'Curso viejo', driveId: 'abc123', duration: '1 hora' }]);
  assert.deepEqual(c.leccionesDe({ title: 'Vacío', lecciones: [] }), []);
  assert.deepEqual(c.leccionesDe(null), []);
  assert.equal(c.leccionDe({ title: 'Curso viejo', driveId: 'abc' }, 0).driveId, 'abc');
  assert.equal(c.leccionDe(curso(), 3), null);
});

// ── Quiz ──

test('preguntasDeLeccion: limpia como el sitio (vof/multiple, descarta incompletas, máximo 15)', () => {
  const l = {
    preguntas: [
      { pregunta: '  ¿Respira?  ', tipo: 'vof', correcta: 1 },
      { pregunta: '¿Cuál?', tipo: 'multiple', opciones: ['A', '', 'C'], correcta: 2 },
      { pregunta: '', tipo: 'vof', correcta: 0 },
      { pregunta: 'Sin opciones', tipo: 'multiple', opciones: ['solo una'], correcta: 0 },
      { pregunta: 'Correcta vacía', tipo: 'multiple', opciones: ['A', 'B', ''], correcta: 2 },
      null
    ]
  };
  assert.deepEqual(c.preguntasDeLeccion(l), [
    { pregunta: '¿Respira?', tipo: 'vof', correcta: 1 },
    { pregunta: '¿Cuál?', tipo: 'multiple', opciones: ['A', 'C'], correcta: 1 }
  ]);
  assert.deepEqual(c.preguntasDeLeccion({}), []);
  assert.deepEqual(c.preguntasDeLeccion(null), []);
  const muchas = { preguntas: Array.from({ length: 40 }, (_, i) => ({ pregunta: 'p' + i, tipo: 'vof', correcta: 0 })) };
  assert.equal(c.preguntasDeLeccion(muchas).length, 15);
});

test('calificarQuiz: cuenta aciertos, acepta sin contestar (null) y rechaza formatos inválidos', () => {
  const ps = [{ pregunta: 'a', tipo: 'vof', correcta: 0 }, { pregunta: 'b', tipo: 'multiple', opciones: ['x', 'y', 'z'], correcta: 2 }];
  assert.deepEqual(c.calificarQuiz(ps, [0, 2]), {
    aprobado: true, correctas: 2, total: 2, detalle: [{ correcta: 0, acertada: true }, { correcta: 2, acertada: true }]
  });
  const fallo = c.calificarQuiz(ps, [1, null]);
  assert.equal(fallo.aprobado, false);
  assert.equal(fallo.correctas, 0);
  assert.deepEqual(fallo.detalle, [{ correcta: 0, acertada: false }, { correcta: 2, acertada: false }]);
  for (const mal of [[0], [0, 2, 1], 'x', null, [0, '2'], [0, 1.5], [0, {}]]) assert.equal(c.calificarQuiz(ps, mal), null, JSON.stringify(mal));
});

// ── Avance ──

const previo = (extra = {}) => ({ sesionesVistas: [], quizzesAprobados: [], completado: false, certificadoFolio: null, ...extra });

test('evaluarAvance: orden secuencial, quiz obligatorio y completar el curso', () => {
  assert.deepEqual(c.evaluarAvance({ previo: previo(), indice: 1, totalLecciones: 3, exigeQuiz: false }),
    { ok: false, status: 409, error: 'Completa primero la clase anterior' });
  assert.deepEqual(c.evaluarAvance({ previo: previo(), indice: 0, totalLecciones: 3, exigeQuiz: true }),
    { ok: false, status: 409, error: 'Aprueba el quiz de esta clase antes de completarla' });
  assert.deepEqual(c.evaluarAvance({ previo: previo(), indice: 3, totalLecciones: 3, exigeQuiz: false }),
    { ok: false, status: 404, error: 'Clase no encontrada' });
  const primera = c.evaluarAvance({ previo: previo(), indice: 0, totalLecciones: 3, exigeQuiz: false });
  assert.deepEqual(primera, { ok: true, sesionesVistas: [0], completado: false, cambia: true });
  const ultima = c.evaluarAvance({ previo: previo({ sesionesVistas: [0, 1] }), indice: 2, totalLecciones: 3, exigeQuiz: false });
  assert.deepEqual(ultima, { ok: true, sesionesVistas: [0, 1, 2], completado: true, cambia: true });
  const conQuiz = c.evaluarAvance({ previo: previo({ quizzesAprobados: [0] }), indice: 0, totalLecciones: 3, exigeQuiz: true });
  assert.equal(conQuiz.ok, true);
});

test('evaluarAvance: repetir una clase ya vista no cambia nada y no vuelve a pedir el quiz', () => {
  const r = c.evaluarAvance({ previo: previo({ sesionesVistas: [0, 1, 2], completado: true }), indice: 2, totalLecciones: 3, exigeQuiz: true });
  assert.deepEqual(r, { ok: true, sesionesVistas: [0, 1, 2], completado: true, cambia: false });
});

test('evaluarAvance: completado es permanente aunque el curso gane clases después', () => {
  const r = c.evaluarAvance({ previo: previo({ sesionesVistas: [0, 1, 2], completado: true }), indice: 0, totalLecciones: 5, exigeQuiz: false });
  assert.equal(r.completado, true);
  const sin = c.evaluarAvance({ previo: previo({ sesionesVistas: [0, 1, 2] }), indice: 2, totalLecciones: 5, exigeQuiz: false });
  assert.equal(sin.completado, false);
});

test('normalizarProgreso: solo enteros válidos, sin repetidos y ordenados', () => {
  const p = c.normalizarProgreso({ sesionesVistas: [2, 0, 'x', 1.5, -1, 2, 99999, 1], quizzesAprobados: [3, 3], completado: 'true', certificadoFolio: 5 });
  assert.deepEqual(p, { sesionesVistas: [0, 1, 2], quizzesAprobados: [3], completado: false, certificadoFolio: null });
  assert.deepEqual(c.normalizarProgreso(null), previo());
});

// ── Legado ──

const cursosMapa = () => new Map([
  ['c1', curso({ lecciones: [{ preguntas: [{ pregunta: 'a', tipo: 'vof', correcta: 0 }] }, {}, {}] })],
  ['c2', curso({ lecciones: [{}, {}] })],
  ['faltante', null]
]);

test('legado: importa solo clases que existen, marca los quizzes y nunca emite certificados', () => {
  const plan = c.planearImportacionLegado({
    uid: ANA, llave: LLAVE, cursos: cursosMapa(), certificados: [],
    courseProgress: {
      c1: { completedLessons: [1, 0, 7, -2, 'x', 0], isCompleted: false },
      faltante: { completedLessons: [0, 1] },
      noexiste: { completedLessons: [0] },
      'a/b': { completedLessons: [0] }
    }
  });
  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.items[0].doc, { cursoId: 'c1', uid: ANA, sesionesVistas: [0, 1], quizzesAprobados: [0], origenLegado: true });
  assert.equal(plan.importadas, 2);
});

test('legado: curso completo CON certificado queda completado con ese folio', () => {
  const cert = { id: 'ZOO-2026-12345', memberUid: ANA, courseId: 'c2', issuedAt: '2026-05-01T10:00:00.000Z' };
  const plan = c.planearImportacionLegado({
    uid: ANA, llave: LLAVE, cursos: cursosMapa(), certificados: [cert],
    courseProgress: { c2: { completedLessons: [0, 1], isCompleted: true, certificateFolio: 'ZOO-2026-12345' } }
  });
  assert.deepEqual(plan.items[0].doc, {
    cursoId: 'c2', uid: ANA, sesionesVistas: [0, 1], quizzesAprobados: [], origenLegado: true, completado: true, certificadoFolio: 'ZOO-2026-12345'
  });
  assert.equal(plan.items[0].completadoEnIso, '2026-05-01T10:00:00.000Z');
});

test('legado: curso completo SIN certificado deja la última clase pendiente', () => {
  const plan = c.planearImportacionLegado({
    uid: ANA, llave: LLAVE, cursos: cursosMapa(), certificados: [],
    courseProgress: { c1: { completedLessons: [0, 1, 2], isCompleted: true } }
  });
  assert.deepEqual(plan.items[0].doc.sesionesVistas, [0, 1]);
  assert.equal(plan.items[0].doc.completado, undefined);
  // si solo tenía la última clase, no queda nada que importar
  const nada = c.planearImportacionLegado({
    uid: ANA, llave: LLAVE, cursos: new Map([['u', curso({ lecciones: [{}] })]]), certificados: [],
    courseProgress: { u: { completedLessons: [0], isCompleted: true } }
  });
  assert.deepEqual(nada, { items: [], importadas: 0 });
});

test('legado: el certificado de otra persona o de otro curso no cuenta; el firmado se prefiere', () => {
  const ajeno = { id: 'ZOO-2026-AAAAA', memberUid: 'otro', courseId: 'c2' };
  const otroCurso = { id: 'ZOO-2026-BBBBB', memberUid: ANA, courseId: 'c1' };
  const sinFirma = { id: 'ZOO-2026-ZZZZZ', memberUid: ANA, courseId: 'c2' };
  const firmado = { ...emitir({ cursoId: 'c2' }), id: undefined };
  firmado.id = firmado.folio;
  const base = { uid: ANA, llave: LLAVE, cursos: cursosMapa(), courseProgress: { c2: { completedLessons: [0, 1] } } };
  const sin = c.planearImportacionLegado({ ...base, certificados: [ajeno, otroCurso] });
  assert.deepEqual(sin.items[0].doc.sesionesVistas, [0]);
  const con = c.planearImportacionLegado({ ...base, certificados: [sinFirma, firmado] });
  assert.equal(con.items[0].doc.certificadoFolio, firmado.folio);
});

test('legado: formas inválidas no rompen nada', () => {
  for (const malo of [null, undefined, 'x', [], 5]) {
    assert.deepEqual(c.planearImportacionLegado({ uid: ANA, courseProgress: malo, cursos: cursosMapa(), certificados: [], llave: LLAVE }), { items: [], importadas: 0 });
  }
  const raro = c.planearImportacionLegado({
    uid: ANA, llave: LLAVE, cursos: cursosMapa(), certificados: null,
    courseProgress: { c1: 'texto', c2: { completedLessons: 'no' } }
  });
  assert.deepEqual(raro, { items: [], importadas: 0 });
});

test('legado: fecha de corte y elegibilidad de la cuenta', () => {
  assert.equal(Number.isNaN(c.corteLegado('')), true);
  assert.equal(Number.isNaN(c.corteLegado('no es fecha')), true);
  const corte = c.corteLegado('2026-10-01T00:00:00Z');
  assert.equal(c.cuentaElegibleParaLegado('2026-09-30T23:59:59Z', corte), true);
  assert.equal(c.cuentaElegibleParaLegado('2026-10-01T00:00:00Z', corte), false, 'cerrado: la fecha de corte no entra');
  assert.equal(c.cuentaElegibleParaLegado('2026-11-01T00:00:00Z', corte), false);
  assert.equal(c.cuentaElegibleParaLegado(null, corte), false);
  assert.equal(c.cuentaElegibleParaLegado('2026-01-01', NaN), false);
});

test('unirProgreso: nunca pierde avance ya guardado por el servidor', () => {
  const r = c.unirProgreso(
    { sesionesVistas: [0, 1, 2], quizzesAprobados: [2], completado: true, certificadoFolio: 'ZOO-2026-NUEVO1' },
    { sesionesVistas: [0], quizzesAprobados: [0], completado: true, certificadoFolio: 'ZOO-2026-VIEJO1' }
  );
  assert.deepEqual(r, { sesionesVistas: [0, 1, 2], quizzesAprobados: [0, 2], completado: true, certificadoFolio: 'ZOO-2026-NUEVO1' });
});

// ── Auditoría y normalización de certificados viejos ──

const viejo = (extra = {}) => ({
  folio: 'ZOO-2026-12345', courseId: 'c1', courseTitle: 'Curso 1', courseArea: 'Manejo', courseDuration: '4 horas',
  memberUid: ANA, memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: '2026-03-04T15:00:00.000Z', totalClases: 3, ...extra
});

test('parcheLegadoValidado: rellena el esquema nuevo desde los nombres viejos, firma y NO borra nada', () => {
  const datos = viejo();
  const r = c.parcheLegadoValidado('ZOO-2026-12345', datos, LLAVE);
  assert.equal(r.ok, true);
  const p = r.parche;
  assert.deepEqual(
    { folio: p.folio, uid: p.uid, cursoId: p.cursoId, nombre: p.nombre, curso: p.curso, area: p.area, horas: p.horas, sesiones: p.sesiones,
      emitido: p.emitido, year: p.year, instructor: p.instructor, origen: p.origen, validadoBackend: p.validadoBackend, verificado: p.verificado },
    { folio: 'ZOO-2026-12345', uid: ANA, cursoId: 'c1', nombre: 'Ana Pérez', curso: 'Curso 1', area: 'Manejo', horas: 4, sesiones: 3,
      emitido: '2026-03-04T15:00:00.000Z', year: 2026, instructor: 'Equipo Zoorigen', origen: 'legacy-validado', validadoBackend: true, verificado: true }
  );
  // el documento resultante (campos viejos + parche) valida con la llave
  assert.equal(c.certificadoValido({ ...datos, ...p }, LLAVE), true);
  assert.equal(c.certificadoValido({ ...datos, ...p }, OTRA), false);
  // el parche no incluye (ni borra) los campos viejos
  assert.equal('memberUid' in p, false);
});

test('parcheLegadoValidado: no inventa datos; sin nombre, curso o fecha válida se rechaza', () => {
  assert.equal(c.parcheLegadoValidado('ZOO-2026-12345', viejo({ memberName: '' }), LLAVE).ok, false);
  assert.equal(c.parcheLegadoValidado('ZOO-2026-12345', viejo({ courseTitle: '' }), LLAVE).ok, false);
  assert.equal(c.parcheLegadoValidado('ZOO-2026-12345', viejo({ issuedAt: 'ayer' }), LLAVE).ok, false);
  assert.equal(c.parcheLegadoValidado('ZOO-2026-12345', viejo({ memberUid: 'a/b' }), LLAVE).ok, false);
  assert.equal(c.parcheLegadoValidado('ZOO-2026-12345', viejo({ memberUid: '' }), LLAVE).ok, false);
});

test('auditarCertificados: válido, revisable, huérfano, duplicado y folio inconsistente', () => {
  const firmado = emitir({ cursoId: 'c1' });
  const filas = c.auditarCertificados({
    llave: LLAVE,
    cursosIds: new Set(['c1', 'c2']),
    miembrosIds: new Set([ANA, 'beto']),
    certificados: [
      { id: firmado.folio, data: firmado },
      { id: 'ZOO-2026-11111', data: viejo({ folio: 'ZOO-2026-11111', memberUid: 'beto', courseId: 'c2' }) },
      { id: 'ZOO-2026-22222', data: viejo({ folio: 'ZOO-2026-22222', memberUid: 'fantasma', courseId: 'c2' }) },
      { id: 'ZOO-2026-33333', data: viejo({ folio: 'ZOO-2026-33333', memberUid: 'beto', courseId: 'curso-borrado' }) },
      // misma persona y curso que el firmado de arriba: duplicado
      { id: 'ZOO-2026-44444', data: viejo({ folio: 'ZOO-2026-44444', memberUid: ANA, courseId: 'c1' }) },
      { id: 'ZOO-2026-55555', data: viejo({ folio: 'ZOO-2026-99999', memberUid: 'beto', courseId: 'c1' }) },
      { id: 'ZOO-2026-66666', data: viejo({ folio: 'ZOO-2026-66666', memberUid: 'beto', courseId: 'c1', memberName: '' }) }
    ]
  });
  const por = Object.fromEntries(filas.map(f => [f.folio, f]));
  assert.equal(por[firmado.folio].accion, 'ya-valido');
  assert.equal(por['ZOO-2026-11111'].accion, 'revisar-manualmente');
  assert.deepEqual(por['ZOO-2026-11111'].razones, []);
  assert.deepEqual(por['ZOO-2026-22222'].razones, ['miembro-no-encontrado']);
  assert.deepEqual(por['ZOO-2026-33333'].razones, ['curso-no-encontrado']);
  assert.deepEqual(por['ZOO-2026-44444'].razones, [], 'un duplicado no es una razón de rechazo');
  assert.deepEqual(por['ZOO-2026-44444'].notas, [`duplicado-de:${firmado.folio}`]);
  assert.ok(por['ZOO-2026-55555'].razones.includes('folio-inconsistente'));
  assert.ok(por['ZOO-2026-66666'].razones.includes('campos-obligatorios-incompletos'));
  assert.equal(por['ZOO-2026-44444'].accion, 'revisar-manualmente');
  assert.equal(por['ZOO-2026-44444'].aceptable, true);
  for (const folio of ['ZOO-2026-22222', 'ZOO-2026-33333', 'ZOO-2026-55555', 'ZOO-2026-66666']) {
    assert.equal(por[folio].accion, 'rechazar', folio);
  }
});

test('auditarCertificados: dos viejos de la misma persona y curso son revisables; el más reciente lleva la nota duplicado-de', () => {
  const filas = c.auditarCertificados({
    llave: LLAVE, cursosIds: new Set(['c1']), miembrosIds: new Set(['beto']),
    certificados: [
      { id: 'ZOO-2026-BBBBB', data: viejo({ folio: 'ZOO-2026-BBBBB', memberUid: 'beto', issuedAt: '2026-05-01T00:00:00.000Z' }) },
      { id: 'ZOO-2026-AAAAA', data: viejo({ folio: 'ZOO-2026-AAAAA', memberUid: 'beto', issuedAt: '2026-04-01T00:00:00.000Z' }) }
    ]
  });
  const por = Object.fromEntries(filas.map(f => [f.folio, f]));
  assert.equal(por['ZOO-2026-AAAAA'].accion, 'revisar-manualmente');
  assert.deepEqual(por['ZOO-2026-AAAAA'].notas, []);
  assert.equal(por['ZOO-2026-BBBBB'].accion, 'revisar-manualmente');
  assert.deepEqual(por['ZOO-2026-BBBBB'].razones, []);
  assert.deepEqual(por['ZOO-2026-BBBBB'].notas, ['duplicado-de:ZOO-2026-AAAAA']);
});

// ── Certificados anteriores: aceptación sin acción manual ──

// Lo que escribía el navegador, exactamente (sin firmaBackend)
const delNavegador = (extra = {}) => ({
  folio: 'ZOO-2026-48213', courseId: 'c1', courseTitle: 'Curso 1', courseArea: 'Manejo', courseDuration: '',
  memberUid: ANA, memberName: 'Ana Pérez', memberEmail: 'ana@example.com', issuedAt: '2026-03-04T15:00:00.000Z', totalClases: 3, ...extra
});
const AHORA = new Date('2026-10-12T12:00:00Z');
const ctx = (extra = {}) => ({ id: 'ZOO-2026-48213', cursoExiste: true, miembroExiste: true, ahora: AHORA, ...extra });

test('certificadoAnteriorAceptable: acepta el certificado del navegador y normaliza sus campos', () => {
  const r = c.certificadoAnteriorAceptable(delNavegador(), ctx());
  assert.equal(r.aceptable, true);
  assert.deepEqual(r.razones, []);
  assert.deepEqual(
    { folio: r.campos.folio, uid: r.campos.uid, cursoId: r.campos.cursoId, nombre: r.campos.nombre, curso: r.campos.curso, area: r.campos.area,
      horas: r.campos.horas, sesiones: r.campos.sesiones, instructor: r.campos.instructor, emitido: r.campos.emitido, year: r.campos.year },
    { folio: 'ZOO-2026-48213', uid: ANA, cursoId: 'c1', nombre: 'Ana Pérez', curso: 'Curso 1', area: 'Manejo', horas: 0, sesiones: 3,
      instructor: 'Equipo Zoorigen', emitido: '2026-03-04T15:00:00.000Z', year: 2026 }
  );
  // horas con el parser que ya existe
  assert.equal(c.certificadoAnteriorAceptable(delNavegador({ courseDuration: '4h 30m' }), ctx()).campos.horas, 4.5);
});

test('certificadoAnteriorAceptable: acepta los dos juegos de nombres (uid/cursoId/nombre/curso/emitido)', () => {
  const admin = { folio: 'ZOO-2026-77001', uid: 'beto', cursoId: 'c2', nombre: 'Beto Ruiz', curso: 'Etología', emitido: '2026-05-01T10:00:00.000Z' };
  const r = c.certificadoAnteriorAceptable(admin, ctx({ id: 'ZOO-2026-77001' }));
  assert.equal(r.aceptable, true);
  assert.equal(r.uid, 'beto');
  assert.equal(r.campos.nombre, 'Beto Ruiz');
  // el id puede venir en el propio documento
  assert.equal(c.certificadoAnteriorAceptable({ ...admin, id: 'ZOO-2026-77001' }, { cursoExiste: true, miembroExiste: true, ahora: AHORA }).aceptable, true);
});

test('certificadoAnteriorAceptable: cada regla rechaza con su razón', () => {
  const razones = (doc, extra) => c.certificadoAnteriorAceptable(doc, ctx(extra)).razones;
  assert.deepEqual(razones(delNavegador({ firmaBackend: 'a'.repeat(64) })), ['firma-alterada']);
  assert.deepEqual(razones(delNavegador({ firmaBackend: 'no-es-firma' })), ['firma-alterada']);
  assert.deepEqual(razones(delNavegador({ folio: 'ZOO-2026-99999' })), ['folio-inconsistente']);
  assert.deepEqual(razones(delNavegador({ folio: undefined })), ['folio-inconsistente']);
  assert.ok(razones(delNavegador({ folio: 'abc' }), { id: 'abc' }).includes('folio-con-formato-invalido'));
  assert.deepEqual(razones(delNavegador(), { miembroExiste: false }), ['miembro-no-encontrado']);
  assert.deepEqual(razones(delNavegador(), { cursoExiste: false }), ['curso-no-encontrado']);
  assert.deepEqual(razones(delNavegador({ memberUid: '' })), ['miembro-no-encontrado']);
  assert.deepEqual(razones(delNavegador({ courseId: '' })), ['curso-no-encontrado']);
  assert.deepEqual(razones(delNavegador({ memberUid: 'a/b' })), ['uid-invalido']);
  assert.deepEqual(razones(delNavegador({ courseId: '../x' })), ['curso-invalido']);
  assert.deepEqual(razones(delNavegador({ memberName: '' })), ['campos-obligatorios-incompletos']);
  assert.deepEqual(razones(delNavegador({ courseTitle: '' })), ['campos-obligatorios-incompletos']);
  assert.deepEqual(razones(delNavegador({ issuedAt: 'ayer' })), ['fecha-invalida']);
  assert.deepEqual(razones(delNavegador({ uid: 'beto' })), ['titular-inconsistente']);
  assert.deepEqual(razones(delNavegador({ cursoId: 'c2' })), ['curso-inconsistente']);
  assert.deepEqual(razones(delNavegador({ issuedAt: '2026-10-14T12:00:00.000Z' })), ['fecha-futura']);
  assert.deepEqual(razones(delNavegador({ issuedAt: '2026-10-13T11:00:00.000Z' })), [], 'hasta un día por desfase de reloj');
  assert.equal(c.certificadoAnteriorAceptable(null, {}).aceptable, false);
});

test('certificadoAnteriorAceptable: existencias como función y límite de fecha inclusivo', () => {
  const soloAna = id => id === ANA;
  const soloC1 = id => id === 'c1';
  assert.equal(c.certificadoAnteriorAceptable(delNavegador(), ctx({ miembroExiste: soloAna, cursoExiste: soloC1 })).aceptable, true);
  assert.equal(c.certificadoAnteriorAceptable(delNavegador({ memberUid: 'otro' }), ctx({ miembroExiste: soloAna, cursoExiste: soloC1 })).aceptable, false);

  const emitido = '2026-03-04T15:00:00.000Z';
  assert.equal(c.certificadoAnteriorAceptable(delNavegador(), ctx({ limite: emitido })).aceptable, true, 'el límite es inclusivo');
  const despues = c.certificadoAnteriorAceptable(delNavegador(), ctx({ limite: '2026-03-04T14:59:59.999Z' }));
  assert.deepEqual(despues.razones, ['posterior-al-limite']);
  assert.equal(c.certificadoAnteriorAceptable(delNavegador(), ctx({ limite: '' })).aceptable, true, 'sin límite: modo transición');
  assert.equal(c.certificadoAnteriorAceptable(delNavegador(), ctx({ limite: undefined })).aceptable, true);
  assert.equal(c.certificadoAnteriorAceptable(delNavegador(), ctx({ limite: new Date(emitido) })).aceptable, true);
  assert.deepEqual(c.certificadoAnteriorAceptable(delNavegador(), ctx({ limite: 'no-es-fecha' })).razones, ['limite-invalido']);
});

test('limiteEnMs: sin valor no hay límite, una fecha válida es el corte y una inválida es NaN', () => {
  assert.equal(c.limiteEnMs(undefined), Infinity);
  assert.equal(c.limiteEnMs(null), Infinity);
  assert.equal(c.limiteEnMs('  '), Infinity);
  assert.equal(c.limiteEnMs('2026-03-01T00:00:00Z'), Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(c.limiteEnMs('"2026-03-01T00:00:00Z"'), Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(Number.isNaN(c.limiteEnMs('mañana')), true);
});

test('evaluarCertificados: firmado, aceptable y duplicado (el firmado o el más antiguo es el canónico; nada se rechaza por duplicado)', () => {
  const firmado = emitir({ cursoId: 'c1' });
  const filas = c.evaluarCertificados([
    { id: firmado.folio, data: firmado },
    { id: 'ZOO-2026-48213', data: delNavegador() }, // misma persona y curso que el firmado: duplicado
    { id: 'ZOO-2026-50001', data: delNavegador({ folio: 'ZOO-2026-50001', memberUid: 'beto', issuedAt: '2026-05-01T00:00:00.000Z' }) },
    { id: 'ZOO-2026-50002', data: delNavegador({ folio: 'ZOO-2026-50002', memberUid: 'beto', issuedAt: '2026-04-01T00:00:00.000Z' }) },
    { id: 'ZOO-2026-50003', data: delNavegador({ folio: 'ZOO-2026-50003', memberUid: 'beto', memberName: '', issuedAt: '2026-01-01T00:00:00.000Z' }) }
  ], { llave: LLAVE, cursoExiste: true, miembroExiste: true, ahora: AHORA });
  const por = Object.fromEntries(filas.map(f => [f.id, f]));
  assert.equal(por[firmado.folio].estado, 'firmado');
  assert.equal(por['ZOO-2026-48213'].estado, 'aceptable', 'un duplicado sigue siendo aceptable');
  assert.deepEqual(por['ZOO-2026-48213'].razones, []);
  assert.deepEqual(por['ZOO-2026-48213'].notas, [`duplicado-de:${firmado.folio}`]);
  assert.equal(por['ZOO-2026-50002'].estado, 'aceptable', 'el más antiguo es el canónico');
  assert.deepEqual(por['ZOO-2026-50002'].notas, []);
  assert.equal(por['ZOO-2026-50001'].estado, 'aceptable');
  assert.deepEqual(por['ZOO-2026-50001'].notas, ['duplicado-de:ZOO-2026-50002']);
  assert.equal(por['ZOO-2026-50003'].estado, 'no-aceptable', 'un inválido más antiguo no impide aceptar al bueno');
  assert.deepEqual(por['ZOO-2026-50003'].razones, ['campos-obligatorios-incompletos']);
});

test('parcheAnteriorAutomatico: igual que la auditoría más migradoAutomaticamente; el resultado valida y no toca campos viejos', () => {
  const datos = delNavegador();
  const r = c.parcheAnteriorAutomatico('ZOO-2026-48213', datos, LLAVE);
  assert.equal(r.ok, true);
  assert.equal(r.parche.migradoAutomaticamente, true);
  assert.equal(r.parche.origen, 'legacy-validado');
  assert.equal(c.certificadoValido({ ...datos, ...r.parche }, LLAVE), true);
  assert.equal('memberUid' in r.parche, false);
  assert.equal(c.parcheAnteriorAutomatico('ZOO-2026-48213', delNavegador({ memberName: '' }), LLAVE).ok, false);
});

test('planearProgresoDesdeCertificados: completa sin documento previo, respeta lo guardado y es idempotente', () => {
  const cursos = new Map([
    ['c1', { title: 'C1', lecciones: [{}, {}, {}] }],
    ['c3', { title: 'C3', lecciones: [{ preguntas: [{ pregunta: '¿Sí?', tipo: 'vof', correcta: 1 }] }, {}] }]
  ]);
  const vigentes = [
    { id: 'ZOO-2026-48213', cursoId: 'c1', emitido: '2026-03-04T15:00:00.000Z' },
    { id: 'ZOO-2026-50001', cursoId: 'c3', emitido: '2026-04-01T00:00:00.000Z' },
    { id: 'ZOO-2026-50009', cursoId: 'borrado', emitido: '2026-04-01T00:00:00.000Z' }
  ];
  const plan = c.planearProgresoDesdeCertificados({ uid: ANA, vigentes, progresos: new Map(), cursos });
  const por = Object.fromEntries(plan.map(p => [p.cursoId, p]));
  assert.deepEqual(por.c1.vista, {
    sesionesVistas: [0, 1, 2], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-48213', completadoEn: '2026-03-04T15:00:00.000Z'
  });
  assert.equal(por.c1.escribir, true);
  assert.equal(por.c1.doc.origenLegado, true);
  assert.deepEqual(por.c3.vista.quizzesAprobados, [0]);
  assert.equal(por.borrado.escribir, false, 'un curso que ya no existe se muestra pero no se guarda');
  assert.deepEqual(por.borrado.vista.sesionesVistas, []);

  // ya coherente: nada que escribir y la vista conserva lo guardado
  const guardado = { cursoId: 'c1', uid: ANA, sesionesVistas: [0, 1], quizzesAprobados: [], completado: true, certificadoFolio: 'ZOO-2026-48213', completadoEn: new Date('2026-03-04T15:00:00.000Z') };
  const otra = c.planearProgresoDesdeCertificados({ uid: ANA, vigentes: [vigentes[0]], progresos: new Map([['c1', guardado]]), cursos });
  assert.equal(otra[0].escribir, false);
  assert.deepEqual(otra[0].vista.sesionesVistas, [0, 1]);

  // con documento previo sin completar: se completa y nunca se pierde avance
  const parcial = { cursoId: 'c1', uid: ANA, sesionesVistas: [0, 7], quizzesAprobados: [0], completado: false };
  const completa = c.planearProgresoDesdeCertificados({ uid: ANA, vigentes: [vigentes[0]], progresos: new Map([['c1', parcial]]), cursos });
  assert.equal(completa[0].escribir, true);
  assert.deepEqual(completa[0].vista.sesionesVistas, [0, 1, 2, 7]);
  assert.deepEqual(completa[0].vista.quizzesAprobados, [0]);
  assert.equal(completa[0].doc.completadoEnIso, '2026-03-04T15:00:00.000Z');
});

test('auditarCertificados: reutiliza la misma aceptación (límite de fecha y firma alterada)', () => {
  const filas = c.auditarCertificados({
    llave: LLAVE, cursosIds: new Set(['c1']), miembrosIds: new Set([ANA, 'beto']), ahora: AHORA, limite: '2026-03-01T00:00:00Z',
    certificados: [
      { id: 'ZOO-2026-48213', data: delNavegador() },
      { id: 'ZOO-2026-60001', data: delNavegador({ folio: 'ZOO-2026-60001', memberUid: 'beto', issuedAt: '2026-02-01T00:00:00.000Z' }) },
      { id: 'ZOO-2026-60002', data: delNavegador({ folio: 'ZOO-2026-60002', memberUid: 'beto', issuedAt: '2026-02-02T00:00:00.000Z', firmaBackend: 'a'.repeat(64) }) }
    ]
  });
  const por = Object.fromEntries(filas.map(f => [f.folio, f]));
  assert.deepEqual(por['ZOO-2026-48213'].razones, ['posterior-al-limite']);
  assert.equal(por['ZOO-2026-48213'].accion, 'rechazar');
  assert.equal(por['ZOO-2026-60001'].accion, 'revisar-manualmente');
  assert.equal(por['ZOO-2026-60001'].aceptable, true);
  assert.deepEqual(por['ZOO-2026-60002'].razones, ['firma-alterada']);
  assert.equal(por['ZOO-2026-60002'].accion, 'rechazar');
});
