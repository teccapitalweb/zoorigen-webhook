'use strict';

// Premio de bienvenida (+100 XP, una sola vez, solo cuentas nuevas) y las formas nuevas de GET /api/premios.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../services/premios');
const L = require('../services/logros');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe
} = require('./helpers/club');

const DIA = 86400000;
const haceDias = n => new Date(Date.now() - n * DIA).toUTCString();

// ── Regla pura ──
test('bienvenidaDisponible: cuentas de hasta 14 días; más viejas, ilegibles o sin dato no', () => {
  const ahora = Date.parse('2026-10-09T12:00:00Z');
  const hace = ms => new Date(ahora - ms).toISOString();
  assert.equal(P.bienvenidaDisponible(hace(0), ahora), true);
  assert.equal(P.bienvenidaDisponible(hace(13 * DIA), ahora), true);
  assert.equal(P.bienvenidaDisponible(hace(14 * DIA), ahora), true, 'el día 14 todavía vale');
  assert.equal(P.bienvenidaDisponible(hace(14 * DIA + 1), ahora), false);
  assert.equal(P.bienvenidaDisponible(hace(15 * DIA), ahora), false);
  assert.equal(P.bienvenidaDisponible(hace(400 * DIA), ahora), false);
  for (const raro of [undefined, null, '', 'ayer', {}, NaN]) assert.equal(P.bienvenidaDisponible(raro, ahora), false, String(raro));
  assert.equal(P.DIAS_CUENTA_NUEVA, 14);
  assert.equal(L.XP_BIENVENIDA, 100);
});

test('evaluar: la bienvenida suma 100 XP al total y a xp.bienvenida', () => {
  const base = { esVIP: true, completados: 0, areas: 0, dias: [], tarjetaDir: false, foroPosts: 0, foroRespuestas: 0, foroLikes: 0, invitadosValidos: 0 };
  const sin = L.evaluar({ ...base }, null, 0, new Date('2026-09-30T18:00:00Z'));
  const con = L.evaluar({ ...base, bienvenida: true }, null, 0, new Date('2026-09-30T18:00:00Z'));
  assert.equal(sin.xp.bienvenida, 0);
  assert.equal(con.xp.bienvenida, 100);
  assert.equal(con.xp.total, sin.xp.total + 100);
  assert.deepEqual(Object.keys(con.xp).sort(), ['bienvenida', 'cursos', 'logros', 'referidos', 'retos', 'total']);
});

// ── Endpoint ──
const tokens = tokensDe('nueva', 'vieja', 'sinplan', 'sinplan-vieja', 'admin', 'fantasma', 'rota');
const usuariosAuth = () => ({
  nueva: { emailVerified: true, creationTime: haceDias(2) },
  vieja: { emailVerified: true, creationTime: haceDias(40) },
  sinplan: { emailVerified: true, creationTime: haceDias(1) },
  'sinplan-vieja': { emailVerified: true, creationTime: haceDias(90) },
  admin: { emailVerified: true, creationTime: haceDias(1) },
  rota: { emailVerified: true, creationTime: 'no-es-una-fecha' }
});
const montar = (extraSeed = {}, au = usuariosAuth()) => cargarServidor({
  tokens, usuariosAuth: au,
  seed: {
    ...cursosSeed(15),
    'miembros/nueva': miembroConPlan({ name: 'Nora Nueva' }),
    'miembros/vieja': miembroConPlan({ name: 'Vera Vieja' }),
    'miembros/sinplan': miembroSinPlan(),
    'miembros/sinplan-vieja': miembroSinPlan(),
    'miembros/admin': miembroSinPlan({ role: 'admin' }),
    'miembros/fantasma': miembroConPlan(),
    'miembros/rota': miembroConPlan(),
    ...extraSeed
  }
});
const reclamar = (app, uid) => request(app).post('/api/premios/bienvenida').set(auth(`token-${uid}`));
const premiosDe = (app, uid) => request(app).get('/api/premios').set(auth(`token-${uid}`));

