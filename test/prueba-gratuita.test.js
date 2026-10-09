'use strict';

// Prueba gratuita de un curso a elección: quién puede elegir, qué cursos se pueden elegir,
// la elección única (también con dos solicitudes a la vez) y qué videos abre /api/bunny/embed-token.
// Todo con Firestore, Stripe y Firebase Auth simulados: no toca nada real.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { cargarServidor, ts, dias, VIDEO_GRATIS, VIDEO_PREMIUM } = require('./helpers/cargar-servidor');
const prueba = require('../services/prueba-gratuita');

const ERROR_SIN_MEMBRESIA = 'Necesitas una membresía activa para ver esta clase';
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lecciones = (desde, cantidad, extra = {}) =>
  Array.from({ length: cantidad }, (_, i) => ({ titulo: `Clase ${i + 1}`, videoId: uuid(desde + i), provider: 'bunny', ...extra }));
const A = lecciones(100, 4); // curso de 4 clases
const B = lecciones(200, 3); // curso de 3 clases
const C = lecciones(300, 5); // curso de 5 clases

// Cursos de Firestore: el de por defecto (trae el video gratis fijo), tres elegibles y varios que no.
const cursos = {
  'cursos/defecto': { titulo: 'Curso por defecto', ordenVip: 0, lecciones: [{ titulo: 'Clase 1', videoId: VIDEO_GRATIS }, { titulo: 'Clase 2', videoId: VIDEO_PREMIUM }, { titulo: 'Clase 3', videoId: uuid(1) }] },
  'cursos/a': { titulo: 'Curso A', ordenVip: 1, lecciones: A },
  'cursos/b': { titulo: 'Curso B', ordenVip: 2, lecciones: B },
  'cursos/c': { titulo: 'Curso C', ordenVip: 3, lecciones: C },
  'cursos/corto': { titulo: 'Una sola clase', lecciones: lecciones(400, 1) },
  'cursos/drive': { titulo: 'Con Drive', lecciones: [{ titulo: 'Clase 1', videoId: uuid(500) }, { titulo: 'Clase 2', url: 'https://drive.google.com/file/d/xyz/view' }] },
  'cursos/siempre': { titulo: 'Siempre disponible', disponibleSiempre: true, lecciones: lecciones(600, 3) },
  'cursos/muestra': { titulo: 'Curso de muestra del panel', cursoMuestraGratis: true, lecciones: lecciones(700, 3).map((l, i) => ({ ...l, gratis: i === 0 })) }
};
const ELEGIBLES = ['a', 'b', 'c'];

// Cuentas (todas en `miembros`, con la forma que escribe el registro del Club).
const registro = { planActivo: false, planCancelado: false, planTipo: null, planInicio: null, planVence: null, ultimoPago: null, role: 'member' };
const cuentas = {
  'miembros/nuevo': { ...registro, name: 'Nueva' },
  'miembros/cliente-stripe': { ...registro, stripeCustomerId: 'cus_sin_pagar' }, // Stripe lo crea al abrir el pago
  'miembros/ex': { ...registro, planActivo: false, planStatus: 'expired', planTipo: 'mensual', planVence: ts(dias(-30)), stripeSubscriptionId: 'sub_viejo' },
  'miembros/pago': { ...registro, planActivo: true, planStatus: 'active', planTipo: 'mensual', planVence: ts(dias(10)), stripeSubscriptionId: 'sub_1' },
  'miembros/admin-rol': { ...registro, role: 'admin' },
  'admins/admin-doc': { activo: true },
  'miembros/admin-doc': { ...registro },
  'miembros/eligio': { ...registro },
  'pruebasGratuitas/eligio': { uid: 'eligio', cursoId: 'a', elegidoEn: ts(dias(-1)) }
};
const tokens = Object.fromEntries(
  ['nuevo', 'cliente-stripe', 'ex', 'pago', 'admin-rol', 'admin-doc', 'eligio', 'sin-registro'].map(uid => [`token-${uid}`, { uid, email: `${uid}@example.com` }])
);
const auth = t => ({ Authorization: `Bearer ${t}` });
const base = { ...cursos, ...cuentas };

