'use strict';

// Reglas puras del panel (services/admin-panel.js) y contrato de las rutas /api/admin/* de lectura y de acción.
const test = require('node:test');
const assert = require('node:assert/strict');
const panel = require('../services/admin-panel');
const bitacora = require('../services/bitacora-memoria');
const { request, cargarServidor, miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const { ts, dias } = require('./helpers/cargar-servidor');

const DIA = 86400000;
const AHORA = new Date('2026-10-15T18:00:00Z');
const hace = n => new Date(AHORA.getTime() - n * DIA);
const tieneAcceso = m => {
  const v = panel.aFecha(m.planVence);
  return Boolean(v && v.getTime() > AHORA.getTime()) && m.planActivo !== false && !['past_due', 'expired'].includes(m.planStatus);
};

/* ───────── reglas puras ───────── */

test('aFecha entiende Timestamp, segundos, ISO y rechaza basura', () => {
  assert.equal(panel.aFecha(ts(1000)).getTime(), 1000);
  assert.equal(panel.aFecha({ seconds: 2 }).getTime(), 2000);
  assert.equal(panel.aFecha('2026-10-15T00:00:00Z').toISOString(), '2026-10-15T00:00:00.000Z');
  for (const malo of [null, undefined, '', 'no es fecha', {}, NaN]) assert.equal(panel.aFecha(malo), null);
});

test('clasificarMiembro: activo, cancelado con acceso, pago pendiente, vencido y sin membresía', () => {
  const futuro = hace(-20); const pasado = hace(10);
  const c = m => panel.clasificarMiembro(m, tieneAcceso).estado;
  assert.equal(c({ planActivo: true, planVence: futuro, planStatus: 'active' }), 'activo');
  assert.equal(c({ planActivo: true, planVence: futuro, planCancelado: true, planStatus: 'cancelled_active' }), 'cancelado-vigente');
  assert.equal(c({ planActivo: false, planVence: pasado, planStatus: 'past_due' }), 'pago-pendiente');
  assert.equal(c({ planActivo: false, planVence: pasado, planTipo: 'mensual', planStatus: 'expired' }), 'vencido');
  assert.equal(c({ planActivo: false }), 'sin-plan');
  assert.equal(c({}), 'sin-plan');
});

test('vistaMiembro no lleva teléfono, ids de Stripe ni datos de pago; fichaMiembro tampoco lleva ids ni firmas', () => {
  const m = {
    name: 'Ana', email: 'ana@example.com', phone: '+52 55 0000', planActivo: true, planVence: hace(-5), planTipo: 'anual',
    stripeSubscriptionId: 'sub_secreta123', stripeCustomerId: 'cus_secreto123', ultimoPago: hace(3), createdAt: hace(40).toISOString()
  };
  const v = panel.vistaMiembro('u1', m, tieneAcceso);
  const f = panel.fichaMiembro('u1', m, tieneAcceso);
  for (const salida of [v, f]) {
    const t = JSON.stringify(salida);
    assert.equal(t.includes('sub_secreta123'), false);
    assert.equal(t.includes('cus_secreto123'), false);
    assert.equal(salida.origen, 'stripe');
  }
  assert.equal(JSON.stringify(v).includes('+52'), false);
  assert.equal(f.telefono, '+52 55 0000');
  assert.equal(v.planTipo, 'anual');
});

test('construirResumen: KPIs, altas por semana, vencimientos y estimación de ingresos sin inventar cifras', () => {
  const mk = (id, data) => ({ id, data });
  const miembros = [
    mk('a', { name: 'A', planActivo: true, planTipo: 'mensual', planVence: hace(-3), ultimoPago: hace(2), createdAt: hace(1).toISOString(), stripeSubscriptionId: 's' }),
    mk('b', { name: 'B', planActivo: true, planTipo: 'anual', planVence: hace(-200), ultimoPago: hace(5), createdAt: hace(20).toISOString() }),
    mk('c', { name: 'C', planActivo: false, planTipo: 'mensual', planVence: hace(30), planStatus: 'expired', createdAt: hace(90).toISOString() }),
    mk('d', { name: 'D', planActivo: false, createdAt: hace(3).toISOString() }),
    mk('e', { name: 'E', planActivo: true, planTipo: 'mensual', planVence: hace(-1), activadoManualmente: true, montoPagado: 150, ultimoPago: hace(1), createdAt: hace(60) })
  ];
  const r = panel.construirResumen({ miembros, certificados: { total: 7, completados: 5 }, ahora: AHORA, tieneAcceso });
  assert.equal(r.kpis.miembros, 5);
  assert.equal(r.kpis.activos, 3);
  assert.equal(r.kpis.nuevosSemana, 2);
  assert.equal(r.kpis.vencenPronto, 2);
  assert.equal(r.kpis.sinMembresia, 1);
  assert.equal(r.kpis.vencidos, 1);
  assert.equal(r.kpis.certificadosEmitidos, 7);
  assert.equal(r.kpis.cursosCompletados, 5);
  assert.equal(r.kpis.pagosMes, 3);
  // 199 (a) + 1899 (b) + 150 (e, monto manual) = 2248 en octubre
  assert.equal(r.kpis.ingresosMesEstimado, 2248);
  assert.equal(r.altasSemanales.length, 12);
  assert.equal(r.altasSemanales.reduce((t, s) => t + s.n, 0), 4); // la persona de hace 90 días queda fuera de las 12 semanas
  assert.equal(r.ingresosMensuales.length, 6);
  assert.equal(r.ingresosMensuales.at(-1).mes, '2026-10');
  assert.deepEqual(r.proximosVencimientos.map(p => p.uid), ['e', 'a']);
  assert.match(r.notas.ingresos, /Estimación/);
});

test('construirResumen sin pagos devuelve null en ingresos (no 0 inventado) y listas vacías', () => {
  const r = panel.construirResumen({ miembros: [], ahora: AHORA, tieneAcceso });
  assert.equal(r.kpis.miembros, 0);
  assert.equal(r.kpis.ingresosMesEstimado, null);
  assert.deepEqual(r.proximosVencimientos, []);
});

test('validarActivacion: tipos, días, monto y método', () => {
  assert.equal(panel.validarActivacion(null).error !== undefined, true);
  assert.equal(panel.validarActivacion({ tipo: 'mensual' }).datos.dias, 30);
  assert.equal(panel.validarActivacion({ tipo: 'anual' }).datos.dias, 365);
  assert.equal(panel.validarActivacion({ tipo: 'custom', dias: 90 }).datos.planTipo, 'mensual');
  for (const malo of [{ tipo: 'gratis' }, { tipo: 'custom' }, { tipo: 'custom', dias: 0 }, { tipo: 'custom', dias: 4000 }, { tipo: 'custom', dias: 1.5 },
    { tipo: 'mensual', monto: -5 }, { tipo: 'mensual', monto: 'mucho' }, { tipo: 'mensual', metodo: { a: 1 } }]) {
    assert.ok(panel.validarActivacion(malo).error, JSON.stringify(malo));
  }
  const v = panel.validarActivacion({ tipo: 'mensual', metodo: '  <b>Transferencia</b>\n', monto: '199' });
  assert.equal(v.datos.metodo, 'bTransferencia/b');
  assert.equal(v.datos.monto, 199);
});

test('limpiarTexto y enmascararCorreo no dejan pasar correos, claves ni tokens', () => {
  const t = panel.limpiarTexto('falló para ana@example.com con sk_live_abcdef123456 y Bearer abcdefghijklmnop');
  assert.equal(/ana@|sk_live|abcdefghijklmnop/.test(t), false);
  assert.equal(panel.enmascararCorreo('duena.zoorigen@gmail.com').includes('duena.zoorigen'), false);
  assert.match(panel.enmascararCorreo('duena.zoorigen@gmail.com'), /^d\*+@gmail\.com$/);
});

test('la bitácora en memoria limpia lo que guarda y conserva solo lo reciente', () => {
  bitacora.registrar('error', ['Falló el cobro de ana@example.com', new Error('token Bearer abcdefghijklmnopq')]);
  const r = bitacora.recientes(1)[0];
  assert.equal(/ana@|abcdefghijklmnopq/.test(r.mensaje), false);
  for (let i = 0; i < 150; i++) bitacora.registrar('error', ['x' + i]);
  assert.ok(bitacora.recientes(500).length <= 100);
});

/* ───────── contrato de las rutas ───────── */

const tokens = {
  ...tokensDe('ana', 'beto', 'cata', 'dani'),
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true }
};
function montar(extra = {}) {
  return cargarServidor({
    tokens,
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Prueba', email: 'ana@example.com', phone: '5555', createdAt: new Date(Date.now() - 2 * DIA).toISOString(),
        stripeCustomerId: 'cus_x', stripeSubscriptionStatus: 'active' }),
      'miembros/beto': miembroSinPlan({ name: 'Beto Sin Plan', email: 'beto@example.com', createdAt: new Date(Date.now() - 40 * DIA).toISOString() }),
      'miembros/cata': miembroConPlan({ name: 'Cata Vencida', planActivo: false, planStatus: 'expired', planVence: ts(dias(-10)), createdAt: new Date(Date.now() - 90 * DIA).toISOString() }),
      'miembros/ana/progresoCursos/c1': { cursoId: 'c1', uid: 'ana', sesionesVistas: [0, 1, 2], completado: true, certificadoFolio: 'ZOO-1' },
      'cursos/c1': { titulo: 'Fototrampeo', lecciones: [] },
      'certificados/ZOO-1': { folio: 'ZOO-1', uid: 'ana', curso: 'Fototrampeo', emitido: new Date().toISOString(), verificado: true, origen: 'backend' },
      'certificados/ZOO-2': { folio: 'ZOO-2', uid: 'cata', curso: 'Otro', emitido: new Date().toISOString(), verificado: true, origen: 'admin' },
      'referidos/beto': { anfitrionUid: 'ana', estado: 'valido', hitos: { pago: true } },
      'referidos/dani': { anfitrionUid: 'ana', estado: 'rechazado', motivo: 'Se registró desde el mismo dispositivo de quien lo invitó' },
      'retosUsuario/ana': { xp: 340, superados: 12 },
      'directorio/ana': { nombre: 'Ana', sector: 'Conservación', publicado: true },
      'directorio/beto': { nombre: 'Beto', sector: 'Conservación', publicado: false },
      'foroPosts/p1': { title: 'Hola', content: 'Primera discusión', authorName: 'Ana', authorUid: 'ana', createdAt: new Date().toISOString(), repliesCount: 2, likes: ['x'], views: 4 },
      ...extra
    }
  });
}
const get = (app, ruta) => request(app).get(ruta).set(auth('token-admin'));