test('POST /api/premios/bienvenida exige sesión (401) y no se guarda en caché', async () => {
  const { app } = montar();
  assert.equal((await request(app).post('/api/premios/bienvenida')).status, 401);
  assert.equal((await request(app).post('/api/premios/bienvenida').set(auth('falso'))).status, 401);
  const ok = await reclamar(app, 'nueva');
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('cuenta nueva con membresía: +100 XP, queda guardado y entra al total, al nivel y al GET', async () => {
  const { app, db } = montar();
  const antes = (await premiosDe(app, 'nueva')).body;
  assert.deepEqual(antes.bienvenida, { disponible: true, xp: 100, reclamado: false });
  assert.equal(antes.xp.bienvenida, 0);

  const res = await reclamar(app, 'nueva');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['nivel', 'ok', 'xp', 'xpTotal', 'yaReclamado']);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.xp, 100);
  assert.equal(res.body.yaReclamado, false);
  assert.equal(res.body.xpTotal, antes.xp.total + 100);
  assert.deepEqual(res.body.nivel, L.infoNivel(res.body.xpTotal));
  assert.match(db.value('premiosUsuario/nueva').bienvenida.fecha, /^\d{4}-\d{2}-\d{2}T/);

  const despues = (await premiosDe(app, 'nueva')).body;
  assert.equal(despues.xp.bienvenida, 100);
  assert.equal(despues.xp.total, antes.xp.total + 100);
  assert.deepEqual(despues.bienvenida, { disponible: false, xp: 100, reclamado: true });
  assert.equal(db.value('premiosUsuario/nueva').xpTotal, despues.xp.total, 'la clasificación usa el mismo total');
});

test('es idempotente: reclamar otra vez no vuelve a pagar', async () => {
  const { app, db } = montar();
  const a = await reclamar(app, 'nueva');
  const fecha = db.value('premiosUsuario/nueva').bienvenida.fecha;
  const b = await reclamar(app, 'nueva');
  const c = await reclamar(app, 'nueva');
  assert.equal(a.body.yaReclamado, false);
  assert.equal(b.status, 200);
  assert.equal(b.body.yaReclamado, true);
  assert.equal(c.body.yaReclamado, true);
  assert.equal(b.body.xpTotal, a.body.xpTotal);
  assert.equal(db.value('premiosUsuario/nueva').bienvenida.fecha, fecha, 'la fecha original no se pisa');
  assert.equal((await premiosDe(app, 'nueva')).body.xp.bienvenida, 100);
});

test('doble reclamo simultáneo = un solo pago', async () => {
  const { app, db } = montar();
  const respuestas = await Promise.all([reclamar(app, 'nueva'), reclamar(app, 'nueva'), reclamar(app, 'nueva')]);
  assert.ok(respuestas.every(r => r.status === 200));
  assert.equal(respuestas.filter(r => r.body.yaReclamado === false).length, 1, 'solo una pago');
  assert.equal(respuestas.filter(r => r.body.yaReclamado === true).length, 2);
  assert.equal((await premiosDe(app, 'nueva')).body.xp.bienvenida, 100, 'el XP no se duplica');
  assert.ok(db.value('premiosUsuario/nueva').bienvenida);
});

test('cuenta antigua (más de 14 días): 403 y no se guarda nada', async () => {
  const { app, db } = montar();
  const res = await reclamar(app, 'vieja');
  assert.equal(res.status, 403);
  assert.ok(res.body.error);
  assert.equal(db.value('premiosUsuario/vieja'), undefined);
  const g = (await premiosDe(app, 'vieja')).body;
  assert.deepEqual(g.bienvenida, { disponible: false, xp: 100, reclamado: false });
  assert.equal(g.xp.bienvenida, 0);
});

test('quien ya reclamó puede volver a preguntar aunque su cuenta ya pase de 14 días', async () => {
  const { app } = montar({ 'premiosUsuario/vieja': { uid: 'vieja', ganados: [], usados: [], bienvenida: { fecha: '2026-08-01T00:00:00.000Z' } } });
  const res = await reclamar(app, 'vieja');
  assert.equal(res.status, 200);
  assert.equal(res.body.yaReclamado, true);
  assert.equal((await premiosDe(app, 'vieja')).body.xp.bienvenida, 100);
});

test('administrador: 403 y GET no le ofrece el premio', async () => {
  const { app, db } = montar();
  const res = await reclamar(app, 'admin');
  assert.equal(res.status, 403);
  assert.equal(db.value('premiosUsuario/admin'), undefined);
  const g = (await premiosDe(app, 'admin')).body;
  assert.equal(g.bienvenida.disponible, false);
  assert.equal(g.xp.bienvenida, 0);
});

