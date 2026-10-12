'use strict';

// ══ CERTIFICADOS Y PROGRESO DE CURSOS · reglas puras ══
// Aquí no hay Express ni Firestore: solo reglas que se prueban en Node. Las rutas están en
// services/rutas-certificados.js y el script de auditoría (scripts/auditar-certificados.js) solo
// llama a estas funciones.
//
// Idea general (igual que en Alintec): el servidor es la única fuente de verdad del avance y de los
// certificados. Un certificado vale solo si lleva una firma HMAC-SHA256 hecha con CERTIFICATE_SIGNING_KEY
// sobre `folio\nuid\ncursoId\nemitido\nyear`; los que escribía el navegador no la tienen y se
// regularizan con el script de auditoría (a mano, con una lista de folios aprobados).

const crypto = require('crypto');
const { texto } = require('./texto');

const FOLIO_REGEX = /^ZOO-[0-9]{4}-[A-Z0-9]{5,16}$/;
const ID_CURSO_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}$/;
const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const ORIGENES_EXTERNOS = Object.freeze(['admin', 'legacy-validado']);
const INSTRUCTOR_POR_DEFECTO = 'Equipo Zoorigen';
const MAX_LECCIONES = 500;
const MAX_CURSOS_LEGADO = 200;
const REGLAS_QUIZ = Object.freeze({ maxPreguntas: 15, textoMax: 300, opcionMax: 160, opcionesMin: 2, opcionesMax: 6 });

// ── Fechas y folio ─────────────────────────────────────────────

