// Run: node --test frontend/src/shared/selfHealClick.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSelfHealClick } from './selfHealClick.ts';

test('escalates a plain named click that errored', () => {
  assert.equal(shouldSelfHealClick(true, false, 'Send', true), true);
});

test('never escalates a click that SUCCEEDED (no double-act)', () => {
  assert.equal(shouldSelfHealClick(false, false, 'Send', true), false);
});

test('never escalates a text-fill (fills verify themselves)', () => {
  assert.equal(shouldSelfHealClick(true, true, 'Write a message', true), false);
});

test('cannot escalate without a name to re-resolve by', () => {
  assert.equal(shouldSelfHealClick(true, false, undefined, true), false);
  assert.equal(shouldSelfHealClick(true, false, '', true), false);
});

test('A/B off-arm (selfheal === false) disables it; undefined/absent stays on', () => {
  assert.equal(shouldSelfHealClick(true, false, 'Send', false), false);
  assert.equal(shouldSelfHealClick(true, false, 'Send', undefined), true);
});
