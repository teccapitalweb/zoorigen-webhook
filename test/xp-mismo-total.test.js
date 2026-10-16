'use strict';

// El XP de una persona es UNO solo: bienvenida + retos + cursos + logros (+ invitados). Retos (GET /api/retos), Logros y el panel
// del perfil (GET /api/premios) y la respuesta del premio de bienvenida (POST /api/premios/bienvenida) deben dar SIEMPRE el
// mismo total y el mismo nivel, con o sin membresía vigente. Quien no es miembro lo VE (solo lectura) aunque no pueda jugar.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../services/logros');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, certificado, fechaHace, ts, dias
} = require('./helpers/club');

const DIA = 86400000;
const haceDias = n => new Date(Date.now() - n * DIA).toUTCString();
const tokens = tokensDe('nueva', 'gratis', 'vencida', 'ana', 'admin');
const usuariosAuth = () => ({
  nueva: { emailVerified: true, creationTime: haceDias(1) },
  gratis: { emailVerified: true, creationTime: haceDias(2) },
  vencida: { emailVerified: true, creationTime: haceDias(60) },
  ana: { emailVerified: true, creationTime: haceDias(60) },
  admin: { emailVerified: true, creationTime: haceDias(1) }
});
const montar = (extra = {}) => cargarServidor({
  tokens, usuariosAuth: usuariosAuth(),
  seed: {
    ...cursosSeed(15),
    'miembros/nueva': miembroConPlan({ name: 'Nora Nueva' }),
    'miembros/gratis': miembroSinPlan(),
    'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
    'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
    'miembros/admin': miembroSinPlan({ role: 'admin' }),
    ...extra
  }
});
const certDe = (uid, courseId, issuedAt) => { const c = certificado(uid, courseId, { issuedAt }); return [`certificados/${c.folio}`, c]; };
const premios = (app, uid) => request(app).get('/api/premios').set(auth(`token-${uid}`));
const retos = (app, uid) => request(app).get('/api/retos').set(auth(`token-${uid}`));
const reclamar = (app, uid) => request(app).post('/api/premios/bienvenida').set(auth(`token-${uid}`));
const jugar = (app, uid, cuerpo) => request(app).post('/api/retos/resultado').set(auth(`token-${uid}`)).send(cuerpo);

// Las tres lecturas dan el mismo total y el mismo nivel. Devuelve el total.
async function totalUnico(app, uid, etiqueta) {
  const [p, r] = await Promise.all([premios(app, uid), retos(app, uid)]);
  assert.equal(p.status, 200, etiqueta);
  assert.equal(r.status, 200, etiqueta);
  assert.equal(r.body.xp, p.body.xp.total, `${etiqueta}: Retos y Logros dan el mismo XP`);
  assert.deepEqual(r.body.nivel, p.body.nivel, `${etiqueta}: mismo nivel`);
  assert.equal(p.body.xp.total, p.body.xp.logros + p.body.xp.retos + p.body.xp.referidos + p.body.xp.cursos + p.body.xp.bienvenida, `${etiqueta}: el total es la suma de sus partes`);
  assert.equal(p.body.nivel.xp, p.body.xp.total, `${etiqueta}: el nivel usa ese mismo total`);
  return p.body.xp.total;
}

// ── 1. Cuenta nueva con los +100 ──
test('cuenta nueva SIN membresía: después de reclamar los +100, Retos y Logros muestran 100 XP (antes mostraban 0)', async () => {
  const { app, db } = montar();
  assert.equal(await totalUnico(app, 'gratis', 'antes de reclamar'), 0);
  const res = await reclamar(app, 'gratis');
  assert.equal(res.body.xpTotal, 100);
  assert.equal(await totalUnico(app, 'gratis', 'después de reclamar'), 100);
  const r = (await retos(app, 'gratis')).body;
  assert.equal(r.membresia, false, 'sigue sin poder jugar');
  assert.equal(r.xp, 100);
  assert.deepEqual([r.nivel.id, r.nivel.nombre, r.nivel.faltan], [1, 'Aprendiz', 400]);
  const p = (await premios(app, 'gratis')).body;
  assert.equal(p.xp.bienvenida, 100);
  assert.equal(p.membresia, false);
  assert.equal(db.value('retosUsuario/gratis'), undefined, 'ver el XP no escribe nada');
  assert.equal(db.value('actividadUsuario/gratis'), undefined, 'ni registra días de actividad');
  assert.equal(db.value('premiosUsuario/gratis').xpTotal, undefined, 'ni lo manda a la clasificación');
});

test('cuenta nueva CON membresía: +100 en Retos, Logros y en la respuesta del premio, todos iguales', async () => {
  const { app } = montar();
  const antes = await totalUnico(app, 'nueva', 'antes');
  const res = await reclamar(app, 'nueva');
  const despues = await totalUnico(app, 'nueva', 'después');
  assert.equal(despues, antes + 100);
  assert.equal(res.body.xpTotal, despues, 'la tarjeta del premio dice el mismo total que Retos');
  assert.equal((await retos(app, 'nueva')).body.xp, despues);
});

// ── 2. Después de jugar un reto ──
test('después de jugar un reto: el XP del reto y la bienvenida se suman y se ven igual en todos lados', async () => {
  const { app } = montar();
  await reclamar(app, 'nueva');
  const antes = await totalUnico(app, 'nueva', 'antes de jugar');
  const j = await jugar(app, 'nueva', { retoId: 'quiz', puntaje: 5, total: 5 });
  assert.equal(j.body.xpGanado, 10);
  const despues = await totalUnico(app, 'nueva', 'después de jugar');
  assert.ok(despues >= antes + 10 + 20, 'el reto (10) y la insignia "Primer reto" (20) suman');
  assert.equal(j.body.xp, despues, 'lo que devuelve el reto es el mismo total que ve la pantalla');
  const p = (await premios(app, 'nueva')).body;
  assert.equal(p.xp.bienvenida, 100, 'la bienvenida sigue contando');
  assert.equal(p.xp.retos, 10 + 20);
});

