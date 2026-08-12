// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// zOrders had three writers and no deleter, so every card ever brought to front stayed in it for the
// life of the board, and it is PERSISTED: each dead entry rode every layout save to disk and back on
// every fetch. Tiny per row, unbounded over a long session, which is exactly the compounding class.
//
// Note on the fixtures: bringToFront deliberately no-ops when a card is ALREADY on top (it would
// otherwise churn the layout on every click), so a one-card board never writes a zOrders entry at
// all. Every case here places a second card first, which is what makes the focus real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import reducer, { removeCard, removeViewCard, removeBrowserCard, bringToFront, reconcileSessions } from './dashboardLayoutSlice.ts';

const place = (s: any, id: string, x = 0) => reducer(s, { type: 'dashboardLayout/placeCard',
  payload: { sessionId: id, x, y: 0, width: 480, height: 280, expandedSessionIds: [] } });

/** Two chats, then focus the BOTTOM one so bringToFront actually writes. */
function twoCardsFocusFirst(): any {
  let s = reducer(undefined, { type: '@@init' }) as any;
  s = place(s, 's1', 0);
  s = place(s, 's2', 600);
  s = reducer(s, bringToFront({ id: 's1', type: 'agent' })) as any;
  return s;
}

test('focusing a card that is not on top writes a zOrder entry', () => {
  assert.ok(twoCardsFocusFirst().zOrders.s1 !== undefined, 'fixture never armed the leak');
});

test('removeCard prunes it', () => {
  const s = reducer(twoCardsFocusFirst(), removeCard('s1')) as any;
  assert.equal(s.zOrders.s1, undefined, 'a closed chat left its zOrder behind');
});

test('reconcileSessions prunes it for cards the server no longer has', () => {
  const s = reducer(twoCardsFocusFirst(), reconcileSessions({ sessionIds: [], expandedSessionIds: [] })) as any;
  assert.equal(s.zOrders.s1, undefined, 'a reconciled-away card left its zOrder behind');
});

test('closing an app prunes its zOrder', () => {
  let s = reducer(undefined, { type: '@@init' }) as any;
  s = reducer(s, { type: 'dashboardLayout/addViewCard', payload: { outputId: 'v1', expandedSessionIds: [], x: 0, y: 0 } });
  s = reducer(s, { type: 'dashboardLayout/addViewCard', payload: { outputId: 'v2', expandedSessionIds: [], x: 900, y: 0 } });
  s = reducer(s, bringToFront({ id: 'v1', type: 'view' })) as any;
  assert.ok(s.zOrders.v1 !== undefined, 'fixture never armed the leak');
  s = reducer(s, removeViewCard('v1')) as any;
  assert.equal(s.zOrders.v1, undefined, 'a closed app left its zOrder behind');
});

test('closing a browser prunes its zOrder', () => {
  let s = reducer(undefined, { type: '@@init' }) as any;
  s = reducer(s, { type: 'dashboardLayout/addBrowserCard', payload: { url: 'about:blank', expandedSessionIds: [], x: 0, y: 0 } });
  const first = Object.keys(s.browserCards)[0];
  s = reducer(s, { type: 'dashboardLayout/addBrowserCard', payload: { url: 'about:blank', expandedSessionIds: [], x: 1400, y: 0 } });
  s = reducer(s, bringToFront({ id: first, type: 'browser' })) as any;
  assert.ok(s.zOrders[first] !== undefined, 'fixture never armed the leak');
  s = reducer(s, removeBrowserCard(first)) as any;
  assert.equal(s.zOrders[first], undefined, 'a closed browser left its zOrder behind');
});

test('the prune is targeted: closing one card keeps another card z-order', () => {
  let s = twoCardsFocusFirst();
  s = reducer(s, bringToFront({ id: 's2', type: 'agent' })) as any;
  assert.ok(s.zOrders.s2 !== undefined);
  s = reducer(s, removeCard('s1')) as any;
  assert.equal(s.zOrders.s1, undefined);
  assert.ok(s.zOrders.s2 !== undefined, 'pruning one card clobbered another card z-order');
});
