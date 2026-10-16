'use strict';

// Regalar tiempo, eliminar con respaldo y restaurar (panel de administración).
// Reglas puras: services/admin-miembros.js · rutas: services/rutas-admin-extra.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, cargarServidor, ts, dias, miembroConPlan, miembroSinPlan, auth, tokensDe } = require('./helpers/club');
const mm = require('./../services/admin-miembros');

const DIA = 86400000;

/* ───────── reglas puras ───────── */

test('validarRegalo: solo 30 o 365 días, nota opcional limpia', () => {
  assert.deepEqual(mm.validarRegalo({ dias: 30 }), { dias: 30, nota: '' });
  assert.deepEqual(mm.validarRegalo({ dias: '365', nota: '  Por <b>su</b>\n colaboración ' }), { dias: 365, nota: 'Por b su /b colaboración' });
  for (const malo of [{ dias: 15 }, { dias: 0 }, { dias: -30 }, { dias: '30.5' }, { dias: null }, {}, null, [], 'x']) {
    assert.ok(mm.validarRegalo(malo).error, JSON.stringify(malo));
  }
  assert.ok(mm.validarRegalo({ dias: 30, nota: 5 }).error);
  assert.equal(mm.validarRegalo({ dias: 30, nota: 'x'.repeat(500) }).nota.length, 200);
});

test('calcularRegalo: suma desde el vencimiento vigente o desde hoy', () => {
  const ahora = new Date('2026-10-16T12:00:00Z');
  const vigente = mm.calcularRegalo({ planVence: new Date('2026-11-01T00:00:00Z') }, 30, ahora);
  assert.equal(vigente.desdeVigente, true);
  assert.equal(vigente.vence.toISOString(), '2026-12-01T00:00:00.000Z');
  const vencido = mm.calcularRegalo({ planVence: new Date('2026-09-01T00:00:00Z') }, 365, ahora);
  assert.equal(vencido.desdeVigente, false);
  assert.equal(vencido.vence.getTime(), ahora.getTime() + 365 * DIA);
  assert.equal(mm.calcularRegalo({}, 30, ahora).vence.getTime(), ahora.getTime() + 30 * DIA);
});

test('stripeActiva: cualquier suscripción no terminada cuenta como activa', () => {
  assert.equal(mm.stripeActiva({}), false);
  assert.equal(mm.stripeActiva({ stripeSubscriptionId: 'sub_1', planStatus: 'active' }), true);
  assert.equal(mm.stripeActiva({ stripeSubscriptionId: 'sub_1', planStatus: 'cancelled_active' }), true);
  assert.equal(mm.stripeActiva({ stripeSubscriptionId: 'sub_1', planStatus: 'cancelled' }), false);
  assert.equal(mm.stripeActiva({ stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'canceled' }), false);
  assert.equal(mm.stripeActiva({ stripeSubscriptionId: 'sub_1', planStatus: 'expired' }), false);
});

test('validarEliminacion exige el correo escrito', () => {
  assert.ok(mm.validarEliminacion(undefined).error);
  assert.ok(mm.validarEliminacion({}).error);
  assert.ok(mm.validarEliminacion({ confirmarCorreo: '  ' }).error);
  assert.ok(mm.validarEliminacion({ confirmarCorreo: 'a@b.c', confirmarStripe: 'si' }).error);
  assert.deepEqual(mm.validarEliminacion({ confirmarCorreo: '  Ana@Example.com ' }), { confirmarCorreo: 'ana@example.com', confirmarStripe: false });
});

