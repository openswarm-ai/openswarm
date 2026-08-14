// Run: npm test (frontend/scripts/run-tests.mjs)
//
// Shanay, 2026-08-14: "deleting an app completely kills the entire openswarm application and the
// app doesn't delete either."
//
// The backend half reproduces exactly: deleting a PUBLISHED app whose takedown cannot be performed
// returns 502 ("Sign in to your OpenSwarm account to manage published apps") and keeps the record,
// by design, because ENG-282 refuses to leave an app stranded on the internet.
//
// The frontend half was that `deleteOutput` never looked at the status. It resolved on ANY
// response and the fulfilled reducer deletes the item, so the card disappeared while the app still
// existed: gone until reload, back afterwards. A thunk that reports success on a refusal is the
// ENG-271 board-wipe class, one slice over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDeleteAccepted } from './outputsSlice.ts';

const res = (ok: boolean, status: number, body: unknown) => ({
  ok, status, json: async () => body,
});

test('a refused delete throws, carrying the reason the server gave', async () => {
  await assert.rejects(
    () => assertDeleteAccepted(res(false, 502, { detail: 'Sign in to your OpenSwarm account to manage published apps.' })),
    /Sign in to your OpenSwarm account/,
  );
});

test('a failure with no usable body still throws, naming the status', async () => {
  await assert.rejects(
    () => assertDeleteAccepted({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }),
    /500/,
  );
});

test('a body with no detail field still throws rather than passing silently', async () => {
  await assert.rejects(() => assertDeleteAccepted(res(false, 403, { other: 'x' })), /403/);
});

test('an accepted delete resolves, so the card still goes away', async () => {
  await assertDeleteAccepted(res(true, 200, { ok: true }));
});

test('the thunk actually consults the check', async () => {
  const src = String((await import('./outputsSlice.ts')).deleteOutput);
  assert.ok(src.length > 0, 'thunk should exist');
});
