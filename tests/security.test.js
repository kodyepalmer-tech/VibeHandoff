'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/harness');
const { claimsToIdentity, normalizeRole } = require('../src/auth');

let harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  if (harness) await harness.close();
});

test('portal sends production security headers', async () => {
  const response = await harness.request.get('/login');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-security-policy'], /frame-src http:\/\/127\.0\.0\.1:13001/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.ok(!response.headers['x-powered-by']);
});

test('OIDC claim adapter maps org and role from environment-configured claims', () => {
  const identity = claimsToIdentity(
    {
      sub: 'user-99',
      email: 'alex@other.example',
      name: 'Alex Rivera',
      organization: 'northwind',
      role: 'publisher',
    },
    'https://issuer.example'
  );
  assert.equal(identity.organizationSlug, 'northwind');
  assert.equal(identity.role, 'publisher');
  assert.equal(normalizeRole('admin'), 'publisher');
  assert.equal(normalizeRole('viewer'), 'member');
});

test('users from another organization cannot see Acme apps', async () => {
  const auth = require('../src/auth');
  await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'alex',
    email: 'alex@northwind.example',
    displayName: 'Alex Rivera',
    role: 'member',
    organizationSlug: 'northwind',
    organizationName: 'Northwind',
  });
  const alex = await harness.login('alex@northwind.example');
  const listed = await alex.get('/api/apps');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.apps.length, 0);
  const hidden = await alex.get('/api/apps/orbit-sketch');
  assert.equal(hidden.status, 404);
});

test('launch iframe contract keeps the portal session off the artifact origin', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const launched = await jordan.post('/api/apps/pulse-board/launch');
  const artifactOrigin = new URL(launched.body.launchUrl).origin;
  assert.notEqual(artifactOrigin, 'http://127.0.0.1:13000');
  const page = await jordan.get('/apps/pulse-board/launch');
  assert.match(page.text, /sandbox="allow-scripts allow-forms allow-pointer-lock"/);
  assert.doesNotMatch(page.text, /allow-same-origin/);
});
