'use strict';

// MODO DE 1 CAMBIO (el de salida). La función "Cambiar el orden de los cursos" sale con UN SOLO cambio por miembro para observar si la usan
// (services/retos.js · MAX_CAMBIOS_ORDEN = 1). Ampliarla a 2 es cambiar ESE número: aquí se simula con fijarMaxCambiosOrdenParaPruebas(2) para
// comprobar que todo reaparece solo (segundo tramo, insignia «Rumbo propio», total de logros). El modo de 2 cambios completo está en
// test/cambio-orden.test.js. También se prueba el panel de administración (GET /api/admin/cambios-orden).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { cargarServidor, ts, dias } = require('./helpers/cargar-servidor');
const { miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const R = require('../services/retos');
const L = require('../services/logros');

const DIA = 86400000;
const tokens = tokensDe('ana', 'beto', 'cleo', 'sinplan', 'admin');

function cursos() {
  const seed = {};
  for (let i = 1; i <= 5; i++) seed[`cursos/c${i}`] = { title: `Curso ${i}`, area: 'Manejo', ordenVip: i, createdAt: ts(Date.now() - (40 - i) * DIA), lecciones: [{ titulo: 'Clase 1', videoId: `bbbbbbbb-0000-4000-8000-${String(i * 10 + 1).padStart(12, '0')}`, provider: 'bunny' }] };
  return seed;
}
const miembroNuevo = (haceDias, extra = {}) => miembroConPlan({ name: 'Ana', createdAt: new Date(Date.now() - (haceDias + 5) * DIA).toISOString(), planInicio: ts(Date.now() - haceDias * DIA), ...extra });
function servidor(seed = {}, env = {}) {
  return cargarServidor({
    tokens, env,
    usuariosAuth: { ana: { creationTime: new Date(Date.now() - 30 * DIA).toUTCString() } },
    seed: {
      ...cursos(), 'config/calendario': { nuevoDesde: ts(Date.now() - 10 * DIA) },
      'miembros/sinplan': miembroSinPlan(),
      'miembros/admin': miembroSinPlan({ role: 'admin', name: 'Admin', email: 'admin@example.com' }),
      ...seed
    }
  });
}
const rango = n => Array.from({ length: n }, (_, i) => i);
function retosCon(q, d, o, { usados = 0, uid = 'ana' } = {}) {
  return {
    uid, xp: 0, xpPractica: 0, superados: q + d + o,
    camino: { quiz: q, detective: d, orden: o }, caminoHechos: { quiz: rango(q), detective: rango(d), orden: rango(o) },
    ordenRetos: { quiz: rango(q), detective: rango(d), orden: rango(o) }, cambiosOrden: usados
  };
}
const estado = (app, t = 'token-ana') => request(app).get('/api/calendario/cambio-orden').set(auth(t));
const cambiar = (app, cuerpo, t = 'token-ana') => request(app).post('/api/calendario/cambiar-orden').set(auth(t)).send(cuerpo);
const base = (extra = {}) => ({ 'miembros/ana': miembroNuevo(2), ...extra });

/* ───────────── La constante y el estado que manda el servidor ───────────── */

test('un solo número decide cuántos cambios hay: MAX_CAMBIOS_ORDEN = 1; los dos tramos (35/8 y 55/14) ya están definidos', () => {
  assert.equal(R.MAX_CAMBIOS_ORDEN, 1);
  assert.equal(R.maxCambiosOrden(), 1);
  assert.deepEqual(R.CAMBIOS_ORDEN_DEFINIDOS.map(t => [t.n, t.total, t.porTipo]), [[1, 35, 8], [2, 55, 14]]);
  assert.deepEqual(R.cambiosOrdenVigentes().map(t => [t.n, t.total, t.porTipo]), [[1, 35, 8]]);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'services', 'retos.js'), 'utf8'), /\nconst MAX_CAMBIOS_ORDEN = 1;/);
});

test('progreso: con 1 cambio hay un solo tramo y maximo = 1; con 55 retos y 14 de cada tipo NO existe un segundo tramo', () => {
  const p = R.progresoCambioOrden(retosCon(26, 14, 14));
  assert.equal(p.maximo, 1);
  assert.equal(p.tramos.length, 1);
  assert.equal(p.siguiente.n, 1);
  assert.equal(p.siguiente.cumple, true);
  assert.deepEqual(p.siguiente.libres, { hechos: 11, meta: 11 });
  const usado = R.progresoCambioOrden(retosCon(26, 14, 14, { usados: 1 }));
  assert.equal(usado.siguiente, null, 'usado el único cambio, no hay siguiente');
  assert.equal(usado.tramos[0].usado, true);
  // un estado guardado con 2 cambios (de cuando se amplíe) no inventa un segundo uso: el tope es el máximo vigente
  assert.equal(R.normalizarEstado({ ...retosCon(26, 14, 14), cambiosOrden: 2 }).cambiosOrden, 1);
});

