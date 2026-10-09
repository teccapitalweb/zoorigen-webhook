'use strict';

// Avisos personales que crea el servidor cuando ya sabe del evento: bienvenida, insignias, XP por curso, premios.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, certificado
} = require('./helpers/club');

const DIA = 86400000;
const haceDias = n => new Date(Date.now() - n * DIA).toUTCString();
const tokens = tokensDe('nueva', 'ana', 'vieja', 'sinplan', 'admin');
const montar = (extra = {}, usuariosAuth = {}) => cargarServidor({
  tokens,
  usuariosAuth: { nueva: { emailVerified: true, creationTime: haceDias(2) }, sinplan: { emailVerified: true, creationTime: haceDias(1) }, ...usuariosAuth },
  seed: {
    ...cursosSeed(15),
    'miembros/nueva': miembroConPlan({ name: 'Nora' }),
    'miembros/ana': miembroConPlan({ name: 'Ana' }),
    'miembros/vieja': miembroConPlan({ name: 'Vera' }),
    'miembros/sinplan': miembroSinPlan(),
    'miembros/admin': miembroSinPlan({ role: 'admin' }),
    ...extra
  }
});
const premios = (app, t = 'token-ana') => request(app).get('/api/premios').set(auth(t));
const avisosDe = db => uid => [...db._data.keys()].filter(k => k.startsWith(`avisos/${uid}/items/`)).map(k => k.split('/')[3]).sort();
const cert = (uid, courseId, issuedAt) => { const c = certificado(uid, courseId, { issuedAt }); return [`certificados/${c.folio}`, c]; };

test('premio de bienvenida: crea el aviso "bono_bienvenida" una sola vez', async () => {
  const { app, db } = montar();
  const a = await request(app).post('/api/premios/bienvenida').set(auth('token-nueva'));
  assert.equal(a.status, 200);
  assert.equal(a.body.yaReclamado, false);
  const aviso = db.value('avisos/nueva/items/bono_bienvenida');
  assert.equal(aviso.tipo, 'bienvenida');
  assert.equal(aviso.titulo, '👋 ¡Bienvenido al club!');
  assert.match(aviso.texto, /\+100 XP/);
  const b = await request(app).post('/api/premios/bienvenida').set(auth('token-nueva'));
  assert.equal(b.body.yaReclamado, true);
  // con membresía, el recálculo también avisa la primera insignia (l1); la bienvenida aparece una sola vez
  assert.deepEqual(avisosDe(db)('nueva'), ['bono_bienvenida', 'logro_l1']);
  const lista = await request(app).get('/api/avisos').set(auth('token-nueva'));
  assert.deepEqual(lista.body.avisos.map(x => [x.id, x.ambito, x.tipo]).sort(), [['bono_bienvenida', 'personal', 'bienvenida'], ['logro_l1', 'personal', 'logro']]);
});

test('premio de bienvenida sin membresía también avisa; un rechazo (administrador o cuenta vieja) no crea nada', async () => {
  const { app, db } = montar({}, { admin: { emailVerified: true, creationTime: haceDias(1) }, vieja: { emailVerified: true, creationTime: haceDias(90) } });
  assert.equal((await request(app).post('/api/premios/bienvenida').set(auth('token-sinplan'))).status, 200);
  assert.deepEqual(avisosDe(db)('sinplan'), ['bono_bienvenida']);
  assert.equal((await request(app).post('/api/premios/bienvenida').set(auth('token-admin'))).status, 403);
  assert.equal((await request(app).post('/api/premios/bienvenida').set(auth('token-vieja'))).status, 403);
  assert.deepEqual(avisosDe(db)('admin'), []);
  assert.deepEqual(avisosDe(db)('vieja'), []);
});

test('cuenta nueva: la primera consulta avisa su insignia y se repite sin duplicar', async () => {
  const { app, db } = montar();
  await premios(app);
  const primera = avisosDe(db)('ana');
  assert.ok(primera.includes('logro_l1'), primera.join());
  const logro = db.value('avisos/ana/items/logro_l1');
  assert.equal(logro.tipo, 'logro');
  assert.equal(logro.titulo, '🏅 ¡Nueva insignia!');
  assert.equal(logro.texto, 'Bienvenido a la manada · +20 XP');
  assert.equal(logro.enlace, 'club-logros.html');
  const guardado = db.value('premiosUsuario/ana');
  assert.ok(guardado.logrosAvisados.includes('l1'));
  await premios(app); await premios(app);
  assert.deepEqual(avisosDe(db)('ana'), primera, 'repetir la consulta no crea avisos nuevos');
});

