'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { platformProfile } = require('../src/platform');
const { storageProfile, publicObjectUrl, exportDownloadDecision } = require('../src/storage-profile');
const { startHarness } = require('./helpers/harness');

const root = path.join(__dirname, '..');

function productionEnv(extra) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret',
    DATABASE_URL: 'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff',
    S3_BUCKET: 'vibehandoff-artifacts',
    S3_ACCESS_KEY: 'vibehandoff',
    S3_SECRET_KEY: 'vibehandoff-secret',
    PORTAL_ORIGIN: 'https://apps.example.com',
    ARTIFACT_HOST_ORIGIN: 'https://play.example.com',
    ...extra,
  };
}

function loadConfig(extra) {
  return spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: root,
    env: productionEnv(extra),
    encoding: 'utf8',
  });
}

test('platform profiles keep the two products apart', () => {
  const enterprise = platformProfile('enterprise');
  assert.equal(enterprise.productName, 'Vibe Handoff Enterprise');
  assert.equal(enterprise.auth, 'oidc');
  assert.equal(enterprise.catalog, 'organization');
  assert.equal(enterprise.leaderboardScope, 'organization');
  assert.equal(enterprise.reviews, false);
  assert.equal(enterprise.exports, 'admin-approval');
  assert.equal(enterprise.csp, 'strict');

  const pub = platformProfile('public');
  assert.equal(pub.productName, 'VibeHandoff');
  assert.equal(pub.auth, 'oauth');
  assert.equal(pub.catalog, 'public');
  assert.equal(pub.leaderboardScope, 'global');
  assert.equal(pub.reviews, true);
  assert.equal(pub.exports, 'creator');
  assert.equal(pub.csp, 'standard');
  assert.equal(platformProfile().mode, 'enterprise');
  assert.throws(() => platformProfile('both'), /PLATFORM_MODE must be enterprise or public/);
});

test('storage keeps enterprise objects private and public objects on a CDN', () => {
  const enterprise = storageProfile('enterprise');
  assert.equal(enterprise.encryption, 'AES256');
  assert.equal(enterprise.serve, 'signed-url');
  assert.equal(enterprise.distribution, 'private');
  assert.equal(publicObjectUrl(enterprise, 'releases/a/index.html'), null);
  assert.equal(storageProfile('enterprise', { sse: false }).encryption, null);

  const pub = storageProfile('public', { publicBaseUrl: 'https://cdn.example.com/' });
  assert.equal(pub.encryption, null);
  assert.equal(pub.serve, 'cdn');
  assert.equal(pub.distribution, 'cdn');
  assert.equal(
    publicObjectUrl(pub, 'releases/a/index.html'),
    'https://cdn.example.com/releases/a/index.html'
  );

  assert.equal(
    exportDownloadDecision({
      mode: 'enterprise',
      sameOrganization: true,
      isCreator: true,
      approved: false,
    }).status,
    403
  );
  assert.equal(
    exportDownloadDecision({
      mode: 'enterprise',
      sameOrganization: false,
      isCreator: true,
      approved: true,
    }).ok,
    false
  );
  assert.equal(
    exportDownloadDecision({
      mode: 'enterprise',
      sameOrganization: true,
      isCreator: false,
      approved: true,
    }).ok,
    true
  );
  const bypass = exportDownloadDecision({
    mode: 'public',
    sameOrganization: true,
    isCreator: true,
    approved: false,
  });
  assert.equal(bypass.ok, true);
  assert.equal(bypass.autoApprove, true);
  assert.equal(
    exportDownloadDecision({
      mode: 'public',
      sameOrganization: true,
      isCreator: false,
      approved: true,
    }).status,
    403
  );
});

