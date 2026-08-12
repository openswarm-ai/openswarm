// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// ENG-272. The collapsed pill hid a plan/progress widget whenever the session was running, on the
// assumption that a mid-turn plan is stale. That is true when work followed it and false when the
// widget IS the newest thing the agent said, which is exactly what a long-running skill does when it
// re-emits its tracker. Result: the minimized view showed older state all day. Staleness is now
// "did real work land after this widget", which these pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasWorkAfterLatestShowUi } from './showUiPayload.ts';

const showUi = (id: string) => ({ role: 'tool_call', content: { id, tool: 'mcp__openswarm-core__ShowUI', input: { component: 'plan', props: {} } } });
const bash = (id: string) => ({ role: 'tool_call', content: { id, tool: 'Bash', input: { command: 'ls' } } });
const say = (text: string) => ({ role: 'assistant', content: text });
const user = (text: string) => ({ role: 'user', content: text });

test('a widget that is the newest thing is NOT stale', () => {
  assert.equal(hasWorkAfterLatestShowUi([user('go'), bash('b1'), showUi('u1')]), false);
});

test('a re-emitted widget is not stale either, which is the whole bug', () => {
  // The send-text case: work, widget, more work, widget again. The newest widget stands.
  assert.equal(hasWorkAfterLatestShowUi([showUi('u1'), bash('b1'), say('sent the batch'), showUi('u2')]), false);
});

test('a tool call after the widget DOES make it stale', () => {
  assert.equal(hasWorkAfterLatestShowUi([showUi('u1'), bash('b1')]), true);
});

test('a spoken answer after the widget makes it stale', () => {
  assert.equal(hasWorkAfterLatestShowUi([showUi('u1'), say('all done')]), true);
});

test('an empty assistant message is not work', () => {
  assert.equal(hasWorkAfterLatestShowUi([showUi('u1'), say('   ')]), false);
});

test('a user message after the widget is not agent work', () => {
  // The user typing does not make the agent's own widget stale; the agent has not acted yet.
  assert.equal(hasWorkAfterLatestShowUi([showUi('u1'), user('any update?')]), false);
});

test('no widget at all reports no work-after', () => {
  assert.equal(hasWorkAfterLatestShowUi([user('go'), bash('b1')]), true);
  assert.equal(hasWorkAfterLatestShowUi([]), false);
});
