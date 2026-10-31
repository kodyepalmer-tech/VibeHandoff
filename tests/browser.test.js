'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/harness');

let harness;
let browser;

before(async () => {
  harness = await startHarness({ listen: true });
});

after(async () => {
  if (browser) await browser.close();
  if (harness) await harness.close();
});

test('browser: member discovers and launches another creator release', async (t) => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }

  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    t.skip('playwright browser binaries are not installed');
    return;
  }

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:13000/login');
  await page.locator('button[data-email="jordan@acme.example"]').click();
  await page.waitForURL('http://127.0.0.1:13000/');
  await page.waitForSelector('#who');

  await page.fill('#q', 'orbit');
  await page.waitForTimeout(200);
  await page.getByRole('link', { name: /Orbit Sketch/ }).click();
  await page.waitForURL(/\/apps\/orbit-sketch$/);
  await page.getByText('Maya Chen').waitFor();
  assert.match(await page.locator('main').innerText(), /Maya Chen/);
  await page.getByRole('link', { name: 'Launch' }).click();
  await page.waitForURL(/\/apps\/orbit-sketch\/launch/);
  const frame = page.frameLocator('#frame');
  await frame.getByRole('heading', { name: 'Orbit Sketch' }).waitFor({ timeout: 10_000 });
  const sandbox = await page.locator('#frame').getAttribute('sandbox');
  assert.equal(sandbox.includes('allow-same-origin'), false);
  const src = await page.locator('#frame').getAttribute('src');
  assert.match(src, /^http:\/\/127\.0\.0\.1:13001\/launch\//);
});

test('browser: admin reviews the audit log and pulls a published app', async (t) => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  if (!browser) {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      t.skip('playwright browser binaries are not installed');
      return;
    }
  }

  const { zipFiles } = require('../scripts/zip-files');
  const maya = await harness.login('maya@acme.example');
  const created = await maya.post('/api/apps').send({
    name: 'Lantern',
    slug: 'lantern',
    description: 'Admin pull target',
  });
  assert.equal(created.status, 201);
  const zip = await zipFiles({ 'index.html': '<!doctype html><h1>Lantern</h1>' });
  const uploaded = await maya
    .post('/api/apps/lantern/releases')
    .field('version', '1.0.0')
    .attach('artifact', zip, 'lantern.zip');
  assert.equal(uploaded.status, 201);
  const published = await maya.post(`/api/apps/lantern/releases/${uploaded.body.release.id}/publish`);
  assert.equal(published.status, 200);

  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('http://127.0.0.1:13000/login');
  await page.locator('button[data-email="avery@acme.example"]').click();
  await page.waitForURL('http://127.0.0.1:13000/');
  await page.locator('a[data-nav="admin"]').click();
  await page.waitForURL('http://127.0.0.1:13000/admin');
  await page.getByRole('heading', { name: 'Operator desk' }).waitFor();
  await page.locator('#audit').getByText('release.publish').first().waitFor();
  await page.locator('button[data-takedown="lantern"]').click();
  await page.locator('button[data-takedown="lantern"]').waitFor({ state: 'detached' });
  const hidden = await maya.get('/api/apps/lantern');
  assert.equal(hidden.status, 404);
});
