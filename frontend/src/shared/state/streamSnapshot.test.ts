import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import reducer, { streamStart, streamSnapshot, streamDelta, streamEnd } from './streamingSlice';

// Every delta that arrives before the per-session socket connects is lost to that client (the ring
// replays them, the client drops pre-ack stream frames on purpose), so the transcript sat on a static
// "Thinking..." and then got the whole reply at once. The server now sends the text so far right after
// the resume ack; the slice seeds the bubble with it and later deltas append.

test('a snapshot seeds the streaming bubble and later deltas append to it', () => {
  let s = reducer(undefined, streamSnapshot({ sessionId: 'a', messageId: 'm1', role: 'assistant', text: 'The Eiffel' }));
  s = reducer(s, streamDelta({ sessionId: 'a', messageId: 'm1', delta: ' Tower' }));
  assert.equal(s.bySession.a?.content, 'The Eiffel Tower');
  s = reducer(s, streamEnd({ sessionId: 'a', messageId: 'm1' }));
  assert.equal(s.bySession.a, undefined);
});

test('a snapshot never shortens text the client already has for the same message', () => {
  let s = reducer(undefined, streamStart({ sessionId: 'a', messageId: 'm1', role: 'assistant' }));
  s = reducer(s, streamDelta({ sessionId: 'a', messageId: 'm1', delta: 'The Eiffel Tower is tall' }));
  s = reducer(s, streamSnapshot({ sessionId: 'a', messageId: 'm1', role: 'assistant', text: 'The Eiffel' }));
  assert.equal(s.bySession.a?.content, 'The Eiffel Tower is tall');
});

test('a snapshot for a newer message replaces a stale bubble', () => {
  let s = reducer(undefined, streamStart({ sessionId: 'a', messageId: 'old', role: 'assistant' }));
  s = reducer(s, streamSnapshot({ sessionId: 'a', messageId: 'new', role: 'assistant', text: 'Second reply so far' }));
  assert.equal(s.bySession.a?.id, 'new');
  assert.equal(s.bySession.a?.content, 'Second reply so far');
});

test('the socket handles the snapshot ABOVE the replay-skip guard that drops pre-ack stream frames', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/shared/ws/WebSocketManager.ts'), 'utf8');
  const snapshot = src.indexOf("event === 'agent:stream_snapshot'");
  const guard = src.indexOf('if (!this.resumeAcked) break;');
  assert.ok(snapshot > 0 && guard > 0 && snapshot < guard, 'the snapshot must be handled before the pre-ack guard');
  const dashboardSkip = src.indexOf('if (this.skipStreamEvents) {');
  assert.ok(snapshot < dashboardSkip, 'the snapshot handler decides skipStreamEvents itself, above the generic skip');
});

test('the socket refuses a snapshot for a session it already knows is finished', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/shared/ws/WebSocketManager.ts'), 'utf8');
  const i = src.indexOf("event === 'agent:stream_snapshot'");
  const block = src.slice(i, i + 900);
  assert.match(block, /agents\.sessions\[session_id\]\?\.status/);
  assert.match(block, /!finished/);
});
