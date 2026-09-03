import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Eric (2026-09-03): "why not something like what anthropic does where they just have a loading thing of
// some sort until the actual thinking / agent response appears". The pre-reply cue is the breathing mark
// alone; a word appears beside it only when the aux-written step label is real.
test('the pre-reply cue is the mark, with no default word', () => {
  const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');
  const start = chat.indexOf('const ThinkingBubble: React.FC');
  const bubble = chat.slice(start, chat.indexOf('interface QueuedMessage', start));
  assert.match(bubble, /<ThinkingMark color=/);
  assert.ok(!bubble.includes('THINKING_LABELS'), 'a default "Thinking" word is back');
  assert.match(bubble, /\{label \? \(/, 'a real label shows by itself');
  assert.match(bubble, /\) : \(\s*<ThinkingMark color=/, 'the mark shows only when there is no label');
});

test('the mark is a no-dependency lift and says where it came from', () => {
  const mark = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/bubbles/ThinkingMark.tsx'), 'utf8');
  assert.match(mark, /MIT, \(c\) 2022 Griffin Johnston/);
  assert.ok(!/from 'ldrs'/.test(mark), 'no runtime dependency on the library');
  assert.match(mark, /@keyframes osw-thinking-mark/);
});
