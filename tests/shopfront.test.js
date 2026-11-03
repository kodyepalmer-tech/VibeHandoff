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

test('friends, wishlists, and a game played twice as often show up on the shelf', async () => {
  const maya = await harness.login('maya@acme.example');
  const jordan = await harness.login('jordan@acme.example');
  const me = await jordan.get('/api/me');
  const mayaId = (await maya.get('/api/me')).body.user.id;

  const self = await jordan.post('/api/follows').send({ userId: me.body.user.id });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'You cannot follow yourself');

  const followed = await jordan.post('/api/follows').send({ userId: mayaId });
  assert.equal(followed.status, 201);
  assert.equal(followed.body.following.display_name, 'Maya Chen');

  assert.equal((await maya.post('/api/apps/snake/launch')).status, 200);
  assert.equal((await maya.post('/api/apps/cubesat/launch')).status, 200);
  assert.equal((await jordan.post('/api/apps/orbit-sketch/launch')).status, 200);
  for (let play = 0; play < 4; play += 1) {
    assert.equal((await jordan.post('/api/apps/cubesat/launch')).status, 200);
  }

  const wished = await jordan.post('/api/apps/cubesat/wishlist').send({});
  assert.equal(wished.status, 201);
  assert.equal(wished.body.wishlist.slug, 'cubesat');

  const moment = await jordan.post('/api/shares').send({
    slug: 'cubesat',
    kind: 'moment',
    note: 'Downlinked the first image.',
  });
  assert.equal(moment.status, 201);
  assert.match(moment.body.text, /Downlinked the first image\. — Cubesat /);

  const home = await jordan.get('/api/community');
  assert.equal(home.status, 200);
  assert.ok(home.body.friendsPlaying.some((row) => row.display_name === 'Maya Chen' && row.slug === 'snake'));
  assert.ok(home.body.wishlist.some((row) => row.slug === 'cubesat'));
  assert.ok(home.body.heating.some((row) => row.slug === 'cubesat' && row.plays === 5));
  assert.equal(home.body.heating.some((row) => row.slug === 'snake'), false);
  assert.ok(home.body.activity.some((row) => row.note === 'Downlinked the first image.'));
  assert.ok(home.body.library.some((row) => row.slug === 'cubesat'));

  const social = await jordan.get('/api/apps/cubesat/social');
  assert.equal(social.body.wishlisted, true);
  assert.equal(social.body.heating, true);
  assert.equal(social.body.weeklyPlays, 5);
  assert.equal(social.body.creatorName, 'Maya Chen');
  assert.deepEqual(social.body.friends, ['Maya Chen']);
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
  await page.getByRole('heading', { name: 'Friends are playing' }).waitFor();
  await page.getByRole('heading', { name: 'Picked up' }).waitFor();
  await page.getByRole('heading', { name: 'Wishlist' }).waitFor();
  await page.getByRole('link', { name: /Cubesat/ }).first().waitFor();
  await page.locator('a.card.game', { hasText: 'Sandbox' }).click();
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

  await page.goto('http://127.0.0.1:13000/apps/cubesat');
  await page.getByText(/Fly a cubesat/).waitFor();
  await page.getByRole('button', { name: 'Wishlist' }).waitFor();
  await page.getByRole('button', { name: 'Share' }).waitFor();
  await page.getByRole('button', { name: 'Post moment' }).waitFor();
  await page.getByText(/twice as often as a typical game/).waitFor();
  await page.getByRole('link', { name: 'Play solo' }).click();
  await page.waitForURL(/\/apps\/cubesat\/launch/);
  const sat = page.frameLocator('#frame');
  await sat.getByRole('heading', { name: 'Cubesat' }).waitFor({ timeout: 10_000 });
  await sat.getByRole('button', { name: 'Antenna' }).click();
  await sat.locator('#radio').check();
  await sat.getByText(/Ground station received/).waitFor({ timeout: 15_000 });
});