test('estado del servidor: maximo 1, un solo tramo y, tras usarlo, la oferta desaparece (disponible false, sin siguiente)', async () => {
  const { app } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }));
  const e = (await estado(app)).body;
  assert.equal(e.maximo, 1);
  assert.equal(e.tramos.length, 1);
  assert.equal(e.disponible, true);
  assert.deepEqual([e.tramos[0].total, e.tramos[0].porTipo, e.tramos[0].libres.meta], [35, 8, 11]);
  assert.equal(e.xpInsignias[1], 40);
  const hecho = await cambiar(app, { cursoId: 'c4', confirmar: true });
  assert.equal(hecho.status, 200);
  const d = (await estado(app)).body;
  assert.deepEqual([d.usados, d.maximo, d.disponible, d.siguiente], [1, 1, false, null]);
  assert.equal(d.cambios.length, 1);
});

test('el segundo cambio se rechaza aunque tenga 55 retos (14 de cada tipo): 409 sin-cambios y el calendario no se toca', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(26, 14, 14) }));
  assert.equal((await cambiar(app, { cursoId: 'c4', confirmar: true })).status, 200);
  const antes = JSON.stringify(db.value('calendariosCursos/ana').entradas);
  const otra = await cambiar(app, { cursoId: 'c5', confirmar: true });
  assert.equal(otra.status, 409);
  assert.equal(otra.body.codigo, 'sin-cambios');
  assert.match(otra.body.error, /Ya usaste tu cambio de orden/);
  assert.equal(/2 cambios/.test(otra.body.error), false, 'sin hablar de un segundo cambio');
  assert.equal(JSON.stringify(db.value('calendariosCursos/ana').entradas), antes);
  assert.equal(db.value('retosUsuario/ana').cambiosOrden, 1);
  assert.equal(db.value('calendariosCursos/ana').cambiosOrden.length, 1);
});

test('el aviso de la campana habla de un solo cambio y no menciona XP ni un segundo cambio', async () => {
  const { app, db } = servidor(base({ 'retosUsuario/ana': retosCon(19, 8, 8) }));
  await cambiar(app, { cursoId: 'c4', confirmar: true });
  const aviso = db.value('avisos/ana/items/cambio_orden_1');
  assert.ok(aviso, 'se creó el aviso');
  assert.match(aviso.texto, /Ya usaste tu cambio./);
  assert.equal(/XP|segundo|2 cambios|queda/i.test(aviso.texto), false);
});

/* ───────────── Insignias y total de logros ───────────── */

test('insignias: con 1 cambio solo existe «Calendario a tu medida» (r11); «Rumbo propio» (r12) no se muestra ni cuenta', () => {
  const ids = R.insigniasVigentes().map(i => i.id);
  assert.equal(ids.includes('r11'), true);
  assert.equal(ids.includes('r12'), false);
  assert.equal(ids.length, 11);
  assert.equal(R.insignias(retosCon(26, 14, 14, { usados: 1 })).some(i => i.id === 'r12'), false);
  assert.equal(R.insignias(retosCon(26, 14, 14, { usados: 1 })).find(i => i.id === 'r11').desbloqueada, true);
  const r11 = R.insigniasVigentes().find(i => i.id === 'r11');
  assert.equal(r11.desc, 'Cambiaste el orden de tu calendario');
  assert.match(r11.criterio, /un solo cambio/);
  assert.equal(/2 cambios|segundo/i.test(r11.criterio + r11.desc), false);
  // vista previa y evaluación traen el mismo total: 26 logros + 11 insignias = 37
  assert.equal(L.logrosVistaPrevia().length, 37);
  const ev = L.evaluar({ esVIP: true, completados: 0, areas: 0, dias: [], tarjetaDir: false, foroPosts: 0, foroRespuestas: 0, foroLikes: 0, invitadosValidos: 0 }, retosCon(26, 14, 14, { usados: 1 }));
  assert.equal(ev.logros.length, 37);
  assert.equal(ev.logros.filter(l => l.ganado && l.id === 'r11').length, 1);
  assert.equal(ev.logros.some(l => l.id === 'r12'), false);
});

