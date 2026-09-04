import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudAvailability } from './cloudAvailability';
import type { CloudProbe } from './cloudApi';

// A cloud with no workflows API used to read as "The cloud declined this request" under an unknown
// state (Haik, 2026-09-03: "requests routed to Cloud don't go through"). It is a blocked state with a
// reason that says the app is ahead of the cloud and nothing was sent.

test('a cloud without the workflows API blocks the toggle with the honest reason', () => {
  const probe = { phase: 'answered', status: { state: 'unavailable', reason: 'Cloud runs are not available on your OpenSwarm Cloud yet; this version of the app is ahead of it. Nothing was sent.', target: 'device', schedule_supported: true, schedule_reason: null } } as unknown as CloudProbe;
  const a = cloudAvailability(probe);
  assert.equal(a.kind, 'blocked');
  assert.match((a as { reason: string }).reason, /not available on your OpenSwarm Cloud yet/);
  assert.equal((a as { action: string | null }).action, null);
});
