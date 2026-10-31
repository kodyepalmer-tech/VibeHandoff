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

test('members and publishers cannot open the operator API', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const maya = await harness.login('maya@acme.example');
  assert.equal((await jordan.get('/api/admin/audit')).status, 403);
  assert.equal((await maya.get('/api/admin/users')).status, 403);
  assert.equal((await jordan.post('/api/admin/apps/orbit-sketch/takedown')).status, 403);
  const page = await jordan.get('/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, /Operator desk/);
});

test('an admin can read the audit log, grant a publisher role, and pull an app', async () => {
  const maya = await harness.login('maya@acme.example');
  const created = await maya.post('/api/apps').send({
    name: 'Quiet Room',
    slug: 'quiet-room',
    description: 'A blank room an admin can pull.',
    tags: ['tool'],
  });
  assert.equal(created.status, 201);
  const zip = await zipFiles({ 'index.html': '<!doctype html><h1>Quiet</h1>' });
  const uploaded = await maya
    .post('/api/apps/quiet-room/releases')
    .field('version', '1.0.0')
    .attach('artifact', zip, 'quiet-room.zip');
  assert.equal(uploaded.status, 201);
  const published = await maya.post(`/api/apps/quiet-room/releases/${uploaded.body.release.id}/publish`);
  assert.equal(published.status, 200);

  const auth = require('../src/auth');
  const guest = await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'guest-role',
    email: 'guest@acme.example',
    displayName: 'Guest Role',
    role: 'member',
    organizationSlug: 'acme',
    organizationName: 'Acme',
  });

  const avery = await harness.login('avery@acme.example');
  const audit = await avery.get('/api/admin/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.logs.some((entry) => entry.action === 'release.publish'));

  const granted = await avery.post(`/api/admin/users/${guest.id}/role`).send({ role: 'publisher' });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.user.role, 'publisher');

  const self = await avery.get('/api/me');
  const demote = await avery.post(`/api/admin/users/${self.body.user.id}/role`).send({ role: 'member' });
  assert.equal(demote.status, 409);

  const pulled = await avery.post('/api/admin/apps/quiet-room/takedown');
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.release.status, 'unpublished');
  const hidden = await avery.get('/api/apps/quiet-room');
  assert.equal(hidden.status, 404);

  const mayaPull = await maya.post('/api/admin/apps/orbit-sketch/takedown');
  assert.equal(mayaPull.status, 403);
});
