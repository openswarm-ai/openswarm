// Run: node --test (via scripts/run-tests.mjs)
//
// The wipe chain, reproduced live 2026-08-12: one fetchSessions.fulfilled whose payload was empty
// and whose meta carried no dashboardId stripped EVERY completed session from the store; the
// reconcile effect then deleted every card, and the debounced layout save persisted the wipe.
// Card-less sessions are never promoted from disk again, so it was permanent (ENG-271). These pin
// the reducer's strip authority: scoped fetches prune their own dashboard, unscoped prune nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import reducer, { fetchSessions } from './agentsSlice.ts';

function seeded(): any {
  const mk = (id: string, dash: string, status = 'completed') => ({
    id, name: id, status, mode: 'agent', provider: 'anthropic', model: 'm',
    dashboard_id: dash, messages: [], pending_approvals: [], tool_group_meta: {},
  });
  const empty = reducer(undefined, { type: '@@init' }) as any;
  return {
    ...empty,
    sessions: {
      a1: mk('a1', 'dashA'), a2: mk('a2', 'dashA'),
      b1: mk('b1', 'dashB'),
      run: mk('run', 'dashA', 'running'),
    },
  };
}

function fulfilled(payload: any[], arg: any): any {
  return { type: fetchSessions.fulfilled.type, payload, meta: { arg, requestId: 't' } };
}

test('a scoped empty answer prunes only its own dashboard', () => {
  const next = reducer(seeded(), fulfilled([], { dashboardId: 'dashA' })) as any;
  assert.deepEqual(Object.keys(next.sessions).sort(), ['b1', 'run'],
    'dashA completed sessions go; dashB and the running one stay');
});

test('an UNSCOPED empty answer deletes nothing at all', () => {
  const next = reducer(seeded(), fulfilled([], {})) as any;
  assert.deepEqual(Object.keys(next.sessions).sort(), ['a1', 'a2', 'b1', 'run'],
    'no scope means no authority to strip; this exact dispatch wiped a real board');
});

test('an unscoped answer still merges what it carries', () => {
  const incoming = { id: 'new1', name: 'new1', status: 'completed', mode: 'agent',
    provider: 'anthropic', model: 'm', dashboard_id: 'dashC', messages: [],
    pending_approvals: [], tool_group_meta: {} };
  const next = reducer(seeded(), fulfilled([incoming], {})) as any;
  assert.ok(next.sessions.new1, 'merge still works without scope');
  assert.equal(Object.keys(next.sessions).length, 5, 'and nothing was deleted');
});

test('a rejected fetch strips nothing', () => {
  const next = reducer(seeded(), { type: fetchSessions.rejected.type, error: { message: '500' },
    meta: { arg: { dashboardId: 'dashA' }, requestId: 't' } }) as any;
  assert.equal(Object.keys(next.sessions).length, 4);
});
