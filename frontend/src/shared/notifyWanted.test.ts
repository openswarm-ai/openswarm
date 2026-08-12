// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// Every assertion here has a matching negative, because a gate that only ever says yes passes a
// one-sided test perfectly. The bug that motivated the split: workflow alerts were re-checked
// against the AGENT toggle on the fallback path, so turning agents off silently muted workflows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyWanted, notifyAllowedNow, notifyOn, type NotifyPrefs } from './notifyWanted.ts';

const all: NotifyPrefs = {};

test('a fresh profile with no saved toggles gets everything', () => {
  assert.equal(notifyWanted(all, 'agent', false), true);
  assert.equal(notifyWanted(all, 'agent', true), true);
  assert.equal(notifyWanted(all, 'workflow', false), true);
  assert.equal(notifyWanted(all, 'workflow', true), true);
});

test('turning off agent completions still lets an agent ERROR through', () => {
  const p: NotifyPrefs = { notify_agent_completion: false };
  assert.equal(notifyWanted(p, 'agent', false), false);
  assert.equal(notifyWanted(p, 'agent', true), true, 'silencing routine finishes also silenced failures');
});

test('turning off agents does NOT touch workflows (the bug this split exists for)', () => {
  const p: NotifyPrefs = { notify_agent_completion: false, notify_agent_errors: false };
  assert.equal(notifyWanted(p, 'workflow', false), true);
  assert.equal(notifyWanted(p, 'workflow', true), true);
});

test('turning off workflows does NOT touch agents', () => {
  const p: NotifyPrefs = { notify_workflow_runs: false, notify_workflow_failures: false };
  assert.equal(notifyWanted(p, 'agent', false), true);
  assert.equal(notifyWanted(p, 'agent', true), true);
});

test('a user who only wants to hear about failures can have exactly that', () => {
  const p: NotifyPrefs = { notify_agent_completion: false, notify_workflow_runs: false };
  assert.equal(notifyWanted(p, 'agent', false), false);
  assert.equal(notifyWanted(p, 'workflow', false), false);
  assert.equal(notifyWanted(p, 'agent', true), true);
  assert.equal(notifyWanted(p, 'workflow', true), true);
});

test('everything off means nothing fires', () => {
  const p: NotifyPrefs = {
    notify_agent_completion: false, notify_agent_errors: false,
    notify_workflow_runs: false, notify_workflow_failures: false,
  };
  for (const kind of ['agent', 'workflow'] as const) {
    for (const bad of [true, false]) assert.equal(notifyWanted(p, kind, bad), false);
  }
});

test('a hidden window is the normal case, a focused one is held back unless asked for', () => {
  assert.equal(notifyAllowedNow(all, true), true);
  assert.equal(notifyAllowedNow(all, false), false, 'notified about the window already in front');
  assert.equal(notifyAllowedNow({ notify_when_focused: true }, false), true);
});

test('notify_when_focused defaults OFF, so it must be opted into explicitly', () => {
  assert.equal(notifyAllowedNow({}, false), false);
  assert.equal(notifyAllowedNow({ notify_when_focused: false }, false), false);
});

test('sound follows the same absent-means-on rule as the rest', () => {
  assert.equal(notifyOn(undefined), true);
  assert.equal(notifyOn(true), true);
  assert.equal(notifyOn(false), false);
});