const obtener = (app, t = 'token-nuevo') => request(app).get('/api/prueba-gratuita').set(auth(t));
const elegir = (app, cursoId, t = 'token-nuevo', extra = {}) => request(app).post('/api/prueba-gratuita').set(auth(t)).send({ cursoId, ...extra });
const embed = (app, videoId, t) => request(app).post('/api/bunny/embed-token').set(auth(t)).send({ videoId });

// Cuenta (y puede romper o hacer lentas) las lecturas a una colección. Con `lenta` la lectura toma
// su foto del documento y TARDA un turno del reloj en entregarla: así dos solicitudes simultáneas
// leen el mismo estado viejo, como pasa en producción, y solo una transacción real evita el doble guardado.
function vigilar(db, nombre, { fallar = false, lenta = false } = {}) {
  const estado = { lecturas: 0, fallar };
  const original = db.collection.bind(db);
  db.collection = n => {
    const real = original(n);
    if (n !== nombre) return real;
    return {
      doc: id => {
        const ref = real.doc(id);
        return { ...ref, id: ref.id, path: ref.path, get: async () => {
          estado.lecturas++;
          if (estado.fallar) throw new Error('Firestore caído');
          const foto = await ref.get();
          if (lenta) await new Promise(resolver => setImmediate(resolver));
          return foto;
        }, set: (...a) => ref.set(...a) };
      },
      get: async () => {
        estado.lecturas++;
        if (estado.fallar) throw new Error('Firestore caído');
        return real.get();
      }
    };
  };
  return estado;
}
const silenciar = t => t.mock.method(console, 'error', () => {});

// ═══ Reglas puras ═══
test('nuncaHaTenidoPlan: solo true si ninguna señal de plan en miembros ni en usuarios', () => {
  const nunca = [
    registro, {}, { ...registro, stripeCustomerId: 'cus_1' }, { planStatus: 'pending_payment' },
    { ...registro, planTipo: '', ultimoPago: undefined, activadoManualmente: false }
  ];
  for (const m of nunca) assert.equal(prueba.nuncaHaTenidoPlan(m), true, JSON.stringify(m));
  const pagaron = [
    { planVence: ts(dias(5)) }, { planVence: ts(dias(-5)) }, { planVence: '2026-01-01' },
    { fechaExpiracion: ts(dias(-5)) }, { planInicio: ts(dias(-9)) }, { ultimoPago: ts(dias(-9)) },
    { stripeSubscriptionId: 'sub_x' }, { stripeSubscriptionStatus: 'canceled' }, { planTipo: 'anual' },
    { activadoManualmente: true }, { shopifyOrderId: '123' }, { viaShopify: true },
    { planActivo: true }, { planCancelado: true }, { planStatus: 'expired' }, { planStatus: 'cancelled' },
    { canceladoEn: ts(dias(-3)) }, { fechaCancelacion: ts(dias(-3)) }
  ];
  for (const m of pagaron) assert.equal(prueba.nuncaHaTenidoPlan({ ...registro, ...m }), false, JSON.stringify(m));
});

test('nuncaHaTenidoPlan: también mira el documento legado usuarios y exige registro de miembro', () => {
  assert.equal(prueba.nuncaHaTenidoPlan(registro, { fechaExpiracion: ts(dias(-1)) }), false);
  assert.equal(prueba.nuncaHaTenidoPlan(registro, { tipoPlan: 'mensual' }), false);
  assert.equal(prueba.nuncaHaTenidoPlan(registro, { stripeCustomerId: 'cus_1' }), true);
  assert.equal(prueba.nuncaHaTenidoPlan(registro, null), true);
  assert.equal(prueba.nuncaHaTenidoPlan(null, null), false, 'sin registro no hay evidencia');
  assert.equal(prueba.nuncaHaTenidoPlan(undefined), false);
});

