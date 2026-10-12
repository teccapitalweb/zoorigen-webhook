'use strict';

// Rutas públicas y de administrador de services/rutas-publico.js:
//   GET /api/cursos/demo, POST /api/encuesta, POST /api/chatbot/sin-respuesta,
//   GET /api/admin/encuesta y GET /api/admin/chatbot/sin-respuesta.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, uuid
} = require('./helpers/club');
const publico = require('../services/rutas-publico');

const tokens = tokensDe('ana', 'admin');
const IP = '203.0.113.9';

const leccion = (n, extra = {}) => ({
  titulo: `Clase ${n}`, videoId: uuid(n), provider: 'bunny', url: `https://secreto.example/video-${n}.mp4`, ...extra
});

function cursosBase() {
  return {
    'cursos/jaguar': {
      title: 'Jaguares de México', description: 'Biología y conservación del jaguar.', area: 'Fauna silvestre',
      instructor: 'Dra. Pérez', image: 'https://img.example/jaguar.jpg', driveId: 'DRIVE-SECRETO',
      createdAt: '2026-05-01T10:00:00.000Z',
      lecciones: [
        leccion(1, { preguntas: [{ pregunta: '¿Es felino?', tipo: 'vof', correcta: 0 }] }),
        leccion(2), leccion(3)
      ]
    },
    'cursos/aves': {
      title: 'Aves rapaces', description: 'Manejo de aves de presa.', area: 'Manejo',
      createdAt: '2026-06-01T10:00:00.000Z', lecciones: [leccion(11), leccion(12)]
    },
    'cursos/pronto': {
      title: 'Reptiles ponzoñosos', area: 'Veterinaria', proximamente: true, lecciones: []
    },
    'cursos/nuevo': {
      title: 'Bienestar en zoológicos', area: 'Manejo', ordenVip: 1, disponibleSiempre: true,
      lecciones: [leccion(21), leccion(22)]
    },
    // No deben aparecer
    'cursos/oculto': { title: 'Curso oculto', area: 'Manejo', oculto: true, lecciones: [leccion(31), leccion(32)] },
    'cursos/borrador': { title: 'Curso borrador', estado: 'Borrador', lecciones: [leccion(33), leccion(34)] },
    'cursos/sintitulo': { area: 'Manejo', lecciones: [leccion(35), leccion(36)] },
    'cursos/sinclases': { title: 'Curso sin clases', area: 'Manejo', lecciones: [] }
  };
}

function servidor({ seed = {}, lenta = false } = {}) {
  const s = cargarServidor({
    tokens,
    seed: {
      ...cursosBase(),
      'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin Zoorigen' }),
      ...seed
    }
  });
  s.db.lenta = lenta;
  return s;
}

const desde = (ip, ruta, app) => request(app).post(ruta).set('X-Forwarded-For', ip);
const enviarEncuesta = (app, cuerpo, ip = IP) => desde(ip, '/api/encuesta', app).send(cuerpo);
const enviarSinRespuesta = (app, cuerpo, ip = IP) => desde(ip, '/api/chatbot/sin-respuesta', app).send(cuerpo);
const docsDe = (db, coleccion) => [...db._data.keys()].filter(k => k.startsWith(`${coleccion}/`)).map(k => db.value(k));

const encuestaValida = (extra = {}) => ({
  sessionId: 'sesion-abc-123',
  respuestas: { meta: 'Aprender desde cero sobre fauna silvestre', p1: 'Estudiante' },
  completada: false,
  ...extra
});

// ══════════════════════════════════════════════════════════════
// GET /api/cursos/demo
// ══════════════════════════════════════════════════════════════

