// ENG-304: spawning an unrelated agent despawned another agent's live subagents. Mechanism:
// revealSubAgent places cards for plumbing sessions (sub/browser/invoked agents) that
// deservesCanvasCard filters out of the reconcile id-list forever, so the next id-list change
// handed reconcileSessions a list without them and its delete loop removed the cards. keepIds is
// the exemption: delete-immune while the session lives, never create-eligible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import reducer, { reconcileSessions } from '@/shared/state/dashboardLayoutSlice';
import { isPlumbingSession, deservesCanvasCard } from '@/shared/state/isUserLaunchedSession';

function seedBoard() {
  let s = reducer(undefined, { type: '@@init' });
  const place = (sessionId: string, x: number) => {
    s = reducer(s, { type: 'dashboardLayout/placeCard', payload: { sessionId, x, y: 100, width: 480, height: 280, expandedSessionIds: [], exact: true } });
  };
  place('parent-1', 100);
  place('sub-1', 700);
  return { get: () => s, apply: (a: unknown) => { s = reducer(s, a as { type: string }); } };
}

test('the bug, pinned: without keepIds an unrelated spawn despawns the revealed subagent', () => {
  const b = seedBoard();
  b.apply(reconcileSessions({ sessionIds: ['parent-1', 'new-agent'], expandedSessionIds: [] }));
  assert.equal(b.get().cards['sub-1'], undefined, 'this IS ENG-304; if this starts passing with a card present, the id-list derivation changed');
  assert.ok(b.get().cards['new-agent'], 'the spawn itself must still land');
});

test('the fix: keepIds makes the revealed subagent delete-immune', () => {
  const b = seedBoard();
  b.apply(reconcileSessions({ sessionIds: ['parent-1', 'new-agent'], expandedSessionIds: [], keepIds: ['sub-1'] }));
  assert.ok(b.get().cards['sub-1'], 'live subagent card must survive an unrelated spawn');
  assert.ok(b.get().cards['new-agent']);
  assert.ok(b.get().cards['parent-1']);
});

test('keep is not create: a keep id with no card stays cardless', () => {
  const b = seedBoard();
  b.apply(reconcileSessions({ sessionIds: ['parent-1'], expandedSessionIds: [], keepIds: ['sub-never-revealed'] }));
  assert.equal(b.get().cards['sub-never-revealed'], undefined, 'granting cards here would undo the ENG-256 rule');
});

test('a stopped workflow run still loses its card (keepIds must not cover it)', () => {
  // The keep set is derived from isPlumbingSession, and a run session is mode "agent": not plumbing.
  const run = { mode: 'agent', workflow_run_id: 'r1', status: 'completed' };
  assert.equal(isPlumbingSession(run), false);
  assert.equal(deservesCanvasCard(run), false);
  const b = seedBoard();
  b.apply(reconcileSessions({ sessionIds: ['parent-1'], expandedSessionIds: [], keepIds: [] }));
  assert.equal(b.get().cards['sub-1'], undefined, 'not in the list, not in keep: deleted, as a stopped run should be');
});

test('the lifecycle effect actually derives and passes keepIds', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Dashboard/hooks/lifecycle/useDashboardLifecycle.ts'), 'utf8');
  assert.ok(src.includes('isPlumbingSession(s)'), 'an exemption nobody computes is a boundary drawn but not enforced');
  assert.ok(src.includes('expandedSessionIds, keepIds }'), 'keepIds must reach the reducer');
});
