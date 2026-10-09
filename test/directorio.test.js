'use strict';

// Directorio de la comunidad: validación, escape de HTML, límites, vista previa sin membresía.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../services/directorio');
const {
  request, cargarServidor, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe, ts, dias
} = require('./helpers/club');

// ── Reglas puras ──
test('escape de HTML: & < > " \' y ` pasan a entidades', () => {
  assert.equal(D.escaparHtml(`<img src=x onerror="alert('1')">&\``), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;&#96;');
  assert.equal(D.escaparHtml(null), '');
  assert.equal(D.escaparHtml(5), '5');
});

test('tarjeta válida: se limpian espacios y caracteres invisibles, se escapa el texto y se normaliza el contacto', () => {
  const r = D.validarTarjeta({
    nombre: '  Ana   <b>Pérez</b>  ', profesion: 'Bióloga​', sector: 'Conservación', ciudad: 'Mérida, Yuc.', bio: 'Línea 1\r\n\r\n\r\n\r\nLínea 2\u0000‮ fin',
    contacto: { whatsapp: '+52 (55) 1234-5678', email: ' ana@example.com ', web: 'zoorigen.com/club?x=1', linkedin: 'https://www.linkedin.com/in/ana', instagram: '@ana_p' }
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.tarjeta, {
    nombre: 'Ana &lt;b&gt;Pérez&lt;/b&gt;', profesion: 'Bióloga', sector: 'Conservación', ciudad: 'Mérida, Yuc.', bio: 'Línea 1\n\nLínea 2 fin',
    contacto: { whatsapp: '525512345678', email: 'ana@example.com', linkedin: 'https://www.linkedin.com/in/ana', web: 'https://zoorigen.com/club?x=1', instagram: 'ana_p' }
  });
});

test('tarjeta: solo el nombre es obligatorio y todo lo demás puede ir vacío', () => {
  const r = D.validarTarjeta({ nombre: 'Ana' });
  assert.deepEqual(r.tarjeta, { nombre: 'Ana', profesion: '', sector: '', ciudad: '', bio: '', contacto: {} });
  assert.deepEqual(D.validarTarjeta({ nombre: 'Ana', contacto: { web: '', email: '   ', whatsapp: null } }).tarjeta.contacto, {});
});

test('tarjeta: rechaza tipos raros, textos largos y datos de contacto mal formados', () => {
  const ok = { nombre: 'Ana' };
  const largo = n => 'x'.repeat(n);
  const malos = [
    null, undefined, 'texto', 5, [], {}, { nombre: '' }, { nombre: 'A' }, { nombre: 5 }, { nombre: ['Ana'] }, { nombre: { a: 1 } }, { nombre: largo(81) },
    { ...ok, profesion: largo(81) }, { ...ok, sector: largo(61) }, { ...ok, ciudad: largo(81) }, { ...ok, bio: largo(401) }, { ...ok, bio: 7 }, { ...ok, ciudad: ['x'] },
    { ...ok, contacto: 'tel' }, { ...ok, contacto: [] }, { ...ok, contacto: { whatsapp: '123' } }, { ...ok, contacto: { whatsapp: '1234567890123456' } },
    { ...ok, contacto: { whatsapp: 5512345678 } }, { ...ok, contacto: { whatsapp: 'llámame' } },
    { ...ok, contacto: { email: 'sin-arroba' } }, { ...ok, contacto: { email: 'a@b' } }, { ...ok, contacto: { email: 'a b@c.com' } }, { ...ok, contacto: { email: '<a@b.com>' } }, { ...ok, contacto: { email: ['a@b.com'] } },
    { ...ok, contacto: { web: 'javascript:alert(1)' } }, { ...ok, contacto: { web: 'data:text/html;base64,AAAA' } }, { ...ok, contacto: { web: 'ftp://x.com' } },
    { ...ok, contacto: { web: 'https://a.com/"onmouseover=alert(1)' } }, { ...ok, contacto: { web: 'https://a.com/<script>' } }, { ...ok, contacto: { web: 'https://user:pass@a.com' } },
    { ...ok, contacto: { web: 'localhost' } }, { ...ok, contacto: { web: 'https://a.com/' + largo(250) } }, { ...ok, contacto: { web: { u: 1 } } },
    { ...ok, contacto: { linkedin: 'https://evil.com/linkedin.com' } }, { ...ok, contacto: { linkedin: 'https://notlinkedin.com/in/x' } },
    { ...ok, contacto: { instagram: 'con espacios' } }, { ...ok, contacto: { instagram: '<x>' } }, { ...ok, contacto: { instagram: largo(31) } }
  ];
  for (const m of malos) {
    const r = D.validarTarjeta(m);
    assert.ok(r.error && !r.tarjeta, JSON.stringify(m) && String(JSON.stringify(m)).slice(0, 80));
  }
});

test('tarjeta: los campos extra que mande el navegador se ignoran', () => {
  const r = D.validarTarjeta({ nombre: 'Ana', uid: 'otro', role: 'admin', planActivo: true, verificado: true, contacto: { whatsapp: '5512345678', secreto: 'x' }, __proto__: { admin: true } });
  assert.deepEqual(Object.keys(r.tarjeta).sort(), ['bio', 'ciudad', 'contacto', 'nombre', 'profesion', 'sector']);
  assert.deepEqual(r.tarjeta.contacto, { whatsapp: '5512345678' });
});

test('filtros: por sector exacto y por texto sin importar mayúsculas ni acentos', () => {
  const t = [
    { uid: 'a', nombre: 'María Pérez', profesion: 'Bióloga', sector: 'Conservación', ciudad: 'Mérida', bio: '' },
    { uid: 'b', nombre: 'Luis Gómez', profesion: 'Veterinario', sector: 'Medicina veterinaria', ciudad: 'León', bio: 'Fauna exótica y &quot;rescate&quot;' }
  ];
  const ids = f => D.filtrar(t, f).map(x => x.uid);
  assert.deepEqual(ids({}), ['a', 'b']);
  assert.deepEqual(ids({ sector: 'conservacion' }), ['a']);
  assert.deepEqual(ids({ sector: 'Conservación' }), ['a']);
  assert.deepEqual(ids({ sector: 'otro' }), []);
  assert.deepEqual(ids({ q: 'maria' }), ['a']);
  assert.deepEqual(ids({ q: 'LEON' }), ['b']);
  assert.deepEqual(ids({ q: 'bióloga' }), ['a']);
  assert.deepEqual(ids({ q: 'rescate' }), ['b']);
  assert.deepEqual(ids({ q: '"rescate"' }), ['b'], 'se busca igual que se guarda (escapado)');
  assert.deepEqual(ids({ q: 'nada', sector: 'Conservación' }), []);
  assert.deepEqual(ids({ q: '   ' }), ['a', 'b']);
});

test('los 3 ejemplos de la vista previa son ficticios y no traen datos de contacto', () => {
  assert.equal(D.EJEMPLOS.length, 3);
  for (const e of D.EJEMPLOS) {
    assert.match(e.uid, /^ejemplo-\d$/);
    assert.match(e.profesion, /ejemplo/i);
    assert.deepEqual(e.contacto, {});
  }
});

// ── Endpoints ──
const tokens = tokensDe('ana', 'beto', 'sinplan', 'vencida', 'admin');
const baseSeed = (extra = {}) => ({
  ...cursosSeed(3),
  'miembros/ana': miembroConPlan({ name: 'Ana Pérez' }),
  'miembros/beto': miembroConPlan({ name: 'Beto Gómez' }),
  'miembros/sinplan': miembroSinPlan(),
  'miembros/vencida': miembroConPlan({ planActivo: false, planStatus: 'expired', planVence: ts(dias(-3)) }),
  'miembros/admin': miembroSinPlan({ role: 'admin' }),
  ...extra
});
const ver = (app, t = 'token-ana', consulta = '') => request(app).get(`/api/directorio${consulta}`).set(auth(t));
const guardar = (app, cuerpo, t = 'token-ana') => request(app).post('/api/directorio').set(auth(t)).send(cuerpo);
const borrar = (app, t = 'token-ana') => request(app).delete('/api/directorio').set(auth(t));
const tarjeta = (uid, extra = {}, minutos = 0) => ({
  uid, nombre: `Persona ${uid}`, profesion: 'Bióloga', sector: 'Conservación', ciudad: 'Mérida', bio: 'Hola',
  contacto: { email: `${uid}@example.com`, whatsapp: '5512345678' }, actualizado: ts(Date.now() - minutos * 60000), ...extra
});

test('directorio: GET exige sesión (401), no se guarda en caché y POST/DELETE también piden sesión', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await request(app).get('/api/directorio')).status, 401);
  assert.equal((await request(app).post('/api/directorio').send({ nombre: 'Ana' })).status, 401);
  assert.equal((await request(app).delete('/api/directorio')).status, 401);
  assert.equal((await ver(app, 'falso')).status, 401);
  const ok = await ver(app);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('directorio SIN membresía: solo 3 ejemplos ficticios (nunca tarjetas reales ni su contacto)', async () => {
  const seed = baseSeed({ 'directorio/beto': tarjeta('beto'), 'directorio/sinplan': tarjeta('sinplan') });
  const { app } = cargarServidor({ tokens, seed });
  for (const t of ['token-sinplan', 'token-vencida']) {
    const res = await ver(app, t, '?q=beto&sector=Conservaci%C3%B3n');
    assert.equal(res.status, 200);
    assert.equal(res.body.membresia, false);
    assert.equal(res.body.tarjetas.length, 3);
    assert.ok(res.body.tarjetas.every(x => x.uid.startsWith('ejemplo-') && Object.keys(x.contacto).length === 0));
    assert.equal(res.body.mia, null);
    assert.ok(!JSON.stringify(res.body).includes('example.com'));
    assert.ok(!JSON.stringify(res.body).includes('5512345678'));
  }
});

test('directorio con membresía: tarjetas reales con su forma del contrato, la más reciente primero, y "mia"', async () => {
  const seed = baseSeed({ 'directorio/ana': tarjeta('ana', {}, 30), 'directorio/beto': tarjeta('beto', {}, 5) });
  const { app } = cargarServidor({ tokens, seed });
  const res = await ver(app);
  assert.equal(res.body.membresia, true);
  assert.deepEqual(res.body.tarjetas.map(t => t.uid), ['beto', 'ana']);
  assert.deepEqual(Object.keys(res.body.tarjetas[0]).sort(), ['actualizado', 'bio', 'ciudad', 'contacto', 'nombre', 'profesion', 'sector', 'uid']);
  assert.ok(!Number.isNaN(Date.parse(res.body.tarjetas[0].actualizado)));
  assert.equal(res.body.mia.uid, 'ana');
  assert.deepEqual(res.body.mia.contacto, { email: 'ana@example.com', whatsapp: '5512345678' });
  assert.equal((await ver(app, 'token-beto')).body.mia.uid, 'beto');
});

test('directorio: filtros ?sector= y ?q= (sin importar acentos ni mayúsculas); valores raros se ignoran', async () => {
  const seed = baseSeed({
    'directorio/ana': tarjeta('ana', { nombre: 'Ana Pérez', sector: 'Conservación' }),
    'directorio/beto': tarjeta('beto', { nombre: 'Beto Gómez', sector: 'Medicina veterinaria', ciudad: 'León' })
  });
  const { app } = cargarServidor({ tokens, seed });
  const uids = async c => (await ver(app, 'token-ana', c)).body.tarjetas.map(t => t.uid).sort();
  assert.deepEqual(await uids('?sector=conservacion'), ['ana']);
  assert.deepEqual(await uids('?sector=Medicina%20veterinaria'), ['beto']);
  assert.deepEqual(await uids('?q=leon'), ['beto']);
  assert.deepEqual(await uids('?q=PEREZ'), ['ana']);
  assert.deepEqual(await uids('?q=zzz'), []);
  assert.deepEqual(await uids('?sector=&q='), ['ana', 'beto']);
  assert.deepEqual(await uids('?q[]=a&q[]=b'), ['ana', 'beto'], 'un arreglo no es un texto: se ignora');
  assert.deepEqual(await uids('?q=' + 'a'.repeat(500)), [], 'se recorta a 80 caracteres');
});

test('directorio: devuelve como máximo 300 tarjetas', async () => {
  const seed = baseSeed();
  for (let i = 0; i < 350; i++) seed[`directorio/m${i}`] = tarjeta(`m${i}`, {}, i);
  const { app } = cargarServidor({ tokens, seed });
  const res = await ver(app);
  assert.equal(res.body.tarjetas.length, 300);
  assert.equal(res.body.tarjetas[0].uid, 'm0', 'las más recientes primero');
});

test('POST: SIN membresía no se puede crear la tarjeta (403 membresia-requerida) y no se guarda nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  for (const [t, uid] of [['token-sinplan', 'sinplan'], ['token-vencida', 'vencida']]) {
    const res = await guardar(app, { nombre: 'Nombre Válido' }, t);
    assert.equal(res.status, 403);
    assert.equal(res.body.codigo, 'membresia-requerida');
    assert.equal(db.value(`directorio/${uid}`), undefined);
  }
});