test('resumirCurso: libera todas las clases menos la última, sean 2, 3 o 5', () => {
  const noFijo = () => false;
  for (const n of [2, 3, 5]) {
    const ls = lecciones(900, n);
    const r = prueba.resumirCurso({ lecciones: ls }, noFijo);
    assert.equal(r.elegible, true, `${n} clases`);
    assert.deepEqual([...r.gratisPrueba], ls.slice(0, -1).map(l => l.videoId));
    assert.equal(r.gratisPrueba.has(ls[n - 1].videoId), false);
  }
});

test('resumirCurso: la última clase queda bloqueada aunque su video se repita antes', () => {
  const repetido = [{ videoId: uuid(1) }, { videoId: uuid(2) }, { videoId: uuid(1) }];
  const r = prueba.resumirCurso({ lecciones: repetido }, () => false);
  assert.equal(r.gratisPrueba.has(uuid(1)), false);
  assert.equal(r.elegible, false, 'con videos repetidos no es elegible');
});

test('evaluarPruebaGratuita: cada motivo y el caso elegible', () => {
  const ok = { miembro: registro, cursosElegibles: ['a'] };
  assert.deepEqual(prueba.evaluarPruebaGratuita(ok), { elegible: true, elegida: null, motivo: null, codigo: null });
  assert.equal(prueba.evaluarPruebaGratuita({ ...ok, esAdmin: true }).codigo, 'admin');
  assert.equal(prueba.evaluarPruebaGratuita({ ...ok, miembro: null }).codigo, 'sin-registro');
  assert.equal(prueba.evaluarPruebaGratuita({ ...ok, tienePlan: true }).codigo, 'membresia');
  assert.equal(prueba.evaluarPruebaGratuita({ ...ok, miembro: { ...registro, planVence: ts(dias(-9)) } }).codigo, 'ya-pago');
  assert.equal(prueba.evaluarPruebaGratuita({ ...ok, cursosElegibles: [] }).codigo, 'sin-cursos');
  const ya = prueba.evaluarPruebaGratuita({ ...ok, eleccion: 'a' });
  assert.equal(ya.codigo, 'ya-elegida');
  assert.deepEqual(ya.elegida, { cursoId: 'a' });
  assert.equal(ya.motivo, 'Ya elegiste tu prueba gratuita y no se puede cambiar');
});

// ═══ GET /api/prueba-gratuita ═══
test('GET exige sesión (mismos 401 que el resto)', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const sin = await request(app).get('/api/prueba-gratuita');
  assert.equal(sin.status, 401);
  assert.equal(sin.body.error, 'Sesión requerida');
  const mala = await obtener(app, 'falso');
  assert.equal(mala.status, 401);
  assert.equal(mala.body.error, 'Sesión inválida o vencida');
  assert.equal((await request(app).post('/api/prueba-gratuita').send({ cursoId: 'a' })).status, 401);
});

test('GET: quien nunca pagó es elegible y recibe los cursos elegibles y el curso por defecto', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const res = await obtener(app);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { elegible: true, elegida: null, motivo: null, cursosElegibles: ELEGIBLES, cursoPorDefectoId: 'defecto' });
});

test('GET: tener stripeCustomerId sin haber pagado NO quita la prueba', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  assert.equal((await obtener(app, 'token-cliente-stripe')).body.elegible, true);
});

test('GET: quien ya pagó alguna vez (vencido/cancelado) no es elegible', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const res = await obtener(app, 'token-ex');
  assert.equal(res.status, 200);
  assert.equal(res.body.elegible, false);
  assert.equal(res.body.elegida, null);
  assert.equal(res.body.motivo, prueba.MOTIVOS_PRUEBA['ya-pago']);
  assert.deepEqual(res.body.cursosElegibles, []);
  assert.equal(res.body.cursoPorDefectoId, 'defecto');
});

