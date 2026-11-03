'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { median, heatingUp, shareText } = require('../src/discovery');

test('a game heats up only when it is played at least twice as often as the typical active game', () => {
  assert.equal(median([]), 0);
  assert.equal(median([4]), 4);
  assert.equal(median([1, 1, 4]), 1);
  assert.equal(median([4, 1]), 2.5);
  assert.equal(heatingUp(4, 4), false);
  assert.equal(heatingUp(1, 1), false);
  assert.equal(heatingUp(4, 2.5), false);
  assert.equal(heatingUp(4, 1), true);
  assert.equal(heatingUp(6, 2.5), true);
  assert.equal(heatingUp(0, 1), false);
});

test('share lines name the game and stay short enough to paste', () => {
  const url = 'http://127.0.0.1:13000/apps/cubesat';
  assert.equal(
    shareText({ kind: 'moment', appName: 'Cubesat', note: 'Downlinked the first image.', url }),
    'Downlinked the first image. — Cubesat http://127.0.0.1:13000/apps/cubesat'
  );
  assert.equal(
    shareText({ kind: 'review', appName: 'Cubesat', note: 'The pass window is the whole game.', url }),
    'The pass window is the whole game. — review of Cubesat http://127.0.0.1:13000/apps/cubesat'
  );
  assert.equal(
    shareText({ kind: 'playing', appName: 'Snake', url }),
    'Playing Snake on VibeHandoff http://127.0.0.1:13000/apps/cubesat'
  );
  assert.equal(
    shareText({ kind: 'game', appName: 'Snake', creatorName: 'Maya Chen', url }),
    'Maya Chen posted Snake on VibeHandoff http://127.0.0.1:13000/apps/cubesat'
  );
});
