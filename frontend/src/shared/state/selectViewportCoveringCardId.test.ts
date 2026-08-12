// Run: node --test frontend/src/shared/state/selectViewportCoveringCardId.test.ts
//
// The canvas hides its floating chrome when a card owns the screen. That used to be keyed on the
// 'fullscreen' zone alone, but TILE_ZONES also has `fill`, which covers the whole viewport and is a
// different string. Measured live before the fix: 4 controls (minimap, Tidy layout, Zoom out, Zoom
// in) sitting on top of a filled card, versus 0 on a fullscreen one. These pin the predicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectViewportCoveringCardId, selectFullscreenCardId } from './dashboardLayoutSlice.ts';

function stateWith(tiledCards: Record<string, string>, extra: Record<string, unknown> = {}): any {
  return {
    dashboardLayout: {
      tiledCards,
      minimizedCards: {},
      cards: { chat1: { x: 0, y: 0, width: 480, height: 300 } },
      viewCards: {}, browserCards: {}, workflowCards: {},
      workflowsHub: null, settingsCard: null, marketplaceCard: null, workflowsMonitorCard: null,
      ...extra,
    },
  };
}

test('a fullscreen card owns the screen', () => {
  assert.equal(selectViewportCoveringCardId(stateWith({ chat1: 'fullscreen' })), 'chat1');
});

test('a FILLED card owns the screen too, which is the whole bug', () => {
  assert.equal(selectViewportCoveringCardId(stateWith({ chat1: 'fill' })), 'chat1');
});

test('a half-screen tile does not own the screen, so chrome stays', () => {
  for (const zone of ['left', 'right', 'top', 'bottom', 'tl', 'tr', 'bl', 'br', 't3l', 't3c', 't3r']) {
    assert.equal(selectViewportCoveringCardId(stateWith({ chat1: zone })), null, `zone ${zone}`);
  }
});

test('nothing tiled means nothing owns the screen', () => {
  assert.equal(selectViewportCoveringCardId(stateWith({})), null);
});

test('a minimized card cannot own the screen', () => {
  const s = stateWith({ chat1: 'fill' }, { minimizedCards: { chat1: true } });
  assert.equal(selectViewportCoveringCardId(s), null);
});

test('a tile whose card is gone cannot own the screen', () => {
  const s = stateWith({ ghost: 'fill' });
  assert.equal(selectViewportCoveringCardId(s), null);
});

test('the Run Monitor counts as a real tile owner', () => {
  // It was missing from tileOwnerExists, so its fullscreen read as "owner gone" and left the canvas
  // chrome on top of it. Latent today (no tiling UI on that card) but a hole in a load-bearing check.
  const s = stateWith({ 'workflows-monitor': 'fullscreen' },
    { workflowsMonitorCard: { x: 0, y: 0, width: 900, height: 600, zOrder: 1 } });
  assert.equal(selectViewportCoveringCardId(s), 'workflows-monitor');
  assert.equal(selectFullscreenCardId(s), 'workflows-monitor');
});

test('fullscreen and covering stay different questions', () => {
  // Only chrome-hiding should treat `fill` as fullscreen; window buttons and the exit pill must not.
  const filled = stateWith({ chat1: 'fill' });
  assert.equal(selectViewportCoveringCardId(filled), 'chat1');
  assert.equal(selectFullscreenCardId(filled), null);
});