// Texto ISO de una fecha de Firestore (Timestamp, Date, texto o número); '' si no es válida
function fechaIso(valor) {
  if (!valor && valor !== 0) return '';
  let d;
  if (typeof valor.toDate === 'function') d = valor.toDate();
  else if (valor instanceof Date) d = valor;
  else if (typeof valor._seconds === 'number') d = new Date(valor._seconds * 1000);
  else d = new Date(valor);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

// Folio determinista: el mismo uid y curso dan siempre el mismo código (el año es el de la emisión, en UTC)
function folioCertificado(uid, cursoId, fecha) {
  const codigo = crypto.createHash('sha256').update(`${uid}|${cursoId}`).digest('hex').slice(0, 8).toUpperCase();
  const anio = String(fecha.getUTCFullYear()).padStart(4, '0');
  return `ZOO-${anio}-${codigo}`;
}

// Folio recibido en la URL: mayúsculas y sin espacios; '' si no tiene el formato (ZOO-2026-12345 también vale)
function normalizarFolio(valor) {
  const folio = String(valor == null ? '' : valor).trim().toUpperCase();
  return FOLIO_REGEX.test(folio) ? folio : '';
}

// ── Firma ──────────────────────────────────────────────────────

function datosFirma(cert) {
  const c = cert || {};
  return [
    String(c.folio || ''),
    String(c.uid || ''),
    String(c.cursoId || ''),
    fechaIso(c.emitido),
    String(Number(c.year) || '')
  ].join('\n');
}

function firmar(cert, llave) {
  if (!llave) throw new Error('Falta CERTIFICATE_SIGNING_KEY');
  return crypto.createHmac('sha256', llave).update(datosFirma(cert), 'utf8').digest('hex');
}

function firmaValida(cert, llave) {
  if (!llave || !cert) return false;
  const recibida = String(cert.firmaBackend || '');
  if (!/^[a-f0-9]{64}$/.test(recibida)) return false;
  const esperada = firmar(cert, llave);
  return crypto.timingSafeEqual(Buffer.from(recibida, 'hex'), Buffer.from(esperada, 'hex'));
}

// Válido = verificado, con firma correcta y de origen conocido (el servidor, el admin o la auditoría)
function certificadoValido(cert, llave) {
  if (!cert || cert.verificado !== true || !firmaValida(cert, llave)) return false;
  if (cert.origen === 'backend') return true;
  return cert.validadoBackend === true && ORIGENES_EXTERNOS.includes(cert.origen);
}

// Lo único que se muestra al público (nunca uid, correo ni la firma)
function certificadoPublico(cert) {
  const c = cert || {};
  return {
    folio: String(c.folio || ''),
    nombre: String(c.nombre || c.memberName || ''),
    curso: String(c.curso || c.courseTitle || ''),
    area: String(c.area || c.courseArea || ''),
    horas: Number(c.horas) || 0,
    sesiones: Number(c.sesiones) || Number(c.totalClases) || 0,
    instructor: String(c.instructor || ''),
    emitido: fechaIso(c.emitido || c.issuedAt)
  };
}

// ── Datos del curso y de la persona ────────────────────────────

const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Igual que el sitio: un curso viejo sin `lecciones` pero con `driveId` cuenta como una sola clase
function leccionesDe(curso) {
  if (curso && Array.isArray(curso.lecciones) && curso.lecciones.length) return curso.lecciones.slice(0, MAX_LECCIONES);
  if (curso && typeof curso.driveId === 'string' && curso.driveId.trim()) {
    return [{ titulo: tituloDeCurso(curso), driveId: curso.driveId.trim(), duration: curso.duration }];
  }
  return [];
}

function leccionDe(curso, indice) {
  const lista = leccionesDe(curso);
  const leccion = Number.isInteger(indice) && indice >= 0 ? lista[indice] : null;
  return esObjeto(leccion) ? leccion : null;
}

function tituloDeCurso(curso) {
  return texto((curso && (curso.title || curso.titulo)) || '', 160) || 'Curso Zoorigen';
}

function areaDeCurso(curso) {
  return texto((curso && curso.area) || '', 80) || 'General';
}

function instructorDeCurso(curso) {
  return texto((curso && curso.instructor) || '', 80) || INSTRUCTOR_POR_DEFECTO;
}

// Duración tal como la escribió el administrador ("6 horas", "4h 30m"...)
function duracionDeCurso(curso) {
  return texto((curso && (curso.duration || curso.duracion)) || '', 60);
}

function redondear(n) { return Math.round(n * 100) / 100; }

// "6 horas" -> 6 · "4h 30m" -> 4.5 · "90 min" -> 1.5 · "2:30" -> 2.5 · lo que no se entiende -> 0
function horasDeTexto(valor) {
  const s = String(valor == null ? '' : valor).toLowerCase().replace(',', '.');
  const reloj = s.match(/^\s*(\d{1,3}):([0-5]\d)\s*$/);
  if (reloj) return redondear(Number(reloj[1]) + Number(reloj[2]) / 60);
  const h = s.match(/(\d+(?:\.\d+)?)\s*(?:horas?|hrs?|h)(?![a-z])/);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:minutos?|mins?|min|m)(?![a-z])/);
  const total = (h ? Number(h[1]) : 0) + (m ? Number(m[1]) / 60 : 0);
  return Number.isFinite(total) && total > 0 ? redondear(Math.min(total, 1000)) : 0;
}

// El curso puede traer `horas` (número) o `duration`/`duracion` (texto). Sin ninguna: 0.
function horasDeCurso(curso) {
  const c = curso || {};
  const directa = Number(c.horas);
  if (Number.isFinite(directa) && directa > 0) return redondear(Math.min(directa, 1000));
  return horasDeTexto(c.duration || c.duracion);
}

// Nombre que sale en el certificado: el que la persona eligió, su nombre de siempre, el del token o su correo
function nombreParaCertificado({ miembro, usuario, token } = {}) {
  const m = esObjeto(miembro) ? miembro : {};
  const u = esObjeto(usuario) ? usuario : {};
  const t = esObjeto(token) ? token : {};
  const candidatos = [m.nombreCertificado, m.name, m.nombre, m.nombreCompleto, u.name, u.nombre, t.name, m.email, u.email, t.email];
  for (const c of candidatos) {
    if (typeof c !== 'string') continue;
    const limpio = texto(c, 80);
    if (limpio) return limpio;
  }
  return 'Miembro VIP';
}

function correoDeMiembro({ miembro, usuario, token } = {}) {
  for (const c of [miembro && miembro.email, usuario && usuario.email, token && token.email]) {
    if (typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim())) return c.trim().toLowerCase().slice(0, 254);
  }
  return '';
}

// ── Emisión ────────────────────────────────────────────────────

