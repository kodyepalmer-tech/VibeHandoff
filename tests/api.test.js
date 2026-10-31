'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { zipFiles } = require('../scripts/zip-files');
const { startHarness } = require('./helpers/harness');

let harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  if (harness) await harness.close();
});

test('seeded marketplace is org-scoped and searchable', async () => {
  const maya = await harness.login('maya@acme.example');
  const listed = await maya.get('/api/apps');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.apps.length >= 3);
  const search = await maya.get('/api/apps?q=timer');
  assert.equal(search.body.apps.length, 1);
  assert.equal(search.body.apps[0].slug, 'standup-timer');
  const tagged = await maya.get('/api/apps?tag=game');
  assert.ok(tagged.body.apps.some((app) => app.slug === 'orbit-sketch'));
});

test('a second identity can discover and launch another creator release', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const me = await jordan.get('/api/me');
  assert.equal(me.body.user.role, 'member');
  const detail = await jordan.get('/api/apps/orbit-sketch');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.app.creator_name, 'Maya Chen');
  assert.equal(detail.body.app.version, '1.0.0');
  const launched = await jordan.post('/api/apps/orbit-sketch/launch');
  assert.equal(launched.status, 200);
  assert.match(launched.body.launchUrl, /http:\/\/127\.0\.0\.1:13001\/launch\//);
  assert.equal(launched.body.sandbox.includes('allow-scripts'), true);
  assert.equal(launched.body.sandbox.includes('allow-same-origin'), false);

  const url = new URL(launched.body.launchUrl);
  const artifact = await harness.artifactRequest.get(url.pathname);
  assert.equal(artifact.status, 200);
  assert.match(artifact.text, /Orbit Sketch/);
  assert.equal(artifact.headers['content-security-policy'].includes("connect-src 'none'"), true);
  assert.equal(artifact.headers['content-security-policy'].includes('http://127.0.0.1:13000'), true);
});

test('members cannot publish and artifacts stay private without a ticket', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const created = await jordan.post('/api/apps').send({ name: 'Secret Lab', slug: 'secret-lab' });
  assert.equal(created.status, 403);
  const prefix = await harness.db.query(
    `SELECT immutable_prefix FROM releases WHERE status = 'published' LIMIT 1`
  );
  const denied = await harness.artifactRequest.get(`/launch/not-a-ticket/index.html`);
  assert.equal(denied.status, 403);
  const raw = await harness.artifactRequest.get(`/${prefix.rows[0].immutable_prefix}/index.html`);
  assert.equal(raw.status, 404);
});

test('publish pipeline quarantines, validates, promotes, and blocks duplicate versions', async () => {
  const maya = await harness.login('maya@acme.example');
  const created = await maya.post('/api/apps').send({
    name: 'Desk Compass',
    slug: 'desk-compass',
    description: 'Tiny north-star for the week.',
    tags: ['tool'],
  });
  assert.equal(created.status, 201);
  const zip = await zipFiles({ 'index.html': '<!doctype html><h1>Desk Compass</h1>' });
  const uploaded = await maya
    .post('/api/apps/desk-compass/releases')
    .field('version', '0.1.0')
    .attach('artifact', zip, 'desk-compass.zip');
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.release.status, 'validated');
  assert.ok(uploaded.body.release.immutable_prefix);
  assert.equal(uploaded.body.release.quarantine_key, null);

  const published = await maya.post(`/api/apps/desk-compass/releases/${uploaded.body.release.id}/publish`);
  assert.equal(published.status, 200);
  assert.equal(published.body.release.status, 'published');

  const duplicate = await maya
    .post('/api/apps/desk-compass/releases')
    .field('version', '0.1.0')
    .attach('artifact', zip, 'desk-compass.zip');
  assert.equal(duplicate.status, 409);

  const unpublished = await maya.post(
    `/api/apps/desk-compass/releases/${uploaded.body.release.id}/unpublish`
  );
  assert.equal(unpublished.status, 200);
  assert.equal(unpublished.body.release.status, 'unpublished');
});

test('rejected uploads return validation feedback and never publish', async () => {
  const maya = await harness.login('maya@acme.example');
  await maya.post('/api/apps').send({ name: 'Bad Ship', slug: 'bad-ship' });
  const zip = await zipFiles({
    'index.html': '<!doctype html><title>bad</title>',
    'package.json': '{"scripts":{"start":"node server.js"}}',
  });
  const uploaded = await maya
    .post('/api/apps/bad-ship/releases')
    .field('version', '9.9.9')
    .attach('artifact', zip, 'bad.zip');
  assert.equal(uploaded.status, 422);
  assert.equal(uploaded.body.release.status, 'rejected');
  assert.ok(uploaded.body.validation.errors.length > 0);
  const publish = await maya.post(`/api/apps/bad-ship/releases/${uploaded.body.release.id}/publish`);
  assert.equal(publish.status, 409);
});

test('health endpoint reports database and object storage', async () => {
  const response = await harness.request.get('/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.body.database, true);
  assert.equal(response.body.objectStorage, true);
});
