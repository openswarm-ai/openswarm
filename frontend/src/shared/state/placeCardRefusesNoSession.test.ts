import { test } from 'node:test';
import assert from 'node:assert/strict';
import dashboardLayoutReducer, { placeCard } from './dashboardLayoutSlice';

// A drill dispatched placeCard without a sessionId and the reducer wrote cards["undefined"], which persisted and made the
// search palette throw on every render until the file was edited by hand. The bad state is unrepresentable now.
test('placeCard without a session id writes nothing', () => {
  const before = dashboardLayoutReducer(undefined, { type: 'init' });
  const after = dashboardLayoutReducer(before, placeCard({ x: 1, y: 2, width: 100, height: 100 } as unknown as Parameters<typeof placeCard>[0]));
  assert.deepEqual(Object.keys(after.cards), Object.keys(before.cards));
  assert.ok(!('undefined' in after.cards));
});

test('placeCard with a session id still places', () => {
  const after = dashboardLayoutReducer(undefined, placeCard({ sessionId: 's1', x: 1, y: 2, width: 100, height: 100, exact: true }));
  assert.equal(after.cards.s1.x, 1);
});
