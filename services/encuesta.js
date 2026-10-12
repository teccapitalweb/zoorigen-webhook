'use strict';

// ══ REGLAS PURAS: catálogo público, encuesta de la portada y preguntas sin respuesta del chatbot ══
// Sin Firebase y sin red: services/rutas-publico.js las usa en las rutas públicas y en las de
// administrador, y test/encuesta.test.js las prueba directamente.
//
// Privacidad: lo que llega de una persona anónima se guarda solo después de pasar por estas
// reglas (lista blanca de claves, largos fijos, texto del chatbot sin correos, teléfonos ni URLs).

const crypto = require('crypto');
const { limpiarTexto, recortar, texto, aIso } = require('./texto');
const { resumirCurso } = require('./prueba-gratuita');

// ── Encuesta ─────────────────────────────────────────────────────────────

// Únicas claves que puede traer `respuestas` (ver la sección 3 de la especificación).
const CLAVES_RESPUESTA = Object.freeze([
  'meta', 'p1', 'origen', 'grupo', 'p2', 'p2b', 'tamano', 'experiencia', 'urgencia', 'freno'
]);
const MAX_SESSION_ID = 100;
const MAX_VALOR_RESPUESTA = 80;
const MAX_AVISO_VERSION = 40;

// Número de WhatsApp: acepta que lo escriban con +, espacios, guiones o paréntesis, pero guarda solo
// dígitos y exige de 8 a 15 (formato internacional). Devuelve '' si no es válido.
function normalizarNumero(valor) {
  if (typeof valor !== 'string') return '';
  const t = valor.trim();
  if (!/^\+?[0-9 ()\-.]+$/.test(t)) return '';
  const digitos = t.replace(/\D/g, '');
  return /^[0-9]{8,15}$/.test(digitos) ? digitos : '';
}

const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Valida el cuerpo de POST /api/encuesta.
// Devuelve { ok: false, error } o { ok: true, ignorar, valor } con valor =
//   { sessionId, respuestas, completada, contacto?: '<solo dígitos>', avisoAceptado?: true, avisoVersion?: '...' }
// `ignorar` es true cuando no hay respuestas ni contacto: no vale la pena guardar un documento vacío.
function validarEncuesta(cuerpo) {
  if (!esObjeto(cuerpo)) return { ok: false, error: 'Los datos enviados no son válidos' };

  const sessionId = typeof cuerpo.sessionId === 'string' ? limpiarTexto(cuerpo.sessionId) : '';
  if (!sessionId || sessionId.length > MAX_SESSION_ID) {
    return { ok: false, error: `sessionId debe ser texto de 1 a ${MAX_SESSION_ID} caracteres` };
  }

  if (!esObjeto(cuerpo.respuestas)) return { ok: false, error: 'respuestas debe ser un objeto' };
  const respuestas = {};
  for (const [clave, valor] of Object.entries(cuerpo.respuestas)) {
    if (!CLAVES_RESPUESTA.includes(clave)) return { ok: false, error: `La respuesta "${recortar(clave, 30)}" no está permitida` };
    const limpio = typeof valor === 'string' ? limpiarTexto(valor) : '';
    if (!limpio) return { ok: false, error: `La respuesta "${clave}" debe ser texto` };
    if (limpio.length > MAX_VALOR_RESPUESTA) {
      return { ok: false, error: `La respuesta "${clave}" no puede pasar de ${MAX_VALOR_RESPUESTA} caracteres` };
    }
    respuestas[clave] = limpio;
  }

  if (typeof cuerpo.completada !== 'boolean') return { ok: false, error: 'completada debe ser verdadero o falso' };

  const valor = { sessionId, respuestas, completada: cuerpo.completada };

  if (cuerpo.contacto !== undefined && cuerpo.contacto !== null) {
    const c = cuerpo.contacto;
    if (!esObjeto(c)) return { ok: false, error: 'contacto debe ser un objeto' };
    const numero = normalizarNumero(c.numero);
    if (!numero) return { ok: false, error: 'El número debe tener solo dígitos, de 8 a 15' };
    if (c.avisoAceptado !== true) return { ok: false, error: 'Falta aceptar el aviso de privacidad' };
    const version = typeof c.avisoVersion === 'string' ? limpiarTexto(c.avisoVersion) : '';
    if (!version || version.length > MAX_AVISO_VERSION) {
      return { ok: false, error: `avisoVersion debe ser texto de 1 a ${MAX_AVISO_VERSION} caracteres` };
    }
    valor.contacto = numero;
    valor.avisoAceptado = true;
    valor.avisoVersion = version;
  }

  return { ok: true, ignorar: !Object.keys(respuestas).length && !valor.contacto, valor };
}

// ── Preguntas sin respuesta del chatbot ──────────────────────────────────

const MAX_TEXTO_CHATBOT = 120;
const MAX_ENTRADA_CHATBOT = 1000;   // antes de limpiar: evita trabajar con textos enormes
const MIN_TEXTO_CHATBOT = 3;
const MAX_CLAVE = 80;
const TIPOS_CHATBOT = Object.freeze(['animal', 'otro']);