test('con 1 cambio nadie gana r12 aunque el estado guardado diga 2 cambios (no suma XP de más)', () => {
  const dos = { ...retosCon(26, 14, 14), cambiosOrden: 2 };
  const uno = { ...retosCon(26, 14, 14), cambiosOrden: 1 };
  const evaluar = e => L.evaluar({ esVIP: true, completados: 0, areas: 0, dias: [], tarjetaDir: false, foroPosts: 0, foroRespuestas: 0, foroLikes: 0, invitadosValidos: 0 }, e);
  assert.equal(evaluar(dos).xp.total, evaluar(uno).xp.total);
});

test('modo de 2 cambios (simulado): reaparece r12, el total pasa a 38, hay dos tramos y el XP máximo sube lo que vale r12 (60)', () => {
  const xp1 = L.xpMaximo();
  const restaurar = R.fijarMaxCambiosOrdenParaPruebas(2);
  try {
    assert.equal(R.maxCambiosOrden(), 2);
    assert.deepEqual(R.cambiosOrdenVigentes().map(t => t.total), [35, 55]);
    assert.equal(R.progresoCambioOrden(retosCon(26, 14, 14)).tramos.length, 2);
    assert.equal(R.progresoCambioOrden(retosCon(26, 14, 14)).maximo, 2);
    assert.equal(R.insigniasVigentes().length, 12);
    assert.equal(L.logrosVistaPrevia().length, 38);
    assert.equal(L.evaluar({ esVIP: true, completados: 0, areas: 0, dias: [], tarjetaDir: false, foroPosts: 0, foroRespuestas: 0, foroLikes: 0, invitadosValidos: 0 }, retosCon(26, 14, 14, { usados: 2 })).logros.filter(l => l.ganado && /^r1[12]$/.test(l.id)).length, 2);
    const xp2 = L.xpMaximo();
    assert.equal(xp2.total - xp1.total, 60);
    assert.ok(xp1.total >= 6000 && xp1.total <= 8500 && xp2.total >= 6000 && xp2.total <= 8500, `el tope de XP sigue en rango: ${xp1.total} y ${xp2.total}`);
    assert.match(R.insigniasVigentes().find(i => i.id === 'r11').criterio, /2 cambios por miembro/);
  } finally { restaurar(); }
  assert.equal(R.maxCambiosOrden(), 1);
  assert.equal(L.logrosVistaPrevia().length, 37);
});

test('modo de 2 cambios (simulado) en el servidor: el segundo cambio con 55 retos SÍ se permite', async () => {
  const restaurar = R.fijarMaxCambiosOrdenParaPruebas(2);
  try {
    const { app } = servidor(base({ 'retosUsuario/ana': retosCon(27, 14, 14) }));
    assert.equal((await estado(app)).body.tramos.length, 2);
    assert.equal((await cambiar(app, { cursoId: 'c4', confirmar: true })).status, 200);
    const e = (await estado(app)).body;
    assert.deepEqual([e.usados, e.maximo, e.disponible], [1, 2, true]);
    assert.equal((await cambiar(app, { cursoId: 'c5', confirmar: true })).status, 200);
    assert.equal((await cambiar(app, { cursoId: 'c3', confirmar: true })).status, 409);
  } finally { restaurar(); }
});

/* ───────────── Panel de administración ───────────── */

async function conCambios() {
  const hoy = Date.now();
  const seed = base({
    'miembros/beto': miembroNuevo(3, { name: 'Beto Soto', email: 'beto.soto@example.com' }),
    'miembros/cleo': miembroNuevo(4, { name: 'Cleo Ruiz', email: 'cleo@example.com' }),
    'miembros/vencida': miembroConPlan({ name: 'Vencida', planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)), planInicio: ts(dias(-60)), createdAt: new Date(dias(-90)).toISOString() }),
    'retosUsuario/ana': retosCon(19, 8, 8),                                  // puede y no lo ha usado
    'retosUsuario/beto': retosCon(20, 9, 9, { usados: 1, uid: 'beto' }),    // ya lo usó
    'retosUsuario/cleo': retosCon(3, 1, 0, { uid: 'cleo' }),                // con retos nuevos, aún lejos
    'calendarioCambios/k1': { uid: 'beto', n: 1, cursoId: 'c4', titulo: 'Curso 4', anteriorCursoId: 'c2', anteriorTitulo: 'Curso 2', deLugar: 3, aLugar: 1, en: new Date(hoy - 2 * DIA).toISOString(), fecha: ts(hoy - 2 * DIA), retos: { quiz: 20, detective: 9, orden: 9, total: 38 } },
    'calendarioCambios/k2': { uid: 'cleo', n: 1, cursoId: 'c4', titulo: 'Curso 4', deLugar: 3, aLugar: 1, en: new Date(hoy - 5 * DIA).toISOString(), fecha: ts(hoy - 5 * DIA) }
  });
  return servidor(seed, { ADMIN_EMAILS: 'admin@example.com' });
}

