'use strict';

// Avisos (campana): creación idempotente, recorte de límites, mezcla personal + global.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../services/avisos');
const { FakeFirestore } = require('./helpers/fake-firestore');

const T0 = new Date('2026-10-09T15:00:00Z');
const min = n => new Date(T0.getTime() + n * 60000);

test('crearAviso guarda el aviso con id determinista y NO lo sobrescribe', async () => {
  const db = new FakeFirestore();
  const r1 = await A.crearAviso(db, 'ana', { id: 'logro_l4', tipo: 'logro', titulo: '🏅 ¡Nueva insignia!', texto: 'Primer curso', enlace: 'club-logros.html' }, { ahora: T0 });
  assert.deepEqual(r1, { creado: true, id: 'logro_l4' });
  const guardado = db.value('avisos/ana/items/logro_l4');
  assert.equal(guardado.tipo, 'logro');
  assert.equal(guardado.titulo, '🏅 ¡Nueva insignia!');
  assert.equal(guardado.texto, 'Primer curso');
  assert.equal(guardado.enlace, 'club-logros.html');
  assert.equal(guardado.creadoEn.getTime(), T0.getTime());

  const r2 = await A.crearAviso(db, 'ana', { id: 'logro_l4', tipo: 'logro', titulo: 'OTRO TÍTULO', texto: 'otro' }, { ahora: min(5) });
  assert.deepEqual(r2, { creado: false, id: 'logro_l4' });
  assert.equal(db.value('avisos/ana/items/logro_l4').titulo, '🏅 ¡Nueva insignia!', 'no se sobrescribe');
  assert.equal(db.value('avisos/ana/items/logro_l4').creadoEn.getTime(), T0.getTime());
});

test('crearAviso: dos llamadas simultáneas crean un solo aviso', async () => {
  const db = new FakeFirestore();
  db.lenta = true;
  const datos = { id: 'premio_profesional', tipo: 'premio', titulo: '🎁 ¡Ganaste un premio!' };
  const r = await Promise.all([A.crearAviso(db, 'ana', datos), A.crearAviso(db, 'ana', datos), A.crearAviso(db, 'ana', datos)]);
  assert.equal(r.filter(x => x.creado).length, 1);
});

test('crearAviso recorta a los límites (120 / 240 / 40) y limpia caracteres de control; el texto va tal cual', async () => {
  const db = new FakeFirestore();
  await A.crearAviso(db, 'ana', {
    id: 'xp_1', tipo: 'xp', titulo: `  <b>T</b>${'t'.repeat(200)}\u0000‮`, texto: `x${'y'.repeat(400)}`, enlace: 'a'.repeat(100)
  });
  const g = db.value('avisos/ana/items/xp_1');
  assert.equal(g.titulo.length, 120);
  assert.ok(g.titulo.startsWith('<b>T</b>'), 'no se convierte a entidades: el sitio escapa al mostrar');
  assert.ok(!/[\u0000‮]/.test(g.titulo));
  assert.equal(g.texto.length, 240);
  assert.equal(g.enlace.length, 40);
});

test('crearAviso no parte un emoji por la mitad al recortar', async () => {
  const db = new FakeFirestore();
  await A.crearAviso(db, 'ana', { id: 'e', tipo: 'xp', titulo: '😀'.repeat(100) });
  const t = db.value('avisos/ana/items/e').titulo;
  assert.ok(t.length <= 120);
  assert.equal([...t].every(c => c === '😀'), true);
});

test('crearAviso rechaza lo inválido sin lanzar', async () => {
  const db = new FakeFirestore();
  const malos = [
    ['ana', { id: '', tipo: 'xp', titulo: 'x' }],
    ['ana', { id: '///', tipo: 'xp', titulo: 'x' }],
    ['ana', { id: 'a', tipo: 'noticia', titulo: 'x' }],      // tipo global en un aviso personal
    ['ana', { id: 'a', tipo: 'xp', titulo: '   ' }],
    ['', { id: 'a', tipo: 'xp', titulo: 'x' }],
    ['a/b', { id: 'a', tipo: 'xp', titulo: 'x' }],
    [null, { id: 'a', tipo: 'xp', titulo: 'x' }],
    ['ana', undefined],
    ['ana', null]
  ];
  for (const [uid, datos] of malos) {
    const r = await A.crearAviso(db, uid, datos);
    assert.equal(r.creado, false, JSON.stringify([uid, datos]));
  }
  assert.equal(db._data.size, 0);
});

