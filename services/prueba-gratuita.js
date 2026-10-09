'use strict';

// ══ PRUEBA GRATUITA DE UN CURSO A ELECCIÓN ══
// Reglas puras (sin Firebase, sin red) para decidir quién puede elegir su prueba y qué
// cursos se pueden elegir. server.js las usa en los endpoints /api/prueba-gratuita y en
// /api/bunny/embed-token. Se prueban en test/prueba-gratuita.test.js.

const VIDEO_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mensajes que ve la persona (se devuelven tal cual en `motivo`).
const MOTIVOS_PRUEBA = Object.freeze({
  admin: 'Las cuentas de administrador ya tienen todos los cursos abiertos',
  'sin-registro': 'No encontramos tu registro de miembro',
  'ya-elegida': 'Ya elegiste tu prueba gratuita y no se puede cambiar',
  membresia: 'Ya cuentas con una membresía activa',
  'ya-pago': 'Tu cuenta ya tuvo una membresía, por eso no aplica la prueba gratuita',
  'sin-cursos': 'Todavía no hay cursos disponibles para elegir'
});

const tieneValor = v => v !== undefined && v !== null && v !== '' && v !== false;

// ¿Hay rastro de que esta persona pagó o tuvo un plan alguna vez? Se revisan `miembros` y el
// documento legado `usuarios`. Es deliberadamente conservadora: ante cualquier señal de plan
// se considera que SÍ lo tuvo, para no regalarle una prueba a quien ya fue (o es) cliente.
//
// NO es señal `stripeCustomerId`: Stripe lo crea al abrir el pago aunque nunca se complete.
// Es más amplia que club.js → calculateStatus() === 'pending_payment' (la cuenta de "nunca
// pagaron" del panel): todo lo que ahí cuenta como "nunca pagó" lo es aquí también, salvo
// los casos con `planActivo: true` o un estado de cobro, que aquí se tratan como "ya tuvo plan".
function huboPlan(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const campos = [
    'planVence', 'fechaExpiracion',           // fecha de fin de periodo (Stripe, Shopify, manual)
    'planInicio', 'fechaActivacion',          // inicio de plan
    'ultimoPago',                             // algún cobro confirmado
    'stripeSubscriptionId', 'stripeSubscriptionStatus',
    'planTipo', 'tipoPlan',                   // mensual / anual
    'activadoManualmente',                    // alta hecha a mano
    'shopifyOrderId', 'viaShopify',           // sistema anterior (Shopify)
    'canceladoEn', 'fechaCancelacion',        // cancelar implica que hubo plan
  ];
  if (campos.some(campo => tieneValor(doc[campo]))) return true;
  if (doc.planActivo === true || doc.planCancelado === true) return true;
  // Un planStatus real (active, cancelled, expired, past_due...) indica plan; 'pending_payment' no.
  return typeof doc.planStatus === 'string' && doc.planStatus !== '' && doc.planStatus !== 'pending_payment';
}

// true solo si el registro de miembro existe y NINGUNO de los dos documentos muestra plan.
// Sin registro de miembro no hay evidencia suficiente, así que devuelve false.
function nuncaHaTenidoPlan(miembro, usuario = null) {
  if (!miembro || typeof miembro !== 'object') return false;
  return !huboPlan(miembro) && !huboPlan(usuario);
}

// Resumen por curso que arma server.js al leer `cursos` (ver leerIndiceVideosDeFirestore).
// `curso` es el documento tal cual está en Firestore.
function resumirCurso(curso, esVideoGratisFijo) {
  const lecciones = Array.isArray(curso && curso.lecciones) ? curso.lecciones : [];
  const ids = lecciones.map(l => {
    const id = l && typeof l.videoId === 'string' ? l.videoId.trim() : '';
    return VIDEO_ID_REGEX.test(id) ? id : '';
  });
  const proveedoresValidos = lecciones.every(l => {
    const p = l && typeof l.provider === 'string' ? l.provider.trim().toLowerCase() : '';
    return p === '' || p === 'bunny';
  });
  // "Curso por defecto": el que trae el video gratis fijo o el marcado como curso de muestra.
  const porDefecto = Boolean(curso && curso.cursoMuestraGratis === true) || ids.some(id => id && esVideoGratisFijo(id));
  const sinRepetidos = new Set(ids).size === ids.length;
  const elegible = Boolean(
    ids.length >= 2 && ids.every(Boolean) && sinRepetidos && proveedoresValidos &&
    !porDefecto && !(curso && curso.disponibleSiempre === true)
  );
  const ultimo = ids.length ? ids[ids.length - 1] : '';
  // Gratis en la prueba: todas menos la última (aunque su video se repitiera antes, se bloquea).
  const gratisPrueba = new Set(ids.slice(0, -1).filter(id => id && id !== ultimo));
  return {
    ids, elegible, porDefecto, gratisPrueba,
    orden: typeof (curso && curso.ordenVip) === 'number' && Number.isFinite(curso.ordenVip) ? curso.ordenVip : null,
  };
}

// De un Map(cursoId -> resumen) saca los ids elegibles (por ordenVip y luego en el orden leído)
// y el id del curso por defecto (el del video gratis fijo si existe; si no, el primero de muestra).
function resumenDeCursos(cursos, esVideoGratisFijo) {
  const entradas = [...cursos.entries()];
  const elegibles = entradas
    .map(([id, c], posicion) => ({ id, c, posicion }))
    .filter(x => x.c.elegible)
    .sort((a, b) => {
      const oa = a.c.orden === null ? Infinity : a.c.orden;
      const ob = b.c.orden === null ? Infinity : b.c.orden;
      return oa === ob ? a.posicion - b.posicion : oa - ob;
    })
    .map(x => x.id);
  const conFijo = entradas.find(([, c]) => c.ids.some(id => id && esVideoGratisFijo(id)));
  const porDefectoId = (conFijo || entradas.find(([, c]) => c.porDefecto) || [null])[0];
  return { elegibles, porDefectoId };
}

// ¿Puede esta persona elegir su prueba ahora?
//   miembro/usuario: datos de `miembros/{uid}` y `usuarios/{uid}` (null si no existen)
//   esAdmin / tienePlan: ya calculados por server.js con las reglas de acceso de siempre
//   eleccion: cursoId guardado en pruebasGratuitas/{uid} (o null)
//   cursosElegibles: ids que hoy se pueden elegir
// Devuelve { elegible, elegida: null | { cursoId }, motivo: null | string, codigo: null | string }.
function evaluarPruebaGratuita({ miembro, usuario = null, esAdmin = false, tienePlan = false, eleccion = null, cursosElegibles = [] }) {
  const sin = codigo => ({ elegible: false, elegida: eleccion ? { cursoId: eleccion } : null, motivo: MOTIVOS_PRUEBA[codigo], codigo });
  if (esAdmin) return sin('admin');
  if (eleccion) return sin('ya-elegida');
  if (!miembro) return sin('sin-registro');
  if (tienePlan) return sin('membresia');
  if (!nuncaHaTenidoPlan(miembro, usuario)) return sin('ya-pago');
  if (!cursosElegibles.length) return sin('sin-cursos');
  return { elegible: true, elegida: null, motivo: null, codigo: null };
}

module.exports = {
  VIDEO_ID_REGEX, MOTIVOS_PRUEBA,
  nuncaHaTenidoPlan, resumirCurso, resumenDeCursos, evaluarPruebaGratuita,
};
