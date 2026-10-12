'use strict';

// ══ CERTIFICADOS Y PROGRESO DE CURSOS · reglas puras ══
// Aquí no hay Express ni Firestore: solo reglas que se prueban en Node. Las rutas están en
// services/rutas-certificados.js y el script de auditoría (scripts/auditar-certificados.js) solo
// llama a estas funciones.
//
// Idea general (igual que en Alintec): el servidor es la única fuente de verdad del avance y de los
// certificados. Un certificado vale solo si lleva una firma HMAC-SHA256 hecha con CERTIFICATE_SIGNING_KEY
// sobre `folio\nuid\ncursoId\nemitido\nyear`; los que escribía el navegador no la tienen: si pasan la revisión de
// certificadoAnteriorAceptable el servidor los acepta y los firma en su lugar (sin acción manual); el script de
// auditoría es solo una revisión global opcional.

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

// ── Certificados anteriores: aceptación SIN acción manual ───────
// Los certificados que ya escribió el navegador (usuarios reales, ya impresos o compartidos) no llevan firma.
// En vez de dejarlos "en validación" hasta que alguien corra la auditoría, el servidor los acepta cuando pasan
// una revisión objetiva (esta función) y los firma EN SU LUGAR cuando su titular abre el sitio. Un único
// criterio: lo usan la verificación pública, el progreso, la finalización de curso, la ruta de administrador
// y el script de auditoría.

const TOLERANCIA_FUTURO_MS = 24 * 60 * 60 * 1000;

// CERTIFICADOS_ANTERIORES_HASTA -> milisegundos. Sin definir (modo transición): Infinity, no hay límite.
// Definida pero que no es una fecha: NaN (se rechaza todo anterior; es más seguro que abrir la ventana por un error de dedo).
function limiteEnMs(valor) {
  if (valor === undefined || valor === null) return Infinity;
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === 'number') return valor === Infinity ? Infinity : (Number.isFinite(valor) ? valor : NaN);
  const s = String(valor).trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return Infinity;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

const tieneFirma = d => d.firmaBackend !== undefined && d.firmaBackend !== null && d.firmaBackend !== '';
const comoPredicado = v => (typeof v === 'function' ? id => Boolean(v(id)) : () => Boolean(v));

// Decide si un certificado SIN firma válida puede aceptarse como anterior. Pura.
//   doc: los datos del documento (si trae `id`, se usa como id del documento)
//   opciones: { id, cursoExiste, miembroExiste, ahora, limite }
//     cursoExiste / miembroExiste: boolean, o función (id) => boolean
//     ahora: Date (por defecto la actual) · limite: ISO / Date / ms; sin valor no hay límite de fecha
// Devuelve { aceptable, razones:[...], campos|null, uid, cursoId, emitido } (campos = esquema nuevo ya normalizado).
// Un documento con firmaBackend (válida o no) nunca es "anterior": si la firma es válida lo reconoce
// certificadoValido y si no lo es, se trata como alteración.
function certificadoAnteriorAceptable(doc, opciones = {}) {
  const d = esObjeto(doc) ? doc : {};
  const op = esObjeto(opciones) ? opciones : {};
  const id = String(op.id !== undefined && op.id !== null ? op.id : (d.id !== undefined && d.id !== null ? d.id : ''));
  const cursoExiste = comoPredicado(op.cursoExiste);
  const miembroExiste = comoPredicado(op.miembroExiste);
  const ahora = op.ahora instanceof Date && !Number.isNaN(op.ahora.getTime()) ? op.ahora : new Date();
  const limite = limiteEnMs(op.limite);
  const razones = [];

  if (tieneFirma(d)) razones.push('firma-alterada');

  if (!FOLIO_REGEX.test(id)) razones.push('folio-con-formato-invalido');
  if (!d.folio || String(d.folio) !== id) razones.push('folio-inconsistente');

  const uidA = String(d.uid || '');
  const uidB = String(d.memberUid || '');
  const cursoA = String(d.cursoId || '');
  const cursoB = String(d.courseId || '');
  if (uidA && uidB && uidA !== uidB) razones.push('titular-inconsistente');
  if (cursoA && cursoB && cursoA !== cursoB) razones.push('curso-inconsistente');
  const uid = uidA || uidB;
  const cursoId = cursoA || cursoB;

  if (!uid) razones.push('miembro-no-encontrado');
  else if (!UID_REGEX.test(uid)) razones.push('uid-invalido');
  else if (!miembroExiste(uid)) razones.push('miembro-no-encontrado');

  if (!cursoId) razones.push('curso-no-encontrado');
  else if (!ID_CURSO_REGEX.test(cursoId)) razones.push('curso-invalido');
  else if (!cursoExiste(cursoId)) razones.push('curso-no-encontrado');

  const r = camposDesdeLegado(id, d);
  if (!r.ok && r.razon !== 'uid-invalido' && r.razon !== 'curso-vacio') razones.push(r.razon);
  const campos = r.ok ? r.campos : null;

  const emitido = campos ? campos.emitido : '';
  if (emitido) {
    const t = Date.parse(emitido);
    if (t > ahora.getTime() + TOLERANCIA_FUTURO_MS) razones.push('fecha-futura');
    if (Number.isNaN(limite)) razones.push('limite-invalido');
    else if (t > limite) razones.push('posterior-al-limite');
  }

  const aceptable = razones.length === 0 && Boolean(campos);
  return { aceptable, razones, campos: aceptable ? campos : null, uid, cursoId, emitido };
}