test('catálogo: es público, trae solo los campos permitidos y nunca videos, urls ni preguntas', async () => {
  const { app } = servidor();
  const r = await request(app).get('/api/cursos/demo');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=300');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.ok(Array.isArray(r.body.cursos));

  const jaguar = r.body.cursos.find(c => c.id === 'jaguar');
  assert.deepEqual(Object.keys(jaguar).sort(), ['area', 'clases', 'descripcion', 'elegiblePrueba', 'id', 'proximamente', 'titulo']);
  assert.equal(jaguar.titulo, 'Jaguares de México');
  assert.equal(jaguar.area, 'Fauna silvestre');
  assert.equal(jaguar.descripcion, 'Biología y conservación del jaguar.');
  assert.equal(jaguar.clases, 3);
  assert.equal(jaguar.proximamente, false);

  const crudo = JSON.stringify(r.body);
  for (const prohibido of ['videoId', 'secreto.example', 'DRIVE-SECRETO', 'preguntas', 'correcta', 'bbbbbbbb-0000', 'instructor', 'img.example']) {
    assert.ok(!crudo.includes(prohibido), `no debe filtrar "${prohibido}"`);
  }
});

test('catálogo: solo cursos visibles; respeta "próximamente"; marca cuáles se pueden elegir como prueba', async () => {
  const { app } = servidor();
  const { cursos } = (await request(app).get('/api/cursos/demo')).body;
  const ids = cursos.map(c => c.id);
  assert.deepEqual([...ids].sort(), ['aves', 'jaguar', 'nuevo', 'pronto']);
  for (const oculto of ['oculto', 'borrador', 'sintitulo', 'sinclases']) assert.ok(!ids.includes(oculto), oculto);

  const por = Object.fromEntries(cursos.map(c => [c.id, c]));
  assert.equal(por.pronto.proximamente, true);
  assert.equal(por.pronto.clases, 0);
  assert.equal(por.jaguar.elegiblePrueba, true);
  assert.equal(por.nuevo.elegiblePrueba, false, 'disponibleSiempre no se elige como prueba');
  assert.equal(por.pronto.elegiblePrueba, false);
});

test('catálogo: orden como la biblioteca (los de siempre, el más nuevo primero; luego ordenVip)', async () => {
  const { app } = servidor();
  const { cursos } = (await request(app).get('/api/cursos/demo')).body;
  assert.deepEqual(cursos.map(c => c.id), ['aves', 'jaguar', 'pronto', 'nuevo']);
});

test('catálogo: una sola lectura de Firestore dentro de los 5 minutos', async () => {
  const { app, db } = servidor();
  const primero = await request(app).get('/api/cursos/demo');
  assert.equal(primero.status, 200);
  db._data.set('cursos/extra', { title: 'Curso agregado después', area: 'Manejo', lecciones: [leccion(51), leccion(52)] });
  db._data.delete('cursos/jaguar');
  const segundo = await request(app).get('/api/cursos/demo');
  assert.deepEqual(segundo.body, primero.body);
});

test('catálogo: ráfaga de visitas simultáneas comparte una sola lectura', async () => {
  const { app, db } = servidor();
  let lecturas = 0;
  const coleccion = db.collection.bind(db);
  db.collection = nombre => {
    if (nombre === 'cursos') lecturas += 1;
    return coleccion(nombre);
  };
  const respuestas = await Promise.all(Array.from({ length: 12 }, () => request(app).get('/api/cursos/demo')));
  assert.ok(respuestas.every(r => r.status === 200));
  assert.equal(lecturas, 1);
});

test('catálogo: si Firestore falla y no hay caché responde 503 sin caché; con caché sirve lo último', async () => {
  const sin = servidor();
  sin.db.collection = () => { throw new Error('Firestore caído'); };
  const falla = await request(sin.app).get('/api/cursos/demo');
  assert.equal(falla.status, 503);
  assert.equal(falla.headers['cache-control'], 'no-store');
  assert.match(falla.body.error, /cursos/);

  // otra visita inmediata no vuelve a golpear Firestore
  let intentos = 0;
  sin.db.collection = () => { intentos += 1; throw new Error('Firestore caído'); };
  const otra = await request(sin.app).get('/api/cursos/demo');
  assert.equal(otra.status, 503);
  assert.equal(intentos, 0);
});

