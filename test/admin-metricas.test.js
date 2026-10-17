'use strict';

// Métricas, Pruebas gratuitas, Encuesta (detalle y acciones), Configuración y contador de visitas del panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, ts, dias, miembroConPlan, miembroSinPlan, auth, tokensDe, uuid } = require('./helpers/club');
const met = require('../services/admin-metricas');
const vis = require('../services/admin-visitas');
const cfg = require('../services/admin-config');
const { diaMexico } = require('../services/admin-panel');

const DIA = 86400000;
const iso = n => new Date(Date.now() - n * DIA).toISOString();
const dia = n => diaMexico(new Date(Date.now() - n * DIA));

/* ───────── reglas puras ───────── */

test('resolverRango: por defecto 30 días, nunca en el futuro, desde ≤ hasta y tope de 731 días', () => {
  const ahora = new Date('2026-10-16T18:00:00Z');
  assert.deepEqual(met.resolverRango({ ahora }), { desde: '2026-09-17', hasta: '2026-10-16', dias: 30 });
  assert.deepEqual(met.resolverRango({ desde: '2026-10-01', hasta: '2026-10-10', ahora }), { desde: '2026-10-01', hasta: '2026-10-10', dias: 10 });
  assert.equal(met.resolverRango({ hasta: '2030-01-01', ahora }).hasta, '2026-10-16');
  assert.deepEqual(met.resolverRango({ desde: '2026-10-12', hasta: '2026-10-05', ahora }), { desde: '2026-10-05', hasta: '2026-10-05', dias: 1 });
  assert.equal(met.resolverRango({ desde: '2000-01-01', ahora }).dias, 731);
  assert.equal(met.resolverRango({ desde: 'basura', hasta: '2026-13-45', ahora }).dias, 30);
  assert.equal(met.resolverRango({ desde: 'todo', ahora, primerDia: '2026-08-01' }).desde, '2026-08-01');
});

test('serieDiaria rellena con ceros y cuenta por día de México', () => {
  const r = met.serieDiaria([new Date('2026-10-02T03:00:00Z'), new Date('2026-10-02T20:00:00Z'), null, new Date('2026-09-01T00:00:00Z')], '2026-10-01', '2026-10-03');
  assert.deepEqual(r.serie, [{ dia: '2026-10-01', n: 1 }, { dia: '2026-10-02', n: 1 }, { dia: '2026-10-03', n: 0 }]);
  assert.equal(r.total, 2);
});

const tieneAcceso = m => m.planActivo === true && m.planVence && m.planVence.toMillis() > Date.now() && m.planStatus === 'active';

