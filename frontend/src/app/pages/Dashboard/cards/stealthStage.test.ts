import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stealthStage, STEALTH_MARGIN_PX } from './stealthStage';

// The layer sits at (-1400, -300) on screen with the camera at zoom 0.5: the card must land at the
// viewport's top-left corner at screen size, whatever the camera is doing.
test('the stage lands inside the viewport at screen scale for any camera', () => {
  const s = stealthStage({ left: -1400, top: -300 }, 0.5, 900, 600, 1400, 900);
  // screen x = layer.left + left * zoom
  assert.equal(-1400 + s.left * 0.5, STEALTH_MARGIN_PX);
  assert.equal(-300 + s.top * 0.5, STEALTH_MARGIN_PX);
  // screen width = displayW * scale * zoom
  assert.equal(Math.round(900 * s.scale * 0.5), 900);
});

test('a card larger than the window shrinks to fit so at least 80 px of it composites', () => {
  const s = stealthStage({ left: 0, top: 0 }, 1, 2000, 1400, 1400, 900);
  assert.ok(2000 * s.scale <= 1400 - 2 * STEALTH_MARGIN_PX);
  assert.ok(1400 * s.scale <= 900 - 2 * STEALTH_MARGIN_PX);
  assert.ok(2000 * s.scale >= 80 && 1400 * s.scale >= 80);
});

test('a zero zoom never divides by zero', () => {
  const s = stealthStage({ left: 0, top: 0 }, 0, 900, 600, 1400, 900);
  assert.ok(Number.isFinite(s.left) && Number.isFinite(s.scale));
});
