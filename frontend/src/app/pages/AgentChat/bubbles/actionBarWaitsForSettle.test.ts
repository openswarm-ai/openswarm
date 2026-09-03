import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Eric's send-to-answer table (2026-09-03): "the action bar and the Done chip are already mounted under the
// first revealed line, while the text is still revealing". The bar under a burst-revealed reply now mounts
// only once the reveal has drained; history and streamed replies (no burst) keep it at once.
test('the action bar under a burst-revealed reply mounts only after the reveal settles', () => {
  const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');
  assert.match(chat, /onSettled=\{\(\) => markSettled\(msg\.id\)\}/);
  assert.match(chat, /lastAssistantIdsInTurn\.has\(msg\.id\) && \(!revealingIdsRef\.current\.has\(msg\.id\) \|\| settledIds\.has\(msg\.id\)\)/);
  assert.match(chat, /if \(burstAnimate\) revealingIdsRef\.current\.add\(msg\.id\);/, 'the gate keys on a reveal that STARTED, not on the burst flag, which flips one render later');
  const bubble = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/bubbles/BurstRevealBubble.tsx'), 'utf8');
  assert.match(bubble, /if \(done\) settledRef\.current\?\.\(\);/, 'onSettled must fire from the done flag, once');
});

test('a reply that just streamed lands whole: it never re-types itself from zero after the commit', () => {
  const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');
  assert.match(chat, /if \(streamingMessageId\) lastStreamingIdRef\.current = streamingMessageId;/, 'remembered during render, not in an effect');
  const burst = chat.indexOf('const burstAnimate =');
  assert.ok(chat.slice(burst, burst + 400).includes('msg.id !== lastStreamingIdRef.current'), 'the burst reveal must exclude the id that was streaming a moment ago');
});