test('GET /api/admin/resumen: KPIs reales, sin ids de Stripe ni teléfonos', async () => {
  const { app } = montar();
  const r = await get(app, '/api/admin/resumen');
  assert.equal(r.status, 200);
  assert.equal(r.body.kpis.miembros, 4);
  assert.equal(r.body.kpis.activos, 1);
  assert.equal(r.body.kpis.nuevosSemana, 1);
  assert.equal(r.body.kpis.certificadosEmitidos, 2);
  assert.equal(r.body.kpis.cursosCompletados, 1);
  assert.equal(r.body.altasSemanales.length, 12);
  assert.ok(Array.isArray(r.body.actividadReciente));
  const texto = JSON.stringify(r.body);
  assert.equal(/cus_x|sub_x|5555/.test(texto), false);
});

test('GET /api/admin/miembros: lista mínima (sin teléfono ni ids de pago)', async () => {
  const { app } = montar();
  const r = await get(app, '/api/admin/miembros');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 4);
  const ana = r.body.miembros.find(m => m.uid === 'ana');
  assert.equal(ana.estado, 'activo');
  assert.equal(ana.conAcceso, true);
  assert.equal(ana.correo, 'ana@example.com');
  assert.deepEqual(Object.keys(ana).sort(), ['conAcceso', 'correo', 'esAdmin', 'esRegalo', 'estado', 'nombre', 'origen', 'planTipo', 'registro', 'registroOrigen', 'stripeActiva', 'uid', 'ultimoPago', 'vence']);
  assert.equal(JSON.stringify(r.body).includes('5555'), false);
  assert.equal(r.body.miembros.find(m => m.uid === 'cata').estado, 'vencido');
});

