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
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('owner'), 'admin');
  assert.equal(normalizeRole('viewer'), 'member');
});

test('OIDC login state is one-time and stored in Postgres', async () => {
  const auth = require('../src/auth');
  const state = `state-${Date.now()}`;
  await auth.saveOidcTransaction({ state, nonce: 'nonce-1', codeVerifier: 'verifier-1' });
  const first = await auth.takeOidcTransaction(state);
  assert.equal(first.nonce, 'nonce-1');
  assert.equal(first.code_verifier, 'verifier-1');
  assert.equal(await auth.takeOidcTransaction(state), null);
});

test('a later sign-in keeps the role an admin assigned', async () => {
  const auth = require('../src/auth');
  const created = await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'role-stick',
    email: 'stick@acme.example',
    displayName: 'Stick Role',
    role: 'member',
    organizationSlug: 'acme',
    organizationName: 'Acme',
  });
  await harness.db.query(`UPDATE users SET role = 'publisher' WHERE id = $1`, [created.id]);
  const again = await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'role-stick',
    email: 'stick@acme.example',
    displayName: 'Stick Role',
    role: 'member',
    organizationSlug: 'acme',
    organizationName: 'Acme',
  });
  assert.equal(again.role, 'publisher');
});

test('rate limits survive a second limiter in another process image', async () => {
  const { createLimiter } = require('../src/security');
  const options = { windowMs: 60_000, max: 2, name: `shared-${Date.now()}` };
  const first = createLimiter(options);
  const second = createLimiter(options);
  const req = { ip: '203.0.113.10', path: '/api/limited', baseUrl: '', headers: {} };

  async function hit(limiter) {
    return new Promise((resolve, reject) => {
      const headers = {};
      const res = {
        set(name, value) {
          headers[name.toLowerCase()] = value;
        },
        status(code) {
          return {
            json(body) {
              resolve({ status: code, body, headers });
            },
          };
        },
      };
      limiter(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: 200, headers });
      });
    });
  }

  assert.equal((await hit(first)).status, 200);
  assert.equal((await hit(second)).status, 200);
  const blocked = await hit(first);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'Too many requests');
});

test('production refuses the development login adapter', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "require('./src/config')",
    ],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        AUTH_ADAPTER: 'dev',
        SESSION_SECRET: 'production-session-secret',
        DATABASE_URL: 'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff',
        S3_BUCKET: 'vibehandoff-artifacts',
        S3_ACCESS_KEY: 'vibehandoff',
        S3_SECRET_KEY: 'vibehandoff-secret',
        PORTAL_ORIGIN: 'https://apps.example.com',
        ARTIFACT_HOST_ORIGIN: 'https://play.example.com',
      },
      encoding: 'utf8',
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /AUTH_ADAPTER must be oidc in production/);
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
