// The zoom/scroll toggle's 3rd field report: physical wheels did nothing different when the
// setting flipped, while every synthetic harness verification passed. Gap = this classifier:
// macOS wheel acceleration emits NON-INTEGER deltaY for real notches, and the old rule sent any
// fractional delta to the trackpad branch (always pan) regardless of size. Synthetic wheels have
// integer deltas, so harnesses could never see it. These pin the traces for both device families.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWheelDevice } from './classifyWheelDevice';

const TRACKPAD = true;
const MOUSE = false;

test('synthetic harness wheel (integer, legacy 120-multiple): mouse', () => {
  assert.equal(classifyWheelDevice({ deltaMode: 0, wheelDeltaY: -120 }, 0, 40), MOUSE);
});

test('accelerated physical wheel notch (large FRACTIONAL deltaY): mouse — the 3rd-report fix', () => {
  // Magic Mouse / Logitech smooth scrolling: wheelDeltaY not a 120-multiple, deltaY fractional.
  assert.equal(classifyWheelDevice({ deltaMode: 0, wheelDeltaY: -173 }, 0, 57.999755859375), MOUSE);
  assert.equal(classifyWheelDevice({ deltaMode: 0 }, 0, 88.5), MOUSE);
});

test('two-finger trackpad drift (small fractional, dx jitter): trackpad', () => {
  assert.equal(classifyWheelDevice({ deltaMode: 0, wheelDeltaY: -9 }, 0.5, 3.2), TRACKPAD);
  assert.equal(classifyWheelDevice({ deltaMode: 0 }, 0, 2.75), TRACKPAD);
});

test('slow trackpad vertical-only small integers stay trackpad (old conservative verdict)', () => {
  assert.equal(classifyWheelDevice({ deltaMode: 0, wheelDeltaY: -9 }, 0, 3), TRACKPAD);
});

test('line-mode deltas (Windows wheel config) are mouse', () => {
  assert.equal(classifyWheelDevice({ deltaMode: 1 }, 0, 3), MOUSE);
});

test('any sideways component is fingers on glass', () => {
  assert.equal(classifyWheelDevice({ deltaMode: 0 }, 12, 80), TRACKPAD);
});
