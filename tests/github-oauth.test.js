'use strict';

process.env.NODE_ENV = 'test';
process.env.PLATFORM_MODE = 'public';
process.env.AUTH_ADAPTER = 'oauth';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_SECRET = 'test-session-secret-not-for-prod';
process.env.PORTAL_ORIGIN = 'http://127.0.0.1:13000';
process.env.ARTIFACT_HOST_ORIGIN = 'http://127.0.0.1:13001';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff_test';
process.env.ORGANIZATION_SLUG = 'acme';
process.env.ORGANIZATION_NAME = 'Acme';
process.env.OAUTH_GITHUB_CLIENT_ID = 'github-client';
process.env.OAUTH_GITHUB_CLIENT_SECRET = 'github-secret';
process.env.S3_BUCKET = 'vibehandoff-test';
process.env.S3_ACCESS_KEY = 'test';
process.env.S3_SECRET_KEY = 'test';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const {
  selectAuthRoute,
  githubRedirectUri,
  mapGithubIdentity,
} = require('../src/github-oauth');
const db = require('../src/db');
const { attachAuthRoutes, sessionMiddleware } = require('../src/auth');

const redirectUri = 'http://127.0.0.1:13000/auth/callback';
let githubFetch = async () => {
  throw new Error('unexpected fetch');
};
const originalFetch = global.fetch;

function githubProfile() {
  return {
    ok: true,
    json: async () => ({ id: 4242, login: 'maya-gh', name: 'Maya From GitHub' }),
  };
}

function githubEmails() {
  return {
    ok: true,
    json: async () => [
      { email: 'other@example.com', primary: false, verified: true },
      { email: 'maya.github@example.com', primary: true, verified: true },
    ],
  };
}

function tokenOk() {
  return {
    ok: true,
    json: async () => ({ access_token: 'gho_test' }),
  };
}

test('route selection keeps development login and enterprise OIDC', () => {
  assert.equal(selectAuthRoute({ authAdapter: 'dev', platformMode: 'enterprise' }), 'dev');
  assert.equal(selectAuthRoute({ authAdapter: 'dev', platformMode: 'public' }), 'dev');
  assert.equal(selectAuthRoute({ authAdapter: 'oidc', platformMode: 'enterprise' }), 'oidc');
  assert.equal(selectAuthRoute({ authAdapter: 'oauth', platformMode: 'enterprise' }), 'oidc');
  assert.equal(selectAuthRoute({ authAdapter: 'oauth', platformMode: 'public' }), 'github');
  assert.equal(githubRedirectUri('https://vibe.example.com'), 'https://vibe.example.com/auth/callback');
  const mapped = mapGithubIdentity(
    { id: 7, login: 'ada', name: '' },
    [{ email: 'Ada@Example.com', primary: true, verified: true }],
    { slug: 'acme', name: 'Acme' }
  );
  assert.equal(mapped.issuer, 'https://github.com');
  assert.equal(mapped.subject, '7');
  assert.equal(mapped.email, 'ada@example.com');
  assert.equal(mapped.displayName, 'ada');
  assert.equal(mapped.role, 'member');
  assert.equal(mapped.organizationSlug, 'acme');
  assert.throws(
    () => mapGithubIdentity({ id: 7, login: 'ada' }, [{ email: 'a@example.com', verified: false }], { slug: 'acme', name: 'Acme' }),
    /no verified email/
  );
});

test('development adapter still redirects to the studio sign-in', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const http = require('http');
       const express = require('express');
       const { attachAuthRoutes } = require('./src/auth');
       const app = express();
       attachAuthRoutes(app);
       const server = app.listen(0, '127.0.0.1', () => {
         const port = server.address().port;
         http.get({ hostname: '127.0.0.1', port, path: '/auth/login' }, (res) => {
           console.log(res.statusCode + ' ' + res.headers.location);
           res.resume();
           server.close();
         }).on('error', (err) => {
           console.error(err);
           process.exit(1);
         });
       });`,
    ],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        AUTH_ADAPTER: 'dev',
        PLATFORM_MODE: 'enterprise',
        LOG_LEVEL: 'silent',
        SESSION_SECRET: 'test-session-secret-not-for-prod',
        PORTAL_ORIGIN: 'http://127.0.0.1:13000',
        ARTIFACT_HOST_ORIGIN: 'http://127.0.0.1:13001',
        DATABASE_URL: process.env.DATABASE_URL,
        ORGANIZATION_SLUG: 'acme',
        ORGANIZATION_NAME: 'Acme',
      },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /302 \/login/);
});

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);
attachAuthRoutes(app);
const agent = request.agent(app);

before(async () => {
  global.fetch = (...args) => githubFetch(...args);
  db.getPool(process.env.DATABASE_URL);
  await db.migrate();
});

after(async () => {
  global.fetch = originalFetch;
  await db.closePool();
});

test('public mode signs in with GitHub and does not fall through to OIDC', async () => {
  githubFetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://github.com/login/oauth/access_token')) return tokenOk();
    if (href === 'https://api.github.com/user/emails') return githubEmails();
    if (href === 'https://api.github.com/user') return githubProfile();
    throw new Error(`unexpected fetch ${href}`);
  };

  const started = await agent.get('/auth/login');
  assert.equal(started.status, 302);
  const location = new URL(started.headers.location);
  assert.equal(`${location.origin}${location.pathname}`, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(location.searchParams.get('client_id'), 'github-client');
  const state = location.searchParams.get('state');
  assert.ok(state);

  const callback = await agent.get(`/auth/callback?code=good-code&state=${encodeURIComponent(state)}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/');
  const me = await agent.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'maya.github@example.com');
  assert.equal(me.body.user.role, 'member');
  assert.equal(me.body.user.displayName, 'Maya From GitHub');
  assert.equal(me.body.organization.slug, 'acme');

  await db.query(`UPDATE users SET role = 'publisher' WHERE email = $1`, ['maya.github@example.com']);
  const again = await agent.get('/auth/login');
  const nextState = new URL(again.headers.location).searchParams.get('state');
  const second = await agent.get(`/auth/callback?code=good-code&state=${encodeURIComponent(nextState)}`);
  assert.equal(second.status, 302);
  const still = await agent.get('/api/me');
  assert.equal(still.body.user.role, 'publisher');

  githubFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'bad_verification_code' }),
  });
  const retry = await agent.get('/auth/login');
  const badState = new URL(retry.headers.location).searchParams.get('state');
  const failed = await agent.get(`/auth/callback?code=bad-code&state=${encodeURIComponent(badState)}`);
  assert.equal(failed.status, 502);
  assert.match(failed.text, /GitHub sign-in failed/);
  assert.doesNotMatch(failed.text, /oidc|Issuer|discover/i);

  const afterFailure = await agent.get('/auth/login');
  assert.equal(afterFailure.status, 302);
  assert.match(afterFailure.headers.location, /^https:\/\/github\.com\/login\/oauth\/authorize/);
});