test('catálogo: límite de solicitudes por IP (429)', async () => {
  const { app } = servidor();
  const ruta = '/api/cursos/demo';
  let ultimo;
  for (let i = 0; i < publico.CATALOGO_POR_IP; i++) {
    ultimo = await request(app).get(ruta).set('X-Forwarded-For', '198.51.100.7');
    assert.equal(ultimo.status, 200);
  }
  const excedida = await request(app).get(ruta).set('X-Forwarded-For', '198.51.100.7');
  assert.equal(excedida.status, 429);
  assert.equal(excedida.headers['cache-control'], 'no-store');
  assert.equal((await request(app).get(ruta).set('X-Forwarded-For', '198.51.100.8')).status, 200);
});

// ══════════════════════════════════════════════════════════════
// POST /api/encuesta
// ══════════════════════════════════════════════════════════════

test('encuesta: copia parcial válida se guarda con fecha del servidor y sin IP', async () => {
  const { app, db } = servidor();
  const r = await enviarEncuesta(app, encuestaValida());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.headers['cache-control'], 'no-store');

  const docs = docsDe(db, 'encuestasProspectos');
  assert.equal(docs.length, 1);
  const doc = docs[0];
  assert.equal(doc.sessionId, 'sesion-abc-123');
  assert.deepEqual(doc.respuestas, { meta: 'Aprender desde cero sobre fauna silvestre', p1: 'Estudiante' });
  assert.equal(doc.completada, false);
  assert.ok(doc.creado && typeof doc.creado.toMillis === 'function', 'creado es la fecha del servidor');
  assert.deepEqual(Object.keys(doc).sort(), ['completada', 'creado', 'respuestas', 'sessionId']);
  const crudo = JSON.stringify(doc);
  assert.ok(!crudo.includes(IP) && !crudo.includes('127.0.0.1'), 'no se guarda la IP');
});

test('encuesta: copia completa con contacto y aviso de privacidad (número normalizado a dígitos)', async () => {
  const { app, db } = servidor();
  const respuestas = {
    meta: 'Cumplir trámites y normatividad', p1: 'Personal de UMA o zoológico', origen: 'Redes sociales',
    grupo: 'Fauna en general', p2: 'Cumplir normas', p2b: 'Informe anual', tamano: '2 a 10',
    experiencia: 'Es mi primera vez', urgencia: 'Lo antes posible', freno: 'Tiempo'
  };
  const r = await enviarEncuesta(app, encuestaValida({
    respuestas, completada: true,
    contacto: { numero: '+52 (236) 111-3237', avisoAceptado: true, avisoVersion: 'aviso-2026-10-02' }
  }));
  assert.equal(r.status, 200);
  const [doc] = docsDe(db, 'encuestasProspectos');
  assert.deepEqual(doc.respuestas, respuestas);
  assert.equal(doc.completada, true);
  assert.equal(doc.contacto, '522361113237');
  assert.equal(doc.avisoAceptado, true);
  assert.equal(doc.avisoVersion, 'aviso-2026-10-02');
});

test('encuesta: varias copias de la misma sesión son normales (parcial y completa)', async () => {
  const { app, db } = servidor();
  assert.equal((await enviarEncuesta(app, encuestaValida())).status, 200);
  assert.equal((await enviarEncuesta(app, encuestaValida({ completada: true }))).status, 200);
  assert.equal(docsDe(db, 'encuestasProspectos').length, 2);
});

test('encuesta: acepta el cuerpo como texto plano (sendBeacon al cerrar la página)', async () => {
  const { app, db } = servidor();
  const r = await desde(IP, '/api/encuesta', app).set('Content-Type', 'text/plain;charset=UTF-8').send(JSON.stringify(encuestaValida()));
  assert.equal(r.status, 200);
  assert.equal(docsDe(db, 'encuestasProspectos').length, 1);
});

