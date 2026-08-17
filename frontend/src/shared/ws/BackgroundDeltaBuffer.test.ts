// The 1Hz background-stream buffer (ENG-329): text must NEVER be lost or reordered, only batched.
// Eviction on message switch is the ordering invariant; a buffer that held two messages could
// interleave them wrong on flush.
import { test } from 'node:test';
import assert from 'node:assert';
import { BackgroundDeltaBuffer } from './BackgroundDeltaBuffer';

test('same-message deltas coalesce into one payload, byte-exact', () => {
  const b = new BackgroundDeltaBuffer();
  assert.strictEqual(b.add('m1', 'Hello '), null);
  assert.strictEqual(b.add('m1', 'wor'), null);
  assert.strictEqual(b.add('m1', 'ld'), null);
  assert.deepStrictEqual(b.take(), { messageId: 'm1', text: 'Hello world' });
  assert.strictEqual(b.hasPending, false);
});

test('a delta for a different message evicts the pending one first', () => {
  const b = new BackgroundDeltaBuffer();
  b.add('m1', 'first');
  const evicted = b.add('m2', 'second');
  assert.deepStrictEqual(evicted, { messageId: 'm1', text: 'first' });
  assert.deepStrictEqual(b.take(), { messageId: 'm2', text: 'second' });
});

test('take on empty is null and pendingMessageId tracks the buffer', () => {
  const b = new BackgroundDeltaBuffer();
  assert.strictEqual(b.take(), null);
  assert.strictEqual(b.pendingMessageId, null);
  b.add('m9', 'x');
  assert.strictEqual(b.pendingMessageId, 'm9');
});

test('nothing is lost across an evict-then-take sequence (byte accounting)', () => {
  const b = new BackgroundDeltaBuffer();
  const seen: string[] = [];
  for (const [mid, d] of [['a', '1'], ['a', '2'], ['b', '3'], ['b', '4'], ['a', '5']] as const) {
    const ev = b.add(mid, d);
    if (ev) seen.push(ev.text);
  }
  const last = b.take();
  if (last) seen.push(last.text);
  assert.strictEqual(seen.join(''), '12345');
});