// ── 3. Después de terminar un curso ──
test('después de terminar un curso (con membresía): el XP del curso se suma al total de Retos y Logros', async () => {
  const [clave, cert] = certDe('ana', 'c1', '2026-09-01T10:00:00.000Z');
  const { app } = montar({ [clave]: cert });
  const p = (await premios(app, 'ana')).body;
  assert.equal(p.xp.cursos, 20);
  assert.equal(await totalUnico(app, 'ana', 'con un curso'), p.xp.total);
  // un segundo curso paga 30 y todo se mueve junto
  const [c2, cert2] = certDe('ana', 'c2', '2026-09-02T10:00:00.000Z');
  const { app: app2 } = montar({ [clave]: cert, [c2]: cert2 });
  assert.equal((await premios(app2, 'ana')).body.xp.cursos, 50);
  assert.equal(await totalUnico(app2, 'ana', 'con dos cursos'), (await premios(app2, 'ana')).body.xp.total);
});

test('quien NO es miembro y terminó un curso de prueba también ve el XP del curso (y la bienvenida) en Retos', async () => {
  const [clave, cert] = certDe('gratis', 'c1', '2026-09-01T10:00:00.000Z');
  const { app } = montar({ [clave]: cert });
  await reclamar(app, 'gratis');
  const total = await totalUnico(app, 'gratis', 'sin membresía, un curso');
  // bienvenida 100 + curso 20 + logro "Primer curso" 20
  assert.equal(total, 100 + 20 + 20);
  const p = (await premios(app, 'gratis')).body;
  assert.equal(p.cursos.terminados, 1);
  assert.equal(p.xp.cursos, 20);
  assert.equal((await retos(app, 'gratis')).body.xp, 140);
});

// ── 4. Miembro vencido ──
test('miembro VENCIDO: sigue viendo el XP que ya ganó (retos, cursos, bienvenida); no puede jugar ni ganar más', async () => {
  const [clave, cert] = certDe('vencida', 'c1', '2026-08-01T10:00:00.000Z');
  const { app, db } = montar({
    [clave]: cert,
    'premiosUsuario/vencida': { uid: 'vencida', ganados: [], usados: [], bienvenida: { fecha: '2026-07-01T00:00:00.000Z' } },
    'retosUsuario/vencida': { uid: 'vencida', xp: 22, xpPractica: 22, superados: 3, dias: [fechaHace(40)], porReto: { quiz: { veces: 3, mejor: 5, total: 5, superados: 3, perfectos: 1 } } }
  });
  const total = await totalUnico(app, 'vencida', 'vencida');
  // bienvenida 100 + XP de retos 22 + insignia "Primer reto" 20 + curso 20 + logro "Primer curso" 20
  assert.equal(total, 100 + 22 + 20 + 20 + 20);
  const r = (await retos(app, 'vencida')).body;
  assert.equal(r.membresia, false);
  assert.equal(r.superados, 3, 've sus retos superados');
  assert.equal((await jugar(app, 'vencida', { retoId: 'quiz', puntaje: 5, total: 5 })).status, 403, 'no puede jugar');
  assert.equal(db.value('retosUsuario/vencida').xp, 22, 'jugar no cambió nada');
  assert.equal(await totalUnico(app, 'vencida', 'vencida otra vez'), total);
});

test('cuando el miembro vencido renueva, su total no cambia salvo el logro de "membresía vigente" (+20)', async () => {
  const { app, db } = montar({ 'premiosUsuario/vencida': { uid: 'vencida', ganados: [], usados: [], bienvenida: { fecha: '2026-07-01T00:00:00.000Z' } } });
  const vencida = await totalUnico(app, 'vencida', 'vencida');
  db._data.set('miembros/vencida', miembroConPlan({ name: 'Renovó' }));
  const renovada = await totalUnico(app, 'vencida', 'renovada');
  assert.equal(renovada, vencida + 20);
});

// ── Fuera de lugar: lo que no debe cambiar ──
test('solo lectura: ver el XP de una cuenta sin membresía no crea documentos ni avisos', async () => {
  const { app, db } = montar();
  await reclamar(app, 'gratis');
  const antes = JSON.stringify([...db._data.entries()]);
  for (let i = 0; i < 3; i++) { await premios(app, 'gratis'); await retos(app, 'gratis'); }
  assert.equal(JSON.stringify([...db._data.entries()]), antes, 'ninguna lectura escribió algo');
});

test('la lista de logros de quien no es miembro sigue siendo vista previa (sin XP ni "ganado" por insignia)', async () => {
  const { app } = montar();
  await reclamar(app, 'gratis');
  const p = (await premios(app, 'gratis')).body;
  assert.equal(p.logros.length, L.LOGROS.length + 10);
  for (const l of p.logros) assert.ok(!('ganado' in l) && !('xp' in l), l.id);
  assert.equal(p.racha, 0);
  assert.equal(p.disponibles, 0);
});

test('un administrador sigue contando como miembro (su total es el de siempre)', async () => {
  const { app } = montar();
  assert.equal((await retos(app, 'admin')).body.membresia, true);
  await totalUnico(app, 'admin', 'administrador');
});
