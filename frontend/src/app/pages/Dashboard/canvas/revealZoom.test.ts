// Run: cd frontend && npx tsx --test src/app/pages/Dashboard/canvas/revealZoom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealZoom, REVEAL_MIN_ZOOM } from './revealZoom.ts';

const MIN = 0.15, MAX = 3.0;

test('a spawn never zooms IN, which is the behaviour worth keeping', () => {
  assert.equal(revealZoom(0.8, 2.0, MIN, MAX), 0.8);
});

test('it still zooms out when the card genuinely does not fit', () => {
  assert.equal(revealZoom(1.0, 0.7, MIN, MAX), 0.7);
});

test('but never below readable, which is the bug', () => {
  assert.equal(revealZoom(1.0, 0.05, MIN, MAX), REVEAL_MIN_ZOOM);
  assert.equal(revealZoom(0.6, 0.18, MIN, MAX), REVEAL_MIN_ZOOM);
});

test('the measured death spiral bottoms out instead of reaching 18%', () => {
  // Replays the real session: each step is a reveal whose fit was tighter than the last.
  let z = 1.0;
  for (const fit of [0.88, 0.79, 0.76, 0.61, 0.36, 0.34, 0.18]) z = revealZoom(z, fit, MIN, MAX);
  assert.equal(z, REVEAL_MIN_ZOOM);
  assert.ok(z >= REVEAL_MIN_ZOOM, 'must not ratchet past the floor no matter how many spawns');
});

test('a camera the user already zoomed out by hand is left alone', () => {
  // Below the floor already: the reveal must not yank them back IN, that would fight the user.
  assert.equal(revealZoom(0.2, 0.9, MIN, MAX), 0.2);
});

test('it respects the hard bounds', () => {
  assert.equal(revealZoom(5.0, 9.0, MIN, MAX), MAX);
});
