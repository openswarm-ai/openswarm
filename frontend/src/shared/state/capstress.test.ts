import { test } from 'node:test';
import assert from 'node:assert/strict';
import reducer, { reconcileSessions, removeCard, bringToFront } from '@/shared/state/dashboardLayoutSlice';

function seed(n: number) {
  let s: any = reducer(undefined, { type: '@@init' });
  const want: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < n; i++) {
    const id = 'c' + i, x = 100 + i * 31, y = 200 + i * 17;
    want[id] = { x, y };
    s = reducer(s, { type: 'dashboardLayout/placeCard',
      payload: { sessionId: id, x, y, width: 480, height: 280, expandedSessionIds: [], exact: true } });
  }
  return { s, want, ids: Object.keys(s.cards) };
}
const lost = (s: any, ids: string[], want: any) =>
  ids.filter((id) => !s.cards[id] || s.cards[id].x !== want[id].x || s.cards[id].y !== want[id].y).length;

test('STRESS: flaky backend, 30 strip/restore cycles on a 200-card board', () => {
  const { s, want, ids } = seed(200);
  let cur: any = s;
  for (let r = 0; r < 30; r++) {
    cur = reducer(cur, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
    cur = reducer(cur, reconcileSessions({ sessionIds: ids, expandedSessionIds: [] }));
  }
  console.log(`    200 cards, 30 flaps -> lost=${lost(cur, ids, want)} closedPos=${Object.keys(cur.closedCardPositions).length}`);
  assert.equal(lost(cur, ids, want), 0);
});

test('STRESS: half the board vanishes and returns, repeatedly', () => {
  const { s, want, ids } = seed(120);
  const half = ids.slice(0, 60);
  let cur: any = s;
  for (let r = 0; r < 40; r++) {
    cur = reducer(cur, reconcileSessions({ sessionIds: ids.slice(60), expandedSessionIds: [] }));
    cur = reducer(cur, reconcileSessions({ sessionIds: ids, expandedSessionIds: [] }));
  }
  console.log(`    120 cards, 40 half-flaps -> lost=${lost(cur, ids, want)} closedPos=${Object.keys(cur.closedCardPositions).length}`);
  assert.equal(lost(cur, ids, want), 0);
});

test('STRESS: long life, 3000 distinct cards churned, map stays bounded', () => {
  let cur: any = reducer(undefined, { type: '@@init' });
  for (let i = 0; i < 3000; i++) {
    cur = reducer(cur, { type: 'dashboardLayout/placeCard',
      payload: { sessionId: 'z' + i, x: i, y: i, width: 480, height: 280, expandedSessionIds: [] } });
    cur = reducer(cur, bringToFront({ id: 'z' + i, type: 'agent' }));
    cur = reducer(cur, reconcileSessions({ sessionIds: [], expandedSessionIds: [] }));
  }
  const cp = Object.keys(cur.closedCardPositions).length;
  const zo = Object.keys(cur.zOrders).length;
  console.log(`    3000 cards churned -> closedPos=${cp} zOrders=${zo}`);
  assert.ok(cp <= 1000, `closedCardPositions unbounded at ${cp}`);
  assert.equal(zo, 0, `zOrders leaked ${zo} entries`);
});

test('STRESS: mixed usage, explicit close + reconcile + refocus interleaved', () => {
  // An EXPLICIT close (you pressed X) deliberately does not record a position, unlike a session
  // vanishing, so a card resurrected afterwards lands in a fresh cell BY DESIGN. This asserts the
  // invariant that actually matters here (no card is lost) and prints the position count without
  // asserting it, because asserting 0 would encode a behaviour we do not want. The first version of
  // this test asserted only presence while printing lostSpot=25, i.e. it would have stayed green
  // through a real scattering regression; the split is the point.
  const { s, want, ids } = seed(80);
  let cur: any = s;
  for (let r = 0; r < 25; r++) {
    cur = reducer(cur, bringToFront({ id: ids[r % ids.length], type: 'agent' }));
    cur = reducer(cur, removeCard(ids[r % ids.length]));
    cur = reducer(cur, reconcileSessions({ sessionIds: ids, expandedSessionIds: [] }));
  }
  const survivors = ids.filter((id) => cur.cards[id]);
  const moved = lost(cur, ids, want);
  console.log(`    80 cards, 25 explicit close+resurrect -> present=${survivors.length} movedByDesign=${moved}`);
  assert.equal(survivors.length, 80, 'cards went missing under mixed usage');
  assert.ok(moved <= 25, `${moved} cards moved, more than the 25 that were explicitly closed`);
});