test('enterprise production still requires corporate OIDC', () => {
  const result = loadConfig({ AUTH_ADAPTER: 'dev' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /AUTH_ADAPTER must be oidc in production/);
});

test('public production requires OAuth and a provider client id', () => {
  const devLogin = loadConfig({ PLATFORM_MODE: 'public', AUTH_ADAPTER: 'dev' });
  assert.notEqual(devLogin.status, 0);
  assert.match(
    `${devLogin.stderr}\n${devLogin.stdout}`,
    /AUTH_ADAPTER must be oauth in production when PLATFORM_MODE=public/
  );

  const missingProvider = loadConfig({ PLATFORM_MODE: 'public', AUTH_ADAPTER: 'oauth' });
  assert.notEqual(missingProvider.status, 0);
  assert.match(
    `${missingProvider.stderr}\n${missingProvider.stdout}`,
    /At least one public OAuth provider client id is required/
  );

  const ready = loadConfig({
    PLATFORM_MODE: 'public',
    AUTH_ADAPTER: 'oauth',
    OAUTH_GITHUB_CLIENT_ID: 'github-client',
  });
  assert.equal(ready.status, 0, `${ready.stderr}\n${ready.stdout}`);
});

test('public artifact pages can only connect to themselves', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const express = require('express');
       const security = require('./src/security');
       const app = express();
       app.use(security.artifactSecurity());
       app.get('/', (req, res) => res.end('ok'));
       const server = app.listen(0, '127.0.0.1', async () => {
         const response = await fetch('http://127.0.0.1:' + server.address().port + '/');
         console.log(response.headers.get('content-security-policy') || '');
         server.close();
       });`,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        PLATFORM_MODE: 'public',
        AUTH_ADAPTER: 'dev',
        LOG_LEVEL: 'silent',
        SESSION_SECRET: 'test-session-secret-not-for-prod',
        PORTAL_ORIGIN: 'http://127.0.0.1:13000',
        ARTIFACT_HOST_ORIGIN: 'http://127.0.0.1:13001',
        DATABASE_URL: 'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff_test',
      },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /connect-src 'self'/);
  assert.doesNotMatch(result.stdout, /connect-src 'none'/);
});

function readZip(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function zipNames(buffer) {
  const yauzl = require('yauzl');
  const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true });
  const names = [];
  await new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      names.push(entry.fileName);
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  return names;
}

let harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  if (harness) await harness.close();
});

test('enterprise mode saves progress, keeps the best score, and gates reviews and exports', async () => {
  const platform = await harness.request.get('/api/platform');
  assert.equal(platform.status, 200);
  assert.equal(platform.body.mode, 'enterprise');
  assert.equal(platform.body.productName, 'Vibe Handoff Enterprise');
  assert.equal(platform.body.reviews, false);
  assert.equal(platform.body.exports, 'admin-approval');

  const maya = await harness.login('maya@acme.example');
  const review = await maya.post('/api/apps/snake/reviews').send({ rating: 5, body: 'Sharp.' });
  assert.equal(review.status, 404);
  assert.equal(review.body.error, 'Reviews are part of the public store.');
  const profile = await maya.patch('/api/me/profile').send({ handle: 'maya', profileBio: 'Builds games.' });
  assert.equal(profile.status, 404);

  const badKey = await maya.post('/api/user/save-state').send({ slug: 'snake', key: 'bad key', data: { hp: 1 } });
  assert.equal(badKey.status, 400);
  const saved = await maya.post('/api/user/save-state').send({
    slug: 'snake',
    key: 'progress',
    data: { length: 4, alive: true },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.state.data.length, 4);
  const loaded = await maya.get('/api/user/save-state?slug=snake&key=progress');
  assert.equal(loaded.body.state.data.alive, true);

  const jordan = await harness.login('jordan@acme.example');
  const hidden = await jordan.get('/api/user/save-state?slug=snake&key=progress');
  assert.equal(hidden.body.state, null);

  const low = await maya.post('/api/leaderboards/submit').send({ slug: 'snake', score: 4 });
  assert.equal(low.status, 200);
  assert.equal(low.body.score, 4);
  assert.equal(low.body.kept, true);
  const high = await maya.post('/api/leaderboards/submit').send({ slug: 'snake', score: 12 });
  assert.equal(high.body.score, 12);
  assert.equal(high.body.kept, true);
  const worse = await maya.post('/api/leaderboards/submit').send({ slug: 'snake', score: 9 });
  assert.equal(worse.body.score, 12);
  assert.equal(worse.body.kept, false);
  await jordan.post('/api/leaderboards/submit').send({ slug: 'snake', score: 20 });
  const board = await jordan.get('/api/leaderboards/snake');
  assert.equal(board.body.scope, 'organization');
  assert.equal(board.body.entries[0].displayName, 'Jordan Lee');
  assert.equal(board.body.entries[0].score, 20);
  assert.equal(board.body.entries[1].score, 12);

  const other = await jordan.post('/api/leaderboards/submit').send({ slug: 'not-a-game', score: 1 });
  assert.equal(other.status, 404);

  const requested = await maya.post('/api/apps/snake/exports').send({});
  assert.equal(requested.status, 201);
  assert.equal(requested.body.export.status, 'pending');
  assert.match(requested.body.transfer, /Nothing is copied/);
  const blockedDownload = await maya.get('/api/apps/snake/export/download');
  assert.equal(blockedDownload.status, 403);
  assert.match(blockedDownload.body.error, /admin has to approve/);
  const memberDecision = await jordan
    .post(`/api/admin/exports/${requested.body.export.id}/decision`)
    .send({ decision: 'approved' });
  assert.equal(memberDecision.status, 403);
  const memberExport = await jordan.post('/api/apps/snake/exports').send({});
  assert.equal(memberExport.status, 403);

  const avery = await harness.login('avery@acme.example');
  const pending = await avery.get('/api/admin/exports');
  assert.equal(pending.body.exports[0].status, 'pending');
  const approved = await avery
    .post(`/api/admin/exports/${requested.body.export.id}/decision`)
    .send({ decision: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.export.status, 'approved');
  assert.match(approved.body.transfer, /Nothing is copied/);
  const again = await avery
    .post(`/api/admin/exports/${requested.body.export.id}/decision`)
    .send({ decision: 'denied' });
  assert.equal(again.status, 404);

  assert.ok(harness.s3.puts.some((put) => put.encryption === 'AES256'));
  const downloaded = await maya.get('/api/apps/snake/export/download').buffer(true).parse(readZip);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers['content-type'], /application\/zip/);
  assert.match(downloaded.headers['content-disposition'], /attachment; filename="snake-/);
  assert.ok((await zipNames(downloaded.body)).includes('index.html'));
  const jordanDownload = await jordan.get('/api/apps/snake/export/download').buffer(true).parse(readZip);
  assert.equal(jordanDownload.status, 200);

  const publisherQuota = await maya.put('/api/admin/quota').send({
    maxUploadBytes: 1024,
    maxMemberStorageBytes: 4096,
  });
  assert.equal(publisherQuota.status, 403);
  const quota = await avery.put('/api/admin/quota').send({
    maxUploadBytes: 1024 * 1024,
    maxMemberStorageBytes: 8 * 1024 * 1024,
  });
  assert.equal(quota.status, 200);
  assert.equal(quota.body.custom, true);
  assert.equal(quota.body.maxUploadBytes, 1024 * 1024);
  const read = await avery.get('/api/admin/quota');
  assert.equal(read.body.maxMemberStorageBytes, 8 * 1024 * 1024);
  const raised = await avery.put('/api/admin/quota').send({
    maxUploadBytes: 1024 * 1024 * 1024,
    maxMemberStorageBytes: 2 * 1024 * 1024 * 1024,
  });
  assert.equal(raised.status, 400);
});