// Documento completo de `certificados/{folio}`: los campos del esquema nuevo (los que firma y verifica el
// servidor) y, además, los nombres que ya usan el sitio y los logros (memberUid, courseId, issuedAt...).
function construirCertificado({ uid, cursoId, curso, nombre, email, emitido, llave, origen = 'backend', horas, sesiones }) {
  const fecha = emitido instanceof Date ? emitido : new Date(emitido);
  if (Number.isNaN(fecha.getTime())) throw new Error('Fecha de emisión inválida');
  const id = String(cursoId);
  const totalSesiones = Number.isInteger(sesiones) && sesiones >= 0 ? sesiones : leccionesDe(curso).length;
  const horasFinal = Number.isFinite(horas) && horas >= 0 ? redondear(Math.min(horas, 1000)) : horasDeCurso(curso);
  const base = {
    folio: folioCertificado(uid, id, fecha),
    uid,
    nombre,
    cursoId: id,
    curso: tituloDeCurso(curso),
    area: areaDeCurso(curso),
    horas: horasFinal,
    sesiones: totalSesiones,
    instructor: instructorDeCurso(curso),
    emitido: fecha.toISOString(),
    year: fecha.getUTCFullYear(),
    verificado: true,
    origen
  };
  if (origen === 'admin') { base.emitidoPor = 'admin'; base.validadoBackend = true; }
  const firmaBackend = firmar(base, llave);
  return {
    ...base,
    firmaBackend,
    memberUid: uid,
    courseId: id,
    courseTitle: base.curso,
    courseArea: base.area,
    courseDuration: duracionDeCurso(curso),
    memberName: nombre,
    memberEmail: email || '',
    issuedAt: base.emitido,
    totalClases: totalSesiones
  };
}

// Entre los certificados de una persona, el válido de ese curso (si hay varios, el más antiguo)
function certificadoValidoDeCurso(certificados, uid, cursoId, llave) {
  const id = String(cursoId);
  const validos = (Array.isArray(certificados) ? certificados : []).filter(c => {
    const dueno = String((c && (c.uid || c.memberUid)) || '');
    const curso = String((c && (c.cursoId || c.courseId)) || '');
    return dueno === uid && curso === id && certificadoValido(c, llave);
  });
  validos.sort((a, b) => (fechaIso(a.emitido) < fechaIso(b.emitido) ? -1 : fechaIso(a.emitido) > fechaIso(b.emitido) ? 1 : (String(a.folio) < String(b.folio) ? -1 : 1)));
  return validos[0] || null;
}

// ── Quiz de clase ──────────────────────────────────────────────

// Misma limpieza que hace el sitio al mostrar las preguntas (assets/js/club-quiz.js): así el número de
// preguntas que contesta la persona es el mismo que cuenta el servidor.
function preguntaValida(p) {
  const q = esObjeto(p) ? p : {};
  const enunciado = texto(q.pregunta, REGLAS_QUIZ.textoMax);
  if (!enunciado) return null;
  if (q.tipo !== 'multiple') return { pregunta: enunciado, tipo: 'vof', correcta: Number(q.correcta) === 1 ? 1 : 0 };
  const crudas = Array.isArray(q.opciones) ? q.opciones.slice(0, REGLAS_QUIZ.opcionesMax) : [];
  const opciones = [];
  const idx = Number(q.correcta);
  let correcta = -1;
  crudas.forEach((o, i) => {
    const t = texto(o, REGLAS_QUIZ.opcionMax);
    if (!t) return;
    if (i === idx) correcta = opciones.length;
    opciones.push(t);
  });
  if (opciones.length < REGLAS_QUIZ.opcionesMin || correcta < 0) return null;
  return { pregunta: enunciado, tipo: 'multiple', opciones, correcta };
}

function preguntasDeLeccion(leccion) {
  const crudas = leccion && Array.isArray(leccion.preguntas) ? leccion.preguntas : [];
  const lista = [];
  for (const p of crudas) {
    if (lista.length >= REGLAS_QUIZ.maxPreguntas) break;
    const v = preguntaValida(p);
    if (v) lista.push(v);
  }
  return lista;
}