const DOMINIOS = 'com|mx|org|net|edu|gob|gov|io|co|info|app|dev|me|tv|ly|us|es|ar|cl|pe|biz|xyz|site|online|store|shop|link|page';
const RE_CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RE_URL = new RegExp(
  '\\b(?:https?:\\/\\/|www\\.)\\S+|\\b[a-z0-9-]{2,}(?:\\.[a-z0-9-]+)*\\.(?:' + DOMINIOS + ')\\b(?:\\/\\S*)?', 'gi'
);
const RE_USUARIO = /(^|\s)@[A-Za-z0-9_.]{2,}/g;
// 7 o más dígitos, aunque vengan separados por espacios, guiones, puntos o paréntesis
const RE_TELEFONO = /\+?\d(?:[\s().-]{0,2}\d){6,}/g;

// Texto de la pregunta listo para guardar: sin correos, usuarios, URLs ni teléfonos, de una sola línea y
// de máximo 120 caracteres. Devuelve '' si lo que queda es demasiado corto.
function limpiarTextoChatbot(valor) {
  if (typeof valor !== 'string') return '';
  let t = limpiarTexto(valor.slice(0, MAX_ENTRADA_CHATBOT));
  t = t.replace(RE_CORREO, ' ').replace(RE_URL, ' ').replace(RE_USUARIO, '$1').replace(RE_TELEFONO, ' ');
  t = t.replace(/\s+/g, ' ').replace(/\s+([,;:.])/g, '$1').trim();
  t = recortar(t, MAX_TEXTO_CHATBOT).trim();
  return t.length < MIN_TEXTO_CHATBOT ? '' : t;
}

// Clave del documento chatbotSinRespuesta/{clave}: minúsculas, sin acentos, solo letras y números con
// espacios simples, máximo 80 caracteres (si es más largo, se corta y se agrega un hash corto).
function claveChatbot(valor) {
  const base = String(valor == null ? '' : valor).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (base.length <= MAX_CLAVE) return base;
  const hash = crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `${base.slice(0, MAX_CLAVE - 9).trimEnd()}-${hash}`;
}

// Valida el cuerpo de POST /api/chatbot/sin-respuesta.
// Devuelve { ok: false, error } o { ok: true, ignorar: true } (texto sin contenido útil: se responde ok y no se guarda)
// o { ok: true, ignorar: false, valor: { clave, ejemplo, tipo } }.
function validarSinRespuesta(cuerpo) {
  if (!esObjeto(cuerpo)) return { ok: false, error: 'Los datos enviados no son válidos' };
  if (typeof cuerpo.texto !== 'string') return { ok: false, error: 'texto debe ser un texto' };
  let tipo = 'otro';
  if (cuerpo.tipo !== undefined && cuerpo.tipo !== null) {
    if (!TIPOS_CHATBOT.includes(cuerpo.tipo)) return { ok: false, error: 'tipo debe ser "animal" u "otro"' };
    tipo = cuerpo.tipo;
  }
  const ejemplo = limpiarTextoChatbot(cuerpo.texto);
  const clave = ejemplo ? claveChatbot(ejemplo) : '';
  if (!ejemplo || !clave) return { ok: true, ignorar: true };
  return { ok: true, ignorar: false, valor: { clave, ejemplo, tipo } };
}

// Documento nuevo o actualizado de chatbotSinRespuesta/{clave}. `previo` es el dato guardado (o null);
// `ahora` es lo que se escribe como fecha (serverTimestamp en producción).
function combinarSinRespuesta(previo, { ejemplo, tipo }, ahora) {
  const p = esObjeto(previo) ? previo : null;
  const veces = p && Number.isFinite(Number(p.veces)) && Number(p.veces) > 0 ? Math.floor(Number(p.veces)) : 0;
  return {
    ejemplo: p && typeof p.ejemplo === 'string' && p.ejemplo ? p.ejemplo : ejemplo,
    tipo,
    veces: veces + 1,
    primeraVez: p && p.primeraVez ? p.primeraVez : ahora,
    ultimaVez: ahora
  };
}

// ── Lectura para el panel de administración ───────────────────────────────

function limiteDeConsulta(valor, defecto, maximo) {
  const n = Number.parseInt(Array.isArray(valor) ? valor[0] : valor, 10);
  if (!Number.isFinite(n) || n < 1) return defecto;
  return Math.min(n, maximo);
}

