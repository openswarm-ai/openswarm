import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coveredByTiledZones, rectsIntersect } from './spawnPillCover';

// With a chat tiled to the bottom-left quarter, the floating "Ask me anything" pill sat on top of the
// card's own composer, two inputs on one spot (ENG-469). The pill yields to any tile that covers it.
const viewport = { w: 1400, h: 900 };
const fakeZone = (zone: string) => {
  const z: Record<string, { x: number; y: number; w: number; h: number }> = {
    bl: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, tl: { x: 0, y: 0, w: 0.5, h: 0.5 }, right: { x: 0.5, y: 0, w: 0.5, h: 1 },
  };
  const r = z[zone]; return r ? { x: r.x * viewport.w, y: r.y * viewport.h, w: r.w * viewport.w, h: r.h * viewport.h } : null;
};
const pill = { x: 480, y: 830, w: 440, h: 56 };

test('a bottom-left tile covers the pill; a top-left tile does not', () => {
  assert.equal(coveredByTiledZones(['bl'], pill, fakeZone), true);
  assert.equal(coveredByTiledZones(['tl'], pill, fakeZone), false);
});

test('a right-half tile reaches the pill too, an unknown zone is ignored, no tiles means not covered', () => {
  assert.equal(coveredByTiledZones(['right'], pill, fakeZone), true);
  assert.equal(coveredByTiledZones(['nope'], pill, fakeZone), false);
  assert.equal(coveredByTiledZones([], pill, fakeZone), false);
});

test('rectsIntersect is a strict overlap, not a touch', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 }), true);
});