// respuestas[i] = número de la opción elegida (o null si quedó sin contestar). Devuelve null si el formato no es válido.
function calificarQuiz(preguntas, respuestas) {
  if (!Array.isArray(respuestas) || respuestas.length !== preguntas.length) return null;
  if (respuestas.some(r => r !== null && !Number.isInteger(r))) return null;
  const detalle = preguntas.map((p, i) => ({ correcta: p.correcta, acertada: respuestas[i] === p.correcta }));
  const correctas = detalle.filter(d => d.acertada).length;
  return { aprobado: correctas === preguntas.length, correctas, total: preguntas.length, detalle };
}

// ── Progreso ───────────────────────────────────────────────────

function enteros(valor) {
  if (!Array.isArray(valor)) return [];
  return [...new Set(valor.filter(n => Number.isInteger(n) && n >= 0 && n < MAX_LECCIONES))].sort((a, b) => a - b);
}

// Lo que hay guardado en miembros/{uid}/progresoCursos/{cursoId}, ya limpio
function normalizarProgreso(doc) {
  const d = esObjeto(doc) ? doc : {};
  return {
    sesionesVistas: enteros(d.sesionesVistas),
    quizzesAprobados: enteros(d.quizzesAprobados),
    completado: d.completado === true,
    certificadoFolio: typeof d.certificadoFolio === 'string' && d.certificadoFolio ? d.certificadoFolio : null
  };
}

function todasVistas(vistas, total) {
  if (!(total > 0)) return false;
  const set = new Set(vistas);
  for (let i = 0; i < total; i++) if (!set.has(i)) return false;
  return true;
}

// Decide si se puede marcar la clase `indice` como vista. Orden de las comprobaciones (igual que Alintec):
// 1) clase válida, 2) quiz contestado, 3) clase anterior vista. Repetir una clase ya vista no cambia nada.
function evaluarAvance({ previo, indice, totalLecciones, exigeQuiz }) {
  const p = previo || normalizarProgreso(null);
  if (!Number.isInteger(indice) || indice < 0 || indice >= totalLecciones) {
    return { ok: false, status: 404, error: 'Clase no encontrada' };
  }
  const yaVista = p.sesionesVistas.includes(indice);
  if (!yaVista) {
    if (exigeQuiz && !p.quizzesAprobados.includes(indice)) {
      return { ok: false, status: 409, error: 'Aprueba el quiz de esta clase antes de completarla' };
    }
    if (indice > 0 && !p.sesionesVistas.includes(indice - 1)) {
      return { ok: false, status: 409, error: 'Completa primero la clase anterior' };
    }
  }
  const sesionesVistas = yaVista ? p.sesionesVistas : [...p.sesionesVistas, indice].sort((a, b) => a - b);
  const completa = todasVistas(sesionesVistas, totalLecciones);
  // Una vez completado no se deshace (aunque el curso gane clases después): el certificado ya existe
  return { ok: true, sesionesVistas, completado: p.completado || completa, cambia: !yaVista };
}

// ── Importación única del progreso viejo (miembros/{uid}.courseProgress) ──

// Fecha de corte (ISO) o NaN si la variable no existe o no es una fecha
function corteLegado(valor) {
  const t = Date.parse(String(valor || '').trim());
  return Number.isFinite(t) ? t : NaN;
}

function cuentaElegibleParaLegado(creacion, corte) {
  const creada = Date.parse(String(creacion || ''));
  return Number.isFinite(creada) && Number.isFinite(corte) && creada < corte;
}