test('crearAviso: el id se vuelve seguro (sin barras ni espacios)', async () => {
  const db = new FakeFirestore();
  const r = await A.crearAviso(db, 'ana', { id: 'bonoxp_curso/uno dos', tipo: 'xp', titulo: 'x' });
  assert.equal(r.id, 'bonoxp_curso_uno_dos');
  assert.ok(db.value('avisos/ana/items/bonoxp_curso_uno_dos'));
});

test('crearAviso NUNCA lanza aunque Firestore falle', async () => {
  const roto = { collection: () => { throw new Error('Firestore caído'); }, runTransaction: async () => { throw new Error('Firestore caído'); } };
  const errores = [];
  const original = console.error; console.error = (...a) => errores.push(a.join(' '));
  try {
    const r = await A.crearAviso(roto, 'ana', { id: 'a', tipo: 'xp', titulo: 'x' });
    assert.deepEqual(r, { creado: false, motivo: 'error' });
    const g = await A.crearNotificacionGlobal(roto, { id: 'a', tipo: 'dato', titulo: 'x' });
    assert.deepEqual(g, { creado: false, motivo: 'error' });
  } finally { console.error = original; }
  assert.equal(errores.length, 2);
});

test('el enlace del aviso no admite esquemas peligrosos ni espacios', async () => {
  const db = new FakeFirestore();
  for (const [i, enlace] of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', 'con espacio.html', '"><x'].entries()) {
    await A.crearAviso(db, 'ana', { id: `e${i}`, tipo: 'xp', titulo: 'x', enlace });
    assert.equal(db.value(`avisos/ana/items/e${i}`).enlace, '', enlace);
  }
});

test('crearNotificacionGlobal: icono y color por tipo, id fijo idempotente y origen', async () => {
  const db = new FakeFirestore();
  const r = await A.crearNotificacionGlobal(db, { id: 'noticias_2026-10-09', tipo: 'noticia', titulo: '📰 Nuevas noticias del sector', descripcion: 'd'.repeat(500), enlace: 'club-noticias.html' }, { ahora: T0 });
  assert.deepEqual(r, { creado: true, id: 'noticias_2026-10-09' });
  const g = db.value('notificacionesGlobales/noticias_2026-10-09');
  assert.equal(g.icono, A.PRESETS.noticia.icono);
  assert.equal(g.color, A.PRESETS.noticia.color);
  assert.equal(g.descripcion.length, 320);
  assert.equal(g.origen, 'auto');
  const otra = await A.crearNotificacionGlobal(db, { id: 'noticias_2026-10-09', tipo: 'noticia', titulo: 'otro' });
  assert.equal(otra.creado, false);
  assert.equal(db.value('notificacionesGlobales/noticias_2026-10-09').titulo, '📰 Nuevas noticias del sector');
});

test('crearNotificacionGlobal sin id genera uno distinto cada vez; el tipo personal no vale', async () => {
  const db = new FakeFirestore();
  const a = await A.crearNotificacionGlobal(db, { tipo: 'general', titulo: 'Hola', origen: 'admin' }, { ahora: T0 });
  const b = await A.crearNotificacionGlobal(db, { tipo: 'general', titulo: 'Hola', origen: 'admin' }, { ahora: T0 });
  assert.ok(a.creado && b.creado && a.id !== b.id);
  assert.equal(db.value(`notificacionesGlobales/${a.id}`).origen, 'admin');
  assert.equal((await A.crearNotificacionGlobal(db, { tipo: 'logro', titulo: 'x' })).creado, false);
  assert.equal((await A.crearNotificacionGlobal(db, { tipo: 'general', titulo: '' })).creado, false);
});