test('POST: 400 con datos inválidos y no se guarda nada', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const malos = [{}, { nombre: 'A' }, { nombre: 5 }, { nombre: 'Ana', bio: 'x'.repeat(401) }, { nombre: 'Ana', contacto: { web: 'javascript:alert(1)' } },
    { nombre: 'Ana', contacto: { email: 'no' } }, { nombre: 'Ana', contacto: 'x' }];
  for (const m of malos) {
    const r = await guardar(app, m);
    assert.equal(r.status, 400, JSON.stringify(m).slice(0, 60));
    assert.ok(r.body.error);
  }
  assert.equal((await request(app).post('/api/directorio').set(auth('token-ana'))).status, 400, 'sin cuerpo');
  assert.equal(db.value('directorio/ana'), undefined);
});

test('POST: crea la tarjeta propia, devuelve la tarjeta guardada y escapa el HTML', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  const res = await guardar(app, {
    nombre: 'Ana <script>alert(1)</script> Pérez', profesion: '<img src=x onerror=alert(1)>', sector: 'Conservación', ciudad: 'Mérida', bio: 'Hola "mundo" & \'amigos\'',
    contacto: { email: 'ana@example.com', web: 'https://zoorigen.com' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tarjeta.uid, 'ana');
  const guardado = db.value('directorio/ana');
  assert.equal(guardado.uid, 'ana');
  assert.ok(guardado.actualizado);
  const texto = JSON.stringify(guardado);
  assert.ok(!texto.includes('<script') && !texto.includes('<img') && !/[<>]/.test(guardado.nombre + guardado.profesion + guardado.bio));
  assert.equal(guardado.nombre, 'Ana &lt;script&gt;alert(1)&lt;/script&gt; Pérez');
  assert.equal(guardado.bio, 'Hola &quot;mundo&quot; &amp; &#39;amigos&#39;');
  assert.equal((await ver(app)).body.mia.nombre, guardado.nombre);
});

test('POST: siempre es la tarjeta de quien llama; un uid, rol o campo extra del navegador no se guarda', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed({ 'directorio/beto': tarjeta('beto') }) });
  const antesBeto = db.value('directorio/beto');
  const res = await guardar(app, { nombre: 'Ana', uid: 'beto', role: 'admin', planActivo: true, verificado: true, contacto: { whatsapp: '5512345678', otro: 'x' } });
  assert.equal(res.status, 200);
  assert.deepEqual(db.value('directorio/beto'), antesBeto, 'la tarjeta ajena no se toca');
  assert.deepEqual(Object.keys(db.value('directorio/ana')).sort(), ['actualizado', 'bio', 'ciudad', 'contacto', 'nombre', 'profesion', 'sector', 'uid']);
  assert.deepEqual(db.value('directorio/ana').contacto, { whatsapp: '5512345678' });
});