// courseProgress: { [cursoId]: { completedLessons:[int], isCompleted, certificateFolio?, completedAt? } }
// cursos: Map(cursoId -> datos del curso o null) · certificados: [{ id, ...datos }] de la persona
// Devuelve { items: [{ cursoId, doc, completadoEnIso }], importadas }. Nunca emite certificados.
function planearImportacionLegado({ uid, courseProgress, cursos, certificados, llave }) {
  const items = [];
  let importadas = 0;
  if (!esObjeto(courseProgress)) return { items, importadas };
  const lista = Array.isArray(certificados) ? certificados : [];
  for (const cursoId of Object.keys(courseProgress).slice(0, MAX_CURSOS_LEGADO)) {
    if (!ID_CURSO_REGEX.test(cursoId)) continue;
    const curso = cursos instanceof Map ? cursos.get(cursoId) : null;
    const total = leccionesDe(curso).length;
    if (!total) continue;
    const viejo = courseProgress[cursoId];
    const pedidas = esObjeto(viejo) && Array.isArray(viejo.completedLessons) ? viejo.completedLessons : [];
    let vistas = [...new Set(pedidas.filter(i => Number.isInteger(i) && i >= 0 && i < total))].sort((a, b) => a - b);
    if (!vistas.length) continue;

    const delCurso = lista.filter(c => String(c.courseId || c.cursoId || '') === cursoId
      && String(c.memberUid || c.uid || '') === uid);
    const certificado = delCurso.find(c => certificadoValido(c, llave))
      || delCurso.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))[0] || null;

    // Curso terminado sin certificado: se deja la última clase pendiente para que el flujo normal
    // la complete y el servidor emita el certificado firmado.
    if (todasVistas(vistas, total) && !certificado) vistas = vistas.filter(i => i !== total - 1);
    if (!vistas.length) continue;

    const completado = todasVistas(vistas, total) && Boolean(certificado);
    const quizzes = vistas.filter(i => preguntasDeLeccion(leccionDe(curso, i)).length > 0);
    const doc = { cursoId, uid, sesionesVistas: vistas, quizzesAprobados: quizzes, origenLegado: true };
    let completadoEnIso = '';
    if (completado) {
      doc.completado = true;
      doc.certificadoFolio = String(certificado.id || certificado.folio);
      completadoEnIso = fechaIso(certificado.emitido || certificado.issuedAt) || fechaIso(viejo.completedAt);
    }
    items.push({ cursoId, doc, completadoEnIso });
    importadas += vistas.length;
  }
  return { items, importadas };
}

// Une lo que ya había en el servidor con lo importado (nunca se pierde avance)
function unirProgreso(existente, importado) {
  const e = normalizarProgreso(existente);
  return {
    sesionesVistas: enteros([...e.sesionesVistas, ...importado.sesionesVistas]),
    quizzesAprobados: enteros([...e.quizzesAprobados, ...importado.quizzesAprobados]),
    completado: e.completado || importado.completado === true,
    certificadoFolio: e.certificadoFolio || importado.certificadoFolio || null
  };
}

// ── Certificados escritos por el navegador (auditoría) ─────────

// Completa el esquema nuevo a partir de los nombres viejos, SIN borrar ninguno. Solo rellena lo que falta.
// Devuelve { ok:true, campos } o { ok:false, razon }.
function camposDesdeLegado(docId, datos) {
  const c = esObjeto(datos) ? datos : {};
  const uid = String(c.uid || c.memberUid || '');
  const cursoId = String(c.cursoId || c.courseId || '');
  const nombre = texto(c.nombre || c.memberName || '', 80);
  const curso = texto(c.curso || c.courseTitle || '', 160);
  const emitido = fechaIso(c.emitido || c.issuedAt);
  if (!UID_REGEX.test(uid)) return { ok: false, razon: 'uid-invalido' };
  if (!cursoId) return { ok: false, razon: 'curso-vacio' };
  if (!nombre || !curso) return { ok: false, razon: 'campos-obligatorios-incompletos' };
  if (!emitido) return { ok: false, razon: 'fecha-invalida' };
  const sesiones = Number.isFinite(Number(c.sesiones)) && Number(c.sesiones) > 0 ? Number(c.sesiones) : (Number(c.totalClases) || 0);
  const horas = Number.isFinite(Number(c.horas)) && Number(c.horas) > 0 ? Number(c.horas) : horasDeTexto(c.courseDuration);
  return {
    ok: true,
    campos: {
      folio: docId,
      uid,
      cursoId,
      nombre,
      curso,
      area: texto(c.area || c.courseArea || '', 80) || 'General',
      horas,
      sesiones,
      instructor: texto(c.instructor || '', 80) || INSTRUCTOR_POR_DEFECTO,
      emitido,
      year: new Date(emitido).getUTCFullYear()
    }
  };
}

