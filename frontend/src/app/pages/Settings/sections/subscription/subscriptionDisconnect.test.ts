import { test } from 'node:test';
import assert from 'node:assert/strict';

import { performDisconnect, type DisconnectCtx } from './subscriptionDisconnect';

// The spinner is the whole subject. Every case below asserts it ended, because the reported bug is
// not "disconnect failed" -- it is a row that spins forever after the disconnect already worked.

function harness(over: Partial<DisconnectCtx> = {}) {
  const calls: { spinner: (string | null)[]; errors: unknown[]; refreshed: number } = {
    spinner: [], errors: [], refreshed: 0,
  };
  const ctx: DisconnectCtx = {
    providerId: 'anthropic',
    apiBase: 'http://x',
    fetchStatus: async () => ({}),
    refreshPickerModels: () => { calls.refreshed++; },
    setDisconnectError: (e) => { calls.errors.push(e); },
    setDisconnecting: (v) => { calls.spinner.push(v); },
    fetchImpl: (async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
    ...over,
  };
  return { ctx, calls };
}

const spinnerEnded = (calls: { spinner: (string | null)[] }) =>
  calls.spinner.length >= 2 && calls.spinner[calls.spinner.length - 1] === null;

test('happy path: spinner starts and ends', async () => {
  const { ctx, calls } = harness();
  await performDisconnect(ctx);
  assert.equal(calls.spinner[0], 'anthropic', 'precondition: the spinner actually started');
  assert.ok(spinnerEnded(calls));
  assert.equal(calls.refreshed, 1);
});

test('THE BUG: a throwing status refresh must still release the spinner', async () => {
  // This is the exact shape that wedged the row: fetchStatus() unwraps a thunk, and a rejected
  // thunk throws. Before the fix the rejection escaped past setDisconnecting(null).
  const { ctx, calls } = harness({
    fetchStatus: async () => { throw new Error('Rejected'); },
  });
  await performDisconnect(ctx);
  assert.ok(spinnerEnded(calls), 'the row must not spin forever when the refresh fails');
});

test('a throwing model-picker refresh must still release the spinner', async () => {
  const { ctx, calls } = harness({
    refreshPickerModels: () => { throw new Error('dispatch blew up'); },
  });
  await performDisconnect(ctx);
  assert.ok(spinnerEnded(calls));
});

test('network failure reports a reason AND releases the spinner', async () => {
  const { ctx, calls } = harness({
    fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
  });
  await performDisconnect(ctx);
  assert.ok(spinnerEnded(calls));
  const last = calls.errors[calls.errors.length - 1] as { message: string };
  assert.match(last.message, /Could not reach OpenSwarm/);
});

test('a backend refusal reports the backend reason AND releases the spinner', async () => {
  const { ctx, calls } = harness({
    fetchImpl: (async () => ({
      ok: false, json: async () => ({ ok: false, error: 'lane is busy' }),
    })) as unknown as typeof fetch,
  });
  await performDisconnect(ctx);
  assert.ok(spinnerEnded(calls));
  const last = calls.errors[calls.errors.length - 1] as { message: string };
  assert.equal(last.message, 'lane is busy');
});

test('unparseable body still yields a readable message, never a blank card', async () => {
  const { ctx, calls } = harness({
    fetchImpl: (async () => ({
      ok: false, json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch,
  });
  await performDisconnect(ctx);
  assert.ok(spinnerEnded(calls));
  const last = calls.errors[calls.errors.length - 1] as { message: string };
  assert.match(last.message, /Could not disconnect/);
});

test('NEGATIVE CONTROL: the harness can observe a stuck spinner', async () => {
  // Without this, every assertion above could be passing because spinnerEnded() is simply always
  // true -- the vacuous green VERIFICATION.md section 3 warns about. Prove the detector can fail.
  const calls = { spinner: ['anthropic'] as (string | null)[] };
  assert.equal(spinnerEnded(calls), false, 'the check must be able to catch a wedged spinner');
});
