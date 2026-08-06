import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepSecondsFor, ROOM_MAX_PLAYERS } from './constants.js';

test('prep timer encolhe conforme jogadores morrem', () => {
  assert.equal(prepSecondsFor(15), 30);
  assert.equal(prepSecondsFor(5), 20);
  assert.equal(prepSecondsFor(2), 15);
  assert.equal(prepSecondsFor(1), 15);
});

test('limite de sala e 15', () => {
  assert.equal(ROOM_MAX_PLAYERS, 15);
});