// Lo que se escribe al aprobar un certificado viejo: campos nuevos + marcas de validación + firma
function parcheLegadoValidado(docId, datos, llave) {
  const r = camposDesdeLegado(docId, datos);
  if (!r.ok) return r;
  const validado = { ...r.campos, verificado: true, origen: 'legacy-validado', validadoBackend: true };
  return { ok: true, parche: { ...validado, firmaBackend: firmar(validado, llave) } };
}

// certificados: [{ id, data }] · cursosIds / miembrosIds: Set de ids · llave: CERTIFICATE_SIGNING_KEY
// Devuelve una fila por certificado: { folio, accion, razones, uid, cursoId, nombre, curso }.
// acciones: 'ya-valido' | 'revisar-manualmente' (se puede aprobar con la lista) | 'rechazar'
function auditarCertificados({ certificados, cursosIds, miembrosIds, llave }) {
  const lista = (Array.isArray(certificados) ? certificados : []).map(({ id, data }) => {
    const d = data || {};
    return {
      id, data: d,
      uid: String(d.uid || d.memberUid || ''),
      cursoId: String(d.cursoId || d.courseId || ''),
      valido: certificadoValido(d, llave) && String(d.folio || '') === id
    };
  });

  // Duplicados: una persona y un curso con más de un certificado. Se conserva el válido, o el más antiguo.
  const porClave = new Map();
  for (const c of lista) {
    if (!c.uid || !c.cursoId) continue;
    const k = `${c.uid}|${c.cursoId}`;
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(c);
  }
  const duplicados = new Set();
  for (const grupo of porClave.values()) {
    if (grupo.length < 2) continue;
    const orden = grupo.slice().sort((a, b) => {
      if (a.valido !== b.valido) return a.valido ? -1 : 1;
      const fa = fechaIso(a.data.emitido || a.data.issuedAt) || '9999';
      const fb = fechaIso(b.data.emitido || b.data.issuedAt) || '9999';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    for (const sobrante of orden.slice(1)) duplicados.add(sobrante.id);
  }

  return lista.map(c => {
    const razones = [];
    if (!c.valido) {
      if (!FOLIO_REGEX.test(c.id)) razones.push('folio-con-formato-invalido');
      if (c.data.folio && String(c.data.folio) !== c.id) razones.push('folio-inconsistente');
      if (!c.uid || !miembrosIds.has(c.uid)) razones.push('miembro-no-encontrado');
      if (!c.cursoId || !cursosIds.has(c.cursoId)) razones.push('curso-no-encontrado');
      const r = camposDesdeLegado(c.id, c.data);
      if (!r.ok && r.razon !== 'uid-invalido' && r.razon !== 'curso-vacio') razones.push(r.razon);
      if (duplicados.has(c.id)) razones.push('duplicado-uid-curso');
    }
    const accion = c.valido ? 'ya-valido' : (razones.length ? 'rechazar' : 'revisar-manualmente');
    return {
      folio: c.id, accion, razones, uid: c.uid, cursoId: c.cursoId,
      nombre: String(c.data.nombre || c.data.memberName || ''), curso: String(c.data.curso || c.data.courseTitle || '')
    };
  });
}

module.exports = {
  FOLIO_REGEX, ID_CURSO_REGEX, UID_REGEX, INSTRUCTOR_POR_DEFECTO, MAX_LECCIONES, MAX_CURSOS_LEGADO, REGLAS_QUIZ,
  fechaIso, folioCertificado, normalizarFolio,
  datosFirma, firmar, firmaValida, certificadoValido, certificadoPublico,
  leccionesDe, leccionDe, tituloDeCurso, areaDeCurso, instructorDeCurso, duracionDeCurso, horasDeTexto, horasDeCurso,
  nombreParaCertificado, correoDeMiembro,
  construirCertificado, certificadoValidoDeCurso,
  preguntasDeLeccion, calificarQuiz,
  normalizarProgreso, evaluarAvance, todasVistas,
  corteLegado, cuentaElegibleParaLegado, planearImportacionLegado, unirProgreso,
  camposDesdeLegado, parcheLegadoValidado, auditarCertificados
};
