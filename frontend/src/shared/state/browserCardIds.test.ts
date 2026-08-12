// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// addBrowserCard built its id from Date.now() alone, so two cards created inside the same
// millisecond got the SAME id and the second silently overwrote the first. Found by a fixture that
// added two browsers and only ever saw one; the earlier surface census confirmed it in the wild
// (adding 8 browsers in a loop produced 6). generateTabId, three lines above in the same file,
// already carried the randomness this did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import reducer, { addBrowserCard } from './dashboardLayoutSlice.ts';

function addN(n: number): string[] {
  let s = reducer(undefined, { type: '@@init' }) as any;
  for (let i = 0; i < n; i++) {
    s = reducer(s, addBrowserCard({ url: 'about:blank', expandedSessionIds: [], x: i * 100, y: 0 }));
  }
  return Object.keys(s.browserCards);
}

test('every browser opened in a burst survives', () => {
  // Synchronous dispatches land in the same millisecond, which is exactly the collision window.
  const ids = addN(8);
  assert.equal(ids.length, 8, `expected 8 browser cards, kept ${ids.length}`);
});

test('their ids are distinct', () => {
  const ids = addN(20);
  assert.equal(new Set(ids).size, 20, 'duplicate browser card ids');
});

test('each keeps the position it was given, so none is a silent overwrite of another', () => {
  let s = reducer(undefined, { type: '@@init' }) as any;
  s = reducer(s, addBrowserCard({ url: 'about:blank', expandedSessionIds: [], x: 111, y: 0 }));
  s = reducer(s, addBrowserCard({ url: 'about:blank', expandedSessionIds: [], x: 222, y: 0 }));
  const xs = Object.values(s.browserCards).map((b: any) => b.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [111, 222]);
});
