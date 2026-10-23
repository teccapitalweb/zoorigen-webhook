'use strict';

// Calibración de la dificultad: con las fuentes nuevas de XP (cursos, bienvenida) los umbrales de nivel
// se fijan respecto al XP MÁXIMO posible: Profesional ~25 %, Maestro ~75 % (y siempre alcanzable, <= 90 %).
// Estas pruebas arman personas "de ejemplo" con las reglas reales y comprueban que la dificultad se sostiene.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../services/logros');
const P = require('../services/premios');
const R = require('../services/retos');
const { ruta } = require('./helpers/rutas-xp');

const MAX = L.xpMaximo();
const nivel = id => L.NIVELES.find(n => n.id === id);
const PROFESIONAL = nivel(3).desde;
const LIDER = nivel(4).desde;
const MAESTRO = nivel(5).desde;
const xp = p => ruta(p).xp.total;

// Rutas de ejemplo (cada una es una persona con membresía y el premio de bienvenida)
const RUTAS = {
  casual: { cursos: 1, areas: 1, dias: 8, racha: 3, retos: { practicaDias: 2 } },
  // el escenario del contrato: ~4 cursos + 20 retos + foro/directorio + 30 días en el club
  tipica: { cursos: 4, areas: 2, dias: 30, racha: 14, tarjeta: true, foroPosts: 1, retos: { practicaDias: 5 } },
  tipicaMasForo: { cursos: 4, areas: 4, dias: 30, racha: 14, tarjeta: true, foroPosts: 3, retos: { practicaDias: 5 } },
  constante: { cursos: 6, areas: 4, dias: 30, racha: 14, tarjeta: true, foroPosts: 3, retos: { practicaDias: 5 } },
  dedicada: { cursos: 12, areas: 4, dias: 90, racha: 60, tarjeta: true, foroPosts: 6, foroRespuestas: 9, foroLikes: 25, retos: { camino: 77, practicaDias: 15 } },
  soloEstudiar: { cursos: 15, areas: 5, dias: 10, racha: 3, tarjeta: true },
  soloRetos: { dias: 60, racha: 60, retos: { camino: 77, practicaDias: 15 } },
  soloInvitar: { invitados: 6, dias: 3, racha: 3 },
  todoMenosInvitados: { cursos: 15, areas: 5, dias: 90, racha: 60, tarjeta: true, foroPosts: 9, foroRespuestas: 9, foroLikes: 99, retos: { camino: 77, practicaDias: 15 } }
};
const TODO = { ...RUTAS.todoMenosInvitados, invitados: 6 };

test('niveles: 5 niveles con nombres fijos, umbrales crecientes y tabla única (la misma que sirve el servidor)', () => {
  assert.deepEqual(L.NIVELES.map(n => n.nombre), ['Aprendiz', 'Técnico', 'Profesional', 'Líder', 'Maestro']);
  assert.deepEqual(L.NIVELES.map(n => [n.desde, n.hasta]), [[0, 500], [500, 1700], [1700, 3500], [3500, 5100], [5100, 99999]]);
  for (let i = 1; i < L.NIVELES.length; i++) assert.equal(L.NIVELES[i].desde, L.NIVELES[i - 1].hasta, 'sin huecos entre niveles');
});

test('calibración: Profesional ~25 % y Maestro ~75 % del XP máximo, y Maestro sigue siendo alcanzable (<= 90 %)', () => {
  assert.ok(Math.abs(PROFESIONAL / MAX.total - 0.25) <= 0.05, `Profesional pide ${(PROFESIONAL / MAX.total * 100).toFixed(1)} % del máximo`);
  // Al agregar 24 retos al camino (+240 XP de máximo) y luego 30 escenas de Detective (+300 XP) los umbrales NO se movieron a propósito:
  // subirlos haría bajar de nivel a quien ya lo tiene. Con 15 preguntas de quiz y 15 secuencias más (+300 XP), Profesional pide 21.9 % y Maestro 65.6 % del
  // máximo (antes 25 % y 74.5 %), por eso las tolerancias son de 5 y 10 puntos. Si algún día se quiere devolver la dificultad, se hará con cuidado de no bajar a nadie.
  assert.ok(Math.abs(MAESTRO / MAX.total - 0.75) <= 0.10, `Maestro pide ${(MAESTRO / MAX.total * 100).toFixed(1)} % del máximo`);
  assert.ok(MAESTRO / MAX.total <= 0.9);
  assert.ok(MAX.total >= 6000 && MAX.total <= 8000, `máximo ${MAX.total}`);
});

test('los logros de cursos no pagan dos veces lo mismo: todos juntos valen menos que el XP por terminar los 15 cursos', () => {
  const ids = ['l4', 'l5', 'l6', 'l7', 'l8', 'l23', 'l24', 'l25', 'l26'];
  const logrosDeCursos = L.LOGROS.filter(l => ids.includes(l.id)).reduce((t, l) => t + l.xp, 0);
  assert.ok(logrosDeCursos < MAX.cursos, `${logrosDeCursos} de logros contra ${MAX.cursos} de la fórmula`);
});

