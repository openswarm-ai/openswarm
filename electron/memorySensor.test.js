// The leak detector's math, pinned: a flat session reports nothing, a straight climb is caught.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { slopeMbPerMin, totalMb, GROWTH_MB_PER_MIN } = require('./memorySensor');

test('a flat memory profile has no slope, so nothing is ever reported', () => {
  assert.ok(Math.abs(slopeMbPerMin([900, 905, 898, 902, 900, 903, 899, 901, 900, 902])) < 1, 'jitter is not a trend');
});

test('a steady climb is caught above the growth threshold', () => {
  const climbing = Array.from({ length: 10 }, (_, i) => 800 + i * 60);
  assert.ok(slopeMbPerMin(climbing) >= GROWTH_MB_PER_MIN, 'a 60MB/min climb must exceed the threshold');
});

test('a single spike is not a leak', () => {
  const spike = [900, 900, 900, 900, 2000, 900, 900, 900, 900, 900];
  assert.ok(slopeMbPerMin(spike) < GROWTH_MB_PER_MIN, 'one spike must not read as a trend');
});

test('too few samples never guesses', () => {
  assert.equal(slopeMbPerMin([900, 2000, 3000]), 0);
});

test('totals sum every process in MB', () => {
  assert.equal(totalMb([{ memory: { workingSetSize: 1024 * 500 } }, { memory: { workingSetSize: 1024 * 300 } }]), 800);
  assert.equal(totalMb([{}, { memory: {} }]), 0);
});
