'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { buildPreviewPolicy, canWatchPreview, INITIAL_COURSE_TITLE } = require('../course-preview');
const catalog = require('../data/zoorigen-bunny-catalog.json');

for (const count of [0, 1, 2, 8]) {
  test(`curso inicial de ${count} clases: solamente N-1 son gratuitas`, () => {
    const lecciones = Array.from({ length: count }, (_, i) => ({ num: i + 1, videoId: 'video-' + i }));
    const policy = buildPreviewPolicy([{ title: INITIAL_COURSE_TITLE, lecciones }, { title: 'Otro', lecciones: [{ num: 1, videoId: 'other' }] }]);
    assert.equal(policy.freeVideoIds.length, Math.max(0, count - 1));
    for (let i = 0; i < count; i++) assert.equal(canWatchPreview(policy, policy.courseKey, 'video-' + i), i < count - 1);
    assert.equal(canWatchPreview(policy, 'otro', 'video-0'), false);
    assert.equal(canWatchPreview(policy, policy.courseKey, 'other'), false);
    assert.equal(canWatchPreview(policy, policy.courseKey, 'unknown'), false);
  });
}

test('el catálogo real conserva dos clases gratuitas y el cierre premium', () => {
  const policy = buildPreviewPolicy(catalog);
  assert.equal(policy.lessonCount, 3);
  assert.equal(policy.freeVideoIds.length, 2);
  assert.equal(canWatchPreview(policy, policy.courseKey, policy.lecciones[2].videoId), false);
});

test('orden numérico canónico y catálogo inválido cierran acceso gratuito', () => {
  const lessons = [{ num: 2, videoId: 'last' }, { num: 1, videoId: 'first' }];
  assert.deepEqual(buildPreviewPolicy([{ title: INITIAL_COURSE_TITLE, lecciones: lessons }]).freeVideoIds, ['first']);
  for (const lecciones of [[{ num: 1, videoId: 'x' }, { num: 2, videoId: 'x' }], [{ num: 2, videoId: 'x' }]]) {
    assert.deepEqual(buildPreviewPolicy([{ title: INITIAL_COURSE_TITLE, lecciones }]).freeVideoIds, []);
  }
  assert.deepEqual(buildPreviewPolicy([]).freeVideoIds, []);
  const initial = { title: INITIAL_COURSE_TITLE, lecciones: lessons };
  assert.deepEqual(buildPreviewPolicy([initial, initial]).freeVideoIds, []);
  assert.deepEqual(buildPreviewPolicy([initial, { title: 'Otro', lecciones: [{ num: 1, videoId: 'first' }] }]).freeVideoIds, []);
});

test('endpoint real: sesión, curso, última clase, pago, cancelado vigente y admin', async () => {
  const routes = new Map();
  let member = null, adminAccess = false;
  const app = { use() {}, get(route, ...handlers) { routes.set('GET ' + route, handlers.at(-1)); }, post(route, ...handlers) { routes.set('POST ' + route, handlers.at(-1)); }, listen() {} };
  const express = () => app;
  express.raw = express.json = () => () => {};
  const db = { collection(name) { return { doc() { return { async get() { return { exists: name === 'admins' ? adminAccess : name === 'miembros' && !!member, data: () => name === 'miembros' ? member : undefined }; } }; } }; } };
  const auth = { async verifyIdToken(token) { if (token !== 'valid') throw new Error('invalid'); return { uid: 'test-user' }; } };
  const firebase = { apps: [{}], firestore: () => db, auth: () => auth };
  const serverPath = path.resolve(__dirname, '../server.js');
  const localRequire = createRequire(serverPath);
  const context = vm.createContext({
    require(name) { if (name === 'express') return express; if (name === 'cors') return () => () => {}; if (name === 'stripe') return () => ({}); if (name === 'firebase-admin') return firebase; return localRequire(name); },
    process: { env: { STRIPE_SECRET_KEY: 'sk_test_placeholder', BUNNY_TOKEN_AUTH_KEY: 'test-key' } },
    console: { log() {}, error() {}, warn() {} }, Buffer, Date, Set, Map
  });
  new vm.Script(fs.readFileSync(serverPath, 'utf8'), { filename: serverPath }).runInContext(context);
  const policy = buildPreviewPolicy(catalog);
  const request = async (videoId, courseKey = policy.courseKey, authorization = 'Bearer valid') => {
    const result = { statusCode: 200, body: null };
    const res = { set() { return this; }, status(code) { result.statusCode = code; return this; }, json(body) { result.body = body; return this; } };
    await routes.get('POST /api/bunny/embed-token')({ body: { videoId, courseKey }, headers: { authorization } }, res);
    return result;
  };
  for (const lesson of policy.lecciones.slice(0, -1)) {
    const response = await request(lesson.videoId);
    assert.equal(response.statusCode, 200);
    assert.match(response.body.embedUrl, /token=[a-f0-9]{64}/);
  }
  const last = policy.lecciones.at(-1).videoId;
  assert.equal((await request(last)).statusCode, 403);
  assert.equal((await request(catalog[1].lecciones[0].videoId)).statusCode, 403);
  assert.equal((await request(policy.lecciones[0].videoId, 'other')).statusCode, 403);
  assert.equal((await request(last, policy.courseKey, '')).statusCode, 401);
  assert.equal((await request(last, policy.courseKey, 'Bearer invalid')).statusCode, 401);
  assert.equal((await request('unknown')).statusCode, 404);
  for (const planStatus of ['active', 'cancelled_active']) {
    member = { planStatus, planVence: new Date(Date.now() + 86400000).toISOString() };
    assert.equal((await request(last)).statusCode, 200);
    assert.equal((await request(catalog[1].lecciones[0].videoId)).statusCode, 200);
  }
  member = { planStatus: 'active', planVence: new Date(Date.now() - 86400000).toISOString() };
  assert.equal((await request(last)).statusCode, 403);
  member = null; adminAccess = true;
  assert.equal((await request(last)).statusCode, 200);
});