test('admin: GET /api/admin/cambios-orden solo para administradores (401 sin sesión, 403 a un miembro)', async () => {
  const { app } = await conCambios();
  assert.equal((await request(app).get('/api/admin/cambios-orden')).status, 401);
  assert.equal((await request(app).get('/api/admin/cambios-orden').set(auth('token-ana'))).status, 403);
  assert.equal((await request(app).get('/api/admin/cambios-orden').set(auth('token-admin'))).status, 200);
});

test('admin: la lista trae nombre, correo enmascarado, fecha, retos por tipo, curso nuevo y curso que iba primero, del más reciente al más antiguo', async () => {
  const { app } = await conCambios();
  const r = (await request(app).get('/api/admin/cambios-orden').set(auth('token-admin'))).body;
  assert.equal(r.ok, true);
  assert.equal(r.maximo, 1);
  assert.deepEqual(r.tramos, [{ n: 1, total: 35, porTipo: 8 }]);
  assert.deepEqual(r.cambios.map(c => c.uid), ['beto', 'cleo'], 'más reciente primero');
  const b = r.cambios[0];
  assert.equal(b.nombre, 'Beto Soto');
  assert.match(b.correo, /^b\*+@example\.com$/);
  assert.equal(b.correo.includes('beto.soto'), false, 'nunca el correo completo');
  assert.deepEqual([b.curso, b.anterior, b.deLugar, b.aLugar, b.n], ['Curso 4', 'Curso 2', 3, 1, 1]);
  assert.deepEqual(b.retos, { quiz: 20, detective: 9, orden: 9, total: 38 });
  assert.ok(Date.parse(b.en) > 0);
  assert.equal(r.cambios[1].anterior, '', 'un registro viejo sin el curso anterior no rompe nada');
  assert.equal(r.cambios[1].retos, null);
  assert.deepEqual(r.resumen, { cambios: 2, personas: 2 });
});

test('admin: el embudo cuenta solo miembros con membresía vigente y sin administradores', async () => {
  const { app } = await conCambios();
  const r = (await request(app).get('/api/admin/cambios-orden').set(auth('token-admin'))).body;
  const por = Object.fromEntries(r.embudo.map(x => [x.id, x.personas]));
  assert.deepEqual(r.embudo.map(x => x.id), ['activos', 'conRetos', 'alcanzaron', 'usaron', 'disponibles']);
  assert.equal(por.activos, 3, 'ana, beto y cleo (no el administrador ni la membresía vencida ni quien no tiene plan)');
  assert.equal(por.conRetos, 3);
  assert.equal(por.alcanzaron, 2, 'ana (puede) y beto (ya lo usó)');
  assert.equal(por.usaron, 1);
  assert.equal(por.disponibles, 1);
  assert.deepEqual(r.puedenSinUsar.map(x => [x.uid, x.retos]), [['ana', 35]]);
  assert.match(r.embudo[2].nombre, /35 retos/);
});

test('admin: cambios por día (30 días en hora de México) y cursos más elegidos', async () => {
  const { app } = await conCambios();
  const r = (await request(app).get('/api/admin/cambios-orden').set(auth('token-admin'))).body;
  assert.equal(r.porDia.length, 30);
  assert.equal(r.porDia.reduce((t, d) => t + d.cambios, 0), 2);
  assert.equal(r.porDia.filter(d => d.cambios > 0).length, 2, 'dos días distintos');
  assert.ok(r.porDia.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.dia)));
  assert.deepEqual(r.cursos, [{ cursoId: 'c4', curso: 'Curso 4', veces: 2 }]);
});

test('admin: sin cambios todavía el panel recibe listas vacías (estado vacío) y el embudo en cero para los que no cumplen', async () => {
  const { app } = servidor(base({}), { ADMIN_EMAILS: 'admin@example.com' });
  const r = (await request(app).get('/api/admin/cambios-orden').set(auth('token-admin'))).body;
  assert.deepEqual([r.total, r.cambios.length, r.cursos.length, r.puedenSinUsar.length], [0, 0, 0, 0]);
  assert.equal(r.porDia.reduce((t, d) => t + d.cambios, 0), 0);
  assert.equal(r.embudo.find(x => x.id === 'usaron').personas, 0);
  assert.equal(r.embudo.find(x => x.id === 'activos').personas, 1);
});