test('construirRespaldo copia sin undefined, conserva fechas y evaluarRestauracion respeta los 30 días', () => {
  const ahora = new Date('2026-10-16T12:00:00Z');
  const r = mm.construirRespaldo({
    uid: 'u1', miembro: { name: 'Ana', email: 'ana@example.com', planVence: ts(1), vacio: undefined }, progreso: { c1: { sesionesVistas: [0, 1], x: undefined } },
    certificados: [{ folio: 'F1', curso: 'Curso' }], cuenta: { email: 'ana@example.com', proveedores: undefined }, por: 'adm', porCorreo: 'ADM@x.com', ahora
  });
  assert.equal(r.estado, 'eliminado');
  assert.equal(r.completado, false);
  assert.equal('vacio' in r.miembro, false);
  assert.equal('x' in r.progreso.c1, false);
  assert.equal(typeof r.miembro.planVence.toMillis, 'function');
  assert.equal(r.eliminadoPorCorreo, 'adm@x.com');
  assert.equal(r.restaurableHasta.getTime(), ahora.getTime() + 30 * DIA);
  assert.equal(mm.evaluarRestauracion(r, ahora).motivo, 'incompleto');
  const hecho = { ...r, completado: true };
  assert.equal(mm.evaluarRestauracion(hecho, ahora).ok, true);
  assert.equal(mm.evaluarRestauracion(hecho, new Date(ahora.getTime() + 31 * DIA)).motivo, 'vencido');
  assert.equal(mm.evaluarRestauracion({ ...hecho, estado: 'restaurado' }, ahora).motivo, 'ya-restaurado');
  assert.equal(mm.evaluarRestauracion(null, ahora).motivo, 'no-existe');
  const enormes = mm.construirRespaldo({ uid: 'u2', miembro: { texto: 'x'.repeat(800000) }, por: 'a', porCorreo: 'a@b.c', ahora });
  assert.equal(mm.respaldoCabe(enormes), false);
});

/* ───────── rutas ───────── */

const tokens = {
  ...tokensDe('ana', 'beto', 'cata'),
  'token-admin': { uid: 'admin', email: 'admin@example.com', email_verified: true },
  'token-otroadmin': { uid: 'otroadmin', email: 'otro@example.com', email_verified: true }
};

function montar(extra = {}, usuariosExtra = {}) {
  return cargarServidor({
    tokens,
    usuariosAuth: {
      ana: { emailVerified: true, email: 'ana@example.com', displayName: 'Ana Prueba' },
      beto: { emailVerified: true, email: 'beto@example.com', displayName: 'Beto' },
      cata: { emailVerified: false, email: 'cata@example.com' },
      admin: { emailVerified: true, email: 'admin@example.com' },
      otroadmin: { emailVerified: true, email: 'otro@example.com' },
      ...usuariosExtra
    },
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', email: 'admin@example.com', role: 'admin' }),
      'miembros/otroadmin': miembroSinPlan({ name: 'Otra Admin', email: 'otro@example.com', role: 'admin' }),
      'miembros/ana': miembroConPlan({ name: 'Ana Prueba', email: 'ana@example.com', createdAt: new Date(Date.now() - 40 * DIA).toISOString(), stripeSubscriptionStatus: 'active' }),
      'miembros/beto': miembroSinPlan({ name: 'Beto Sin Plan', email: 'beto@example.com', createdAt: new Date(Date.now() - 10 * DIA).toISOString() }),
      'miembros/cata': miembroConPlan({ name: 'Cata Vencida', email: 'cata@example.com', planActivo: false, planStatus: 'expired', planVence: ts(dias(-10)), stripeSubscriptionId: null }),
      'usuarios/beto': { planActivo: false },
      'usuarios/cata': { planActivo: false, planStatus: 'expired' },
      'directorio/cata': { nombre: 'Cata', sector: 'Conservación', publicado: true },
      'retosUsuario/cata': { xp: 120, superados: 4 },
      'premiosUsuario/cata': { usados: [] },
      'actividadUsuario/cata': { dias: ['2026-10-01'] },
      'miembros/cata/progresoCursos/c1': { cursoId: 'c1', uid: 'cata', sesionesVistas: [0, 1, 2], completado: true, certificadoFolio: 'ZOO-9' },
      'miembros/cata/progresoCursos/c2': { cursoId: 'c2', uid: 'cata', sesionesVistas: [0] },
      'certificados/ZOO-9': { folio: 'ZOO-9', uid: 'cata', memberUid: 'cata', curso: 'Fototrampeo', emitido: new Date().toISOString(), verificado: true, origen: 'backend' },
      ...extra
    }
  });
}
const adm = t => ({ Authorization: `Bearer ${t || 'token-admin'}` });
const acciones = db => [...db._data.entries()].filter(([k]) => k.startsWith('adminAcciones/')).map(([, v]) => v);