test('construirMetricas: altas, conversión de prueba a miembro, retención por cohorte y cursos', () => {
  const rango = met.resolverRango({ desde: dia(29), hasta: dia(0) });
  const miembros = [
    { id: 'a', data: miembroConPlan({ createdAt: iso(5) }) },
    { id: 'b', data: miembroSinPlan({ createdAt: iso(5) }) },
    { id: 'c', data: miembroConPlan({ createdAt: iso(40), planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }) },
    { id: 'd', data: miembroSinPlan({ createdAt: iso(2) }) },
    { id: 'adm', data: miembroSinPlan({ createdAt: iso(1), role: 'admin' }) }
  ];
  const r = met.construirMetricas({
    miembros,
    certificados: [
      { id: 'F1', data: { courseId: 'c1', emitido: iso(3), verificado: true } },
      { id: 'F2', data: { courseId: 'c1', emitido: iso(60), verificado: true } },
      { id: 'F3', data: { courseId: 'c2', emitido: iso(2), verificado: false } }
    ],
    retos: [{ id: 'a', data: { xp: 340, superados: 12, actualizadoEn: ts(Date.now() - DIA) } }, { id: 'b', data: { xp: 0, superados: 0 } }, { id: 'd', data: { xp: 30, superados: 1 } }],
    pruebas: [
      { id: 'a', data: { uid: 'a', cursoId: 'c1', elegidoEn: ts(Date.now() - 4 * DIA) } },
      { id: 'b', data: { uid: 'b', cursoId: 'c2', elegidoEn: ts(Date.now() - 4 * DIA) } },
      { id: 'c', data: { uid: 'c', cursoId: 'c1', elegidoEn: ts(Date.now() - 50 * DIA) } }
    ],
    progreso: [
      { uid: 'a', cursoId: 'c1', data: { sesionesVistas: [0, 1], completado: true } },
      { uid: 'b', cursoId: 'c1', data: { sesionesVistas: [0] } },
      { uid: 'b', cursoId: 'c2', data: { sesionesVistas: [] } }
    ],
    cursos: new Map([['c1', 'Fototrampeo'], ['c2', 'Mariposarios']]), rango, tieneAcceso
  });
  assert.equal(r.totales.altas, 3); // a, b, d (el administrador no cuenta)
  assert.equal(r.series.altas.length, 30);
  assert.equal(r.totales.certificados, 1); // el no verificado y el antiguo no cuentan
  assert.equal(r.anterior.altas, 1); // c se registró hace 40 días, dentro de los 30 días anteriores
  assert.equal(r.cuentas.total, 4);
  assert.equal(r.cuentas.conAccesoHoy, 1);
  assert.equal(r.cuentas.conPlanAlgunaVez, 2);
  assert.equal(r.cuentas.retencion, 50);
  assert.equal(r.cuentas.vencidos, 1);
  assert.equal(r.cuentas.sinMembresia, 2);
  assert.equal(r.conversion.eligieronRango, 2);
  assert.equal(r.conversion.seHicieronMiembroRango, 1);
  assert.equal(r.conversion.tasaRango, 50);
  assert.equal(r.conversion.eligieronTotal, 3);
  assert.equal(r.conversion.seHicieronMiembroTotal, 2);
  assert.deepEqual(r.cursos.masElegidos[0], { cursoId: 'c1', curso: 'Fototrampeo', n: 2 });
  assert.equal(r.cursos.masCompletados[0].cursoId, 'c1');
  assert.equal(r.cursos.masCompletados[0].n, 2);
  assert.equal(r.cursos.masEmpezados.find(x => x.cursoId === 'c1').n, 2);
  assert.equal(r.cursos.masEmpezados.find(x => x.cursoId === 'c2'), undefined);
  assert.equal(r.retos.conActividad, 2);
  assert.equal(r.retos.xpTotal, 370);
  assert.equal(r.retos.actividadPorDia.reduce((t, x) => t + x.n, 0), 1);
  assert.ok(r.cohortes.length >= 1);
  assert.ok(r.cohortes.every(c => c.registrados >= c.conPlanAlgunaVez));
  assert.deepEqual(r.visitas, { activo: false, total: 0, porDia: [], porPagina: [] });
  // embudo: se registraron > eligieron prueba > vieron clases > tuvieron membresía > terminaron un curso
  assert.deepEqual(r.embudo.rango.etapas.map(e => e.valor), [3, 2, 2, 1, 1]);
  assert.deepEqual(r.embudo.total.etapas.map(e => e.valor), [4, 3, 2, 1, 1]);
  assert.equal(r.embudo.rango.pagaronSinPrueba, 0);
  assert.ok(r.embudo.nota.length > 20);
  // planes de quienes tienen acceso, ingresos y periodo anterior
  assert.equal(r.cuentas.planes.mensual + r.cuentas.planes.anual + r.cuentas.planes.otro, r.cuentas.conAccesoHoy);
  assert.equal(r.series.ingresos.length, 30);
  assert.equal(typeof r.totales.ingresos, 'number');
  assert.equal(typeof r.anterior.ingresos, 'number');
  assert.equal(r.seriesAnterior.altas.length, 30);
  assert.equal(r.seriesAnterior.altas.reduce((t, x) => t + x.n, 0), 1);
  // actividad por día y hora: el mapa suma lo mismo que el total
  assert.equal(r.actividad.mapa.length, 7);
  assert.ok(r.actividad.mapa.every(f => f.length === 24));
  assert.equal(r.actividad.mapa.flat().reduce((t, n) => t + n, 0), r.actividad.total);
  assert.equal(r.actividad.porDiaSemana.reduce((t, n) => t + n, 0), r.actividad.total);
  assert.ok(r.actividad.total >= 7);
});

