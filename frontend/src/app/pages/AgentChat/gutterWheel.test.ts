// Run: npm test (frontend/scripts/run-tests.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldForwardGutterWheel } from './gutterWheel.ts';

const base = { ctrlKey: false, metaKey: false, deltaX: 0, deltaY: 40, targetIsGutter: true };

test('a plain vertical wheel on the bare gutter forwards', () => {
  assert.equal(shouldForwardGutterWheel(base), true);
  assert.equal(shouldForwardGutterWheel({ ...base, deltaY: -40 }), true);
});

test('anything inside the column keeps its own scroll (no double-scroll)', () => {
  assert.equal(shouldForwardGutterWheel({ ...base, targetIsGutter: false }), false);
});

test('pinch-zoom stays free on every surface', () => {
  assert.equal(shouldForwardGutterWheel({ ...base, ctrlKey: true }), false);
  assert.equal(shouldForwardGutterWheel({ ...base, metaKey: true }), false);
});

test('horizontal-dominant gestures pass through to the canvas', () => {
  assert.equal(shouldForwardGutterWheel({ ...base, deltaX: 80, deltaY: 10 }), false);
});