/* ── Regalar ── */
test('POST regalar: valida, suma desde el vencimiento vigente, marca origen regalo y no toca Stripe ni el último pago', async () => {
  const { app, db, registro } = montar();
  const post = (uid, cuerpo, token) => request(app).post(`/api/admin/miembros/${uid}/regalar`).set(adm(token)).send(cuerpo);
  assert.equal((await post('beto', { dias: 15 })).status, 400);
  assert.equal((await post('beto', {})).status, 400);
  assert.equal((await post('noexiste1', { dias: 30 })).status, 404);
  assert.equal((await post('otroadmin', { dias: 30 })).status, 400);
  assert.equal((await post('admin', { dias: 30 })).status, 400);
  assert.equal((await post('a%20b', { dias: 30 })).status, 400);
  assert.equal(db.value('miembros/beto').esRegalo, undefined);

  // Sin plan: desde hoy
  const r = await post('beto', { dias: 30, nota: 'Cortesía por su ayuda' });
  assert.equal(r.status, 200);
  assert.equal(r.body.desdeVigente, false);
  assert.equal(r.body.stripeActiva, false);
  const b = db.value('miembros/beto');
  assert.equal(b.esRegalo, true);
  assert.equal(b.regaloDias, 30);
  assert.equal(b.regaloNota, 'Cortesía por su ayuda');
  assert.equal(b.planActivo, true);
  assert.equal(b.planStatus, 'active');
  assert.equal(b.ultimoPago, null);
  assert.ok(Math.abs(b.planVence.toMillis() - (Date.now() + 30 * DIA)) < 60000);
  assert.equal(db.value('usuarios/beto').planActivo, true);
  assert.equal(db.value('usuarios/beto').planStatus, 'active');
  const lista = await request(app).get('/api/admin/miembros').set(adm());
  const fila = lista.body.miembros.find(m => m.uid === 'beto');
  assert.equal(fila.estado, 'activo');
  assert.equal(fila.origen, 'regalo');
  assert.equal(fila.esRegalo, true);

  // Con plan vigente y Stripe: suma al vencimiento actual y avisa que sigue cobrándose
  const antes = db.value('miembros/ana').planVence.toMillis();
  const r2 = await post('ana', { dias: 365 });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.desdeVigente, true);
  assert.equal(r2.body.stripeActiva, true);
  assert.match(r2.body.aviso, /seguirá cobrando/);
  assert.equal(db.value('miembros/ana').planVence.toMillis(), antes + 365 * DIA);
  assert.equal(db.value('miembros/ana').stripeSubscriptionId, 'sub_x');
  assert.equal(registro.actualizaciones.length, 0); // Stripe no se toca
  // Regalar dos veces suma dos veces (no es idempotente a propósito: cada clic es un regalo)
  await post('ana', { dias: 30 });
  assert.equal(db.value('miembros/ana').planVence.toMillis(), antes + 395 * DIA);

  const a = acciones(db).filter(x => x.accion === 'regalar-plan');
  assert.equal(a.length, 3);
  assert.equal(a[0].uidDestino, 'beto');
  assert.equal(a[0].por, 'admin');
  assert.equal(a.some(x => x.stripeActiva === true), true);
});

test('Activar a mano después de un regalo quita la marca de regalo', async () => {
  const { app, db } = montar();
  await request(app).post('/api/admin/miembros/beto/regalar').set(adm()).send({ dias: 30 });
  assert.equal(db.value('miembros/beto').esRegalo, true);
  await request(app).post('/api/admin/miembros/beto/activar').set(adm()).send({ tipo: 'mensual' });
  assert.equal(db.value('miembros/beto').esRegalo, false);
});

/* ── Eliminar ── */
const eliminar = (app, uid, cuerpo, token) => request(app).delete(`/api/admin/miembros/${uid}`).set(adm(token)).send(cuerpo);