test('todos los tipos tienen preset de icono y color', () => {
  for (const tipo of [...A.TIPOS_PERSONALES, ...A.TIPOS_GLOBALES]) {
    assert.ok(A.PRESETS[tipo].icono && /^#[0-9A-F]{6}$/i.test(A.PRESETS[tipo].color), tipo);
  }
  assert.deepEqual(A.TIPOS_PERSONALES, ['certificado', 'logro', 'premio', 'libro', 'xp', 'bienvenida']);
  assert.deepEqual(A.TIPOS_GLOBALES, ['noticia', 'dato', 'sistema', 'clase', 'curso', 'general']);
  assert.equal(A.presetDe('inventado'), A.PRESETS.general);
});

test('listarAvisos mezcla personales y globales, más reciente primero, con ámbito, icono y color', async () => {
  const db = new FakeFirestore();
  await A.crearAviso(db, 'ana', { id: 'logro_l1', tipo: 'logro', titulo: 'Insignia', texto: 'Bienvenido', enlace: 'club-logros.html' }, { ahora: min(1) });
  await A.crearNotificacionGlobal(db, { id: 'dato_1', tipo: 'dato', titulo: 'Dato', descripcion: 'Algo curioso' }, { ahora: min(2) });
  await A.crearAviso(db, 'ana', { id: 'xp_a', tipo: 'xp', titulo: 'XP', texto: '+20' }, { ahora: min(3) });
  await A.crearAviso(db, 'beto', { id: 'xp_b', tipo: 'xp', titulo: 'De Beto' }, { ahora: min(4) });
  const lista = await A.listarAvisos(db, 'ana');
  assert.deepEqual(lista.map(a => a.id), ['xp_a', 'dato_1', 'logro_l1']);
  assert.deepEqual(lista.map(a => a.ambito), ['personal', 'global', 'personal']);
  assert.deepEqual(lista[1], {
    id: 'dato_1', ambito: 'global', tipo: 'dato', titulo: 'Dato', texto: 'Algo curioso', enlace: '',
    icono: A.PRESETS.dato.icono, color: A.PRESETS.dato.color, fecha: min(2).toISOString()
  });
  assert.equal(lista[2].fecha, min(1).toISOString());
  assert.equal(lista[2].icono, A.PRESETS.logro.icono);
  assert.ok(!lista.some(a => a.id === 'xp_b'), 'los avisos de otra persona no aparecen');
});

test('listarAvisos: 30 personales + 15 globales entre las más recientes, máximo 40', async () => {
  const db = new FakeFirestore();
  for (let i = 0; i < 40; i++) await A.crearAviso(db, 'ana', { id: `p${i}`, tipo: 'xp', titulo: `p${i}` }, { ahora: min(i * 2) });
  for (let i = 0; i < 20; i++) await A.crearNotificacionGlobal(db, { id: `g${i}`, tipo: 'general', titulo: `g${i}` }, { ahora: min(i * 2 + 1) });
  const lista = await A.listarAvisos(db, 'ana');
  assert.equal(lista.length, 40);
  const personales = lista.filter(a => a.ambito === 'personal');
  const globales = lista.filter(a => a.ambito === 'global');
  assert.ok(personales.length <= 30 && globales.length <= 15);
  // ordenados de más nuevo a más viejo
  for (let i = 1; i < lista.length; i++) assert.ok(lista[i - 1].fecha >= lista[i].fecha);
  assert.equal(lista[0].id, 'p39');
});

test('listarAvisos de alguien sin avisos devuelve lista vacía (sin globales: vacía)', async () => {
  assert.deepEqual(await A.listarAvisos(new FakeFirestore(), 'nadie'), []);
});

test('listarGlobalesAdmin: últimos 50 con su origen', async () => {
  const db = new FakeFirestore();
  for (let i = 0; i < 55; i++) await A.crearNotificacionGlobal(db, { id: `g${i}`, tipo: 'sistema', titulo: `g${i}`, origen: i % 2 ? 'admin' : 'auto' }, { ahora: min(i) });
  const lista = await A.listarGlobalesAdmin(db);
  assert.equal(lista.length, 50);
  assert.equal(lista[0].id, 'g54');
  assert.equal(lista[0].origen, 'auto');
  assert.equal(lista[1].origen, 'admin');
});
