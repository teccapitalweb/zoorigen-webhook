'use strict';

// Ventana «Acciones del miembro»: editar datos (nombre, teléfono y especialidad), quitar acceso y avance por curso en la ficha.
// Todo es solo administrador, queda anotado en adminAcciones y NADA toca Stripe. Regalar 30 días y eliminar (papelera de 30 días) ya existían
// y se siguen probando en test/admin-miembros.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, ts, dias, miembroConPlan, miembroSinPlan, tokensDe } = require('./helpers/club');
const mm = require('../services/admin-miembros');
const panel = require('../services/admin-panel');

const DIA = 86400000;
const tokens = {
  ...tokensDe('ana', 'beto', 'cata', 'dani'),
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true },
  'token-otroadmin': { uid: 'otroadmin', email: 'otro@example.com', email_verified: true }
};
const curso = (n, clases) => ({ title: `Curso ${n}`, area: 'Manejo', ordenVip: n, lecciones: Array.from({ length: clases }, (_, i) => ({ titulo: `Clase ${i + 1}`, videoId: `bbbbbbbb-0000-4000-8000-${String(n * 100 + i).padStart(12, '0')}`, provider: 'bunny' })) });

function montar(extra = {}) {
  return cargarServidor({
    tokens,
    usuariosAuth: {
      ana: { emailVerified: true, email: 'ana@example.com' }, beto: { emailVerified: true, email: 'beto@example.com' },
      cata: { emailVerified: true, email: 'cata@example.com' }, dani: { emailVerified: true, email: 'dani@example.com' },
      admin: { emailVerified: true, email: 'admin@example.com' }, otroadmin: { emailVerified: true, email: 'otro@example.com' }
    },
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', email: 'admin@example.com', role: 'admin' }),
      'miembros/otroadmin': miembroSinPlan({ name: 'Otra Admin', email: 'otro@example.com', role: 'admin' }),
      // Ana: plan mensual activo SIN Stripe (cortesía) · Beto: con suscripción de Stripe activa · Cata: ya sin membresía · Dani: plan anual activo sin Stripe
      'miembros/ana': miembroConPlan({ name: 'Ana Prueba', email: 'ana@example.com', phone: '2361112233', planTipo: 'mensual', stripeSubscriptionId: null, planVence: ts(dias(20)) }),
      'miembros/beto': miembroConPlan({ name: 'Beto Stripe', email: 'beto@example.com', planTipo: 'mensual', stripeSubscriptionId: 'sub_123', stripeSubscriptionStatus: 'active' }),
      'miembros/cata': miembroSinPlan({ name: 'Cata Sin Plan', email: 'cata@example.com' }),
      'miembros/dani': miembroConPlan({ name: 'Dani Anual', email: 'dani@example.com', planTipo: 'anual', stripeSubscriptionId: null, planVence: ts(dias(300)) }),
      'usuarios/ana': { planActivo: true, planStatus: 'active' },
      'cursos/c1': curso(1, 4), 'cursos/c2': curso(2, 5), 'cursos/c3': curso(3, 0), 'cursos/c4': curso(4, 3),
      'miembros/ana/progresoCursos/c2': { cursoId: 'c2', uid: 'ana', sesionesVistas: [0, 1, 2], completado: false },
      'miembros/ana/progresoCursos/c4': { cursoId: 'c4', uid: 'ana', sesionesVistas: [0, 1, 2, 3, 4, 5], completado: true, certificadoFolio: 'ZOO-77' },
      'certificados/ZOO-77': { folio: 'ZOO-77', uid: 'ana', memberUid: 'ana', curso: 'Curso 4', emitido: new Date().toISOString(), verificado: true, origen: 'backend' },
      ...extra
    }
  });
}
const adm = t => ({ Authorization: `Bearer ${t || 'token-admin'}` });
const acciones = db => [...db._data.entries()].filter(([k]) => k.startsWith('adminAcciones/')).map(([, v]) => v);

/* ───────── Reglas puras ───────── */

