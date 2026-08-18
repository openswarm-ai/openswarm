// Step-6 gate (AGENTCHAT_SPLIT_PLAN §6): the windowing solver internals behind useMessageScroll are
// pure functions over explicit inputs, so the hysteresis + follow-the-tail window rules pin down here
// (the rAF pinning side is real-app-verified; jsdom has no layout).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_ITEM_ESTIMATED_HEIGHT } from '../windowing/messageWindow';
import {
  measureMountedHeights,
  nextWindowForItems,
  reservedHeightFor,
  solveWindowFromScroll,
  sumReservedHeights,
} from './windowingCore';
import type { RenderItem } from '../tool-bubbles/ToolGroupBubble';

const msg = (id: string): RenderItem =>
  ({ id, role: 'assistant', content: 'x'.repeat(40), branch_id: 'main' }) as unknown as RenderItem;

// A fake scroll container: the solver only reads scrollTop/clientHeight.
const el = (scrollTop: number, clientHeight: number) => ({ scrollTop, clientHeight }) as HTMLElement;
const flat100 = () => 100; // every item 100px tall

describe('reservedHeightFor', () => {
  test('measured height wins over the estimate and the fallback', () => {
    const measured = new Map([['a', 77]]);
    assert.equal(reservedHeightFor(msg('a'), measured, new Map(), 800), 77);
    assert.equal(reservedHeightFor(undefined, measured, new Map(), 800), RENDER_ITEM_ESTIMATED_HEIGHT);
  });

  test('estimates are computed once and cached per id', () => {
    const estimates = new Map<string, number>();
    const first = reservedHeightFor(msg('a'), new Map(), estimates, 800);
    estimates.set('a', 999); // poke the cache to prove the second call reads it
    assert.equal(reservedHeightFor(msg('a'), new Map(), estimates, 800), 999);
    assert.ok(first > 0);
  });
});

test('sumReservedHeights sums [from, to) through the reserve fn', () => {
  const items = [msg('a'), msg('b'), msg('c')];
  assert.equal(sumReservedHeights(items, 0, 2, () => 10), 20);
  assert.equal(sumReservedHeights(items, 2, 2, () => 10), 0);
});

describe('solveWindowFromScroll', () => {
  // clientHeight 500 → tight buffer 1500px, loose 2000px. 100 flat-100px items.
  test('returns null when the window is already correct (no churn)', () => {
    assert.equal(solveWindowFromScroll(el(0, 500), 100, 0, 20, false, flat100), null);
  });

  test('hysteresis: an already-mounted edge inside the loose band is kept', () => {
    // curEnd 23 sits past the tight end (20) but inside loose (25): unchanged → null, no flip-flop.
    assert.equal(solveWindowFromScroll(el(0, 500), 100, 0, 23, false, flat100), null);
  });

  test('following pins the window end to the newest item', () => {
    assert.deepEqual(solveWindowFromScroll(el(0, 500), 100, 0, 20, true, flat100), { start: 0, end: 100 });
  });

  test('scrolling to the middle slides the window to the viewport band', () => {
    assert.deepEqual(solveWindowFromScroll(el(5000, 500), 100, 0, 20, false, flat100), { start: 30, end: 70 });
  });
});

describe('nextWindowForItems', () => {
  test('following keeps the newest item and seeds a bounded recent slice', () => {
    const next = nextWindowForItems(100, 500, 0, 0, true);
    assert.equal(next.end, 100);
    assert.ok(next.start > 0); // bounded, not the whole transcript
    assert.ok(next.start < 100);
  });

  test('scrolled up only clamps the existing window against the new length', () => {
    assert.deepEqual(nextWindowForItems(40, 500, 10, 50, false), { start: 10, end: 40 });
  });
});

test('measureMountedHeights records offsetHeights and reports change once (converges)', () => {
  // The function reads only querySelectorAll / dataset / offsetHeight, so a structural stand-in
  // keeps the case DOM-free under node:test.
  const child = { dataset: { windowItemId: 'a' }, offsetHeight: 120 };
  const container = { querySelectorAll: () => [child] } as unknown as HTMLElement;
  const measured = new Map<string, number>();
  assert.equal(measureMountedHeights(container, measured), true);
  assert.equal(measured.get('a'), 120);
  // Same heights again: no change reported, so the caller's version bump converges.
  assert.equal(measureMountedHeights(container, measured), false);
});