test('DELETE miembro: validaciones, rechaza administradores y la propia cuenta, y no borra nada si algo no cuadra', async () => {
  const { app, db, registroAuth } = montar();
  assert.equal((await eliminar(app, 'cata', undefined)).status, 400);
  assert.equal((await eliminar(app, 'cata', {})).status, 400);
  const mal = await eliminar(app, 'cata', { confirmarCorreo: 'otra@example.com' });
  assert.equal(mal.status, 400);
  assert.match(mal.body.error, /no coincide/);
  assert.equal((await eliminar(app, 'admin', { confirmarCorreo: 'admin@example.com' })).status, 400); // propia cuenta
  const otro = await eliminar(app, 'otroadmin', { confirmarCorreo: 'otro@example.com' });
  assert.equal(otro.status, 403);
  assert.match(otro.body.error, /administración/);
  assert.equal((await eliminar(app, 'noexiste1', { confirmarCorreo: 'x@y.z' })).status, 404);
  assert.equal((await eliminar(app, 'a%20b', { confirmarCorreo: 'x@y.z' })).status, 400);
  assert.ok(db.value('miembros/cata'));
  assert.ok(db.value('miembros/otroadmin'));
  assert.equal(registroAuth.borrados.length, 0);
  assert.equal(db.value('adminEliminados/cata'), undefined);
});