test('validarDatos: solo los campos que llegan, con límites y sin caracteres raros', () => {
  assert.deepEqual(mm.validarDatos({ nombre: '  Ana   María  ', telefono: '(236) 111-2233', especialidad: 'Fisioterapia' }).datos, { name: 'Ana María', phone: '(236) 111-2233', especialidad: 'Fisioterapia' });
  assert.deepEqual(mm.validarDatos({ telefono: '' }).datos, { phone: '' }, 'se puede borrar el teléfono');
  assert.deepEqual(mm.validarDatos({ especialidad: '' }).datos, { especialidad: '' });
  assert.deepEqual(mm.validarDatos({ nombre: 'Ana <b>x</b>‮' }).datos, { name: 'Ana b x /b' });
  assert.equal(mm.validarDatos({ nombre: 'A' }).error.includes('al menos 2'), true);
  assert.ok(mm.validarDatos({ nombre: 5 }).error);
  assert.ok(mm.validarDatos({ telefono: 'llámame' }).error);
  assert.ok(mm.validarDatos({ telefono: '123' }).error);
  assert.ok(mm.validarDatos({ especialidad: 7 }).error);
  assert.ok(mm.validarDatos({}).error);
  assert.ok(mm.validarDatos(null).error);
  assert.ok(mm.validarDatos([]).error);
  assert.equal(mm.validarDatos({ nombre: 'x'.repeat(200) }).datos.name.length, 80);
  assert.deepEqual(Object.keys(mm.validarDatos({ nombre: 'Ana', plan: 'anual', role: 'admin', planVence: 1 }).datos), ['name'], 'nada de plan, rol ni fechas');
});

test('avanceDeCursos: todos los cursos con N/M, los empezados primero y sin pasarse del total', () => {
  const lista = [{ id: 'c1', titulo: 'Uno', clases: 4 }, { id: 'c2', titulo: 'Dos', clases: 5 }, { id: 'c3', titulo: 'Tres', clases: 0 }, { id: 'c4', titulo: 'Cuatro', clases: 3 }];
  const r = panel.avanceDeCursos(lista, [{ cursoId: 'c2', clasesVistas: 3 }, { cursoId: 'c4', clasesVistas: 9, completado: true }]);
  assert.deepEqual(r.map(x => [x.cursoId, x.clasesVistas, x.clasesTotal, x.completado]), [['c2', 3, 5, false], ['c4', 3, 3, true], ['c1', 0, 4, false], ['c3', 0, 0, false]]);
  assert.deepEqual(panel.avanceDeCursos(null, null), []);
});

/* ───────── Ficha: avance por curso ───────── */

test('ficha: trae el avance de TODOS los cursos (N/M clases) además de lo que ya traía, solo para administradores', async () => {
  const { app } = montar();
  assert.equal((await request(app).get('/api/admin/miembros/ana')).status, 401);
  assert.equal((await request(app).get('/api/admin/miembros/ana').set(adm('token-ana'))).status, 403);
  const r = (await request(app).get('/api/admin/miembros/ana').set(adm())).body;
  assert.deepEqual(r.avance.map(x => [x.curso, x.clasesVistas, x.clasesTotal, x.completado]), [['Curso 2', 3, 5, false], ['Curso 4', 3, 3, true], ['Curso 1', 0, 4, false], ['Curso 3', 0, 0, false]]);
  assert.equal(r.progreso.length, 2, 'lo que ya traía la ficha sigue igual');
  assert.equal(r.certificados.length, 1);
  assert.equal(r.miembro.especialidad, '');
  assert.equal(r.miembro.telefono, '2361112233');
  const sin = (await request(app).get('/api/admin/miembros/cata').set(adm())).body;
  assert.equal(sin.avance.length, 4);
  assert.ok(sin.avance.every(x => x.clasesVistas === 0));
});

/* ───────── Editar datos ───────── */

