// ENG-301: mid-gesture stream deltas must yield to the hand. Pins the decay contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markInteraction, interactionActive } from './interactionPriority';

test('quiet by default', () => {
  assert.equal(interactionActive(), false);
});

test('active immediately after a gesture, decays after 350ms', async () => {
  markInteraction();
  assert.equal(interactionActive(), true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(interactionActive(), false);
});