// Evalúa un conjunto de certificados (todos los de la colección, o los de una persona).
//   docs: [{ id, data }] · contexto: { llave, cursoExiste, miembroExiste, ahora, limite }
// Una fila por documento: { id, folio, uid, cursoId, estado, razones, campos, emitido, data }
//   estado: 'firmado' (firma válida) | 'aceptable' (anterior que el servidor firmará) | 'no-aceptable'
// Duplicados: una persona y un curso con más de un certificado vigente conservan uno (el firmado o, si no, el más
// antiguo); los demás anteriores quedan 'no-aceptable' con la razón 'duplicado-uid-curso'.
function evaluarCertificados(docs, contexto = {}) {
  const ctx = esObjeto(contexto) ? contexto : {};
  const filas = (Array.isArray(docs) ? docs : []).map(({ id, data }) => {
    const d = esObjeto(data) ? data : {};
    const folioId = String(id);
    const base = {
      id: folioId, folio: folioId,
      uid: String(d.uid || d.memberUid || ''), cursoId: String(d.cursoId || d.courseId || ''),
      emitido: fechaIso(d.emitido || d.issuedAt), data: d
    };
    if (String(d.folio || '') === folioId && certificadoValido(d, ctx.llave)) {
      return { ...base, estado: 'firmado', razones: [], campos: null };
    }
    const r = certificadoAnteriorAceptable(d, {
      id: folioId, cursoExiste: ctx.cursoExiste, miembroExiste: ctx.miembroExiste, ahora: ctx.ahora, limite: ctx.limite
    });
    return { ...base, estado: r.aceptable ? 'aceptable' : 'no-aceptable', razones: r.razones, campos: r.campos };
  });

  const grupos = new Map();
  for (const f of filas) {
    if (f.estado === 'no-aceptable' || !f.uid || !f.cursoId) continue;
    const k = `${f.uid}|${f.cursoId}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(f);
  }
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    grupo.sort(compararVigentes);
    for (const sobrante of grupo.slice(1)) {
      if (sobrante.estado === 'aceptable') {
        sobrante.estado = 'no-aceptable';
        sobrante.razones = [...sobrante.razones, 'duplicado-uid-curso'];
        sobrante.campos = null;
      }
    }
  }
  return filas;
}

// Orden de preferencia entre certificados vigentes de una misma persona y curso: el firmado, luego el más antiguo
function compararVigentes(a, b) {
  if ((a.estado === 'firmado') !== (b.estado === 'firmado')) return a.estado === 'firmado' ? -1 : 1;
  const fa = a.emitido || '9999';
  const fb = b.emitido || '9999';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

// Lo que se escribe al firmar en su lugar un certificado anterior aceptable: la normalización y firma de la
// auditoría más la marca de que fue automática. No borra ni cambia ningún campo viejo.
function parcheAnteriorAutomatico(docId, datos, llave) {
  const r = parcheLegadoValidado(docId, datos, llave);
  if (!r.ok) return r;
  return { ok: true, parche: { ...r.parche, migradoAutomaticamente: true } };
}

// Progreso coherente con los certificados vigentes de una persona (firmados o anteriores aceptables).
//   vigentes: [{ id, cursoId, emitido }] · progresos: Map(cursoId -> datos crudos del progreso | null)
//   cursos: Map(cursoId -> datos del curso | null)
// Devuelve [{ cursoId, folio, vista, escribir, doc }]:
//   vista: lo que ve la persona { sesionesVistas, quizzesAprobados, completado:true, certificadoFolio, completadoEn }
//   escribir/doc: si hay que guardarlo en miembros/{uid}/progresoCursos/{cursoId} (merge) y qué guardar.
// Idempotente: con el progreso ya coherente `escribir` es false. Nunca quita avance.
function planearProgresoDesdeCertificados({ uid, vigentes, progresos, cursos }) {
  const porCurso = new Map();
  for (const v of Array.isArray(vigentes) ? vigentes : []) {
    if (!v || !v.cursoId || !v.id) continue;
    if (!porCurso.has(v.cursoId)) porCurso.set(v.cursoId, []);
    porCurso.get(v.cursoId).push(v);
  }
  const salida = [];
  for (const [cursoId, lista] of porCurso) {
    lista.sort((a, b) => {
      const fa = a.emitido || '9999';
      const fb = b.emitido || '9999';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    const crudo = progresos instanceof Map && esObjeto(progresos.get(cursoId)) ? progresos.get(cursoId) : null;
    const p = normalizarProgreso(crudo);
    const elegido = lista.find(v => v.id === p.certificadoFolio) || lista[0];
    const curso = cursos instanceof Map ? cursos.get(cursoId) : null;
    const total = leccionesDe(curso).length;
    const todas = Array.from({ length: total }, (_, i) => i);
    const propia = crudo ? fechaIso(crudo.completadoEn) : '';
    const completadoEn = propia || elegido.emitido || null;

    // Con el curso ya completado se respeta lo guardado; si no, todas las clases cuentan como vistas
    const completarClases = !crudo || !p.completado;
    const sesionesVistas = completarClases ? enteros([...p.sesionesVistas, ...todas]) : p.sesionesVistas;
    const quizzesAprobados = !crudo
      ? todas.filter(i => preguntasDeLeccion(leccionDe(curso, i)).length > 0)
      : p.quizzesAprobados;
    const vista = { sesionesVistas, quizzesAprobados, completado: true, certificadoFolio: elegido.id, completadoEn };

    const coherente = Boolean(crudo) && p.completado && p.certificadoFolio === elegido.id && (Boolean(propia) || !elegido.emitido);
    // Un curso que ya no existe y sin progreso previo: se muestra, pero no hay nada coherente que guardar
    const escribir = !coherente && (Boolean(crudo) || Boolean(curso));
    const item = { cursoId, folio: elegido.id, vista, escribir, doc: null };
    if (escribir) {
      item.doc = { cursoId, uid, completado: true, certificadoFolio: elegido.id, origenLegado: true };
      if (completarClases) {
        item.doc.sesionesVistas = sesionesVistas;
        if (!crudo) item.doc.quizzesAprobados = quizzesAprobados;
      }
      if (!propia && elegido.emitido) item.doc.completadoEnIso = elegido.emitido;
    }
    salida.push(item);
  }
  return salida;
}

// certificados: [{ id, data }] · cursosIds / miembrosIds: Set de ids · llave: CERTIFICATE_SIGNING_KEY
// ahora / limite (opcionales): los mismos que usa el servidor (CERTIFICADOS_ANTERIORES_HASTA)
// Devuelve una fila por certificado: { folio, accion, aceptable, razones, uid, cursoId, nombre, curso, emitido }.
// acciones: 'ya-valido' | 'revisar-manualmente' (aceptable: se puede aprobar con la lista) | 'rechazar'
function auditarCertificados({ certificados, cursosIds, miembrosIds, llave, ahora, limite }) {
  const filas = evaluarCertificados(
    (Array.isArray(certificados) ? certificados : []).map(({ id, data }) => ({ id, data: data || {} })),
    {
      llave, ahora, limite,
      cursoExiste: id => Boolean(cursosIds && cursosIds.has(id)),
      miembroExiste: id => Boolean(miembrosIds && miembrosIds.has(id))
    }
  );
  return filas.map(f => ({
    folio: f.id,
    accion: f.estado === 'firmado' ? 'ya-valido' : (f.estado === 'aceptable' ? 'revisar-manualmente' : 'rechazar'),
    aceptable: f.estado === 'aceptable',
    razones: f.razones,
    uid: f.uid,
    cursoId: f.cursoId,
    nombre: String(f.data.nombre || f.data.memberName || ''),
    curso: String(f.data.curso || f.data.courseTitle || ''),
    emitido: f.emitido
  }));
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
  camposDesdeLegado, parcheLegadoValidado, auditarCertificados,
  TOLERANCIA_FUTURO_MS, limiteEnMs, certificadoAnteriorAceptable, evaluarCertificados, compararVigentes,
  parcheAnteriorAutomatico, planearProgresoDesdeCertificados
};
