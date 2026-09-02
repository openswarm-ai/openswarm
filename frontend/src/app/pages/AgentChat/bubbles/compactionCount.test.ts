import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@/shared/state/agentsSlice';
import { countSummarizedUserTurns } from './compactionCount';

function msg(id: string, role: AgentMessage['role'], hidden = false): AgentMessage {
  return { id, role, content: id, timestamp: '', branch_id: 'main', parent_id: null, hidden };
}

// The old marker used the anchor's index in the render list, which counts tool groups and every
// visible item, so "14 earlier turns summarized" was a wrong number that stayed forever.
const transcript = [
  msg('u1', 'user'),
  msg('a1', 'assistant'),
  msg('tc1', 'tool_call'),
  msg('tr1', 'tool_result'),
  msg('nudge', 'user', true),
  msg('a2', 'assistant'),
  msg('u2', 'user'),
  msg('a3', 'assistant'),
  msg('u3', 'user'),
];

test('counts only the user\'s own turns at or before the anchor', () => {
  assert.equal(countSummarizedUserTurns(transcript, 'a3'), 2);
  assert.equal(countSummarizedUserTurns(transcript, 'u2'), 2);
  assert.equal(countSummarizedUserTurns(transcript, 'tr1'), 1);
});

test('a hidden harness prompt is not a turn the user took', () => {
  assert.equal(countSummarizedUserTurns(transcript, 'a2'), 1);
});

test('an unknown or missing anchor yields 0 so the marker says "Older turns summarized"', () => {
  assert.equal(countSummarizedUserTurns(transcript, 'nope'), 0);
  assert.equal(countSummarizedUserTurns(transcript, null), 0);
  assert.equal(countSummarizedUserTurns([], 'u1'), 0);
});
