import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Typing at a running agent parks the message server-side until the turn ends. Measured live on a
// packaged build, 2026-08-30: 11 minutes and 119 further tool calls with the message leaving no
// trace anywhere, so the only available reading was "it ignored me". The backend now emits
// agent:message_queued; these pin the renderer half, because an event nobody consumes is just
// another silent path.
const here = path.join(process.cwd(), 'src/shared');
const slice = fs.readFileSync(path.join(here, 'state/agentsSlice.ts'), 'utf8');
const ws = fs.readFileSync(path.join(here, 'ws/WebSocketManager.ts'), 'utf8');
const bubble = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/bubbles/MessageBubble.tsx'), 'utf8');

test('queued is a real optimistic state, not a synonym for pending', () => {
  assert.match(slice, /optimistic_status\?: 'pending' \| 'failed' \| 'queued';/);
  assert.match(slice, /markOptimisticQueued\(/, 'a reducer must set it');
  assert.match(slice, /\n  markOptimisticQueued,/, 'and it must be exported');
});

test('the reducer only upgrades a still-pending bubble', () => {
  // Anchor on the REDUCER definition, not the first mention: markOptimisticFailed( also appears in
  // dispatch() calls hundreds of lines earlier, which made the first version of this slice run backwards.
  const start = slice.indexOf('markOptimisticQueued(\n');
  const end = slice.indexOf('markOptimisticFailed(\n', start);
  assert.ok(start > 0 && end > start, 'both reducer definitions must be present, in order');
  const body = slice.slice(start, end);
  assert.match(body, /optimistic_status === 'pending'/,
    'a delivered or failed bubble must not be relabelled queued');
  assert.match(body, /msg\.optimistic_status = 'queued'/);
});

test('the socket consumes the backend event', () => {
  assert.match(ws, /case 'agent:message_queued':/);
  const arm = ws.slice(ws.indexOf("case 'agent:message_queued':"), ws.indexOf("case 'agent:message':"));
  assert.match(arm, /markOptimisticQueued\(/, 'the event must dispatch the reducer');
  assert.match(arm, /client_message_id/, 'it has to mark the RIGHT bubble');
  assert.match(ws, /\n  markOptimisticQueued,/, 'and import it');
});

test('the bubble says why it is dimmed, and names the control that works', () => {
  assert.match(bubble, /'pending' \| 'failed' \| 'queued'/);
  assert.match(bubble, /Waiting for the current step to finish\. Press Stop to send it now\./,
    'dimming alone is what made held and ignored look identical');
  // It must still read as pending (dimmed), not as delivered.
  assert.match(bubble, /const isPending = optimisticStatus === 'pending' \|\| isQueued;/);
});
