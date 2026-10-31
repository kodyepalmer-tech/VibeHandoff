'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/harness');

let harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  if (harness) await harness.close();
});

test('a solo app cannot open a live room', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const denied = await jordan.post('/api/apps/orbit-sketch/rooms').send({});
  assert.equal(denied.status, 409);
  const snake = await jordan.get('/api/apps/snake');
  assert.equal(snake.status, 200);
  assert.equal(snake.body.app.multiplayer, true);
  assert.equal(snake.body.app.name, 'Snake');
});

test('two people in one organization share a live snake room', async () => {
  const jordan = await harness.login('jordan@acme.example');
  const maya = await harness.login('maya@acme.example');
  const created = await jordan.post('/api/apps/snake/rooms').send({});
  assert.equal(created.status, 201);
  const code = created.body.room.code;
  assert.equal(created.body.room.players.length, 1);

  const joined = await maya.post(`/api/apps/snake/rooms/${code}/join`).send({});
  assert.equal(joined.status, 200);
  assert.equal(joined.body.room.players.length, 2);

  const posted = await jordan.post(`/api/apps/snake/rooms/${code}/events`).send({
    payload: { kind: 'input', direction: 'up' },
  });
  assert.equal(posted.status, 201);

  const seen = await maya.get(`/api/apps/snake/rooms/${code}/events?after=0`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.events.length, 1);
  assert.equal(seen.body.events[0].payload.direction, 'up');
  assert.equal(seen.body.players.length, 2);

  const echo = await jordan.get(`/api/apps/snake/rooms/${code}/events?after=0`);
  assert.equal(echo.body.events.length, 0);

  const listed = await maya.get('/api/apps/snake/rooms');
  assert.ok(listed.body.rooms.some((room) => room.code === code && room.playerCount === 2));
});

test('live room events stay inside the organization and under the size cap', async () => {
  const auth = require('../src/auth');
  await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'alex-rooms',
    email: 'alex-rooms@northwind.example',
    displayName: 'Alex Rivera',
    role: 'member',
    organizationSlug: 'northwind',
    organizationName: 'Northwind',
  });
  const jordan = await harness.login('jordan@acme.example');
  const alex = await harness.login('alex-rooms@northwind.example');
  const created = await jordan.post('/api/apps/snake/rooms').send({});
  const code = created.body.room.code;
  const hidden = await alex.post(`/api/apps/snake/rooms/${code}/join`).send({});
  assert.equal(hidden.status, 404);

  const bulky = await jordan.post(`/api/apps/snake/rooms/${code}/events`).send({
    payload: { kind: 'state', pad: 'x'.repeat(5000) },
  });
  assert.equal(bulky.status, 413);
});
