'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMission } = require('../fixtures/apps/cubesat/mission');

test('a ground pass downlinks when the antenna and radio are on', () => {
  const mission = createMission();
  mission.setMode('antenna');
  mission.setRadio(true);
  let view = mission.snapshot();
  for (let step = 0; step < 80 && view.downlinked < 1; step += 1) {
    view = mission.step(0.05);
  }
  assert.equal(view.downlinked, 1);
  assert.equal(view.images, 0);
  assert.match(view.log[0], /Ground station received/);
  assert.ok(view.battery > 40);
});

test('the camera stores an image only while nadir-pointed in sunlight', () => {
  const mission = createMission();
  mission.setMode('sun');
  mission.setCamera(true);
  let view = mission.snapshot();
  for (let step = 0; step < 40; step += 1) view = mission.step(0.05);
  assert.equal(view.images, 1);
  mission.setMode('nadir');
  for (let step = 0; step < 20; step += 1) view = mission.step(0.05);
  assert.equal(view.images, 2);
});
