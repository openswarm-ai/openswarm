// The lying-banner class (Haik, 2026-08-16): a transient outage failed the settings/models fetches
// and the old banner then claimed "no model configured" forever. The ladder must never report
// no-model while any loading gate is unsettled, and each state must clear on its recovery signal.
import { test } from 'node:test';
import assert from 'node:assert';
import { modelErrorState, ModelErrorInputs } from './modelErrorState';

const healthy: ModelErrorInputs = {
  isOnline: true, settingsKnown: true, settingsSettled: true, modelsOk: true,
  hasModel: true, freeTrialArmSettled: true, freeTrialActive: false, freeTrialSpent: false,
};

test('healthy install shows nothing', () => {
  assert.strictEqual(modelErrorState(healthy), null);
});

test('offline outranks everything', () => {
  assert.strictEqual(modelErrorState({ ...healthy, isOnline: false, hasModel: false }), 'offline');
});

test('unreachable backend says backend, never no-model', () => {
  assert.strictEqual(modelErrorState({ ...healthy, settingsKnown: false, hasModel: false }), 'backend');
});

test('a failed models fetch must NOT claim no-model (the lying-banner bug)', () => {
  // Settings answered, but the /models fetch failed during a blip: without data there is no claim.
  assert.strictEqual(modelErrorState({ ...healthy, modelsOk: false, hasModel: false }), null);
});

test('genuine no-model fires only with every gate settled', () => {
  assert.strictEqual(modelErrorState({ ...healthy, hasModel: false }), 'no-model');
  assert.strictEqual(modelErrorState({ ...healthy, hasModel: false, freeTrialArmSettled: false }), null);
  assert.strictEqual(modelErrorState({ ...healthy, hasModel: false, freeTrialActive: true }), null);
  assert.strictEqual(modelErrorState({ ...healthy, hasModel: false, freeTrialSpent: true }), null);
});

test('recovery clears it: same inputs back to healthy read null again', () => {
  const broken = { ...healthy, settingsKnown: false, hasModel: false };
  assert.strictEqual(modelErrorState(broken), 'backend');
  assert.strictEqual(modelErrorState({ ...broken, settingsKnown: true, hasModel: true }), null);
});