test('sin membresía: se puede reclamar, el XP queda guardado y GET sigue en vista previa sin revelar XP', async () => {
  const { app, db } = montar();
  const previa = (await premiosDe(app, 'sinplan')).body;
  assert.equal(previa.membresia, false);
  assert.deepEqual(previa.bienvenida, { disponible: true, xp: 100 }, 'sin membresía solo disponible y xp');
  assert.ok(!('reclamado' in previa.bienvenida));

  const res = await reclamar(app, 'sinplan');
  assert.equal(res.status, 200);
  assert.equal(res.body.yaReclamado, false);
  assert.equal(res.body.xpTotal, 100);
  assert.ok(db.value('premiosUsuario/sinplan').bienvenida);

  const despues = (await premiosDe(app, 'sinplan')).body;
  assert.equal(despues.membresia, false);
  assert.deepEqual(despues.xp, { total: 0, logros: 0, retos: 0, referidos: 0, cursos: 0, bienvenida: 0 }, 'la vista previa no revela el XP');
  assert.deepEqual(despues.cursos, { terminados: 0, lista: [] });
  assert.deepEqual(despues.bienvenida, { disponible: false, xp: 100 });
  assert.equal(despues.nivel.xp, 0);

  // Al suscribirse, el XP guardado cuenta
  db._data.set('miembros/sinplan', miembroConPlan({ name: 'Ya paga' }));
  const miembro = (await premiosDe(app, 'sinplan')).body;
  assert.equal(miembro.membresia, true);
  assert.equal(miembro.xp.bienvenida, 100);
  assert.deepEqual(miembro.bienvenida, { disponible: false, xp: 100, reclamado: true });
});

test('sin membresía y con cuenta antigua: 403', async () => {
  const { app } = montar();
  assert.equal((await reclamar(app, 'sinplan-vieja')).status, 403);
});

test('si Firebase Auth no conoce la cuenta o la fecha no se entiende: 403 (no se regala XP a ciegas)', async () => {
  const { app, db } = montar();
  assert.equal((await reclamar(app, 'fantasma')).status, 403);
  assert.equal((await reclamar(app, 'rota')).status, 403);
  assert.equal(db.value('premiosUsuario/fantasma'), undefined);
  assert.equal(db.value('premiosUsuario/rota'), undefined);
  for (const uid of ['fantasma', 'rota']) assert.equal((await premiosDe(app, uid)).body.bienvenida.disponible, false);
});

test('si Firebase Auth falla: POST responde 503 y GET /api/premios sigue funcionando sin ofrecer el premio', async () => {
  const au = usuariosAuth();
  au.nueva = { emailVerified: true, get creationTime() { throw new Error('Auth caído'); } };
  const { app, db } = montar({}, au);
  const res = await reclamar(app, 'nueva');
  assert.equal(res.status, 503);
  assert.ok(res.body.error);
  assert.equal(db.value('premiosUsuario/nueva'), undefined);
  const g = await premiosDe(app, 'nueva');
  assert.equal(g.status, 200);
  assert.equal(g.body.bienvenida.disponible, false);
});

test('GET /api/premios trae niveles:[{id,nombre,desde,hasta}] (los 5) con y sin membresía', async () => {
  const { app } = montar();
  const esperado = [
    { id: 1, nombre: 'Aprendiz', desde: 0, hasta: 300 },
    { id: 2, nombre: 'Técnico', desde: 300, hasta: 1200 },
    { id: 3, nombre: 'Profesional', desde: 1200, hasta: 2500 },
    { id: 4, nombre: 'Líder', desde: 2500, hasta: 4500 },
    { id: 5, nombre: 'Maestro', desde: 4500, hasta: 99999 }
  ];
  const conPlan = (await premiosDe(app, 'nueva')).body;
  const sinPlan = (await premiosDe(app, 'sinplan')).body;
  assert.deepEqual(conPlan.niveles.map(n => Object.keys(n).sort().join()), Array(5).fill('desde,hasta,id,nombre'));
  assert.deepEqual(conPlan.niveles, L.listaNiveles());
  assert.deepEqual(sinPlan.niveles, L.listaNiveles());
  assert.equal(conPlan.niveles.length, 5);
  assert.deepEqual(conPlan.niveles.map(n => n.nombre), esperado.map(n => n.nombre));
});

test('GET /api/premios: xp trae exactamente las 6 claves y los premios son solo profesional, maestro y referidos-1', async () => {
  const { app } = montar();
  const g = (await premiosDe(app, 'nueva')).body;
  assert.deepEqual(Object.keys(g.xp).sort(), ['bienvenida', 'cursos', 'logros', 'referidos', 'retos', 'total']);
  assert.equal(g.xp.total, g.xp.logros + g.xp.retos + g.xp.referidos + g.xp.cursos + g.xp.bienvenida);
  assert.deepEqual(g.premios.map(p => p.clave), ['profesional', 'maestro', 'referidos-1']);
  assert.deepEqual(Object.keys(g.bienvenida).sort(), ['disponible', 'reclamado', 'xp']);
  assert.deepEqual(Object.keys(g.cursos).sort(), ['lista', 'terminados']);
  const sinPlan = (await premiosDe(app, 'sinplan')).body;
  assert.deepEqual(sinPlan.premios.map(p => p.clave), ['profesional', 'maestro', 'referidos-1']);
});