// Documento de encuestasProspectos -> fila para el panel. Solo campos conocidos; `creado` en ISO.
function filaEncuesta(datos) {
  const d = esObjeto(datos) ? datos : {};
  const fila = {
    sessionId: texto(d.sessionId, MAX_SESSION_ID),
    respuestas: {},
    completada: d.completada === true,
    creado: aIso(d.creado) || null
  };
  if (esObjeto(d.respuestas)) {
    for (const clave of CLAVES_RESPUESTA) {
      if (typeof d.respuestas[clave] === 'string') fila.respuestas[clave] = texto(d.respuestas[clave], MAX_VALOR_RESPUESTA);
    }
  }
  if (typeof d.contacto === 'string' && d.contacto) fila.contacto = texto(d.contacto, 20);
  if (d.avisoAceptado === true) fila.avisoAceptado = true;
  if (typeof d.avisoVersion === 'string' && d.avisoVersion) fila.avisoVersion = texto(d.avisoVersion, MAX_AVISO_VERSION);
  return fila;
}

// Documento de chatbotSinRespuesta -> fila para el panel.
function filaSinRespuesta(datos) {
  const d = esObjeto(datos) ? datos : {};
  const veces = Number(d.veces);
  return {
    texto: texto(d.ejemplo, MAX_TEXTO_CHATBOT),
    veces: Number.isFinite(veces) && veces > 0 ? Math.floor(veces) : 0,
    ultimaVez: aIso(d.ultimaVez) || null,
    tipo: TIPOS_CHATBOT.includes(d.tipo) ? d.tipo : 'otro'
  };
}

// ── Catálogo público de cursos ───────────────────────────────────────────

// Campos opcionales que, si existen en el curso, lo ocultan del catálogo público. Hoy el panel no los
// crea (todos los cursos de `cursos` se ven en la biblioteca), pero se respetan por si se agregan.
const ESTADOS_OCULTOS = new Set(['oculto', 'oculta', 'borrador', 'archivado', 'archivada', 'inactivo', 'inactiva', 'retirado', 'retirada']);

function cursoOculto(curso) {
  if (curso.oculto === true || curso.archivado === true || curso.borrador === true) return true;
  if (curso.visible === false || curso.publicado === false || curso.activo === false) return true;
  return typeof curso.estado === 'string' && ESTADOS_OCULTOS.has(curso.estado.trim().toLowerCase());
}

// Número de clases: las lecciones guardadas; en cursos viejos, totalClases o el video único (driveId).
function contarClases(curso) {
  if (Array.isArray(curso.lecciones) && curso.lecciones.length) return curso.lecciones.length;
  const total = Number(curso.totalClases);
  if (Number.isInteger(total) && total > 0) return total;
  return typeof curso.driveId === 'string' && curso.driveId.trim() ? 1 : 0;
}

// Un curso de `cursos` -> entrada pública, o null si no se muestra. NUNCA copia videoId, urls,
// preguntas ni respuestas: solo estos campos.
//   elegiblePrueba: ¿se puede elegir como prueba gratuita? (misma regla que /api/prueba-gratuita)
function cursoPublico(id, datos, esVideoGratisFijo = () => false) {
  const curso = esObjeto(datos) ? datos : null;
  if (!curso || !id || cursoOculto(curso)) return null;
  const titulo = texto(curso.title || curso.titulo, 160);
  if (!titulo) return null;
  const proximamente = curso.proximamente === true || curso.pronto === true;
  const clases = contarClases(curso);
  if (!clases && !proximamente) return null;
  return {
    id: String(id),
    titulo,
    area: texto(curso.area, 80),
    descripcion: texto(curso.description || curso.descripcion, 400),
    clases,
    proximamente,
    elegiblePrueba: resumirCurso(curso, esVideoGratisFijo).elegible
  };
}

// Orden igual al de la biblioteca: primero los de siempre (el más nuevo primero) y después los que
// tienen ordenVip, por ese número.
function ordenarCatalogo(entradas) {
  const lista = entradas.map(({ datos, publico }) => ({
    publico,
    orden: typeof datos.ordenVip === 'number' && Number.isFinite(datos.ordenVip) ? datos.ordenVip : null,
    creado: aIso(datos.createdAt) || ''
  }));
  return lista.sort((a, b) => {
    if ((a.orden === null) !== (b.orden === null)) return a.orden === null ? -1 : 1;
    if (a.orden !== null) return (a.orden - b.orden) || a.publico.id.localeCompare(b.publico.id);
    if (a.creado !== b.creado) return a.creado < b.creado ? 1 : -1;
    return a.publico.id.localeCompare(b.publico.id);
  }).map(x => x.publico);
}

// Lista pública a partir de [{ id, datos }].
function catalogoPublico(documentos, esVideoGratisFijo) {
  const entradas = [];
  for (const { id, datos } of documentos) {
    const publico = cursoPublico(id, datos, esVideoGratisFijo);
    if (publico) entradas.push({ id, datos, publico });
  }
  return ordenarCatalogo(entradas);
}

module.exports = {
  CLAVES_RESPUESTA, MAX_SESSION_ID, MAX_VALOR_RESPUESTA, MAX_TEXTO_CHATBOT, TIPOS_CHATBOT,
  normalizarNumero, validarEncuesta,
  limpiarTextoChatbot, claveChatbot, validarSinRespuesta, combinarSinRespuesta,
  limiteDeConsulta, filaEncuesta, filaSinRespuesta,
  cursoPublico, catalogoPublico
};