test('editar datos: solo administradores; valida; guarda nombre, teléfono y especialidad sin tocar plan ni rol; queda anotado', async () => {
  const { app, db } = montar();
  const post = (uid, cuerpo, token) => request(app).post(`/api/admin/miembros/${uid}/datos`).set(adm(token)).send(cuerpo);
  assert.equal((await request(app).post('/api/admin/miembros/ana/datos').send({ nombre: 'Otra' })).status, 401);
  assert.equal((await post('ana', { nombre: 'Otra' }, 'token-ana')).status, 403);
  assert.equal((await post('ana', { nombre: 'A' })).status, 400);
  assert.equal((await post('ana', { telefono: 'xx' })).status, 400);
  assert.equal((await post('ana', {})).status, 400);
  assert.equal((await post('noexiste1', { nombre: 'Alguien' })).status, 404);
  assert.equal((await post('a%20b', { nombre: 'Alguien' })).status, 400);
  assert.equal(db.value('miembros/ana').name, 'Ana Prueba', 'lo rechazado no cambia nada');
  const antes = { plan: db.value('miembros/ana').planTipo, rol: db.value('miembros/ana').role, vence: db.value('miembros/ana').planVence };
  const r = await post('ana', { nombre: 'Ana María Prueba', telefono: '+52 236 111 2233', especialidad: 'Fisioterapia deportiva', planTipo: 'anual', role: 'admin' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.miembro, { nombre: 'Ana María Prueba', telefono: '+52 236 111 2233', especialidad: 'Fisioterapia deportiva' });
  const a = db.value('miembros/ana');
  assert.deepEqual([a.name, a.phone, a.especialidad], ['Ana María Prueba', '+52 236 111 2233', 'Fisioterapia deportiva']);
  assert.deepEqual({ plan: a.planTipo, rol: a.role, vence: a.planVence }, antes, 'plan, rol y vencimiento intactos');
  assert.equal(a.datosEditadosPor, 'admin');
  const nota = acciones(db).filter(x => x.accion === 'editar-datos');
  assert.equal(nota.length, 1);
  assert.deepEqual(nota[0].campos, ['nombre', 'teléfono', 'especialidad']);
  assert.equal(JSON.stringify(nota[0]).includes('2361112233') || JSON.stringify(nota[0]).includes('Fisioterapia'), false, 'la bitácora no guarda el teléfono ni la especialidad');
  // solo un campo
  assert.equal((await post('ana', { especialidad: '' })).status, 200);
  assert.equal(db.value('miembros/ana').especialidad, '');
  assert.equal(db.value('miembros/ana').name, 'Ana María Prueba');
  // la ficha ya muestra la especialidad guardada
  assert.equal((await post('ana', { especialidad: 'Nutrición' })).status, 200);
  assert.equal((await request(app).get('/api/admin/miembros/ana').set(adm())).body.miembro.especialidad, 'Nutrición');
});

/* ───────── Quitar acceso ───────── */

test('quitar acceso: pide confirmación, solo administradores y rechaza cuentas de administración y personas que no existen', async () => {
  const { app, db } = montar();
  const post = (uid, cuerpo, token) => request(app).post(`/api/admin/miembros/${uid}/quitar-acceso`).set(adm(token)).send(cuerpo);
  assert.equal((await request(app).post('/api/admin/miembros/ana/quitar-acceso').send({ confirmar: true })).status, 401);
  assert.equal((await post('ana', { confirmar: true }, 'token-ana')).status, 403);
  assert.equal((await post('ana', {})).status, 400);
  assert.equal((await post('ana', { confirmar: 'si' })).status, 400);
  assert.equal((await post('noexiste1', { confirmar: true })).status, 404);
  assert.equal((await post('otroadmin', { confirmar: true })).status, 400);
  assert.equal((await post('admin', { confirmar: true })).status, 400);
  assert.equal(db.value('miembros/ana').planActivo, true, 'nada cambió');
  assert.equal(acciones(db).length, 0);
});

test('quitar acceso: la cuenta pasa a sin membresía AHORA, se conserva todo lo demás, no toca Stripe y queda anotado', async () => {
  const { app, db } = montar();
  const r = await request(app).post('/api/admin/miembros/ana/quitar-acceso').set(adm()).send({ confirmar: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.yaSinAcceso], [true, false]);
  const a = db.value('miembros/ana');
  assert.equal(a.planActivo, false);
  assert.equal(a.planStatus, 'expired');
  assert.ok(Date.now() - new Date(a.planVence.toDate ? a.planVence.toDate() : a.planVence).getTime() < 60000, 'el vencimiento pasa a ahora');
  assert.equal(a.accesoQuitadoPor, 'admin');
  assert.equal(a.stripeSubscriptionId, null, 'no se toca nada de Stripe');
  assert.equal(a.name, 'Ana Prueba');
  assert.equal(a.planTipo, 'mensual', 'se conserva el tipo de plan para el historial');
  assert.equal(db.value('usuarios/ana').planActivo, false);
  assert.equal(db.value('usuarios/ana').planStatus, 'expired');
  assert.ok(db.value('miembros/ana/progresoCursos/c2'), 'su avance se conserva');
  assert.ok(db.value('certificados/ZOO-77'), 'sus certificados se conservan');
  // la lista del panel ya la ve sin acceso
  const lista = (await request(app).get('/api/admin/miembros?refrescar=1').set(adm())).body.miembros.find(m => m.uid === 'ana');
  assert.equal(lista.conAcceso, false);
  const nota = acciones(db).filter(x => x.accion === 'quitar-acceso');
  assert.equal(nota.length, 1);
  assert.equal(nota[0].uidDestino, 'ana');
  // hacerlo otra vez no inventa nada
  const otra = await request(app).post('/api/admin/miembros/ana/quitar-acceso').set(adm()).send({ confirmar: true });
  assert.deepEqual([otra.status, otra.body.yaSinAcceso], [200, true]);
  assert.equal(acciones(db).filter(x => x.accion === 'quitar-acceso').length, 1);
  // y si después se le regala tiempo, recupera el acceso
  assert.equal((await request(app).post('/api/admin/miembros/ana/regalar').set(adm()).send({ dias: 30 })).status, 200);
  assert.equal(db.value('miembros/ana').planActivo, true);
});

test('quitar acceso con suscripción de Stripe ACTIVA: se rechaza con aviso claro y no cambia nada (Stripe volvería a darle acceso)', async () => {
  const { app, db } = montar();
  const r = await request(app).post('/api/admin/miembros/beto/quitar-acceso').set(adm()).send({ confirmar: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'stripe-activa');
  assert.match(r.body.error, /suscripción de Stripe activa/);
  assert.match(r.body.error, /Cancela primero la suscripción en Stripe/);
  const b = db.value('miembros/beto');
  assert.equal(b.planActivo, true);
  assert.equal(b.stripeSubscriptionId, 'sub_123');
  assert.equal(acciones(db).length, 0);
});

test('quitar acceso a quien ya no tiene membresía no cambia nada', async () => {
  const { app, db } = montar();
  const antes = JSON.stringify(db.value('miembros/cata'));
  const r = await request(app).post('/api/admin/miembros/cata/quitar-acceso').set(adm()).send({ confirmar: true });
  assert.deepEqual([r.status, r.body.yaSinAcceso], [200, true]);
  assert.equal(JSON.stringify(db.value('miembros/cata')), antes);
  assert.equal(acciones(db).length, 0);
});

/* ───────── Lo que ya existía sigue ahí ───────── */

test('regalar 30 días y eliminar a la papelera (con restauración) siguen funcionando', async () => {
  const { app, db } = montar();
  const g = await request(app).post('/api/admin/miembros/dani/regalar').set(adm()).send({ dias: 30 });
  assert.equal(g.status, 200);
  assert.equal(g.body.dias, 30);
  assert.equal(g.body.desdeVigente, true, 'se suma al vencimiento actual');
  const del = await request(app).delete('/api/admin/miembros/cata').set(adm()).send({ confirmarCorreo: 'cata@example.com' });
  assert.equal(del.status, 200);
  assert.equal(db.value('miembros/cata'), undefined);
  assert.ok(db.value('adminEliminados/cata'), 'queda el respaldo para restaurar');
  const lista = (await request(app).get('/api/admin/eliminados').set(adm())).body;
  assert.equal(lista.eliminados.some(e => e.uid === 'cata' && e.restaurable), true);
});
