// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// closedCardPositions remembers where a closed card sat so reopening drops it back in place. Nothing
// pruned it and it is persisted, so it grew forever: 0 -> 555 across 250 clean lifecycles, measured.
// Capping it is right, but the cap has a sharp edge worth pinning: a transient empty answer
// reconciles EVERY card away at once and the restore reads these back, so a cap below the board size
// silently scatters the overflow into fresh grid cells. At a cap of 50, a 60-card board lost exactly
// 10 cards. That is the regression these tests exist to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import reducer, { reconcileSessions } from './dashboardLayoutSlice.ts';

function board(n: number) {
  let s: any = reducer(undefined, { type: '@@init' });
  const want: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < n; i++) {
    const id = 'c' + i, x = 100 + i * 37, y = 200 + i * 11;
    want[id] = { x, y };
    s = reducer(s, { type: 'dashboardLayout/placeCard',
      payload: { sessionId: id, x, y, width: 480, height: 280, expandedSessionIds: [], exact: true } });
  }
  return { s, want, ids: Object.keys(s.cards) };
}

test('a card that vanishes and comes back lands exactly where it was', () => {
  // Note which path remembers: reconcileSessions (the session went away) records the position, an
  // explicit removeCard (you pressed close) deliberately does not. Testing the wrong one reads as a
  // product bug when it is just a different intent.
  const { s, want } = board(1);
  let next: any = reducer(s, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
  next = reducer(next, reconcileSessions({ sessionIds: ['c0'], expandedSessionIds: [] }));
  assert.equal(next.cards.c0.x, want.c0.x);
  assert.equal(next.cards.c0.y, want.c0.y);
});

test('a whole big board survives a strip-and-restore with every spot intact', () => {
  // The failure this pins: 60 cards, cap 50, 10 land in fresh grid cells instead of home.
  const N = 60;
  const { s, want, ids } = board(N);
  let next: any = reducer(s, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
  next = reducer(next, reconcileSessions({ sessionIds: ids, expandedSessionIds: [] }));
  const moved = ids.filter((id) => next.cards[id].x !== want[id].x || next.cards[id].y !== want[id].y);
  assert.equal(moved.length, 0, `${moved.length} of ${N} cards lost their saved position`);
});

test('the map is still BOUNDED, so the leak cannot come back', () => {
  // Close far more cards than any real board to prove the cap engages at all.
  let s: any = reducer(undefined, { type: '@@init' });
  for (let i = 0; i < 1400; i++) {
    s = reducer(s, { type: 'dashboardLayout/placeCard',
      payload: { sessionId: 'x' + i, x: i, y: i, width: 480, height: 280, expandedSessionIds: [] } });
    s = reducer(s, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
  }
  const kept = Object.keys(s.closedCardPositions).length;
  assert.ok(kept <= 1000, `closedCardPositions grew to ${kept}, cap not engaging`);
  assert.ok(kept > 500, `cap is too tight at ${kept}; a real board would lose spots`);
});

test('a card that vanishes twice keeps ONE entry, refreshed, not two', () => {
  const { s } = board(1);
  let next: any = reducer(s, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
  const first = Object.keys(next.closedCardPositions).length;
  next = reducer(next, reconcileSessions({ sessionIds: ['c0'], expandedSessionIds: [] }));
  next = reducer(next, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
  assert.equal(Object.keys(next.closedCardPositions).length, first, 'a re-close duplicated the entry');
});