test('GET /api/admin/miembros/:uid: ficha con progreso, certificados, referidos y retos; 404 y 400 claros', async () => {
  const { app } = montar();
  const r = await get(app, '/api/admin/miembros/ana');
  assert.equal(r.status, 200);
  assert.equal(r.body.miembro.telefono, '5555');
  assert.equal(r.body.progreso[0].curso, 'Fototrampeo');
  assert.equal(r.body.progreso[0].completado, true);
  assert.equal(r.body.certificados.length, 1);
  assert.equal(r.body.referidos.total, 2);
  assert.equal(r.body.referidos.validos, 1);
  assert.equal(r.body.retos.xp, 340);
  assert.equal(JSON.stringify(r.body).includes('cus_x'), false);
  assert.equal((await get(app, '/api/admin/miembros/noexiste1')).status, 404);
  assert.equal((await get(app, '/api/admin/miembros/a%20b')).status, 400);
});

test('POST activar: valida, escribe el plan, anota la acción y no deja datos de otra persona', async () => {
  const { app, db } = montar();
  const post = (uid, cuerpo) => request(app).post(`/api/admin/miembros/${uid}/activar`).set(auth('token-admin')).send(cuerpo);
  assert.equal((await post('beto', { tipo: 'gratis' })).status, 400);
  assert.equal((await post('noexiste1', { tipo: 'mensual' })).status, 404);
  const r = await post('beto', { tipo: 'anual', metodo: 'Transferencia', monto: 1899 });
  assert.equal(r.status, 200);
  assert.equal(r.body.planTipo, 'anual');
  const b = db.value('miembros/beto');
  assert.equal(b.planActivo, true);
  assert.equal(b.planStatus, 'active');
  assert.equal(b.activadoManualmente, true);
  assert.equal(b.metodoPago, 'Transferencia');
  assert.equal(b.montoPagado, 1899);
  assert.ok(b.planVence.toMillis() > Date.now() + 360 * DIA);
  assert.equal(db.value('usuarios/beto').planActivo, true);
  assert.equal(db.value('miembros/ana').planTipo, 'mensual');
  const acciones = [...db._data.entries()].filter(([k]) => k.startsWith('adminAcciones/'));
  assert.equal(acciones.length, 1);
  assert.equal(acciones[0][1].accion, 'activar-plan');
  assert.equal(acciones[0][1].uidDestino, 'beto');
  // La lista refleja el cambio de inmediato (el caché se invalida)
  const lista = await get(app, '/api/admin/miembros');
  assert.equal(lista.body.miembros.find(m => m.uid === 'beto').estado, 'activo');
});

