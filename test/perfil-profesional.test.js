'use strict';

// Perfil profesional de bienvenida: la ficha PRIVADA (nombre, puesto, institución, ciudad, WhatsApp, correo) la
// puede guardar cualquier cuenta; se mezcla con la tarjeta del directorio y nunca la publica.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../services/directorio');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');

// ── Reglas puras ──
test('fusionarPerfil: sin tarjeta previa crea una PRIVADA con lo que vino y sin inventar nada', () => {
  const r = D.fusionarPerfil(null, { nombre: ' Mariana  Torres ', profesion: 'Bióloga', institucion: 'UMA Sierra', ciudad: 'Mérida', whatsapp: '+52 55 1234 5678', email: 'mari@example.com' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.tarjeta, {
    nombre: 'Mariana Torres', profesion: 'Bióloga', institucion: 'UMA Sierra', sector: '', ciudad: 'Mérida', bio: '', estado: '', cedula: '',
    cedulaVisible: false, publicado: false, contacto: { whatsapp: '525512345678', email: 'mari@example.com' }
  });
});

test('fusionarPerfil: conserva sector, descripción, estado, cédula, redes y el "publicado" de la tarjeta existente', () => {
  const previa = {
    nombre: 'Ana Pérez', profesion: 'Veterinaria', institucion: 'Zoo', sector: 'Veterinaria', ciudad: 'León', bio: 'Hola', estado: 'proyectos', cedula: '12345678',
    cedulaVisible: true, publicado: true, contacto: { whatsapp: '5512345678', web: 'https://ana.example.com/', instagram: 'ana_p' }
  };
  const r = D.fusionarPerfil(previa, { nombre: 'Ana Pérez López', ciudad: 'Puebla', email: 'ana@example.com' });
  assert.equal(r.error, undefined);
  assert.equal(r.tarjeta.nombre, 'Ana Pérez López');
  assert.equal(r.tarjeta.ciudad, 'Puebla');
  assert.equal(r.tarjeta.profesion, 'Veterinaria', 'lo que no vino se conserva');
  assert.equal(r.tarjeta.sector, 'Veterinaria');
  assert.equal(r.tarjeta.bio, 'Hola');
  assert.equal(r.tarjeta.estado, 'proyectos');
  assert.equal(r.tarjeta.cedula, '12345678');
  assert.equal(r.tarjeta.cedulaVisible, true);
  assert.equal(r.tarjeta.publicado, true, 'no se despublica ni se publica por aquí');
  assert.deepEqual(r.tarjeta.contacto, { whatsapp: '5512345678', web: 'https://ana.example.com/', instagram: 'ana_p', email: 'ana@example.com' });
});

test('fusionarPerfil: un campo de contacto vacío lo quita; un valor no válido es error', () => {
  const previa = { nombre: 'Ana Pérez', contacto: { whatsapp: '5512345678', email: 'ana@example.com' } };
  assert.deepEqual(D.fusionarPerfil(previa, { whatsapp: '' }).tarjeta.contacto, { email: 'ana@example.com' });
  assert.match(D.fusionarPerfil(previa, { whatsapp: '12' }).error, /WhatsApp/);
  assert.match(D.fusionarPerfil(previa, { email: 'no-es-correo' }).error, /correo/);
  assert.match(D.fusionarPerfil(previa, { ciudad: 55 }).error, /no son válidos/);
  assert.match(D.fusionarPerfil(null, { profesion: 'Bióloga' }).error, /nombre es obligatorio/);
  assert.match(D.fusionarPerfil(previa, null).error, /Faltan/);
  assert.match(D.fusionarPerfil(previa, [1]).error, /Faltan/);
});

test('fusionarPerfil: ignora campos que no son del perfil (no se cuela publicado, cédula, sector ni verificado)', () => {
  const r = D.fusionarPerfil(null, { nombre: 'Ana Pérez', publicado: true, cedula: '99999999', sector: 'Hackeo', verificado: true, bio: 'x' });
  assert.equal(r.tarjeta.publicado, false);
  assert.equal(r.tarjeta.cedula, '');
  assert.equal(r.tarjeta.sector, '');
  assert.equal(r.tarjeta.bio, '');
  assert.equal(r.tarjeta.verificado, undefined);
});

test('perfilPropio: solo texto y contacto del perfil', () => {
  assert.deepEqual(D.perfilPropio(null), { existe: false, nombre: '', profesion: '', institucion: '', ciudad: '', whatsapp: '', email: '', publicado: false });
  const p = D.perfilPropio({ nombre: 'Ana', profesion: 'B', institucion: 'U', ciudad: 'C', contacto: { whatsapp: '55', email: 'a@b.co', web: 'https://x.y/' }, publicado: true, cedula: '1' });
  assert.deepEqual(p, { existe: true, nombre: 'Ana', profesion: 'B', institucion: 'U', ciudad: 'C', whatsapp: '55', email: 'a@b.co', publicado: true });
});

// ── Endpoints ──
const tokens = tokensDe('ana', 'sinplan', 'vencida');
const baseSeed = (extra = {}) => ({
  ...cursosSeed(3),
  'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
  'miembros/sinplan': miembroSinPlan({ name: 'Sin Plan' }),
  'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
  ...extra
});
const ver = (app, t = 'token-sinplan') => request(app).get('/api/perfil-profesional').set(auth(t));
const guardar = (app, cuerpo, t = 'token-sinplan') => request(app).post('/api/perfil-profesional').set(auth(t)).send(cuerpo);

test('perfil profesional: pide sesión y no se guarda en caché', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await request(app).get('/api/perfil-profesional')).status, 401);
  assert.equal((await request(app).post('/api/perfil-profesional').send({ nombre: 'Ana Pérez' })).status, 401);
  const r = await ver(app);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body.perfil, D.perfilPropio(null));
});