test('GET: el usuario con documento legado en usuarios que mostró plan tampoco es elegible', async () => {
  const seed = { ...base, 'usuarios/nuevo': { fechaExpiracion: ts(dias(-100)), tipoPlan: 'mensual' } };
  const { app } = cargarServidor({ tokens, seed });
  assert.equal((await obtener(app)).body.elegible, false);
});

test('GET: miembro con plan vigente y administradores no son elegibles', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  assert.equal((await obtener(app, 'token-pago')).body.motivo, prueba.MOTIVOS_PRUEBA.membresia);
  assert.equal((await obtener(app, 'token-admin-rol')).body.motivo, prueba.MOTIVOS_PRUEBA.admin);
  const doc = await obtener(app, 'token-admin-doc');
  assert.equal(doc.body.elegible, false);
  assert.equal(doc.body.motivo, prueba.MOTIVOS_PRUEBA.admin);
});

test('GET: sin registro de miembro no es elegible', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const res = await obtener(app, 'token-sin-registro');
  assert.equal(res.body.elegible, false);
  assert.equal(res.body.motivo, prueba.MOTIVOS_PRUEBA['sin-registro']);
});

test('GET: quien ya eligió ve su curso y no es elegible', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const res = await obtener(app, 'token-eligio');
  assert.equal(res.body.elegible, false);
  assert.deepEqual(res.body.elegida, { cursoId: 'a' });
  assert.equal(res.body.motivo, 'Ya elegiste tu prueba gratuita y no se puede cambiar');
});

test('GET: sin cursos elegibles (solo el de por defecto) no hay prueba', async () => {
  const seed = { 'cursos/defecto': cursos['cursos/defecto'], ...cuentas };
  const { app } = cargarServidor({ tokens, seed });
  const res = await obtener(app);
  assert.equal(res.body.elegible, false);
  assert.equal(res.body.motivo, prueba.MOTIVOS_PRUEBA['sin-cursos']);
  assert.deepEqual(res.body.cursosElegibles, []);
});

test('el curso por defecto, de Drive, de una sola clase, siempre disponible o de muestra NO son elegibles', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const lista = (await obtener(app)).body.cursosElegibles;
  for (const id of ['defecto', 'corto', 'drive', 'siempre', 'muestra']) assert.ok(!lista.includes(id), id);
  // y el servidor tampoco los acepta al elegir
  for (const id of ['defecto', 'corto', 'drive', 'siempre', 'muestra']) {
    assert.equal((await elegir(app, id)).status, 400, id);
  }
});

test('el curso con cursoMuestraGratis cuenta como por defecto cuando no hay uno con el video fijo', async () => {
  const seed = { 'cursos/muestra': cursos['cursos/muestra'], 'cursos/a': cursos['cursos/a'], ...cuentas };
  const { app } = cargarServidor({ tokens, seed });
  const res = await obtener(app);
  assert.equal(res.body.cursoPorDefectoId, 'muestra');
  assert.deepEqual(res.body.cursosElegibles, ['a']);
});

test('GET con Firestore de cursos caído: sin cursos elegibles, no se rompe', async t => {
  silenciar(t);
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'cursos', { fallar: true });
  const res = await obtener(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.elegible, false);
  assert.deepEqual(res.body.cursosElegibles, []);
  assert.equal(res.body.cursoPorDefectoId, null);
});

// ═══ POST /api/prueba-gratuita ═══
test('POST 200: guarda { uid, cursoId, elegidoEn } en pruebasGratuitas y no toca miembros', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  const antes = db.value('miembros/nuevo');
  const res = await elegir(app, 'b');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { ok: true, cursoId: 'b' });
  const doc = db.value('pruebasGratuitas/nuevo');
  assert.equal(doc.uid, 'nuevo');
  assert.equal(doc.cursoId, 'b');
  assert.ok(doc.elegidoEn && typeof doc.elegidoEn.toMillis === 'function', 'elegidoEn es la marca de tiempo del servidor');
  assert.deepEqual(Object.keys(doc).sort(), ['cursoId', 'elegidoEn', 'uid']);
  assert.deepEqual(db.value('miembros/nuevo'), antes, 'la elección no se guarda en miembros');
  assert.equal(db.value('usuarios/nuevo'), undefined);
});