test('construirMetricas: ingresos estimados por día (precio de lista o monto manual) y actividad por día y hora de México', () => {
  const rango = { desde: '2026-10-10', hasta: '2026-10-16', dias: 7 };
  const r = met.construirMetricas({
    rango, tieneAcceso: () => true, ahora: new Date('2026-10-16T18:00:00Z'),
    miembros: [
      // miércoles 14 oct, 17:30 en México (23:30 UTC)
      { id: 'a', data: { createdAt: '2026-10-14T23:30:00Z', planTipo: 'anual', ultimoPago: '2026-10-14T23:30:00Z', planVence: '2027-10-14T00:00:00Z' } },
      { id: 'b', data: { createdAt: '2026-10-15T14:00:00Z', planTipo: 'mensual', activadoManualmente: true, montoPagado: 500, ultimoPago: '2026-10-15T15:00:00Z' } },
      { id: 'c', data: { createdAt: '2026-08-01T14:00:00Z', planTipo: 'mensual', ultimoPago: '2026-10-05T14:00:00Z' } }
    ]
  });
  assert.equal(r.totales.pagos, 2);
  assert.equal(r.totales.ingresos, 1899 + 500);
  assert.equal(r.series.ingresos.find(x => x.dia === '2026-10-14').n, 1899);
  assert.equal(r.series.ingresos.find(x => x.dia === '2026-10-15').n, 500);
  assert.equal(r.anterior.ingresos, 199, 'el pago del 5 de oct cae en el periodo anterior y vale el precio de lista mensual');
  // 2 altas + 2 pagos en el periodo; el miércoles (índice 2) a las 17 h hay dos movimientos (alta y pago de a)
  assert.equal(r.actividad.total, 4);
  assert.equal(r.actividad.mapa[2][17], 2);
  assert.equal(r.actividad.horaPico, 17);
  assert.equal(r.actividad.diasPorSemana.reduce((t, n) => t + n, 0), 7);
  assert.equal(r.embudo.rango.personas, 2);
});

test('construirMetricas con visitas: suma por día y por página dentro del rango', () => {
  const rango = met.resolverRango({ desde: dia(2), hasta: dia(0) });
  const r = met.construirMetricas({
    rango, tieneAcceso, visitasActivo: true,
    visitas: [
      { id: dia(1), data: { total: 10, paginas: { portada: 8, terminos: 2 } } },
      { id: dia(0), data: { total: 4, paginas: { portada: 4 } } },
      { id: dia(30), data: { total: 99, paginas: { portada: 99 } } }
    ]
  });
  assert.equal(r.visitas.activo, true);
  assert.equal(r.visitas.total, 14);
  assert.deepEqual(r.visitas.porPagina[0], { pagina: 'portada', n: 12 });
  assert.equal(r.visitas.porDia.length, 3);
});

test('construirPruebas: avance, si terminó las clases gratis, si ya es miembro y totales por curso', () => {
  const miembros = new Map([
    ['a', miembroSinPlan({ name: 'Ana', email: 'ana@example.com' })],
    ['b', miembroConPlan({ name: 'Beto', email: 'beto@example.com' })]
  ]);
  const r = met.construirPruebas({
    pruebas: [
      { id: 'a', data: { uid: 'a', cursoId: 'c1', elegidoEn: ts(Date.now() - DIA) } },
      { id: 'b', data: { uid: 'b', cursoId: 'c1', elegidoEn: ts(Date.now() - 3 * DIA) } },
      { id: 'z', data: { uid: 'z', cursoId: 'cx', elegidoEn: ts(Date.now() - 5 * DIA) } }
    ],
    miembros, cursos: new Map([['c1', { titulo: 'Fototrampeo', clases: 4 }]]),
    progreso: new Map([['a|c1', { sesionesVistas: [0, 1, 1] }], ['b|c1', { sesionesVistas: [0, 1, 2], completado: false }]]), tieneAcceso
  });
  const a = r.filas.find(f => f.uid === 'a'); const b = r.filas.find(f => f.uid === 'b'); const z = r.filas.find(f => f.uid === 'z');
  assert.equal(a.clasesGratis, 3);
  assert.equal(a.clasesVistas, 2);
  assert.equal(a.avance, 67);
  assert.equal(a.terminoGratis, false);
  assert.equal(a.yaMiembro, false);
  assert.equal(b.terminoGratis, true);
  assert.equal(b.yaMiembro, true);
  assert.equal(z.cuentaExiste, false);
  assert.equal(z.curso, 'cx');
  assert.equal(r.filas[0].uid, 'a'); // más reciente primero
  assert.deepEqual(r.totales, { elegidas: 3, terminaronGratis: 1, seHicieronMiembro: 1, conAcceso: 1, tasaMiembro: 33, tasaTerminaron: 33 });
  assert.equal(r.porCurso[0].elegidas, 2);
});

