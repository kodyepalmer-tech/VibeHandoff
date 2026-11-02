'use strict';

process.env.NODE_ENV = 'test';
process.env.PLATFORM_MODE = 'public';
process.env.LOG_LEVEL = 'silent';

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

test('a public player can upload a game and comment on the shelf', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const created = await jordan.post('/api/apps').send({
    name: 'Pebble',
    slug: 'pebble',
    description: 'A tiny public game.',
    tags: ['game'],
  });
  assert.equal(created.status, 201);

  const comment = await jordan
    .post('/api/apps/sandbox/reviews')
    .send({ rating: 5, body: 'The grid is the whole game.' });
  assert.equal(comment.status, 201);
  const listed = await jordan.get('/api/apps/sandbox/reviews');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.reviews[0].body, 'The grid is the whole game.');
  assert.equal(listed.body.reviews[0].display_name, 'Jordan Lee');

  const shelf = await jordan.get('/api/apps/sandbox');
  assert.equal(shelf.body.app.creator_name, 'Maya Chen');
  assert.match(shelf.body.app.description, /solo sandbox/i);
});

test('the public shop signs in without company role cards', async (t) => {
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
  await page.getByRole('heading', { name: 'Sign in to play.' }).waitFor();
  await page.getByRole('button', { name: 'Enter the shop' }).waitFor();
  const loginText = await page.locator('main').innerText();
  assert.equal(loginText.includes('Development identities'), false);
  assert.equal(loginText.includes('Jordan Lee'), false);
  assert.equal(loginText.includes('Avery Quinn'), false);
  await page.getByRole('button', { name: 'Enter the shop' }).click();
  await page.waitForURL('http://127.0.0.1:13000/');
  await page.getByRole('heading', { name: 'Play what people posted.' }).waitFor();
  await page.getByRole('link', { name: /Sandbox/ }).click();
  await page.waitForURL(/\/apps\/sandbox$/);
  await page.getByText('Posted by Maya Chen').waitFor();
  await page.getByRole('heading', { name: 'Comments' }).waitFor();
  await page.getByText('The grid is the whole game.').waitFor();
  await page.getByRole('link', { name: 'Play solo' }).click();
  await page.waitForURL(/\/apps\/sandbox\/launch/);
  const frame = page.frameLocator('#frame');
  await frame.getByRole('heading', { name: 'Sandbox' }).waitFor({ timeout: 10_000 });

  await page.goto('http://127.0.0.1:13000/apps/snake');
  await page.getByRole('button', { name: 'Invite friends' }).waitFor();
  await page.getByRole('button', { name: 'Join live' }).waitFor();
  await page.getByRole('link', { name: 'Play solo' }).waitFor();
});