test('DELETE miembro por correo de ADMIN_EMAILS también se rechaza aunque no tenga la marca en Firestore', async () => {
  const previo = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com,jefa@example.com';
  try {
    const { app, db } = montar({ 'miembros/jefa': miembroSinPlan({ name: 'Jefa', email: 'jefa@example.com' }) }, { jefa: { emailVerified: true, email: 'jefa@example.com' } });
    const r = await eliminar(app, 'jefa', { confirmarCorreo: 'jefa@example.com' });
    assert.equal(r.status, 403);
    assert.ok(db.value('miembros/jefa'));
  } finally { if (previo === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previo; }
});

test('DELETE con suscripción de Stripe activa pide confirmación y nunca la cancela por su cuenta', async () => {
  const { app, db, registro } = montar();
  const r = await eliminar(app, 'ana', { confirmarCorreo: 'ana@example.com' });
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'stripe-activa');
  assert.match(r.body.error, /Stripe/);
  assert.ok(db.value('miembros/ana'));
  const ok = await eliminar(app, 'ana', { confirmarCorreo: ' ANA@example.com ', confirmarStripe: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stripeActiva, true);
  assert.match(ok.body.aviso, /Stripe/);
  assert.equal(db.value('miembros/ana'), undefined);
  assert.equal(registro.actualizaciones.length, 0); // ninguna llamada a subscriptions.update
  assert.equal(db.value('adminEliminados/ana').miembro.stripeSubscriptionId, 'sub_x');
});

test('DELETE guarda ANTES una copia completa y luego borra cuenta, miembro, espejo, tarjeta y retos; conserva avance y certificados', async () => {
  const { app, db, registroAuth, usuariosAuth } = montar();
  const r = await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  assert.equal(r.status, 200);
  assert.ok(r.body.restaurableHasta);
  assert.deepEqual(r.body.conservado.slice(0, 2), ['certificados', 'avance por curso']);

  const copia = db.value('adminEliminados/cata');
  assert.equal(copia.estado, 'eliminado');
  assert.equal(copia.completado, true);
  assert.equal(copia.correo, 'cata@example.com');
  assert.equal(copia.eliminadoPor, 'admin');
  assert.equal(copia.eliminadoPorCorreo, 'admin@example.com');
  assert.equal(copia.miembro.name, 'Cata Vencida');
  assert.equal(copia.miembro.planStatus, 'expired');
  assert.equal(typeof copia.miembro.planVence.toMillis, 'function');
  assert.equal(copia.usuario.planStatus, 'expired');
  assert.equal(copia.directorio.sector, 'Conservación');
  assert.equal(copia.retos.xp, 120);
  assert.deepEqual(Object.keys(copia.progreso).sort(), ['c1', 'c2']);
  assert.deepEqual(copia.progreso.c1.sesionesVistas, [0, 1, 2]);
  assert.deepEqual(copia.certificados.map(c => c.folio), ['ZOO-9']);
  assert.equal(copia.cuenta.email, 'cata@example.com');
  assert.ok(copia.restaurableHasta.toMillis() > Date.now() + 29 * DIA);

  assert.deepEqual(registroAuth.borrados, ['cata']);
  assert.equal(usuariosAuth.cata, undefined);
  for (const ruta of ['miembros/cata', 'usuarios/cata', 'directorio/cata', 'retosUsuario/cata']) assert.equal(db.value(ruta), undefined, ruta);
  // Se conserva
  assert.ok(db.value('miembros/cata/progresoCursos/c1'));
  assert.ok(db.value('certificados/ZOO-9'));
  assert.ok(db.value('premiosUsuario/cata'));
  assert.ok(db.value('miembros/ana'));
  const a = acciones(db).find(x => x.accion === 'eliminar-miembro');
  assert.equal(a.uidDestino, 'cata');
  assert.equal(a.cursosConAvance, 2);
  assert.equal(/cata@example/.test(a.resumen), false); // la bitácora no lleva correos
  // Ya no sale en la lista ni en la ficha
  const lista = await request(app).get('/api/admin/miembros?refrescar=1').set(adm());
  assert.equal(lista.body.miembros.some(m => m.uid === 'cata'), false);
  assert.equal((await request(app).get('/api/admin/miembros/cata').set(adm())).status, 404);
});

test('DELETE es idempotente: repetirlo no vuelve a borrar ni pisa el respaldo', async () => {
  const { app, db, registroAuth } = montar();
  const primera = await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  assert.equal(primera.status, 200);
  const respaldo1 = db.value('adminEliminados/cata');
  const segunda = await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  assert.equal(segunda.status, 200);
  assert.equal(segunda.body.yaEliminado, true);
  assert.deepEqual(registroAuth.borrados, ['cata']);
  assert.equal(db.value('adminEliminados/cata').eliminadoEn.toMillis(), respaldo1.eliminadoEn.toMillis());
  assert.equal(acciones(db).filter(x => x.accion === 'eliminar-miembro').length, 1);
});

test('DELETE: si la cuenta de acceso no se puede borrar, el respaldo queda guardado y no se borra nada más', async () => {
  // Una cuenta que no se puede borrar: la propiedad no es configurable, así que borrarla falla como si Firebase rechazara
  const fija = {};
  Object.defineProperty(fija, 'cata', { value: { emailVerified: false, email: 'cata@example.com' }, configurable: false, enumerable: true, writable: true });
  const { app, db } = cargarServidor({
    tokens, usuariosAuth: fija,
    seed: {
      'miembros/admin': miembroSinPlan({ name: 'Admin', role: 'admin' }),
      'miembros/cata': miembroConPlan({ name: 'Cata', email: 'cata@example.com', stripeSubscriptionId: null }),
      'directorio/cata': { nombre: 'Cata' }
    }
  });
  const r = await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  assert.equal(r.status, 502);
  assert.ok(db.value('miembros/cata'));
  assert.ok(db.value('directorio/cata'));
  const copia = db.value('adminEliminados/cata');
  assert.equal(copia.completado, false);
  assert.equal(copia.miembro.name, 'Cata');
  assert.equal(acciones(db).some(x => x.accion === 'eliminar-miembro'), false);
  // Un respaldo incompleto no se puede restaurar
  const lista = await request(app).get('/api/admin/eliminados').set(adm());
  assert.equal(lista.body.eliminados[0].restaurable, false);
  assert.equal((await request(app).post('/api/admin/eliminados/cata/restaurar').set(adm()).send({})).status, 409);
});

test('DELETE: tope de 10 por minuto y 429 después', async () => {
  const { app } = montar();
  let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await eliminar(app, 'noexiste1', { confirmarCorreo: 'x@y.z' });
  assert.equal(ultimo.status, 429);
});

/* ── Eliminados y restaurar ── */
test('GET eliminados y POST restaurar: vuelve la cuenta, los documentos y el avance, y no se puede restaurar dos veces', async () => {
  const { app, db, registroAuth, usuariosAuth } = montar();
  const antes = db.value('miembros/cata');
  await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  const lista = await request(app).get('/api/admin/eliminados').set(adm());
  assert.equal(lista.status, 200);
  assert.equal(lista.body.eliminados.length, 1);
  const e = lista.body.eliminados[0];
  assert.equal(e.uid, 'cata');
  assert.equal(e.nombre, 'Cata Vencida');
  assert.equal(e.restaurable, true);
  assert.equal(e.cursosConAvance, 2);
  assert.equal(JSON.stringify(lista.body).includes('sesionesVistas'), false);

  const r = await request(app).post('/api/admin/eliminados/cata/restaurar').set(adm()).send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.cuentaCreada, true);
  assert.match(r.body.aviso, /Olvidé mi contraseña/);
  assert.equal(registroAuth.creados[0].uid, 'cata');
  assert.equal(registroAuth.creados[0].email, 'cata@example.com');
  assert.ok(usuariosAuth.cata);
  const despues = db.value('miembros/cata');
  assert.equal(despues.name, antes.name);
  assert.equal(despues.planStatus, 'expired');
  assert.ok(despues.restauradoEn);
  assert.equal(db.value('directorio/cata').sector, 'Conservación');
  assert.equal(db.value('retosUsuario/cata').xp, 120);
  assert.equal(db.value('usuarios/cata').planStatus, 'expired');
  assert.deepEqual(db.value('miembros/cata/progresoCursos/c1').sesionesVistas, [0, 1, 2]);
  assert.equal(db.value('adminEliminados/cata').estado, 'restaurado');
  assert.equal(acciones(db).filter(x => x.accion === 'restaurar-miembro').length, 1);
  // Segunda vez
  assert.equal((await request(app).post('/api/admin/eliminados/cata/restaurar').set(adm()).send({})).status, 409);
  // Y puede volver a eliminarse después de restaurar
  const otra = await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  assert.equal(otra.status, 200);
  assert.equal(db.value('adminEliminados/cata').estado, 'eliminado');
});