test('POST cancelar: marca cancelación con acceso vigente y anota la acción', async () => {
  const { app, db } = montar();
  const r = await request(app).post('/api/admin/miembros/ana/cancelar').set(auth('token-admin'));
  assert.equal(r.status, 200);
  const a = db.value('miembros/ana');
  assert.equal(a.planCancelado, true);
  assert.equal(a.planStatus, 'cancelled_active');
  const lista = await get(app, '/api/admin/miembros');
  assert.equal(lista.body.miembros.find(m => m.uid === 'ana').estado, 'cancelado-vigente');
  assert.equal([...db._data.keys()].filter(k => k.startsWith('adminAcciones/')).length, 1);
});

test('GET comunidad, referidos y retos: agregados reales y nada de correos', async () => {
  const { app } = montar();
  const com = await get(app, '/api/admin/comunidad');
  assert.equal(com.body.directorio.total, 2);
  assert.equal(com.body.directorio.publicadas, 1);
  assert.equal(com.body.directorio.privadas, 1);
  assert.equal(com.body.discusiones[0].titulo, 'Hola');
  const ref = await get(app, '/api/admin/referidos');
  assert.equal(ref.body.totales.total, 2);
  assert.equal(ref.body.totales.validos, 1);
  assert.equal(ref.body.totales.rechazados, 1);
  assert.equal(ref.body.totales.conPago, 1);
  assert.equal(ref.body.anfitriones[0].nombre, 'Ana Prueba');
  const ret = await get(app, '/api/admin/retos');
  assert.equal(ret.body.totales.xpTotal, 340);
  assert.equal(ret.body.top[0].nombre, 'Ana Prueba');
  for (const r of [com, ref, ret]) assert.equal(/@example\.com/.test(JSON.stringify(r.body)), false);
});

test('GET /api/admin/estado: solo nombres de variables y si están definidas, nunca sus valores', async () => {
  const guardado = {
    s: process.env.STRIPE_SECRET_KEY, a: process.env.ADMIN_EMAILS, r: process.env.RESEND_API_KEY
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_VALOR_SECRETO_NO_DEBE_SALIR';
  process.env.RESEND_API_KEY = 're_VALOR_SECRETO_RESEND';
  process.env.ADMIN_EMAILS = 'admin@example.com, otra@example.com';
  try {
    const { app } = montar();
    console.error('error de prueba para ana@example.com');
    const r = await get(app, '/api/admin/estado');
    assert.equal(r.status, 200);
    const texto = JSON.stringify(r.body);
    assert.equal(/VALOR_SECRETO/.test(texto), false);
    assert.equal(texto.includes('admin@example.com'), false, 'los correos de administración salen enmascarados');
    assert.equal(r.body.servicios.baseDeDatos.ok, true);
    assert.equal(r.body.servicios.stripe.configurado, true);
    assert.equal(r.body.servicios.stripe.modo, 'prueba');
    assert.ok(r.body.variables.every(v => typeof v.definida === 'boolean' && /^[A-Z0-9_]+$/.test(v.nombre)));
    assert.equal(r.body.variables.find(v => v.nombre === 'RESEND_API_KEY').definida, true);
    assert.equal(r.body.administradores.length, 2);
    assert.ok(r.body.errores.recientes.some(e => /error de prueba/.test(e.mensaje) && !/ana@/.test(e.mensaje)));
  } finally {
    for (const [k, v] of [['STRIPE_SECRET_KEY', guardado.s], ['ADMIN_EMAILS', guardado.a], ['RESEND_API_KEY', guardado.r]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('límite de peticiones: pasado el tope por minuto responde 429', async () => {
  const { app } = montar();
  let ultimo = 200;
  for (let i = 0; i < 100 && ultimo === 200; i++) ultimo = (await get(app, '/api/admin/yo')).status;
  assert.equal(ultimo, 429);
});