test('POST toma el uid del token, no del cuerpo', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  const res = await elegir(app, 'a', 'token-nuevo', { uid: 'eligio', email: 'otro@x.com' });
  assert.equal(res.status, 200);
  assert.equal(db.value('pruebasGratuitas/nuevo').cursoId, 'a');
  assert.equal(db.value('pruebasGratuitas/eligio').cursoId, 'a'); // el de siempre, intacto
  assert.equal(db.value('pruebasGratuitas/nuevo').uid, 'nuevo');
});

test('POST 400: falta cursoId o no es texto', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  for (const cuerpo of [{}, { cursoId: '' }, { cursoId: '   ' }, { cursoId: 7 }, { cursoId: ['a'] }, { cursoId: { a: 1 } }, { cursoId: null }]) {
    const res = await request(app).post('/api/prueba-gratuita').set(auth('token-nuevo')).send(cuerpo);
    assert.equal(res.status, 400, JSON.stringify(cuerpo));
  }
  assert.equal(db.value('pruebasGratuitas/nuevo'), undefined);
});

test('POST 400: curso inexistente o no elegible, y no se guarda nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  for (const cursoId of ['no-existe', '../admins/x', 'cursos/a', 'corto', 'drive', 'defecto']) {
    const res = await elegir(app, cursoId);
    assert.equal(res.status, 400, cursoId);
    assert.equal(res.body.error, 'Ese curso no se puede elegir como prueba gratuita');
  }
  assert.equal(db.value('pruebasGratuitas/nuevo'), undefined);
  // y sigue pudiendo elegir uno válido después
  assert.equal((await elegir(app, 'a')).status, 200);
});

test('POST 403 con motivo: quien ya pagó, tiene plan, es admin o no tiene registro; nada se guarda', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  const casos = [
    ['token-ex', prueba.MOTIVOS_PRUEBA['ya-pago']],
    ['token-pago', prueba.MOTIVOS_PRUEBA.membresia],
    ['token-admin-rol', prueba.MOTIVOS_PRUEBA.admin],
    ['token-admin-doc', prueba.MOTIVOS_PRUEBA.admin],
    ['token-sin-registro', prueba.MOTIVOS_PRUEBA['sin-registro']]
  ];
  for (const [token, motivo] of casos) {
    const res = await elegir(app, 'a', token);
    assert.equal(res.status, 403, token);
    assert.equal(res.body.error, motivo);
  }
  for (const uid of ['ex', 'pago', 'admin-rol', 'admin-doc', 'sin-registro']) {
    assert.equal(db.value(`pruebasGratuitas/${uid}`), undefined, uid);
  }
});

test('POST 403 aunque pida un curso inválido: no se revela nada del catálogo a quien no puede elegir', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  assert.equal((await elegir(app, 'no-existe', 'token-ex')).status, 403);
});

test('POST 409: ya eligió y no puede cambiar (ni al mismo curso)', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  assert.equal((await elegir(app, 'a')).status, 200);
  for (const cursoId of ['b', 'a']) {
    const res = await elegir(app, cursoId);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Ya elegiste tu prueba gratuita y no se puede cambiar');
  }
  assert.equal(db.value('pruebasGratuitas/nuevo').cursoId, 'a');
  const previa = await elegir(app, 'b', 'token-eligio');
  assert.equal(previa.status, 409);
  assert.equal(db.value('pruebasGratuitas/eligio').cursoId, 'a');
});

test('POST: dos solicitudes simultáneas distintas: una gana (200) y la otra recibe 409', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'pruebasGratuitas', { lenta: true });
  const [r1, r2] = await Promise.all([elegir(app, 'a'), elegir(app, 'b')]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const ganador = r1.status === 200 ? 'a' : 'b';
  assert.equal(db.value('pruebasGratuitas/nuevo').cursoId, ganador);
  assert.equal((r1.status === 409 ? r1 : r2).body.error, 'Ya elegiste tu prueba gratuita y no se puede cambiar');
});

