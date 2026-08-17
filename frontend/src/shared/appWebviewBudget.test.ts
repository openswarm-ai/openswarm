// Run: node --test frontend/src/shared/appWebviewBudget.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestAppSlot,
  releaseAppSlot,
  wireBrowserLiveCounter,
  totalLiveGuests,
  MAX_LIVE_APP_WEBVIEWS as MAX,
} from './appWebviewBudget.ts';

// The module holds shared state, so every test fills, asserts, then releases its own keys to leave a clean slate.
function fill(prefix: string, n: number, basePriority: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = `${prefix}${i}`;
    assert.equal(requestAppSlot(k, basePriority + i, false), true, `slot ${i} should be granted below cap`);
    keys.push(k);
  }
  return keys;
}
function release(keys: string[]): void {
  for (const k of keys) releaseAppSlot(k);
}

test('grants every request below the cap', () => {
  const keys = fill('a', MAX, 10);
  release(keys);
});

test('denies a farther card once the cap is full', () => {
  const keys = fill('b', MAX, 10);
  assert.equal(requestAppSlot('b-far', 9999, false), false, 'a card farther than all live cards is denied');
  release([...keys, 'b-far']);
});

// Cooldown + margin guard the evictions now; tests age the grants by shifting the module's clock.
function aged<T>(fn: () => T): T {
  const realNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => realNow() + 60_000;
  try { return fn(); } finally { (Date as unknown as { now: () => number }).now = realNow; }
}

test('a MEANINGFULLY closer card evicts the farthest once grants have aged', () => {
  const keys = fill('c', MAX, 100); // priorities 100..100+MAX-1; farthest is the last
  aged(() => {
    assert.equal(requestAppSlot('c-near', 1, false), true, 'a much closer card takes a slot by eviction');
    const evicted = `c${MAX - 1}`;
    assert.equal(requestAppSlot(evicted, 100 + MAX - 1, false), false, 'the evicted farthest card cannot re-enter');
  });
  release([...keys, 'c-near']);
});

test('anti-flap: fresh grants are cooldown-protected from eviction', () => {
  const keys = fill('f', MAX, 100);
  assert.equal(requestAppSlot('f-near', 1, false), false, 'even a closer card cannot boot a slot granted seconds ago');
  release([...keys, 'f-near']);
});

test('anti-flap: near-equal priorities never steal the slot (the zoom-out storm)', () => {
  const keys = fill('g', MAX, 100); // worst has priority 100+MAX-1
  aged(() => {
    // 10% closer is inside the 20% margin: denied, no reboot.
    assert.equal(requestAppSlot('g-near', Math.round((100 + MAX - 1) * 0.9), false), false,
      'a card only slightly closer must not reboot a live webview');
    // 30% closer clears the margin: granted.
    assert.equal(requestAppSlot('g-vnear', Math.round((100 + MAX - 1) * 0.7), false), true);
  });
  // Outside aged(): real clock, the winner's grant is seconds old, so a challenger CLOSER than the
  // winner cannot steal it back (it is cooldown-protected and every older slot fails the margin).
  assert.equal(requestAppSlot('g-steal', 1, false), false, 'no immediate counter-steal: the oscillation is dead');
  release([...keys, 'g-near', 'g-vnear', 'g-steal']);
});

test('pinned cards bypass the cap and are never evicted', () => {
  const keys = fill('d', MAX, 10);
  assert.equal(requestAppSlot('d-pin', 0, true), true, 'pinned card is admitted past a full cap');
  // A pinned card does not consume an evictable slot, so an unpinned farther card is still denied.
  assert.equal(requestAppSlot('d-far', 9999, false), false, 'unpinned farther card still denied with a pin present');
  // Another pin also admitted.
  assert.equal(requestAppSlot('d-pin2', 0, true), true, 'second pinned card also admitted');
  release([...keys, 'd-pin', 'd-pin2', 'd-far']);
});

test('releasing a slot lets a previously-denied card in', () => {
  const keys = fill('e', MAX, 10);
  assert.equal(requestAppSlot('e-wait', 9999, false), false, 'denied while full');
  releaseAppSlot(keys[0]);
  assert.equal(requestAppSlot('e-wait', 9999, false), true, 'admitted after a slot frees');
  release([keys[1], keys[2], keys[3], keys[4], keys[5], 'e-wait'].filter(Boolean));
});

test('re-requesting an already-live card just updates it, no extra slot', () => {
  const keys = fill('f', MAX, 10);
  assert.equal(requestAppSlot(keys[0], 5, false), true, 'existing card re-request is idempotent');
  assert.equal(requestAppSlot('f-far', 9999, false), false, 'still full after a re-request');
  release([...keys, 'f-far']);
});

test('the global ceiling counts browsers and apps together', () => {
  // 8 live browsers reported: only 2 of the 6 app slots may actually go live.
  wireBrowserLiveCounter(() => 8);
  const keys: string[] = [];
  let granted = 0;
  for (let i = 0; i < 6; i++) {
    const k = `g${i}`;
    if (requestAppSlot(k, i, false)) { granted++; keys.push(k); }
  }
  assert.equal(granted, 2, `apps must stop at the global ceiling, granted ${granted}`);
  assert.equal(totalLiveGuests(), 10);
  wireBrowserLiveCounter(() => 0);
  keys.forEach(releaseAppSlot);
});

test('pinned cards ignore the global ceiling, a working agent is never throttled', () => {
  wireBrowserLiveCounter(() => 99);
  assert.equal(requestAppSlot('pinned-work', 0, true), true);
  wireBrowserLiveCounter(() => 0);
  releaseAppSlot('pinned-work');
});
