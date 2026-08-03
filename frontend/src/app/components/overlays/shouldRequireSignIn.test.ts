// Run: node --test frontend/src/app/components/overlays/shouldRequireSignIn.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRequireSignIn } from './shouldRequireSignIn.ts';

const base = { settingsLoaded: true, userId: null as string | null, onboardingActive: false };

test('the veteran this exists for: settings loaded, no account, no onboarding', () => {
  assert.equal(shouldRequireSignIn(base), true);
});

test('a signed-in user is never walled', () => {
  assert.equal(shouldRequireSignIn({ ...base, userId: 'u-1' }), false);
});

test('nothing shows until settings are read, so a launch does not flash a login wall', () => {
  assert.equal(shouldRequireSignIn({ ...base, settingsLoaded: false }), false);
});

test('a backend that never answers leaves the app usable rather than bricked', () => {
  // settingsLoaded stays false forever in that case; the wall must stay down, not go up.
  assert.equal(shouldRequireSignIn({ settingsLoaded: false, userId: null, onboardingActive: false }), false);
});

test('onboarding owns the screen, so the gate stands down while its own sign-in beat runs', () => {
  assert.equal(shouldRequireSignIn({ ...base, onboardingActive: true }), false);
});

test('a fresh install that finishes onboarding signed in stays down afterwards', () => {
  assert.equal(shouldRequireSignIn({ settingsLoaded: true, userId: 'u-2', onboardingActive: false }), false);
});

test('an empty-string user id is not an account', () => {
  assert.equal(shouldRequireSignIn({ ...base, userId: '' }), true);
});