test('curso terminado: aviso de insignia nueva y de +XP con el número de curso (id bonoxp_<curso>)', async () => {
  const { app, db } = montar();
  await premios(app); // la cuenta ya existe: a partir de aquí cada novedad se avisa
  for (const [ruta, c] of [cert('ana', 'c1', '2026-09-01T10:00:00.000Z'), cert('ana', 'c2', '2026-09-02T10:00:00.000Z')]) db._data.set(ruta, c);
  await premios(app);
  const ids = avisosDe(db)('ana');
  assert.ok(ids.includes('bonoxp_c1') && ids.includes('bonoxp_c2'), ids.join());
  assert.ok(ids.includes('logro_l4') && ids.includes('logro_l5'), 'Primer curso y Curiosidad en marcha');
  const xp = db.value('avisos/ana/items/bonoxp_c2');
  assert.equal(xp.tipo, 'xp');
  assert.equal(xp.titulo, '⭐ ¡Curso terminado!');
  assert.equal(xp.texto, 'Ganaste +30 XP por terminar tu curso número 2.');
  assert.equal(db.value('avisos/ana/items/bonoxp_c1').texto, 'Ganaste +20 XP por terminar tu curso número 1.');
  const antes = avisosDe(db)('ana');
  await premios(app);
  assert.deepEqual(avisosDe(db)('ana'), antes);
});

test('cuenta que ya existía antes de los avisos: lo que ya tenía NO inunda la campana, solo lo nuevo se avisa', async () => {
  const seed = Object.fromEntries([cert('vieja', 'c1', '2026-08-01T10:00:00.000Z'), cert('vieja', 'c2', '2026-08-02T10:00:00.000Z')]);
  seed['premiosUsuario/vieja'] = { uid: 'vieja', ganados: [], usados: [], xpTotal: 120 }; // calculada en el pasado, sin registro de avisos
  const { app, db } = montar(seed);
  await premios(app, 'token-vieja');
  assert.deepEqual(avisosDe(db)('vieja'), [], 'punto de partida silencioso');
  const g = db.value('premiosUsuario/vieja');
  assert.ok(g.logrosAvisados.includes('l1') && g.cursosAvisados.includes('c1') && g.cursosAvisados.includes('c2'));

  const [ruta, c3] = cert('vieja', 'c3', '2026-09-03T10:00:00.000Z');
  db._data.set(ruta, c3);
  await premios(app, 'token-vieja');
  assert.deepEqual(avisosDe(db)('vieja'), ['bonoxp_c3'], 'solo el curso nuevo');
  assert.equal(db.value('avisos/vieja/items/bonoxp_c3').texto, 'Ganaste +40 XP por terminar tu curso número 3.');
});

test('premio disponible: al ganar el premio por nivel se crea "premio_profesional" una sola vez', async () => {
  const seed = Object.fromEntries(Array.from({ length: 15 }, (_, i) => cert('ana', `c${i + 1}`, new Date(Date.UTC(2026, 8, i + 1)).toISOString())));
  const { app, db } = montar(seed);
  const res = await premios(app);
  assert.equal(res.body.premios.find(p => p.clave === 'profesional').disponible, true);
  const aviso = db.value('avisos/ana/items/premio_profesional');
  assert.equal(aviso.tipo, 'premio');
  assert.equal(aviso.titulo, '🎁 ¡Ganaste un premio!');
  assert.match(aviso.texto, /Premio Profesional/);
  await premios(app); await premios(app);
  assert.equal(avisosDe(db)('ana').filter(id => id.startsWith('premio_')).length, 1);
});

test('un premio ganado antes (ya guardado) no vuelve a avisarse', async () => {
  const seed = Object.fromEntries(Array.from({ length: 15 }, (_, i) => cert('ana', `c${i + 1}`, new Date(Date.UTC(2026, 8, i + 1)).toISOString())));
  seed['premiosUsuario/ana'] = { uid: 'ana', ganados: ['profesional'], usados: [] };
  const { app, db } = montar(seed);
  await premios(app);
  assert.equal(avisosDe(db)('ana').filter(id => id.startsWith('premio_')).length, 0);
});

test('sin membresía (vista previa) y administradores no reciben avisos de insignias', async () => {
  const { app, db } = montar();
  await premios(app, 'token-sinplan');
  await premios(app, 'token-admin');
  assert.deepEqual(avisosDe(db)('sinplan'), []);
  assert.deepEqual(avisosDe(db)('admin'), []);
  assert.equal(db.value('premiosUsuario/admin').logrosAvisados, undefined);
});

test('si crear el aviso falla, la consulta de premios responde igual (los avisos nunca rompen nada)', async () => {
  const { app, db } = montar();
  const original = db.collection.bind(db);
  db.collection = nombre => { if (nombre === 'avisos') throw new Error('colección caída'); return original(nombre); };
  const consola = console.error; console.error = () => {};
  try {
    const res = await premios(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.membresia, true);
    const bienvenida = await request(app).post('/api/premios/bienvenida').set(auth('token-nueva'));
    assert.equal(bienvenida.status, 200);
  } finally { console.error = consola; }
});

test('las rutas de retos y referidos que recalculan siguen avisando sin duplicar', async () => {
  const { app, db } = montar();
  const r = await request(app).post('/api/retos/resultado').set(auth('token-ana')).send({ retoId: 'quiz', puntaje: 5, total: 5 });
  assert.equal(r.status, 200);
  const primeros = avisosDe(db)('ana');
  assert.ok(primeros.includes('logro_l1'));
  await request(app).post('/api/retos/resultado').set(auth('token-ana')).send({ retoId: 'quiz', puntaje: 5, total: 5 });
  const despues = avisosDe(db)('ana');
  assert.deepEqual(despues.filter(id => primeros.includes(id)), primeros);
  assert.equal(new Set(despues).size, despues.length);
});
