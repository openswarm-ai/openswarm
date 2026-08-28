import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_WINDOW_SELECTOR, CANVAS_OWNER, GESTURE_GAP_MS, heldBy, WheelGesture } from './wheelGestureOwner';

// Node is a DOM global the rule reads through `instanceof`; the runner has no DOM, so stand one up.
class FakeNode {}
(globalThis as { Node?: unknown }).Node = FakeNode;

// A stand-in for the app-window element. contains() answers for its own subtree only, which is the
// only DOM behaviour this rule reads.
function panel(connected = true) {
  const inside = new FakeNode() as unknown as Node;
  const el = {
    isConnected: connected,
    contains: (n: unknown) => n === inside || n === el,
  } as unknown as HTMLElement;
  return { el, inside };
}

test('a pan the canvas owns survives drifting over an app window', () => {
  const gesture: WheelGesture = { owner: CANVAS_OWNER, at: 1_000 };
  const { inside } = panel();
  assert.equal(heldBy(gesture, 1_016, false, inside), CANVAS_OWNER);
});

test('a scroll a panel owns survives reaching the panel end', () => {
  const { el, inside } = panel();
  const gesture: WheelGesture = { owner: el, at: 1_000 };
  assert.equal(heldBy(gesture, 1_016, false, inside), el);
});

test('a fresh gesture over a panel is up for grabs, so the panel can claim it', () => {
  const gesture: WheelGesture = { owner: CANVAS_OWNER, at: 1_000 };
  const { inside } = panel();
  assert.equal(heldBy(gesture, 1_000 + GESTURE_GAP_MS, false, inside), null);
});

test('a zoom is exempt on every surface, and claims nothing', () => {
  const { el, inside } = panel();
  assert.equal(heldBy({ owner: el, at: 1_000 }, 1_016, true, inside), null);
  assert.equal(heldBy({ owner: CANVAS_OWNER, at: 1_000 }, 1_016, true, inside), null);
});

test('a panel that left the DOM mid-gesture releases it instead of wedging the wheel', () => {
  const { el, inside } = panel(false);
  assert.equal(heldBy({ owner: el, at: 1_000 }, 1_016, false, inside), null);
});

test('a panel only holds the pointer while it is still under it', () => {
  const { el } = panel();
  const elsewhere = new FakeNode() as unknown as Node;
  assert.equal(heldBy({ owner: el, at: 1_000 }, 1_016, false, elsewhere), null);
});

test('nothing owns a gesture before one starts', () => {
  assert.equal(heldBy({ owner: null, at: 0 }, 1_000, false, null), null);
});

test('the app-window selector names each window type exactly', () => {
  for (const t of ['settings-card', 'marketplace-card', 'workflows-hub-card']) {
    assert.ok(APP_WINDOW_SELECTOR.includes(`[data-select-type="${t}"]`), `missing ${t}`);
  }
});

test('it never degrades to the attribute-only selector any descendant matches', () => {
  const parts = APP_WINDOW_SELECTOR.split(',').map((p) => p.trim());
  assert.ok(!parts.includes('[data-select-type]'));
  // The row tag that used to shadow the window from over every setting.
  assert.ok(!parts.includes('[data-select-type="settings-option"]'));
  assert.ok(parts.includes('[data-select-type="settings-card"]'));
});
