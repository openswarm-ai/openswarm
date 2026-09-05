import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import reducer, { healthReported, hideProviderHealthToast } from './subscriptionsSlice';

// A ChatGPT login whose token expired on 08-30 answered every probe with the router's "(reset after Ns)" 401 for six
// days; the boot-time verdict excused it as mid-refresh and nothing ever looked again. The backend now re-probes after
// the rotation window and pushes the verdict; the slice has to open the same pill the boot fetch would have.

test('a pushed verdict opens the reconnect pill', () => {
  const s = reducer(undefined, healthReported({ dead: [{ provider: 'codex', label: 'ChatGPT' }] }));
  assert.equal(s.healthToastOpen, true);
  assert.deepEqual(s.healthDead, [{ provider: 'codex', label: 'ChatGPT' }]);
});

test('an empty verdict closes nothing the user already dismissed and opens nothing', () => {
  let s = reducer(undefined, healthReported({ dead: [{ provider: 'codex', label: 'ChatGPT' }] }));
  s = reducer(s, hideProviderHealthToast());
  s = reducer(s, healthReported({ dead: [] }));
  assert.equal(s.healthToastOpen, false);
  assert.deepEqual(s.healthDead, []);
});

test('the socket routes subscriptions:health into the slice', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/shared/ws/WebSocketManager.ts'), 'utf8');
  assert.ok(src.includes("case 'subscriptions:health':"));
  assert.ok(src.includes('store.dispatch(healthReported({ dead: data.dead }))'));
});
