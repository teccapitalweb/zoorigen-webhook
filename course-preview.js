'use strict';

const INITIAL_COURSE_TITLE = 'Biología, Ecología y Conservación de Tiburones y Rayas';
const INITIAL_COURSE_KEY = 'tiburones-y-rayas';

// El catálogo del servidor decide el curso inicial y su última clase. Nunca
// se aceptan listas de clases gratuitas ni estados de pago del navegador.
function buildPreviewPolicy(catalog, title = INITIAL_COURSE_TITLE) {
  const matches = catalog.filter(course => course.title === title);
  const course = matches.length === 1 ? matches[0] : null;
  const lessons = Array.isArray(course?.lecciones) ? course.lecciones.slice() : [];
  lessons.sort((a, b) => Number(a.num) - Number(b.num));
  const valid = lessons.every((lesson, index) => Number(lesson.num) === index + 1 &&
    typeof lesson.videoId === 'string' && lesson.videoId.length > 0) &&
    new Set(lessons.map(lesson => lesson.videoId)).size === lessons.length;
  const ordered = valid ? lessons : [];
  // Un video usado además en contenido de pago nunca se libera por accidente.
  const protectedIds = new Set(catalog.filter(other => other !== course)
    .flatMap(other => other.lecciones || []).map(lesson => lesson.videoId));
  const freeVideoIds = ordered.slice(0, -1).map(lesson => lesson.videoId)
    .filter(videoId => !protectedIds.has(videoId));
  return {
    version: 1,
    courseKey: INITIAL_COURSE_KEY,
    courseTitle: title,
    lessonCount: ordered.length,
    freeVideoIds,
    lecciones: ordered.map(lesson => ({
      num: Number(lesson.num), titulo: lesson.titulo || `Clase ${lesson.num}`,
      provider: 'bunny', videoId: lesson.videoId
    }))
  };
}

function canWatchPreview(policy, courseKey, videoId) {
  return courseKey === policy.courseKey && policy.freeVideoIds.includes(videoId);
}

module.exports = { buildPreviewPolicy, canWatchPreview, INITIAL_COURSE_TITLE, INITIAL_COURSE_KEY };