test('POST: una cuenta SIN membresía guarda su ficha privada (no se publica) y la ve al volver a abrir', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  for (const t of ['token-sinplan', 'token-vencida']) {
    const uid = t === 'token-sinplan' ? 'sinplan' : 'vencida';
    const r = await guardar(app, { nombre: 'Mariana Torres Ramírez', profesion: 'Bióloga', institucion: 'UMA Sierra', ciudad: 'Mérida', whatsapp: '55 1234 5678', email: 'mari@example.com' }, t);
    assert.equal(r.status, 200);
    assert.equal(r.body.perfil.nombre, 'Mariana Torres Ramírez');
    assert.equal(r.body.perfil.publicado, false);
    const doc = db.value(`directorio/${uid}`);
    assert.equal(doc.publicado, false);
    assert.equal(doc.contacto.whatsapp, '5512345678');
    assert.equal(doc.uid, uid);
    assert.ok(doc.actualizado);
    assert.equal((await ver(app, t)).body.perfil.ciudad, 'Mérida');
  }
});

test('POST: sin membresía NO se puede publicar por aquí (se ignora publicado) y el directorio no la muestra a nadie', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const r = await guardar(app, { nombre: 'Mariana Torres', publicado: true, sector: 'Conservación', cedula: '12345678' });
  assert.equal(r.status, 200);
  const doc = db.value('directorio/sinplan');
  assert.equal(doc.publicado, false);
  assert.equal(doc.cedula, '');
  const dir = await request(app).get('/api/directorio').set(auth('token-ana'));
  assert.deepEqual(dir.body.tarjetas.map(t => t.uid), [], 'una ficha privada no sale en el directorio');
});

test('POST: mezcla con la tarjeta ya publicada de un miembro sin tocar lo demás', async () => {
  const previa = { uid: 'ana', nombre: 'Ana Pérez', profesion: 'Bióloga', sector: 'Conservación', ciudad: 'Mérida', bio: 'Hola', publicado: true, contacto: { email: 'ana@example.com' }, actualizado: ts(Date.now() - 60000) };
  const { app, db } = cargarServidor({ tokens, seed: baseSeed({ 'directorio/ana': previa }) });
  const r = await guardar(app, { institucion: 'Zoológico Nacional', whatsapp: '5599887766' }, 'token-ana');
  assert.equal(r.status, 200);
  const doc = db.value('directorio/ana');
  assert.equal(doc.publicado, true);
  assert.equal(doc.sector, 'Conservación');
  assert.equal(doc.bio, 'Hola');
  assert.equal(doc.institucion, 'Zoológico Nacional');
  assert.deepEqual(doc.contacto, { email: 'ana@example.com', whatsapp: '5599887766' });
});

test('POST: 400 con datos inválidos y no se guarda nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  for (const malo of [{}, { nombre: 'A' }, { nombre: 5 }, { nombre: 'Ana Pérez', whatsapp: '12' }, { nombre: 'Ana Pérez', email: 'x' }, { nombre: 'Ana Pérez', ciudad: 'x'.repeat(200) }, 'texto', [1]]) {
    const r = await guardar(app, malo);
    assert.equal(r.status, 400, JSON.stringify(malo));
    assert.ok(r.body.error);
  }
  assert.equal(db.value('directorio/sinplan'), undefined);
});

test('POST: guardar el perfil no cambia la membresía ni el directorio de otras personas', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed({ 'directorio/ana': { uid: 'ana', nombre: 'Ana Pérez', publicado: true, contacto: {}, actualizado: ts() } }) });
  await guardar(app, { nombre: 'Persona Sin Plan' });
  assert.equal(db.value('miembros/sinplan').planActivo, false);
  assert.equal(db.value('directorio/ana').nombre, 'Ana Pérez');
});
