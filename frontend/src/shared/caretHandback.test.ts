// Run: npm test
//
// ENG-252. Measured from control flow: an agent run of N browser commands hands the caret back N
// times, because capture/restore brackets each command. Each one is correct; the user's caret is
// unusable. These tests pin the coalescing that fixes the frequency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleCaretHandback,
  cancelCaretHandback,
  caretHandbackCount,
  resetCaretHandbackCount,
  caretHandbackPending,
  HANDBACK_IDLE_MS,
} from './caretHandback.ts';

// A controllable clock: real timers would make this a sleep test.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const set = ((fn: () => void, ms: number) => { seq += 1; jobs.set(seq, { at: now + ms, fn }); return seq; }) as unknown as typeof setTimeout;
  const clear = ((id: number) => { jobs.delete(id); }) as unknown as typeof clearTimeout;
  const advance = (ms: number) => {
    now += ms;
    for (const [id, j] of [...jobs]) if (j.at <= now) { jobs.delete(id); j.fn(); }
  };
  return { set, clear, advance, pendingJobs: () => jobs.size };
}

test('a run of 20 commands hands the caret back ONCE, not 20 times', () => {
  resetCaretHandbackCount();
  const t = fakeTimers();
  let restored = 0;
  for (let i = 0; i < 20; i += 1) {
    scheduleCaretHandback(() => { restored += 1; }, HANDBACK_IDLE_MS, t.set, t.clear);
    t.advance(50);                       // commands arrive faster than the idle window
  }
  assert.equal(restored, 0, 'handed the caret back mid-run, which is the bug');
  t.advance(HANDBACK_IDLE_MS + 10);
  assert.equal(restored, 1, `handed back ${restored} times for one run`);
  assert.equal(caretHandbackCount(), 1);
});

test('a single command still hands the caret back', () => {
  resetCaretHandbackCount();
  const t = fakeTimers();
  let restored = 0;
  scheduleCaretHandback(() => { restored += 1; }, HANDBACK_IDLE_MS, t.set, t.clear);
  t.advance(HANDBACK_IDLE_MS + 10);
  assert.equal(restored, 1, 'the user must still get their caret back after one command');
});

test('the LATEST restore wins, so a stale captured element is never used', () => {
  resetCaretHandbackCount();
  const t = fakeTimers();
  const order: string[] = [];
  scheduleCaretHandback(() => order.push('first'), HANDBACK_IDLE_MS, t.set, t.clear);
  t.advance(50);
  scheduleCaretHandback(() => order.push('second'), HANDBACK_IDLE_MS, t.set, t.clear);
  t.advance(HANDBACK_IDLE_MS + 10);
  assert.deepEqual(order, ['second'], `ran ${JSON.stringify(order)}`);
});

test('two runs separated by an idle gap hand back twice', () => {
  resetCaretHandbackCount();
  const t = fakeTimers();
  let restored = 0;
  const cmd = () => scheduleCaretHandback(() => { restored += 1; }, HANDBACK_IDLE_MS, t.set, t.clear);
  cmd(); cmd(); t.advance(HANDBACK_IDLE_MS + 10);
  cmd(); cmd(); t.advance(HANDBACK_IDLE_MS + 10);
  assert.equal(restored, 2, 'each distinct run gets its own handback');
});

test('cancel drops the pending handback and leaves no timer', () => {
  resetCaretHandbackCount();
  const t = fakeTimers();
  let restored = 0;
  scheduleCaretHandback(() => { restored += 1; }, HANDBACK_IDLE_MS, t.set, t.clear);
  assert.equal(caretHandbackPending(), true);
  cancelCaretHandback(t.clear);
  assert.equal(caretHandbackPending(), false);
  t.advance(HANDBACK_IDLE_MS + 10);
  assert.equal(restored, 0, 'a cancelled handback must not fire');
  assert.equal(t.pendingJobs(), 0, 'a cancelled handback must not leak a timer');
});
