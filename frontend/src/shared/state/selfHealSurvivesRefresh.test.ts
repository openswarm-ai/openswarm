import { test } from 'node:test';
import assert from 'node:assert/strict';
import reducer, { clearSelfHeal, fetchSession, resumeSession, setSelfHeal, updateSession } from './agentsSlice';
import type { AgentSession } from './agentsSlice';

// The pill's flag used to live ON the session object, and every server refresh replaces that object
// wholesale (fetchSession on expand, updateSession on each status frame, resumeSession), so a heal that
// landed while the card was collapsed was wiped before the pill could mount: the wire carried
// agent:tool_recovered, the screen showed nothing. The flag now lives beside the sessions, not in them.
function session(id: string): AgentSession {
  return { id, name: 'F2', status: 'running', messages: [], pending_approvals: [], tool_group_meta: {} } as unknown as AgentSession;
}
const seeded = reducer(undefined, updateSession(session('s1')));

test('a heal survives every reducer that replaces the session object', () => {
  let state = reducer(seeded, setSelfHeal({ sessionId: 's1', kind: 'tool_restarted', outstandingS: 25 }));
  assert.equal(state.selfHeals.s1?.kind, 'tool_restarted');
  state = reducer(state, fetchSession.fulfilled(session('s1'), 'req', { sessionId: 's1' } as never));
  assert.equal(state.selfHeals.s1?.kind, 'tool_restarted', 'fetchSession (card expanded) kept it');
  state = reducer(state, updateSession(session('s1')));
  assert.equal(state.selfHeals.s1?.kind, 'tool_restarted', 'a status frame kept it');
  state = reducer(state, resumeSession.fulfilled(session('s1'), 'req', { sessionId: 's1' } as never));
  assert.equal(state.selfHeals.s1?.outstanding_s, 25, 'resume kept it');
  assert.ok(!('self_heal' in state.sessions.s1), 'nothing on the session object carries it any more');
});

test('the pill clears it, and a heal for a card that is not on the board is still recorded', () => {
  let state = reducer(seeded, setSelfHeal({ sessionId: 'not-loaded', kind: 'cli_compacted' }));
  assert.equal(state.selfHeals['not-loaded']?.kind, 'cli_compacted');
  state = reducer(state, clearSelfHeal({ sessionId: 'not-loaded' }));
  assert.equal(state.selfHeals['not-loaded'], undefined);
});