test('POST: muchas solicitudes simultáneas: exactamente una se guarda', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'pruebasGratuitas', { lenta: true });
  const respuestas = await Promise.all(['a', 'b', 'c', 'a', 'b', 'c'].map(id => elegir(app, id)));
  assert.equal(respuestas.filter(r => r.status === 200).length, 1);
  assert.equal(respuestas.filter(r => r.status === 409).length, 5);
  const ganadora = respuestas.find(r => r.status === 200).body.cursoId;
  assert.equal(db.value('pruebasGratuitas/nuevo').cursoId, ganadora);
});

test('POST 503 si nunca se pudieron leer los cursos; no se guarda nada', async t => {
  silenciar(t);
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'cursos', { fallar: true });
  const res = await elegir(app, 'a');
  assert.equal(res.status, 503);
  assert.equal(db.value('pruebasGratuitas/nuevo'), undefined);
});

test('POST no acepta un curso retirado hace segundos (índice fresco al elegir)', async t => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  assert.equal((await obtener(app)).body.cursosElegibles.includes('c'), true);
  // Pasan 11 s (ya se permite releer) y el curso c se retiró.
  const base0 = Date.now();
  t.mock.method(Date, 'now', () => base0 + 11_000);
  db._data.delete('cursos/c');
  assert.equal((await elegir(app, 'c')).status, 400);
});

// ═══ /api/bunny/embed-token ═══
test('embed-token, prueba elegida: clases 1..n-1 de SU curso permitidas y la última 403 (4 clases)', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  for (const l of A.slice(0, -1)) {
    const res = await embed(app, l.videoId, 'token-eligio');
    assert.equal(res.status, 200, l.titulo);
    assert.equal(res.body.freePreview, true);
    assert.ok(res.body.embedUrl.includes(`/${l.videoId}?token=`));
  }
  const ultima = await embed(app, A[3].videoId, 'token-eligio');
  assert.equal(ultima.status, 403);
  assert.equal(ultima.body.error, ERROR_SIN_MEMBRESIA);
});

test('embed-token, prueba elegida: cursos de 3 y de 5 clases también dejan fuera solo la última', async () => {
  for (const [id, ls] of [['b', B], ['c', C]]) {
    const seed = { ...base, 'pruebasGratuitas/eligio': { uid: 'eligio', cursoId: id } };
    const { app } = cargarServidor({ tokens, seed });
    const estados = [];
    for (const l of ls) estados.push((await embed(app, l.videoId, 'token-eligio')).status);
    assert.deepEqual(estados, [...ls.slice(0, -1).map(() => 200), 403], `curso ${id}`);
  }
});

test('embed-token, prueba elegida: NO abre videos de otros cursos ni del catálogo estático', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  for (const v of [B[0].videoId, C[0].videoId, uuid(1), VIDEO_PREMIUM, uuid(700 + 1)]) {
    const res = await embed(app, v, 'token-eligio');
    assert.equal(res.status, 403, v);
    assert.equal(res.body.error, ERROR_SIN_MEMBRESIA);
  }
});

test('embed-token: cada persona abre solo las clases del curso que ELLA eligió', async () => {
  // Quien eligió B abre las clases de B, no las de A.
  const seed = { ...base, 'pruebasGratuitas/nuevo': { uid: 'nuevo', cursoId: 'b' } };
  const { app } = cargarServidor({ tokens, seed });
  assert.equal((await embed(app, B[1].videoId, 'token-nuevo')).status, 200);
  assert.equal((await embed(app, A[0].videoId, 'token-nuevo')).status, 403);
});

test('embed-token: sin haber elegido todavía no se abre ninguna clase de los cursos', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  for (const v of [A[0].videoId, B[0].videoId, C[0].videoId]) {
    assert.equal((await embed(app, v, 'token-nuevo')).status, 403, v);
  }
});

