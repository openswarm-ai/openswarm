// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// ENG-277. A failed request used to reach these reducers as an undefined payload and they iterated
// it, which threw INSIDE immer's produce: "t.payload is not iterable" / "Cannot read properties of
// undefined (reading 'map')", live in a real console.
//
// The fix is deliberately "change nothing", not "treat it as empty". Empty is the dangerous reading:
// it is exactly how one bad answer wiped a whole dashboard layout (ENG-271). So each test asserts
// BOTH that it does not throw AND that the good data already in the store survived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import agents, { fetchSessions, fetchHistory } from './agentsSlice.ts';
import dashboards, { fetchDashboards } from './dashboardsSlice.ts';

const BAD: unknown[] = [undefined, null, {}, 'nope', 42];

function agentsWithOneSession(): any {
  const s = agents(undefined, { type: '@@init' }) as any;
  return agents(s, {
    type: fetchSessions.fulfilled.type,
    payload: [{ id: 'keep-me', name: 'Keep me', status: 'completed', messages: [] }],
    meta: { arg: { dashboardId: 'dash-1' } },
  }) as any;
}

test('a session list that is not a list changes nothing and does not throw', () => {
  const before = agentsWithOneSession();
  assert.ok(before.sessions['keep-me'], 'fixture never armed');
  for (const bad of BAD) {
    const after = agents(before, {
      type: fetchSessions.fulfilled.type, payload: bad, meta: { arg: { dashboardId: 'dash-1' } },
    }) as any;
    assert.ok(after.sessions['keep-me'], `payload ${JSON.stringify(bad)} lost a real session`);
  }
});

test('a bad history payload keeps the history it already had', () => {
  let s = agents(undefined, { type: '@@init' }) as any;
  s = agents(s, { type: fetchHistory.fulfilled.type, payload: [{ id: 'h1', name: 'Old chat' }] }) as any;
  assert.ok(s.history.h1, 'fixture never armed');
  for (const bad of BAD) {
    s = agents(s, { type: fetchHistory.fulfilled.type, payload: bad }) as any;
    assert.ok(s.history.h1, `payload ${JSON.stringify(bad)} wiped history`);
  }
});

test('a bad dashboard list does not read as "you have no dashboards"', () => {
  let s = dashboards(undefined, { type: '@@init' }) as any;
  s = dashboards(s, { type: fetchDashboards.fulfilled.type, payload: [{ id: 'd1', name: 'Board' }] }) as any;
  assert.ok(s.items.d1, 'fixture never armed');
  for (const bad of BAD) {
    s = dashboards(s, { type: fetchDashboards.fulfilled.type, payload: bad }) as any;
    assert.ok(s.items.d1, `payload ${JSON.stringify(bad)} emptied the dashboard list`);
  }
});

// The negative half: a genuinely good answer must still be applied, or "it changes nothing" would
// pass on a reducer that had been broken into doing nothing at all.
test('a real payload still applies', () => {
  const s = agents(agentsWithOneSession(), {
    type: fetchSessions.fulfilled.type,
    payload: [{ id: 'keep-me', name: 'Keep me', status: 'completed', messages: [] },
      { id: 'new-one', name: 'New', status: 'running', messages: [] }],
    meta: { arg: { dashboardId: 'dash-1' } },
  }) as any;
  assert.ok(s.sessions['new-one'], 'a valid payload stopped being applied');
});

test('a real dashboard list still replaces the old one', () => {
  let s = dashboards(undefined, { type: '@@init' }) as any;
  s = dashboards(s, { type: fetchDashboards.fulfilled.type, payload: [{ id: 'd1', name: 'Board' }] }) as any;
  s = dashboards(s, { type: fetchDashboards.fulfilled.type, payload: [{ id: 'd2', name: 'Other' }] }) as any;
  assert.ok(s.items.d2 && !s.items.d1, 'a valid dashboard list no longer replaces');
});
