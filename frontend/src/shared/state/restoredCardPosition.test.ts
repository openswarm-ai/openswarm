// Run: npm test (frontend/scripts/run-tests.mjs)
//
// Haik: "expanding a minimized card should use the same best-position placement logic that runs for
// every other spawning card" — it respawned into its original slot even when the layout had shifted
// under it, so it landed on top of whatever had moved in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoredCardPosition, type Rect } from './restoredCardPosition.ts';

const CARD: Rect = { x: 100, y: 100, w: 300, h: 200 };
// Stand-in for findOpenSpotNear: answers with a fixed marker so a reflow is unmistakable.
const SPOT = (x: number, y: number): { x: number; y: number } => ({ x: x + 999, y: y + 999 });

test('a card whose old spot is still free comes back exactly where it was left', () => {
  const far: Rect[] = [{ x: 900, y: 900, w: 100, h: 100 }];
  assert.deepEqual(restoredCardPosition(CARD, far, SPOT), { x: 100, y: 100 });
});

test('a card whose old spot is now taken reflows instead of landing on top', () => {
  const onTop: Rect[] = [{ x: 150, y: 150, w: 300, h: 200 }];
  const got = restoredCardPosition(CARD, onTop, SPOT);
  assert.deepEqual(got, { x: 1099, y: 1099 }, 'restored onto an occupied slot');
});

test('the reflow is anchored on the old position, so the card stays near where it was parked', () => {
  const onTop: Rect[] = [{ x: 150, y: 150, w: 300, h: 200 }];
  const calls: number[][] = [];
  restoredCardPosition(CARD, onTop, (x, y) => { calls.push([x, y]); return { x, y }; });
  assert.deepEqual(calls, [[100, 100]], 'searched from somewhere other than the parked spot');
});

test('edge contact is not an overlap, so touching cards do not trigger a pointless move', () => {
  const flush: Rect[] = [{ x: 400, y: 100, w: 100, h: 200 }]; // starts exactly where CARD ends
  assert.deepEqual(restoredCardPosition(CARD, flush, SPOT), { x: 100, y: 100 });
});

test('an empty board never reflows', () => {
  assert.deepEqual(restoredCardPosition(CARD, [], SPOT), { x: 100, y: 100 });
});