test('embed-token: la clase gratis fija ya no es gratis para quien aún debe elegir ni para quien ya eligió', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  for (const token of ['token-nuevo', 'token-cliente-stripe', 'token-eligio']) {
    const res = await embed(app, VIDEO_GRATIS, token);
    assert.equal(res.status, 403, token);
    assert.equal(res.body.error, ERROR_SIN_MEMBRESIA);
  }
});

test('embed-token: la clase gratis fija SIGUE gratis para quien ya pagó antes y no tiene plan', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const res = await embed(app, VIDEO_GRATIS, 'token-ex');
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, true);
  // y sin prueba ese mismo usuario sigue sin abrir clases de pago ni de los cursos
  assert.equal((await embed(app, VIDEO_PREMIUM, 'token-ex')).status, 403);
  assert.equal((await embed(app, A[0].videoId, 'token-ex')).status, 403);
});

test('embed-token: sin registro de miembro la clase fija sigue como hoy; sin cursos elegibles también', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  assert.equal((await embed(app, VIDEO_GRATIS, 'token-sin-registro')).status, 200);
  const seed = { 'cursos/defecto': cursos['cursos/defecto'], ...cuentas };
  const { app: app2 } = cargarServidor({ tokens, seed });
  const res = await embed(app2, VIDEO_GRATIS, 'token-nuevo');
  assert.equal(res.status, 200, 'si no hay nada que elegir, no se deja sin clase gratis');
  assert.equal(res.body.freePreview, true);
});

test('embed-token: las clases gratis marcadas en el panel siguen gratis para todos (también en prueba)', async () => {
  const marcada = uuid(700);
  const noMarcada = uuid(701);
  const seed = { ...base };
  for (const token of ['token-nuevo', 'token-eligio', 'token-ex', 'token-sin-registro']) {
    const { app } = cargarServidor({ tokens, seed });
    const ok = await embed(app, marcada, token);
    assert.equal(ok.status, 200, token);
    assert.equal(ok.body.freePreview, true);
    assert.equal((await embed(app, noMarcada, token)).status, 403, token);
  }
});

// ═══ Los miembros que pagan y los administradores no cambian ═══
test('miembro con plan: ve todo igual que antes (incluida la clase fija con freePreview) y no se lee pruebasGratuitas', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  const lecturas = vigilar(db, 'pruebasGratuitas');
  for (const v of [A[3].videoId, B[2].videoId, VIDEO_PREMIUM, uuid(1)]) {
    const res = await embed(app, v, 'token-pago');
    assert.equal(res.status, 200, v);
    assert.equal(res.body.freePreview, false);
  }
  const fija = await embed(app, VIDEO_GRATIS, 'token-pago');
  assert.equal(fija.status, 200);
  assert.equal(fija.body.freePreview, true, 'igual que antes de la prueba');
  assert.equal(lecturas.lecturas, 0, 'a quien paga no se le consulta nada nuevo');
});

test('miembro con plan que además tiene una elección guardada: sin cambios (ve todo, sin freePreview)', async () => {
  const seed = { ...base, 'pruebasGratuitas/pago': { uid: 'pago', cursoId: 'a' } };
  const { app } = cargarServidor({ tokens, seed });
  const ultima = await embed(app, A[3].videoId, 'token-pago');
  assert.equal(ultima.status, 200);
  assert.equal(ultima.body.freePreview, false);
  assert.equal((await embed(app, VIDEO_GRATIS, 'token-pago')).body.freePreview, true);
});

test('miembro con plan por el documento legado usuarios: sin cambios', async () => {
  const seed = { ...base, 'usuarios/nuevo': { planActivo: true, fechaExpiracion: ts(dias(10)) } };
  const { app } = cargarServidor({ tokens, seed });
  const res = await embed(app, A[3].videoId, 'token-nuevo');
  assert.equal(res.status, 200);
  assert.equal(res.body.freePreview, false);
});