test('POST restaurar: pasados 30 días no restaura (el respaldo sigue), no pisa cuentas existentes y avisa si el correo ya se usó', async () => {
  const { app, db } = montar();
  await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  // Vencido
  const copia = db.value('adminEliminados/cata');
  await db.collection('adminEliminados').doc('cata').set({ restaurableHasta: ts(Date.now() - DIA) }, { merge: true });
  const vencido = await request(app).post('/api/admin/eliminados/cata/restaurar').set(adm()).send({});
  assert.equal(vencido.status, 410);
  assert.match(vencido.body.error, /adminEliminados/);
  assert.equal(db.value('miembros/cata'), undefined);
  assert.ok(db.value('adminEliminados/cata').miembro);
  assert.equal(db.value('adminEliminados/cata').miembro.name, copia.miembro.name);
  const lista = await request(app).get('/api/admin/eliminados').set(adm());
  assert.equal(lista.body.eliminados[0].restaurable, false);
  assert.equal(lista.body.eliminados[0].motivo, 'vencido');
  // Sin respaldo
  assert.equal((await request(app).post('/api/admin/eliminados/nadie/restaurar').set(adm()).send({})).status, 404);
});

test('POST restaurar: si el correo ya tiene otra cuenta no restaura nada', async () => {
  const { app, db, usuariosAuth } = montar();
  await eliminar(app, 'cata', { confirmarCorreo: 'cata@example.com' });
  usuariosAuth.nueva = { emailVerified: true, email: 'CATA@example.com' };
  const r = await request(app).post('/api/admin/eliminados/cata/restaurar').set(adm()).send({});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /otra cuenta/);
  assert.equal(db.value('miembros/cata'), undefined);
  assert.equal(db.value('adminEliminados/cata').estado, 'eliminado');
});

test('regalar, eliminar y restaurar: solo administradores', async () => {
  const { app, db } = montar();
  const sinSesion = [
    () => request(app).post('/api/admin/miembros/beto/regalar').send({ dias: 30 }),
    () => request(app).delete('/api/admin/miembros/cata').send({ confirmarCorreo: 'cata@example.com' }),
    () => request(app).get('/api/admin/eliminados'),
    () => request(app).post('/api/admin/eliminados/cata/restaurar').send({})
  ];
  for (const f of sinSesion) assert.equal((await f()).status, 401);
  const comoMiembro = [
    () => request(app).post('/api/admin/miembros/beto/regalar').set(auth('token-ana')).send({ dias: 30 }),
    () => request(app).delete('/api/admin/miembros/cata').set(auth('token-ana')).send({ confirmarCorreo: 'cata@example.com' }),
    () => request(app).get('/api/admin/eliminados').set(auth('token-ana')),
    () => request(app).post('/api/admin/eliminados/cata/restaurar').set(auth('token-beto')).send({})
  ];
  for (const f of comoMiembro) { const r = await f(); assert.equal(r.status, 403); assert.deepEqual(Object.keys(r.body), ['error']); }
  assert.ok(db.value('miembros/cata'));
  assert.equal(db.value('miembros/beto').esRegalo, undefined);
});
