import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@/shared/state/agentsSlice';
import { lastConversationMessage, resumeOwed } from './resumeOwed';

function msg(role: AgentMessage['role'], content: string, hidden = false): AgentMessage {
  return { id: `${role}-${content.length}`, role, content, timestamp: '', branch_id: 'main', parent_id: null, hidden };
}

const SHUTDOWN_NOTE = msg('system', "This chat was still running when OpenSwarm's engine shut down, so it stopped here.");

test('stopped with the user waiting owes a resume', () => {
  assert.equal(resumeOwed('stopped', [msg('user', 'do the thing')]), true);
});

test('a system note after the user does not answer the user', () => {
  // The chat that most needs the chip is exactly the one whose tail is the shutdown note.
  assert.equal(resumeOwed('stopped', [msg('user', 'do the thing'), SHUTDOWN_NOTE]), true);
});

test('a hidden harness prompt after the user does not answer either', () => {
  assert.equal(resumeOwed('stopped', [msg('user', 'do the thing'), msg('user', 'Finish the task, then answer in plain text.', true)]), true);
});

test('the assistant having the last word owes nothing', () => {
  assert.equal(resumeOwed('stopped', [msg('user', 'do the thing'), msg('assistant', 'done')]), false);
  assert.equal(resumeOwed('stopped', [msg('user', 'do the thing'), msg('assistant', 'done'), SHUTDOWN_NOTE]), false);
});

test('only a stopped session can owe one', () => {
  assert.equal(resumeOwed('completed', [msg('user', 'do the thing')]), false);
  assert.equal(resumeOwed('running', [msg('user', 'do the thing')]), false);
  assert.equal(resumeOwed('stopped', []), false);
});

test('the preview never picks a hidden prompt or a system note', () => {
  const tail = [
    msg('user', 'do the thing'),
    msg('assistant', 'on it'),
    msg('user', 'The engine process running you was stopped from outside and has been restarted.', true),
    SHUTDOWN_NOTE,
  ];
  assert.equal(lastConversationMessage(tail)?.content, 'on it');
  assert.equal(lastConversationMessage([msg('tool_call', 'x')]), undefined);
});
