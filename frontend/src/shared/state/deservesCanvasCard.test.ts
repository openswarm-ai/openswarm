// Run: node --test frontend/src/shared/state/deservesCanvasCard.test.ts
//
// ENG-256. A workflow run was denied a canvas card, and the browser-docking path is gated on the
// parent card existing, so its browsers spawned as loose windows nothing owned and nothing tore
// down. ENG-248/249/250 were all symptoms of that one missing object. The rule now: a run gets a
// real card while it is running, and loses it when it stops, so a nightly workflow does not leave a
// card behind every night.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deservesCanvasCard, isUserLaunchedSession } from './isUserLaunchedSession.ts';

const chat = { mode: 'agent', status: 'completed' };
const run = (status: string) => ({ mode: 'agent', status, workflow_run_id: 'run-1' });

test('an ordinary chat always has a card, running or not', () => {
  assert.equal(deservesCanvasCard(chat), true);
  assert.equal(deservesCanvasCard({ mode: 'agent', status: 'running' }), true);
});

test('a workflow run has a card while it works', () => {
  assert.equal(deservesCanvasCard(run('running')), true);
  assert.equal(deservesCanvasCard(run('waiting_approval')), true);
});

test('a workflow run loses its card the moment it stops', () => {
  for (const s of ['completed', 'failed', 'stopped', 'error', '']) {
    assert.equal(deservesCanvasCard(run(s)), false, `status ${s || '(empty)'}`);
  }
  assert.equal(deservesCanvasCard({ mode: 'agent', workflow_run_id: 'run-1' }), false, 'no status at all');
});

test('plumbing chats never get a card, however they look', () => {
  for (const mode of ['browser-agent', 'invoked-agent', 'sub-agent']) {
    assert.equal(deservesCanvasCard({ mode, status: 'running' }), false, mode);
  }
  assert.equal(deservesCanvasCard({ mode: 'agent', status: 'running', workflow_edit_id: 'e1' }), false);
});

test('notifications are still a separate question from cards', () => {
  // A running workflow now earns a CARD but must not start earning notifications: nobody asked for
  // a ping every time a scheduled job fires.
  assert.equal(deservesCanvasCard(run('running')), true);
  assert.equal(isUserLaunchedSession(run('running')), false);
});

// ENG-420: stopping a workflow-backed agent closed its whole card. Haik, production 1.7.9:
// "Stop should mean stop, not close" -- you lose the transcript the moment you stop the run, which
// is the thing you stopped it to read. The despawn rule could not tell "the nightly run finished"
// from "a person pressed Stop", and it was written for the first one.
test('a run a HUMAN stopped keeps its card', () => {
  assert.equal(deservesCanvasCard({
    mode: 'agent', workflow_run_id: 'r1', status: 'stopped', ended_by_user: true,
  }), true);
});

test('a run that ended on its own still despawns', () => {
  // The litter case the rule exists for: a nightly workflow must not leave a card behind every night.
  for (const status of ['completed', 'stopped', 'error']) {
    assert.equal(deservesCanvasCard({ mode: 'agent', workflow_run_id: 'r1', status }), false, status);
  }
});

test('Close still dismisses it, even though Close also sets ended_by_user', () => {
  // Both routes stamp ended_by_user; only Close stamps closed_at, which is what separates them.
  assert.equal(deservesCanvasCard({
    mode: 'agent', workflow_run_id: 'r1', status: 'stopped',
    ended_by_user: true, closed_at: '2026-08-28T00:00:00Z',
  }), false);
});

test('a live run is unaffected either way', () => {
  for (const status of ['running', 'waiting_approval']) {
    assert.equal(deservesCanvasCard({ mode: 'agent', workflow_run_id: 'r1', status }), true, status);
    assert.equal(deservesCanvasCard({
      mode: 'agent', workflow_run_id: 'r1', status, ended_by_user: true,
    }), true, `${status} + stopped flag`);
  }
});

test('a user-launched chat never depends on any of this', () => {
  assert.equal(deservesCanvasCard({ mode: 'agent', status: 'stopped' }), true);
});