test('administradores: ven todo, la clase fija sigue con freePreview y no se les consulta la prueba', async () => {
  const { app, db } = cargarServidor({ tokens, seed: base });
  const lecturas = vigilar(db, 'pruebasGratuitas');
  for (const token of ['token-admin-rol', 'token-admin-doc']) {
    for (const v of [A[3].videoId, VIDEO_PREMIUM]) {
      const res = await embed(app, v, token);
      assert.equal(res.status, 200, `${token} ${v}`);
      assert.equal(res.body.freePreview, false);
    }
    assert.equal((await embed(app, VIDEO_GRATIS, token)).body.freePreview, true);
  }
  assert.equal(lecturas.lecturas, 0);
});

test('plan cancelado con acceso vigente hasta planVence sigue viendo todo', async () => {
  const seed = { ...base, 'miembros/nuevo': { ...registro, planActivo: true, planCancelado: true, planStatus: 'cancelled_active', planVence: ts(dias(5)), stripeSubscriptionId: 'sub_9' } };
  const { app } = cargarServidor({ tokens, seed });
  assert.equal((await embed(app, A[3].videoId, 'token-nuevo')).status, 200);
});

test('los mensajes y códigos de siempre no cambian: 404 desconocido, 401 sin sesión, 403 sin plan', async () => {
  const { app } = cargarServidor({ tokens, seed: base });
  const desconocido = await embed(app, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'token-eligio');
  assert.equal(desconocido.status, 404);
  assert.equal(desconocido.body.error, 'Video no reconocido en el catálogo de Zoorigen');
  assert.equal((await request(app).post('/api/bunny/embed-token').send({ videoId: VIDEO_PREMIUM })).status, 401);
  const sinPlan = await embed(app, VIDEO_PREMIUM, 'token-ex');
  assert.equal(sinPlan.status, 403);
  assert.equal(sinPlan.body.error, ERROR_SIN_MEMBRESIA);
});

// ═══ Firestore caído: no se empeora nada ═══
test('con la colección cursos caída: quien eligió no recibe nada extra y la clase fija queda bloqueada', async t => {
  silenciar(t);
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'cursos', { fallar: true });
  assert.equal((await embed(app, A[0].videoId, 'token-eligio')).status, 404, 'video de Firestore sigue sin reconocerse, como antes');
  const fija = await embed(app, VIDEO_GRATIS, 'token-eligio');
  assert.equal(fija.status, 403);
  assert.equal((await embed(app, VIDEO_PREMIUM, 'token-eligio')).status, 403);
});

test('con la colección cursos caída: la clase fija sigue gratis para nuevos (no hay nada que elegir) y para ex-pagadores', async t => {
  silenciar(t);
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'cursos', { fallar: true });
  assert.equal((await embed(app, VIDEO_GRATIS, 'token-nuevo')).status, 200);
  assert.equal((await embed(app, VIDEO_GRATIS, 'token-ex')).status, 200);
  assert.equal((await embed(app, VIDEO_PREMIUM, 'token-pago')).status, 200, 'el miembro con plan, igual que antes');
});

test('si falla la lectura de pruebasGratuitas no hay 500 ni se concede nada extra: queda como antes', async t => {
  const error = silenciar(t);
  const { app, db } = cargarServidor({ tokens, seed: base });
  vigilar(db, 'pruebasGratuitas', { fallar: true });
  const fija = await embed(app, VIDEO_GRATIS, 'token-nuevo');
  assert.equal(fija.status, 200, 'como antes de la prueba');
  assert.equal((await embed(app, A[0].videoId, 'token-eligio')).status, 403, 'sin conceder nada extra');
  assert.ok(error.mock.callCount() >= 1, 'el fallo se registra');
  assert.equal((await embed(app, VIDEO_PREMIUM, 'token-pago')).status, 200);
  // y los endpoints de la prueba responden 500 con mensaje claro
  const get = await obtener(app);
  assert.equal(get.status, 500);
  assert.equal(get.body.error, 'No se pudo consultar tu prueba gratuita');
});