test('calcularSinElegir: solo quien nunca tuvo plan, no es admin y no eligió', () => {
  const r = met.calcularSinElegir({
    miembros: [
      { id: 'a', data: miembroSinPlan({ name: 'A', createdAt: iso(3) }) },
      { id: 'b', data: miembroSinPlan({ name: 'B', createdAt: iso(1) }) },
      { id: 'c', data: miembroConPlan({ name: 'C' }) },
      { id: 'd', data: miembroSinPlan({ name: 'D', role: 'admin' }) },
      { id: 'e', data: miembroSinPlan({ name: 'E' }) }
    ],
    eleccionesUids: new Set(['e'])
  });
  assert.equal(r.total, 2);
  assert.deepEqual(r.lista.map(x => x.uid), ['b', 'a']);
});

test('visitas: páginas conocidas, DNT y alias; configuración válida y pública', () => {
  assert.equal(vis.normalizarPagina('/'), 'portada');
  assert.equal(vis.normalizarPagina('index.html'), 'portada');
  assert.equal(vis.normalizarPagina('Terminos-y-Condiciones.html?x=1'), 'terminos');
  assert.equal(vis.normalizarPagina('<script>'), 'otra');
  assert.equal(vis.normalizarPagina({}), 'otra');
  assert.equal(vis.visitaNoRastreable({ dnt: '1' }), true);
  assert.equal(vis.visitaNoRastreable({ 'sec-gpc': '1' }), true);
  assert.equal(vis.visitaNoRastreable({ dnt: '0' }), false);
  assert.ok(cfg.validarCambios({ contadorVisitas: 'si' }).error);
  assert.ok(cfg.validarCambios({ otro: true }).error);
  assert.ok(cfg.validarCambios({}).error);
  assert.ok(cfg.validarCambios({ avisoGlobal: { activo: true, texto: 'a' } }).error);
  assert.ok(cfg.validarCambios({ avisoGlobal: { activo: true, texto: 'Hola a todos', tono: 'rojo' } }).error);
  assert.deepEqual(cfg.validarCambios({ clasesEnVivoPronto: null, contadorVisitas: true }).cambios, { clasesEnVivoPronto: null, contadorVisitas: true });
  assert.deepEqual(cfg.vistaPublica({ avisoGlobal: { activo: false, texto: 'x' }, clasesEnVivoPronto: true }), { clasesEnVivoPronto: true, avisoGlobal: null });
  assert.equal(cfg.normalizarConfig(undefined).contadorVisitas, false);
});

/* ───────── rutas ───────── */

