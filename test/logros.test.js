'use strict';

// Logros, XP y niveles: tabla, balance y reglas puras (sin Firebase).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../services/logros');
const R = require('../services/retos');
const P = require('../services/premios');
const REF = require('../services/referidos');

const dia = n => new Date(Date.UTC(2026, 8, n, 18, 0, 0)); // 18:00 UTC = mediodía en México
const fecha = n => `2026-09-${String(n).padStart(2, '0')}`;
const diasSeguidos = (desde, hasta) => Array.from({ length: hasta - desde + 1 }, (_, i) => fecha(desde + i));
const sinNada = { esVIP: false, completados: 0, areas: 0, dias: [], tarjetaDir: false, foroPosts: 0, foroRespuestas: 0, foroLikes: 0, invitadosValidos: 0 };
const evaluar = (datos, estado = null, xpRef = 0, ahora = dia(30)) => L.evaluar({ ...sinNada, ...datos }, estado, xpRef, ahora);

test('la tabla trae 26 logros (l1..l26) y 10 insignias de retos (r1..r10), todos con texto en español y XP entero', () => {
  assert.deepEqual(L.LOGROS.map(l => l.id), Array.from({ length: 26 }, (_, i) => `l${i + 1}`));
  assert.deepEqual(R.INSIGNIAS.map(i => i.id), Array.from({ length: 10 }, (_, i) => `r${i + 1}`));
  for (const l of L.LOGROS) {
    assert.ok(l.nombre && l.descripcion, `${l.id} necesita nombre y descripción`);
    assert.ok(L.CATEGORIAS.includes(l.categoria) && l.categoria !== 'Retos', `${l.id}: categoría ${l.categoria}`);
    assert.ok(Number.isInteger(l.xp) && l.xp > 0);
    assert.equal(typeof l.cumple, 'function');
  }
  for (const i of R.INSIGNIAS) assert.ok(i.nombre && i.desc && Number.isInteger(i.xp) && i.xp > 0);
  const ids = [...L.LOGROS, ...R.INSIGNIAS].map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, 'sin ids repetidos');
  assert.deepEqual([...new Set(L.LOGROS.map(l => l.categoria))].sort(), ['Comunidad', 'Constancia', 'Cursos', 'Inicio', 'Maestría']);
});

test('niveles: 5 niveles recalibrados (Profesional ~25 % y Maestro ~75 % del máximo) y el nivel se calcula, no se guarda', () => {
  assert.deepEqual(L.NIVELES.map(n => [n.nombre, n.desde, n.hasta]),
    [['Aprendiz', 0, 500], ['Técnico', 500, 1700], ['Profesional', 1700, 3500], ['Líder', 3500, 5100], ['Maestro', 5100, 99999]]);
  const casos = [[0, 1], [499, 1], [500, 2], [1699, 2], [1700, 3], [3499, 3], [3500, 4], [5099, 4], [5100, 5], [9000, 5]];
  for (const [xp, nivel] of casos) assert.equal(L.infoNivel(xp).id, nivel, `${xp} XP`);
  assert.deepEqual(L.infoNivel(1000), { id: 2, nombre: 'Técnico', xp: 1000, desde: 500, hasta: 1700, faltan: 700 });
  assert.equal(L.infoNivel(6000).faltan, 0, 'el último nivel ya no tiene siguiente');
  assert.deepEqual(L.listaNiveles().map(n => n.id), [1, 2, 3, 4, 5]);
});

test('balance: el XP máximo alcanzable en toda la vida de la cuenta queda entre 6000 y 7500', () => {
  const m = L.xpMaximo();
  assert.equal(m.total, m.logros + m.insignias + m.retos + m.referidos + m.cursos + m.bienvenida);
  assert.ok(m.total >= 6000 && m.total <= 8000, `máximo ${m.total}`);
  // Y evaluar() con TODO cumplido y los techos de retos y referidos da exactamente ese máximo
  const todosLosRetos = { ...R.estadoInicial(), xp: R.XP_MAXIMO_RETOS, xpPractica: R.TOPE_XP_PRACTICA, superados: 200,
    dias: Array.from({ length: 20 }, (_, i) => fecha(i + 1)),
    porReto: { detective: { veces: 9, mejor: 5, total: 5, superados: 9, perfectos: 9 }, quiz: { veces: 9, mejor: 5, total: 5, superados: 9, perfectos: 9 },
      orden: { veces: 9, mejor: 5, total: 5, superados: 9, perfectos: 0 }, historia: { veces: 5, mejor: 4, total: 4, superados: 5, perfectos: 0 } } };
  const cursosLista = Array.from({ length: 15 }, (_, i) => ({ courseId: `c${i + 1}`, n: i + 1, xp: L.xpDeCurso(i + 1), fecha: null }));
  const sesentaDias = Array.from({ length: 60 }, (_, i) => new Date(dia(30).getTime() - i * 86400000).toISOString().slice(0, 10));
  const todo = evaluar({ esVIP: true, completados: 15, areas: 6, dias: sesentaDias, tarjetaDir: true, foroPosts: 9, foroRespuestas: 9, foroLikes: 99, invitadosValidos: 6, cursosLista, bienvenida: true },
    todosLosRetos, REF.XP_MAXIMO_REFERIDOS);
  assert.equal(todo.xp.total, m.total);
  assert.equal(todo.nivel.id, 5);
});