test('POST: actualizar reemplaza la tarjeta (lo que se quita desaparece) y sigue siendo una sola', async () => {
  const { app, db } = cargarServidor({ tokens, seed: baseSeed() });
  await guardar(app, { nombre: 'Ana', bio: 'Primera versión', contacto: { email: 'a@example.com' } });
  await guardar(app, { nombre: 'Ana Pérez' });
  const g = db.value('directorio/ana');
  assert.equal(g.nombre, 'Ana Pérez');
  assert.equal(g.bio, '');
  assert.deepEqual(g.contacto, {});
  assert.equal([...db._data.keys()].filter(k => k === 'directorio/ana').length, 1);
});

test('POST: un administrador también puede tener su tarjeta; el límite es de 20 cambios por minuto', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  assert.equal((await guardar(app, { nombre: 'Admin' }, 'token-admin')).status, 200);
  for (let i = 0; i < 20; i++) assert.equal((await guardar(app, { nombre: 'Ana' })).status, 200);
  assert.equal((await guardar(app, { nombre: 'Ana' })).status, 429, 'la 21.ª llamada en un minuto se bloquea');
});

test('DELETE: borra solo la tarjeta propia, también sin membresía, y repetirlo no falla', async () => {
  const seed = baseSeed({ 'directorio/ana': tarjeta('ana'), 'directorio/beto': tarjeta('beto'), 'directorio/sinplan': tarjeta('sinplan') });
  const { app, db } = cargarServidor({ tokens, seed });
  assert.deepEqual((await borrar(app)).body, { ok: true });
  assert.equal(db.value('directorio/ana'), undefined);
  assert.ok(db.value('directorio/beto'), 'la de otra persona sigue');
  assert.equal((await borrar(app)).status, 200, 'repetir no falla');
  assert.equal((await borrar(app, 'token-sinplan')).status, 200);
  assert.equal(db.value('directorio/sinplan'), undefined);
  assert.equal((await ver(app, 'token-beto')).body.mia.uid, 'beto');
});

test('tener tarjeta en el directorio da el logro "Tarjeta de presentación" (+60 XP)', async () => {
  const { app } = cargarServidor({ tokens, seed: baseSeed() });
  const antes = (await request(app).get('/api/premios').set(auth('token-ana'))).body;
  assert.ok(!antes.logros.find(l => l.id === 'l3').ganado);
  await guardar(app, { nombre: 'Ana Pérez' });
  const despues = (await request(app).get('/api/premios').set(auth('token-ana'))).body;
  assert.ok(despues.logros.find(l => l.id === 'l3').ganado);
  assert.equal(despues.xp.total - antes.xp.total, 60);
});