const tokens = {
  ...tokensDe('ana', 'beto', 'cata', 'dani'),
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true }
};
const curso = (n, titulo) => ({
  titulo, area: 'Manejo',
  lecciones: [1, 2, 3, 4].map(k => ({ titulo: `Clase ${k}`, videoId: uuid(n * 10 + k), provider: 'bunny' }))
});
function montar(extra = {}) {
  return cargarServidor({
    tokens,
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', email: 'admin@example.com', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Prueba', email: 'ana@example.com', createdAt: iso(5) }),
      'miembros/beto': miembroSinPlan({ name: 'Beto Sin Plan', email: 'beto@example.com', createdAt: iso(4) }),
      'miembros/cata': miembroSinPlan({ name: 'Cata Eligió', email: 'cata@example.com', createdAt: iso(20) }),
      'miembros/dani': miembroConPlan({ name: 'Dani Vencida', email: 'dani@example.com', createdAt: iso(90), planActivo: false, planStatus: 'expired', planVence: ts(dias(-5)) }),
      'cursos/c1': curso(1, 'Fototrampeo'),
      'cursos/c2': curso(2, 'Mariposarios'),
      'pruebasGratuitas/cata': { uid: 'cata', cursoId: 'c1', elegidoEn: ts(Date.now() - 6 * DIA) },
      'pruebasGratuitas/ana': { uid: 'ana', cursoId: 'c2', elegidoEn: ts(Date.now() - 12 * DIA) },
      'miembros/cata/progresoCursos/c1': { cursoId: 'c1', uid: 'cata', sesionesVistas: [0, 1, 2] },
      'certificados/ZOO-1': { folio: 'ZOO-1', uid: 'ana', courseId: 'c2', curso: 'Mariposarios', emitido: iso(3), verificado: true, origen: 'backend' },
      'retosUsuario/ana': { xp: 340, superados: 12, actualizadoEn: ts(Date.now() - DIA) },
      ...extra
    }
  });
}
const adm = () => auth('token-admin');
const get = (app, ruta) => request(app).get(ruta).set(adm());
const post = (app, ruta, cuerpo) => request(app).post(ruta).set(adm()).send(cuerpo);

test('GET metricas: rango, series, conversión, cursos y retención; sin correos ni ids de Stripe', async () => {
  const { app } = montar();
  const r = await get(app, '/api/admin/metricas');
  assert.equal(r.status, 200);
  assert.equal(r.body.rango.dias, 30);
  assert.equal(r.body.series.altas.length, 30);
  assert.equal(r.body.totales.altas, 3); // ana, beto, cata (dani es de hace 90 días; admin no cuenta)
  assert.equal(r.body.cuentas.total, 4);
  assert.equal(r.body.conversion.eligieronTotal, 2);
  assert.equal(r.body.conversion.seHicieronMiembroTotal, 1);
  assert.equal(r.body.cursos.masElegidos.find(c => c.cursoId === 'c1').curso, 'Fototrampeo');
  assert.equal(r.body.cursos.masCompletados[0].cursoId, 'c2');
  assert.equal(r.body.cursos.masEmpezados.find(c => c.cursoId === 'c1').n, 1);
  assert.equal(r.body.visitas.activo, false);
  const texto = JSON.stringify(r.body);
  assert.equal(/@example\.com|sub_x|cus_/.test(texto), false);
  const todo = await get(app, '/api/admin/metricas?desde=todo');
  assert.equal(todo.body.rango.dias >= 91, true);
  const raro = await get(app, '/api/admin/metricas?desde=2026-13-99&hasta=basura');
  assert.equal(raro.status, 200);
  assert.equal(raro.body.rango.dias, 30);
});

test('GET pruebas: filas con avance, totales por curso y quienes no han elegido', async () => {
  const { app } = montar();
  const r = await get(app, '/api/admin/pruebas');
  assert.equal(r.status, 200);
  assert.equal(r.body.totales.elegidas, 2);
  const cata = r.body.filas.find(f => f.uid === 'cata');
  assert.equal(cata.curso, 'Fototrampeo');
  assert.equal(cata.clasesGratis, 3);
  assert.equal(cata.clasesVistas, 3);
  assert.equal(cata.terminoGratis, true);
  assert.equal(cata.yaMiembro, false);
  assert.equal(cata.correo, 'cata@example.com');
  assert.equal(r.body.filas.find(f => f.uid === 'ana').yaMiembro, true);
  assert.equal(r.body.porCurso.length, 2);
  assert.equal(r.body.sinElegir.total, 1); // beto
  assert.equal(r.body.sinElegir.lista[0].uid, 'beto');
  assert.equal(r.body.filas.every(f => !('stripeSubscriptionId' in f)), true);
});