test('balance: ninguna combinación razonable llega a Maestro fácil (más rutas en calibracion.test.js)', () => {
  const m = L.xpMaximo();
  const suma = ids => L.LOGROS.filter(l => ids(l)).reduce((t, l) => t + l.xp, 0);
  const deCursos = l => l.categoria === 'Cursos' || l.categoria === 'Maestría';
  const lider = L.NIVELES[3].desde; const maestro = L.NIVELES[4].desde;
  // Solo estudiar (todos los cursos, su fórmula, sus logros y la bienvenida) NO alcanza Líder
  assert.ok(suma(deCursos) + suma(l => l.categoria === 'Inicio') + m.cursos + m.bienvenida < lider);
  // Solo jugar retos (todo el camino, la práctica al tope y todas las insignias) NO alcanza Líder
  assert.ok(m.insignias + m.retos < lider, `retos: ${m.insignias + m.retos}`);
  // Solo invitar gente (6 invitados que pagan y juegan, con sus logros) NO alcanza Líder
  const soloReferidos = m.referidos + suma(l => l.id === 'l21' || l.id === 'l22');
  assert.ok(soloReferidos < lider, `referidos: ${soloReferidos}`);
  // Sin referidos y sin ningún curso, aunque se haga todo lo demás, no se llega a Maestro
  const sinReferidosNiCursos = m.total - m.referidos - m.cursos - suma(l => l.id === 'l21' || l.id === 'l22' || deCursos(l));
  assert.ok(sinReferidosNiCursos < maestro, `sin cursos ni referidos: ${sinReferidosNiCursos}`);
  // Maestro pide cerca del 70 % de todo el XP posible (68 % desde las 30 escenas nuevas de Detective: los umbrales no se mueven para no bajar el nivel de nadie)
  assert.ok(maestro / m.total > 0.65, `Maestro pide ${Math.round(maestro / m.total * 100)} % del máximo`);
});

