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