/* ── Encuesta y preguntas sin respuesta ── */
const encuestaSeed = {
  'encuestasProspectos/e1111111-aaaa': { sessionId: 's1', respuestas: { p1: 'Estudiante', urgencia: 'Lo antes posible' }, completada: true, creado: ts(Date.now() - DIA), contacto: '5215512345678', avisoAceptado: true, avisoVersion: 'v1' },
  'encuestasProspectos/e2222222-bbbb': { sessionId: 's2', respuestas: { p1: 'Consultor' }, completada: false, creado: ts(Date.now() - 2 * DIA) },
  'chatbotSinRespuesta/como se cuida una iguana': { ejemplo: 'como se cuida una iguana', tipo: 'animal', veces: 4, primeraVez: ts(Date.now() - 5 * DIA), ultimaVez: ts(Date.now() - DIA) },
  'chatbotSinRespuesta/precio': { ejemplo: 'precio', tipo: 'otro', veces: 2, ultimaVez: ts(Date.now() - DIA) }
};

test('GET encuesta/detalle: lleva id y atendida, y el teléfono SOLO enmascarado', async () => {
  const { app } = montar(encuestaSeed);
  const r = await get(app, '/api/admin/encuesta/detalle');
  assert.equal(r.status, 200);
  assert.equal(r.body.docs.length, 2);
  const e1 = r.body.docs.find(d => d.id === 'e1111111-aaaa');
  assert.equal(e1.tieneContacto, true);
  assert.equal(e1.contactoMascara, '••• ••• 5678');
  assert.equal(e1.atendida, false);
  assert.equal(JSON.stringify(r.body).includes('5215512345678'), false);
  assert.equal('contacto' in e1, false);
  assert.equal(r.body.docs.find(d => d.id === 'e2222222-bbbb').tieneContacto, false);
});

test('GET encuesta/:id/contacto entrega el número completo de una sola respuesta y lo anota sin el número', async () => {
  const { app, db } = montar(encuestaSeed);
  const r = await get(app, '/api/admin/encuesta/e1111111-aaaa/contacto');
  assert.equal(r.status, 200);
  assert.equal(r.body.contacto, '5215512345678');
  assert.equal((await get(app, '/api/admin/encuesta/e2222222-bbbb/contacto')).status, 404);
  assert.equal((await get(app, '/api/admin/encuesta/no-existe-1/contacto')).status, 404);
  assert.equal((await get(app, '/api/admin/encuesta/a%20b/contacto')).status, 400);
  const a = [...db._data.entries()].filter(([k]) => k.startsWith('adminAcciones/')).map(([, v]) => v);
  assert.equal(a.length, 1);
  assert.equal(JSON.stringify(a).includes('5215512345678'), false);
  const sin = await request(app).get('/api/admin/encuesta/e1111111-aaaa/contacto');
  assert.equal(sin.status, 401);
  const miembro = await request(app).get('/api/admin/encuesta/e1111111-aaaa/contacto').set(auth('token-ana'));
  assert.equal(miembro.status, 403);
});