test('escenario del contrato: ~4 cursos + 20 retos + foro/directorio + 30 días NO alcanzan Profesional (es difícil)', () => {
  // Persona constante: 30 días en el club (los últimos 14 seguidos), 4 cursos de 2 áreas, 20 retos, 1 discusión y su tarjeta
  let e = R.estadoInicial();
  for (let d = 1; d <= 10; d++) {
    e = R.aplicarResultado(e, { retoId: 'quiz', puntaje: d % 2 ? 5 : 4, total: 5 }, dia(d)).estado;
    e = R.aplicarResultado(e, { retoId: 'historia', puntaje: 3, total: 4 }, dia(d)).estado;
  }
  assert.equal(e.superados, 20);
  const agosto = Array.from({ length: 16 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
  const dias = [...agosto, ...diasSeguidos(17, 30)]; // 30 días en total, los últimos 14 seguidos
  const cursosLista = [1, 2, 3, 4].map(n => ({ courseId: `c${n}`, n, xp: L.xpDeCurso(n), fecha: null }));
  const constante = evaluar({ esVIP: true, completados: 4, areas: 2, dias, tarjetaDir: true, foroPosts: 1, cursosLista, bienvenida: true }, e);
  assert.equal(constante.racha, 14);
  assert.equal(constante.xp.cursos, 20 + 30 + 40 + 50);
  assert.ok(constante.xp.total >= 1200 && constante.xp.total < L.NIVELES[2].desde, `constante: ${constante.xp.total}`);
  assert.equal(constante.nivel.id, 2, 'sigue en Técnico');
  // Misma persona pero que solo entró 10 días: se queda más abajo todavía
  const corto = evaluar({ esVIP: true, completados: 4, areas: 2, dias: diasSeguidos(1, 10), tarjetaDir: true, foroPosts: 1, cursosLista, bienvenida: true }, e, 0, dia(10));
  assert.equal(corto.nivel.id, 2, `corto: ${corto.xp.total}`);
  assert.ok(corto.xp.total < constante.xp.total);
});

test('un miembro nuevo sin nada hecho solo tiene el logro de bienvenida y nivel Aprendiz', () => {
  const ev = evaluar({ esVIP: true, dias: [fecha(30)] });
  assert.deepEqual(ev.logros.filter(l => l.ganado).map(l => l.id), ['l1']);
  assert.equal(ev.xp.total, 20);
  assert.equal(ev.nivel.id, 1);
  assert.equal(ev.nivel.faltan, 480);
});

test('el XP se desglosa en logros, retos y referidos y el total es su suma', () => {
  let e = R.aplicarResultado(R.estadoInicial(), { retoId: 'quiz', puntaje: 5, total: 5 }, dia(30)).estado;
  const ev = evaluar({ esVIP: true, dias: [fecha(30)] }, e, 120);
  assert.equal(ev.xp.logros, 20);
  assert.equal(ev.xp.retos, 10 + 20, 'XP del reto + insignia r1');
  assert.equal(ev.xp.referidos, 120);
  assert.equal(ev.xp.total, 20 + 30 + 120);
});

test('racha: días seguidos que terminan hoy en hora de México; un hueco la rompe', () => {
  const ahora = new Date('2026-09-25T05:59:00Z'); // todavía 24 en México
  assert.equal(L.calcularRacha(['2026-09-24', '2026-09-23', '2026-09-22'], ahora), 3);
  assert.equal(L.calcularRacha(['2026-09-25', '2026-09-24'], ahora), 1, 'el 25 todavía no llega en México');
  assert.equal(L.calcularRacha(['2026-09-24', '2026-09-22'], ahora), 1);
  assert.equal(L.calcularRacha([], ahora), 0);
  const ev = evaluar({ esVIP: true, dias: diasSeguidos(1, 30) });
  assert.equal(ev.racha, 30);
  assert.ok(ev.logros.find(l => l.id === 'l12').ganado, '30 días seguidos');
  assert.ok(!ev.logros.find(l => l.id === 'l13').ganado, '60 días seguidos aún no');
});

test('los logros de cursos suben por cantidad de cursos y de áreas', () => {
  const ganados = datos => evaluar({ esVIP: true, ...datos }).logros.filter(l => l.ganado).map(l => l.id);
  assert.ok(!ganados({ completados: 0 }).includes('l4'));
  assert.ok(ganados({ completados: 1 }).includes('l4'));
  assert.ok(ganados({ completados: 4 }).includes('l6') && !ganados({ completados: 3 }).includes('l6'));
  assert.ok(ganados({ completados: 15 }).includes('l26') && !ganados({ completados: 14 }).includes('l26'));
  assert.ok(ganados({ areas: 2 }).includes('l8') && !ganados({ areas: 1 }).includes('l8'));
  assert.ok(ganados({ areas: 4 }).includes('l25'));
});

test('vista previa: lista todos los logros sin XP ni "ganado"', () => {
  const lista = L.logrosVistaPrevia();
  assert.equal(lista.length, 36);
  for (const l of lista) {
    assert.ok(l.id && l.nombre && l.descripcion && l.categoria);
    assert.ok(!('xp' in l) && !('ganado' in l));
  }
  assert.equal(lista.filter(l => l.categoria === 'Retos').length, 10);
});

// ── Premios (reglas puras) ──
test('premios: solo profesional (nivel 3), maestro (nivel 5) y un premio por 4 invitados válidos', () => {
  assert.deepEqual(P.PREMIOS.map(p => p.clave), ['profesional', 'maestro', 'referidos-1']);
  assert.deepEqual(P.clavesQueCumple({ nivelId: 2, invitadosValidos: 3 }), []);
  assert.deepEqual(P.clavesQueCumple({ nivelId: 3, invitadosValidos: 0 }), ['profesional']);
  assert.deepEqual(P.clavesQueCumple({ nivelId: 4, invitadosValidos: 4 }), ['profesional', 'referidos-1']);
  assert.deepEqual(P.clavesQueCumple({ nivelId: 5, invitadosValidos: 40 }), ['profesional', 'maestro', 'referidos-1']);
});

test('premios: el canje consume el primer premio ganado que no se ha usado', () => {
  const usados = [{ clave: 'profesional', cursoId: 'a', fecha: 'x' }];
  assert.equal(P.premioLibre(['profesional', 'referidos-1'], usados), 'referidos-1');
  assert.equal(P.premioLibre(['profesional'], usados), null);
  assert.equal(P.premioLibre([], []), null);
  const lista = P.armarPremios({ ganados: ['profesional', 'referidos-1'], usados, membresia: true });
  assert.deepEqual(lista.map(p => [p.clave, p.ganado, p.disponible]), [['profesional', true, false], ['maestro', false, false], ['referidos-1', true, true]]);
  assert.deepEqual(lista[0].usado, { cursoId: 'a', fecha: 'x' });
  assert.ok(P.armarPremios({ ganados: ['maestro'], usados: [], membresia: false }).every(p => !p.disponible), 'sin membresía nada está disponible');
});

test('premios guardados: se descartan claves y usos inválidos', () => {
  const g = P.normalizarGuardado({ ganados: ['profesional', 'profesional', 'inventado', 7], usados: [{ clave: 'maestro', cursoId: 'c1', fecha: 'f' }, { clave: 'x', cursoId: 'c' }, null, { clave: 'maestro' }] });
  assert.deepEqual(g.ganados, ['profesional']);
  assert.deepEqual(g.usados, [{ clave: 'maestro', cursoId: 'c1', fecha: 'f' }]);
  assert.deepEqual(P.normalizarGuardado(null), { ganados: [], usados: [], bienvenida: null });
  assert.deepEqual(P.normalizarGuardado({ bienvenida: { fecha: 'hoy' } }).bienvenida, { fecha: 'hoy' });
});
