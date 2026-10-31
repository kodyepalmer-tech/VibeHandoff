'use strict';

const http = require('http');
const { createS3Mock } = require('../tests/helpers/s3-mock');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.AUTH_ADAPTER = process.env.AUTH_ADAPTER || 'dev';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'local-verify-session-secret';
process.env.PORTAL_ORIGIN = process.env.PORTAL_ORIGIN || 'http://127.0.0.1:3000';
process.env.ARTIFACT_HOST_ORIGIN = process.env.ARTIFACT_HOST_ORIGIN || 'http://127.0.0.1:3001';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:19000';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'vibehandoff-artifacts';
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'test';
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'test';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.APP_ROLE = 'all';
process.env.PORTAL_PORT = process.env.PORTAL_PORT || '3000';
process.env.ARTIFACT_PORT = process.env.ARTIFACT_PORT || '3001';

function jsonRequest(method, url, data, cookie) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const setCookie = res.headers['set-cookie']?.[0];
          const isJson = (res.headers['content-type'] || '').includes('json');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: isJson && text ? JSON.parse(text) : {},
            cookie: setCookie ? setCookie.split(';')[0] : cookie,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitFor(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      jsonRequest('GET', url)
        .then((res) => {
          if (res.status === 200) resolve(res);
          else if (left === 0) reject(new Error(`${url} -> ${res.status}`));
          else setTimeout(() => attempt(left - 1), 250);
        })
        .catch((err) => {
          if (left === 0) reject(err);
          else setTimeout(() => attempt(left - 1), 250);
        });
    };
    attempt(attempts);
  });
}

async function main() {
  const mock = createS3Mock();
  await mock.listen(19000);

  const db = require('../src/db');
  const storage = require('../src/storage');
  const { seed } = require('./seed');
  db.getPool(process.env.DATABASE_URL);
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await db.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  await db.migrate();
  await storage.ensureBucket();
  await seed();

  const { start } = require('../src/index');
  await start();
  await waitFor('http://127.0.0.1:3000/healthz');
  await waitFor('http://127.0.0.1:3001/healthz');

  const login = await jsonRequest('POST', 'http://127.0.0.1:3000/api/dev/login', {
    email: 'jordan@acme.example',
  });
  if (login.status !== 200 || login.json.user.role !== 'member') {
    throw new Error(`login failed: ${login.text}`);
  }
  const apps = await jsonRequest(
    'GET',
    'http://127.0.0.1:3000/api/apps?q=orbit',
    null,
    login.cookie
  );
  if (apps.json.apps?.[0]?.slug !== 'orbit-sketch') {
    throw new Error(`marketplace failed: ${apps.text}`);
  }
  const launched = await jsonRequest(
    'POST',
    'http://127.0.0.1:3000/api/apps/orbit-sketch/launch',
    {},
    login.cookie
  );
  if (!launched.json.launchUrl?.includes('13001/launch/') && !launched.json.launchUrl?.includes(':3001/launch/')) {
    throw new Error(`launch failed: ${launched.text}`);
  }
  const artifact = await jsonRequest('GET', launched.json.launchUrl);
  if (!artifact.text.includes('Orbit Sketch')) {
    throw new Error('artifact did not serve the published app');
  }
  if (!(artifact.headers['content-security-policy'] || '').includes("connect-src 'none'")) {
    throw new Error('artifact CSP missing connect-src none');
  }

  console.log('from-scratch deployment verify ok');
  if (process.env.VERIFY_KEEP === '1') {
    console.log('servers kept running on :3000 and :3001');
    return;
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