test('POST encuesta/atender y borrar: validan, marcan, y borrar deja copia en adminPapelera', async () => {
  const { app, db } = montar(encuestaSeed);
  assert.equal((await post(app, '/api/admin/encuesta/atender', {})).status, 400);
  assert.equal((await post(app, '/api/admin/encuesta/atender', { ids: [] })).status, 400);
  assert.equal((await post(app, '/api/admin/encuesta/atender', { ids: ['../x'] })).status, 400);
  assert.equal((await post(app, '/api/admin/encuesta/atender', { ids: Array.from({ length: 26 }, (_, i) => `id-${String(i).padStart(8, '0')}`) })).status, 400);
  assert.equal((await post(app, '/api/admin/encuesta/atender', { ids: ['e1111111-aaaa'], atendida: 'si' })).status, 400);
  const ok = await post(app, '/api/admin/encuesta/atender', { ids: ['e1111111-aaaa', 'no-existe-1'] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.actualizadas, 1);
  assert.equal(db.value('encuestasProspectos/e1111111-aaaa').atendida, true);
  assert.equal(db.value('encuestasProspectos/e1111111-aaaa').contacto, '5215512345678'); // no se pierde nada
  const lista = await get(app, '/api/admin/encuesta/detalle');
  assert.equal(lista.body.docs.find(d => d.id === 'e1111111-aaaa').atendida, true);
  await post(app, '/api/admin/encuesta/atender', { ids: ['e1111111-aaaa'], atendida: false });
  assert.equal(db.value('encuestasProspectos/e1111111-aaaa').atendida, false);

  const b = await post(app, '/api/admin/encuesta/borrar', { ids: ['e2222222-bbbb'] });
  assert.equal(b.status, 200);
  assert.equal(b.body.borradas, 1);
  assert.equal(db.value('encuestasProspectos/e2222222-bbbb'), undefined);
  const copia = db.value('adminPapelera/encuesta__e2222222-bbbb');
  assert.equal(copia.datos.respuestas.p1, 'Consultor');
  assert.equal(copia.borradoPor, 'admin');
  assert.ok(db.value('encuestasProspectos/e1111111-aaaa'));
});

test('chatbot sin respuesta: detalle con clave, atender y borrar con copia', async () => {
  const { app, db } = montar(encuestaSeed);
  const d = await get(app, '/api/admin/chatbot/sin-respuesta/detalle');
  assert.equal(d.status, 200);
  assert.equal(d.body.preguntas[0].clave, 'como se cuida una iguana');
  assert.equal(d.body.preguntas[0].veces, 4);
  assert.equal(d.body.preguntas[0].atendida, false);
  assert.equal((await post(app, '/api/admin/chatbot/sin-respuesta/atender', { claves: ['Mal/Clave'] })).status, 400);
  const a = await post(app, '/api/admin/chatbot/sin-respuesta/atender', { claves: ['como se cuida una iguana'] });
  assert.equal(a.body.actualizadas, 1);
  assert.equal(db.value('chatbotSinRespuesta/como se cuida una iguana').atendida, true);
  assert.equal(db.value('chatbotSinRespuesta/como se cuida una iguana').veces, 4);
  const b = await post(app, '/api/admin/chatbot/sin-respuesta/borrar', { claves: ['precio'] });
  assert.equal(b.body.borradas, 1);
  assert.equal(db.value('chatbotSinRespuesta/precio'), undefined);
  assert.equal(db.value('adminPapelera/chatbot__precio').datos.veces, 2);
  // Si la pregunta vuelve a llegar, el servidor la reescribe sin la marca: vuelve a pedir atención
});

/* ── Configuración y visitas ── */
test('config: GET/POST validan, guardan, anotan y la parte pública solo trae lo seguro', async () => {
  const { app, db } = montar();
  const g = await get(app, '/api/admin/config');
  assert.equal(g.status, 200);
  assert.equal(g.body.config.contadorVisitas, false);
  assert.equal(g.body.config.clasesEnVivoPronto, null);
  assert.equal(g.body.sitio.leeConfigPublica, false);
  assert.equal(JSON.stringify(g.body).includes('admin@example.com'), false);
  assert.deepEqual(g.body.administradores.porDocumento.map(a => a.nombre), ['Admin']);
  assert.equal((await post(app, '/api/admin/config', { contadorVisitas: 'si' })).status, 400);
  assert.equal((await post(app, '/api/admin/config', { clave: 'x' })).status, 400);
  assert.equal((await post(app, '/api/admin/config', { avisoGlobal: { activo: true, texto: '' } })).status, 400);
  const ok = await post(app, '/api/admin/config', { contadorVisitas: true, avisoGlobal: { activo: true, texto: 'Mantenimiento esta noche', tono: 'aviso' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.contadorVisitas, true);
  assert.equal(db.value('config/panel').avisoGlobal.texto, 'Mantenimiento esta noche');
  assert.equal(db.value('config/panel').actualizadoPor, 'admin');
  const pub = await request(app).get('/api/config-publica');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body, { ok: true, clasesEnVivoPronto: null, avisoGlobal: { texto: 'Mantenimiento esta noche', tono: 'aviso' } });
  assert.equal(JSON.stringify(pub.body).includes('contadorVisitas'), false);
  assert.equal((await request(app).post('/api/admin/config').send({ contadorVisitas: true })).status, 401);
  assert.equal((await request(app).post('/api/admin/config').set(auth('token-ana')).send({ contadorVisitas: true })).status, 403);
});

test('contador de visitas: APAGADO por defecto no escribe nada; encendido suma por día y página sin guardar IP ni identificadores', async () => {
  const { app, db } = montar();
  const visitar = (cuerpo, cabeceras = {}) => request(app).post('/api/visita').set(cabeceras).send(cuerpo);
  const guardadas = () => [...db._data.keys()].filter(k => k.startsWith('visitasDiarias/'));
  assert.equal((await visitar({ pagina: 'portada' })).status, 204);
  assert.equal(guardadas().length, 0);

  await post(app, '/api/admin/config', { contadorVisitas: true });
  assert.equal((await visitar({ pagina: 'portada' })).status, 204);
  assert.equal((await visitar({ pagina: 'index.html' })).status, 204);
  assert.equal((await visitar({ pagina: 'terminos-y-condiciones' })).status, 204);
  assert.equal((await visitar({ pagina: '<script>alert(1)</script>' })).status, 204);
  assert.equal((await visitar('texto cualquiera')).status, 204);
  assert.equal((await visitar({ pagina: 'portada' }, { DNT: '1' })).status, 204);
  assert.equal((await visitar({ pagina: 'portada' }, { 'Sec-GPC': '1' })).status, 204);
  const claves = guardadas();
  assert.equal(claves.length, 1);
  const hoy = db.value(claves[0]);
  assert.equal(hoy.total, 5);
  assert.deepEqual(hoy.paginas, { portada: 3, terminos: 1, otra: 1 });
  // Nada de IP, agente de usuario ni identificadores en lo guardado
  const crudo = JSON.stringify(hoy);
  assert.equal(/127\.0\.0\.1|::ffff|supertest|mozilla|ip|uid|session/i.test(crudo.replace('visitasDiarias', '')), false);
  assert.deepEqual(Object.keys(hoy).sort(), ['dia', 'paginas', 'total']);

  // Las métricas lo muestran
  const m = await get(app, '/api/admin/metricas');
  assert.equal(m.body.visitas.activo, true);
  assert.equal(m.body.visitas.total, 5);
  assert.equal(m.body.visitas.porPagina[0].pagina, 'portada');

  // Apagarlo otra vez detiene el conteo
  await post(app, '/api/admin/config', { contadorVisitas: false });
  await visitar({ pagina: 'portada' });
  assert.equal(db.value(claves[0]).total, 5);
});

test('contador de visitas: tope por IP en 10 minutos (las demás visitas se ignoran en silencio)', async () => {
  const { app, db } = montar({ 'config/panel': { contadorVisitas: true } });
  for (let i = 0; i < 130; i++) assert.equal((await request(app).post('/api/visita').send({ pagina: 'portada' })).status, 204);
  const hoy = [...db._data.keys()].find(k => k.startsWith('visitasDiarias/'));
  assert.equal(db.value(hoy).total, 120);
});

test('metricas, pruebas, encuesta y configuración: sin sesión 401 y miembros 403', async () => {
  const { app } = montar(encuestaSeed);
  const rutas = ['/api/admin/metricas', '/api/admin/pruebas', '/api/admin/encuesta/detalle', '/api/admin/chatbot/sin-respuesta/detalle', '/api/admin/config'];
  for (const ruta of rutas) {
    assert.equal((await request(app).get(ruta)).status, 401, ruta);
    const m = await request(app).get(ruta).set(auth('token-ana'));
    assert.equal(m.status, 403, ruta);
    assert.deepEqual(Object.keys(m.body), ['error'], ruta);
  }
});