test('encuesta: sin respuestas ni contacto responde ok y no guarda nada', async () => {
  const { app, db } = servidor();
  const r = await enviarEncuesta(app, encuestaValida({ respuestas: {} }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(docsDe(db, 'encuestasProspectos').length, 0);
});

test('encuesta: clave no permitida, valor largo o que no es texto devuelven 400 y no guardan', async () => {
  const { app, db } = servidor();
  const casos = [
    { respuestas: { meta: 'Estudiante', correo: 'a@b.com' } },
    { respuestas: { p1: 'Estudiante', isAdmin: 'si' } },
    { respuestas: { p1: 'x'.repeat(81) } },
    { respuestas: { p1: 123 } },
    { respuestas: { p1: '   ' } },
    { respuestas: ['Estudiante'] },
    { respuestas: 'Estudiante' }
  ];
  for (const caso of casos) {
    const r = await enviarEncuesta(app, encuestaValida(caso));
    assert.equal(r.status, 400, JSON.stringify(caso));
    assert.match(r.body.error, /\S/);
  }
  // en el límite exacto (80) sí pasa
  assert.equal((await enviarEncuesta(app, encuestaValida({ respuestas: { p1: 'x'.repeat(80) } }))).status, 200);
  assert.equal(docsDe(db, 'encuestasProspectos').length, 1);
});

test('encuesta: sessionId y completada se validan', async () => {
  const { app, db } = servidor();
  for (const caso of [
    { sessionId: '' }, { sessionId: 'a'.repeat(101) }, { sessionId: 12345 }, { sessionId: undefined },
    { completada: 'si' }, { completada: undefined }
  ]) {
    const r = await enviarEncuesta(app, encuestaValida(caso));
    assert.equal(r.status, 400, JSON.stringify(caso));
  }
  assert.equal((await enviarEncuesta(app, encuestaValida({ sessionId: 'a'.repeat(100) }))).status, 200);
  assert.equal(docsDe(db, 'encuestasProspectos').length, 1);
});

test('encuesta: contacto sin aviso de privacidad aceptado devuelve 400', async () => {
  const { app, db } = servidor();
  for (const contacto of [
    { numero: '5212361113237' },
    { numero: '5212361113237', avisoAceptado: false, avisoVersion: 'aviso-2026-10-02' },
    { numero: '5212361113237', avisoAceptado: 'true', avisoVersion: 'aviso-2026-10-02' },
    { numero: '5212361113237', avisoAceptado: true },
    { numero: '5212361113237', avisoAceptado: true, avisoVersion: 'v'.repeat(41) },
    'quiero que me llamen'
  ]) {
    const r = await enviarEncuesta(app, encuestaValida({ contacto }));
    assert.equal(r.status, 400, JSON.stringify(contacto));
  }
  assert.equal(docsDe(db, 'encuestasProspectos').length, 0);
});

test('encuesta: número de contacto inválido devuelve 400', async () => {
  const { app, db } = servidor();
  for (const numero of ['abc', '1234567', '1'.repeat(16), '236-ABC-3237', '', null, 5212361113237, '52123611132<script>']) {
    const r = await enviarEncuesta(app, encuestaValida({
      contacto: { numero, avisoAceptado: true, avisoVersion: 'aviso-2026-10-02' }
    }));
    assert.equal(r.status, 400, String(numero));
  }
  assert.equal(docsDe(db, 'encuestasProspectos').length, 0);
});

test('encuesta: cuerpo roto o demasiado grande devuelve 400 / 413', async () => {
  const { app } = servidor();
  const roto = await desde(IP, '/api/encuesta', app).set('Content-Type', 'application/json').send('{"sessionId": ');
  assert.equal(roto.status, 400);
  const grande = await enviarEncuesta(app, encuestaValida({ respuestas: { p1: 'Estudiante' }, relleno: 'x'.repeat(20000) }));
  assert.equal(grande.status, 413);
  assert.equal((await enviarEncuesta(app, [1, 2, 3])).status, 400);
});

test('encuesta: 20 envíos por IP cada 10 minutos (429) y otra IP sigue pudiendo enviar', async () => {
  const { app, db } = servidor();
  for (let i = 0; i < publico.ENCUESTAS_POR_IP; i++) {
    const r = await enviarEncuesta(app, encuestaValida({ sessionId: `s-${i}` }), '198.51.100.20');
    assert.equal(r.status, 200, `envío ${i + 1}`);
  }
  const excedido = await enviarEncuesta(app, encuestaValida(), '198.51.100.20');
  assert.equal(excedido.status, 429);
  assert.match(excedido.body.error, /Demasiadas/);
  assert.equal(docsDe(db, 'encuestasProspectos').length, publico.ENCUESTAS_POR_IP);
  assert.equal((await enviarEncuesta(app, encuestaValida(), '198.51.100.21')).status, 200);
});

// ══════════════════════════════════════════════════════════════
// POST /api/chatbot/sin-respuesta
// ══════════════════════════════════════════════════════════════

test('sin-respuesta: quita correos, teléfonos y URLs y guarda el texto limpio', async () => {
  const { app, db } = servidor();
  const r = await enviarSinRespuesta(app, {
    texto: 'Escríbeme a juan.perez@correo.com o al 236 111 3237, mira https://sitio.example/ficha y www.otro.com: ¿qué come el ocelote?',
    tipo: 'animal'
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.headers['cache-control'], 'no-store');

  const docs = docsDe(db, 'chatbotSinRespuesta');
  assert.equal(docs.length, 1);
  const [doc] = docs;
  assert.equal(doc.tipo, 'animal');
  assert.equal(doc.veces, 1);
  assert.ok(doc.ultimaVez && typeof doc.ultimaVez.toMillis === 'function');
  for (const filtrado of ['@', '236', '3237', 'http', 'www', 'sitio.example', 'otro.com']) {
    assert.ok(!doc.ejemplo.includes(filtrado), `"${filtrado}" no debe quedar en: ${doc.ejemplo}`);
  }
  assert.match(doc.ejemplo, /qué come el ocelote/);
  assert.ok(doc.ejemplo.length <= 120);
  const crudo = JSON.stringify(doc);
  assert.ok(!crudo.includes(IP) && !crudo.includes('127.0.0.1'));
});

test('sin-respuesta: recorta a 120 caracteres', async () => {
  const { app, db } = servidor();
  await enviarSinRespuesta(app, { texto: `qué come el jaguar ${'muy '.repeat(100)}grande` });
  const [doc] = docsDe(db, 'chatbotSinRespuesta');
  assert.ok(doc.ejemplo.length <= 120 && doc.ejemplo.length > 100);
  assert.equal(doc.tipo, 'otro');
});

test('sin-respuesta: agrupa por texto normalizado y suma veces', async () => {
  const { app, db } = servidor();
  await enviarSinRespuesta(app, { texto: '¿Qué come el Ocelote?', tipo: 'animal' });
  await enviarSinRespuesta(app, { texto: 'que  COME el ocelote', tipo: 'animal' });
  const tercero = await enviarSinRespuesta(app, { texto: 'QUÉ CÓME EL OCELOTE!!!', tipo: 'animal' });
  assert.equal(tercero.status, 200);
  await enviarSinRespuesta(app, { texto: 'cuánto cuesta un ocelote', tipo: 'otro' });

  const llaves = [...db._data.keys()].filter(k => k.startsWith('chatbotSinRespuesta/'));
  assert.deepEqual(llaves.sort(), ['chatbotSinRespuesta/cuanto cuesta un ocelote', 'chatbotSinRespuesta/que come el ocelote']);
  const doc = db.value('chatbotSinRespuesta/que come el ocelote');
  assert.equal(doc.veces, 3);
  assert.equal(doc.ejemplo, '¿Qué come el Ocelote?', 'conserva el primer ejemplo');
  assert.equal(doc.tipo, 'animal');
});

test('sin-respuesta: solicitudes simultáneas no pierden cuentas (transacción)', async () => {
  const { app, db } = servidor({ lenta: true });
  const respuestas = await Promise.all(
    Array.from({ length: 4 }, (_, i) => enviarSinRespuesta(app, { texto: 'dónde vive el quetzal', tipo: 'animal' }, `198.51.100.${40 + i}`))
  );
  assert.ok(respuestas.every(r => r.status === 200));
  assert.equal(db.value('chatbotSinRespuesta/donde vive el quetzal').veces, 4);
});

test('sin-respuesta: texto demasiado corto o solo datos personales responde ok y no guarda', async () => {
  const { app, db } = servidor();
  for (const texto of ['ab', '  ', '??', '???', '236 111 3237', 'correo@ejemplo.com', 'https://ejemplo.com/x']) {
    const r = await enviarSinRespuesta(app, { texto });
    assert.equal(r.status, 200, texto);
    assert.deepEqual(r.body, { ok: true });
  }
  assert.equal(docsDe(db, 'chatbotSinRespuesta').length, 0);
});

test('sin-respuesta: tipo o texto con formato inválido devuelve 400', async () => {
  const { app, db } = servidor();
  assert.equal((await enviarSinRespuesta(app, { texto: 'qué come el tigre', tipo: 'otra-cosa' })).status, 400);
  assert.equal((await enviarSinRespuesta(app, { texto: 12345, tipo: 'otro' })).status, 400);
  assert.equal((await enviarSinRespuesta(app, { tipo: 'otro' })).status, 400);
  assert.equal((await enviarSinRespuesta(app, 'qué come el tigre')).status, 400);
  assert.equal(docsDe(db, 'chatbotSinRespuesta').length, 0);
});

test('sin-respuesta: 30 por IP cada 10 minutos (429)', async () => {
  const { app } = servidor();
  for (let i = 0; i < publico.SIN_RESPUESTA_POR_IP; i++) {
    const r = await enviarSinRespuesta(app, { texto: `pregunta número ${i} sobre fauna` }, '198.51.100.60');
    assert.equal(r.status, 200, `envío ${i + 1}`);
  }
  const excedido = await enviarSinRespuesta(app, { texto: 'una más' }, '198.51.100.60');
  assert.equal(excedido.status, 429);
  assert.equal((await enviarSinRespuesta(app, { texto: 'una más' }, '198.51.100.61')).status, 200);
});

// ══════════════════════════════════════════════════════════════
// Rutas de administrador
// ══════════════════════════════════════════════════════════════

const semillaEncuesta = n => {
  const seed = {};
  for (let i = 1; i <= n; i++) {
    seed[`encuestasProspectos/e${i}`] = {
      sessionId: `sesion-${i}`, respuestas: { p1: 'Estudiante', urgencia: 'Lo antes posible' },
      completada: i % 2 === 0, creado: ts(Date.UTC(2026, 9, 1) + i * 60000)
    };
  }
  return seed;
};
const semillaPreguntas = () => ({
  'chatbotSinRespuesta/a': { ejemplo: 'qué come el ocelote', veces: 2, tipo: 'animal', ultimaVez: ts(Date.UTC(2026, 9, 2)) },
  'chatbotSinRespuesta/b': { ejemplo: 'cuánto cuesta el curso de aves', veces: 9, tipo: 'otro', ultimaVez: ts(Date.UTC(2026, 9, 5)) },
  'chatbotSinRespuesta/c': { ejemplo: 'dónde vive el ajolote', veces: 4, tipo: 'animal', ultimaVez: ts(Date.UTC(2026, 9, 3)) }
});

const RUTAS_ADMIN = ['/api/admin/encuesta', '/api/admin/chatbot/sin-respuesta'];

test('rutas admin: 401 sin sesión, 401 con token inválido y 403 a quien no es administrador', async () => {
  const { app } = servidor({ seed: { ...semillaEncuesta(2), ...semillaPreguntas() } });
  for (const ruta of RUTAS_ADMIN) {
    const sin = await request(app).get(ruta);
    assert.equal(sin.status, 401, ruta);
    assert.equal(sin.headers['cache-control'], 'no-store');
    assert.equal((await request(app).get(ruta).set(auth('token-falso'))).status, 401, ruta);
    const miembro = await request(app).get(ruta).set(auth('token-ana'));
    assert.equal(miembro.status, 403, ruta);
    assert.equal(miembro.body.docs, undefined);
    assert.equal(miembro.body.preguntas, undefined);
  }
});

test('GET /api/admin/encuesta: más recientes primero, fecha ISO y solo campos conocidos', async () => {
  const seed = semillaEncuesta(3);
  seed['encuestasProspectos/e3'] = {
    ...seed['encuestasProspectos/e3'], completada: true, contacto: '522361113237', avisoAceptado: true,
    avisoVersion: 'aviso-2026-10-02', ip: '203.0.113.9', respuestas: { p1: 'Estudiante', campoExtra: 'no debe salir' }
  };
  const { app } = servidor({ seed });
  const r = await request(app).get('/api/admin/encuesta').set(auth('token-admin'));
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body.docs.map(d => d.sessionId), ['sesion-3', 'sesion-2', 'sesion-1']);

  const [masNuevo, medio] = r.body.docs;
  assert.equal(masNuevo.creado, new Date(Date.UTC(2026, 9, 1) + 3 * 60000).toISOString());
  assert.equal(masNuevo.contacto, '522361113237');
  assert.equal(masNuevo.avisoAceptado, true);
  assert.equal(masNuevo.avisoVersion, 'aviso-2026-10-02');
  assert.deepEqual(masNuevo.respuestas, { p1: 'Estudiante' });
  assert.equal(masNuevo.completada, true);
  assert.deepEqual(Object.keys(medio).sort(), ['completada', 'creado', 'respuestas', 'sessionId']);
  assert.ok(!JSON.stringify(r.body).includes('203.0.113.9'));
});

test('GET /api/admin/encuesta: limite respeta el pedido, el valor por defecto y el tope', async () => {
  const { app } = servidor({ seed: semillaEncuesta(5) });
  const pide = async q => (await request(app).get(`/api/admin/encuesta${q}`).set(auth('token-admin'))).body.docs;
  assert.equal((await pide('?limite=2')).length, 2);
  assert.equal((await pide('?limite=2'))[0].sessionId, 'sesion-5');
  assert.equal((await pide('')).length, 5);
  assert.equal((await pide('?limite=0')).length, 5);
  assert.equal((await pide('?limite=abc')).length, 5);
  assert.equal((await pide('?limite=99999')).length, 5);

  const enc = require('../services/encuesta');
  assert.equal(enc.limiteDeConsulta('99999', 1000, 2000), 2000);
  assert.equal(enc.limiteDeConsulta(undefined, 1000, 2000), 1000);
  assert.equal(enc.limiteDeConsulta('-3', 1000, 2000), 1000);
  assert.equal(enc.limiteDeConsulta('37', 1000, 2000), 37);
});

test('GET /api/admin/chatbot/sin-respuesta: ordenadas por veces y con tope', async () => {
  const { app } = servidor({ seed: semillaPreguntas() });
  const r = await request(app).get('/api/admin/chatbot/sin-respuesta').set(auth('token-admin'));
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body.preguntas.map(p => p.veces), [9, 4, 2]);
  assert.deepEqual(r.body.preguntas[0], {
    texto: 'cuánto cuesta el curso de aves', veces: 9, ultimaVez: new Date(Date.UTC(2026, 9, 5)).toISOString(), tipo: 'otro'
  });

  const dos = await request(app).get('/api/admin/chatbot/sin-respuesta?limite=2').set(auth('token-admin'));
  assert.deepEqual(dos.body.preguntas.map(p => p.texto), ['cuánto cuesta el curso de aves', 'dónde vive el ajolote']);
});

test('lo que guardan las rutas públicas lo leen las rutas de administrador', async () => {
  const { app } = servidor();
  await enviarEncuesta(app, encuestaValida());
  await enviarSinRespuesta(app, { texto: 'qué come el tapir', tipo: 'animal' });
  await enviarSinRespuesta(app, { texto: 'Que come el tapir', tipo: 'animal' });
  const encuesta = await request(app).get('/api/admin/encuesta').set(auth('token-admin'));
  assert.equal(encuesta.body.docs.length, 1);
  assert.match(encuesta.body.docs[0].creado, /^\d{4}-\d{2}-\d{2}T/);
  const preguntas = await request(app).get('/api/admin/chatbot/sin-respuesta').set(auth('token-admin'));
  assert.equal(preguntas.body.preguntas[0].veces, 2);
  assert.equal(preguntas.body.preguntas[0].texto, 'qué come el tapir');
});