test('el máximo se puede alcanzar de verdad: la persona que lo hace todo suma exactamente el XP máximo y es Maestro', () => {
  // Solo el escenario máximo hace todos los retos; las rutas de dificultad conservan sus 77.
  const ev = ruta({ ...TODO, retos: { ...TODO.retos, camino: Object.values(R.TOTALES_CAMINO).reduce((suma, n) => suma + n, 0) } });
  assert.equal(ev.xp.total, MAX.total);
  assert.equal(ev.nivel.id, 5);
  assert.deepEqual(ev.xp, { total: MAX.total, logros: MAX.logros, retos: MAX.insignias + MAX.retos, referidos: MAX.referidos, cursos: MAX.cursos, bienvenida: MAX.bienvenida });
});

test('ruta razonable (4 cursos + 20 retos + 30 días + directorio + foro) NO llega a Profesional, aunque sí pasa de Técnico', () => {
  for (const nombre of ['tipica', 'tipicaMasForo']) {
    const ev = ruta(RUTAS[nombre]);
    assert.ok(ev.xp.total < PROFESIONAL, `${nombre}: ${ev.xp.total} (Profesional ${PROFESIONAL})`);
    assert.equal(ev.nivel.id, 2, `${nombre} se queda en Técnico`);
    assert.ok(ev.xp.total > PROFESIONAL * 0.6, `${nombre}: ${ev.xp.total} no debería ser trivial`);
  }
  // Si solo entra 10 días y juega 20 retos baja a menos todavía
  assert.ok(xp({ ...RUTAS.tipica, dias: 10, racha: 10 }) < xp(RUTAS.tipica));
  // Lo casual apenas pasa de Aprendiz
  assert.equal(ruta(RUTAS.casual).nivel.id, 1);
});

test('Profesional sí se alcanza con más esfuerzo: 6 cursos + 3 discusiones, o 4 cursos + 40 retos + 30 días seguidos', () => {
  assert.ok(ruta(RUTAS.constante).nivel.id >= 3, `constante: ${xp(RUTAS.constante)}`);
  assert.ok(ruta({ cursos: 4, areas: 2, dias: 60, racha: 30, tarjeta: true, foroPosts: 1, retos: { practicaDias: 10 } }).nivel.id >= 3);
});

test('hacer una sola cosa no basta para Líder: solo estudiar, solo retos o solo invitar se quedan por debajo', () => {
  for (const nombre of ['soloEstudiar', 'soloRetos', 'soloInvitar']) {
    assert.ok(xp(RUTAS[nombre]) < LIDER, `${nombre}: ${xp(RUTAS[nombre])} (Líder ${LIDER})`);
  }
});

test('Maestro exige casi todo: sin invitados apenas alcanza, y si falta un hito grande o los cursos ya no se llega', () => {
  const sinInvitados = ruta(RUTAS.todoMenosInvitados);
  assert.ok(sinInvitados.xp.total >= MAESTRO, `todo menos invitados: ${sinInvitados.xp.total}`);
  assert.equal(sinInvitados.nivel.id, 5);
  // Margen mínimo: lo que sobra por encima de Maestro es una fracción muy pequeña del máximo
  assert.ok((sinInvitados.xp.total - MAESTRO) / MAX.total < 0.05, `sobran ${sinInvitados.xp.total - MAESTRO} XP`);
  // Sin ningún curso y sin invitados no es Maestro ni de lejos
  const sinCursosNiInvitados = ruta({ ...RUTAS.todoMenosInvitados, cursos: 0, areas: 0 });
  assert.ok(sinCursosNiInvitados.xp.total < MAESTRO * 0.8, `sin cursos ni invitados: ${sinCursosNiInvitados.xp.total}`);
  // Maestro es ~75 % del máximo, así que se puede saltar UNA de las dos grandes fuentes (cursos o invitados), pero sobra muy poco
  const sinCursos = ruta({ ...TODO, cursos: 0, areas: 0 });
  assert.ok(sinCursos.xp.total >= MAESTRO && (sinCursos.xp.total - MAESTRO) / MAX.total < 0.05, `sin cursos pero con 6 invitados que pagan: ${sinCursos.xp.total}`);
  // Sin la racha de 60 días (el logro más caro) y sin invitados tampoco
  const sinRacha = ruta({ ...RUTAS.todoMenosInvitados, racha: 20 });
  assert.ok(sinRacha.xp.total < MAESTRO, `sin racha de 60: ${sinRacha.xp.total}`);
  // Una ruta muy completa pero incompleta (12 cursos, sin invitados) llega a Líder, no a Maestro
  const dedicada = ruta(RUTAS.dedicada);
  assert.equal(dedicada.nivel.id, 4, `dedicada: ${dedicada.xp.total}`);
});

test('con 4 invitados que pagan y juegan, una persona muy completa sí llega a Maestro sin hacer los 15 cursos', () => {
  const ev = ruta({ ...RUTAS.dedicada, invitados: 4 });
  assert.equal(ev.nivel.id, 5, `${ev.xp.total}`);
});

test('el texto de los premios por nivel sale de la tabla de niveles (no queda un número viejo)', () => {
  const texto = clave => P.PREMIOS.find(p => p.clave === clave).requisito;
  assert.ok(texto('profesional').includes(PROFESIONAL.toLocaleString('en-US')), texto('profesional'));
  assert.ok(texto('maestro').includes(MAESTRO.toLocaleString('en-US')), texto('maestro'));
  assert.equal(texto('referidos-1'), '4 invitados válidos');
});
