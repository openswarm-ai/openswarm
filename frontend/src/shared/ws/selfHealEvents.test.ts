import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// An event nobody consumes is a silent path: agent:free_trial_exhausted and agent:out_of_credits were
// emitted by the backend with a designed card and had no case in the switch. These pin the routing by
// reading the source, the same way queuedSendBubble.test.ts does.
const ws = fs.readFileSync(path.join(process.cwd(), 'src/shared/ws/WebSocketManager.ts'), 'utf8');
const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');

function arm(event: string): string {
  const start = ws.indexOf(`case '${event}':`);
  assert.ok(start > 0, `${event} must have a case`);
  const end = ws.indexOf('\n      case ', start + 1);
  return ws.slice(start, end);
}

test('the two blocked-session events fill the shared top-of-transcript slot', () => {
  assert.match(arm('agent:free_trial_exhausted'), /setContextOverflow\([\s\S]*reason: 'free_trial_exhausted'/);
  assert.match(arm('agent:out_of_credits'), /setContextOverflow\([\s\S]*reason: 'out_of_credits'/);
  assert.match(chat, /isFreeTrial \? 'Free runs used up'/);
  assert.match(chat, /isOutOfCredits \? 'Out of credits'/);
  assert.match(chat, /isFreeTrial \? 'Connect a model'/);
  assert.match(chat, /opensSettings \? 'Open Settings'/);
});

test('a restarted tool and a CLI compaction ride the self-heal pill', () => {
  assert.match(arm('agent:tool_recovered'), /setSelfHeal\([\s\S]*kind: 'tool_restarted'[\s\S]*outstanding_s/);
  assert.match(arm('agent:context_recovered'), /kind: 'context_overflow'/);
  assert.match(chat, /<SelfHealPill sessionId=\{session\.id\} \/>/);
});

test('cli_compacted never reaches recordCompaction, which zeroes tokens and plants the permanent marker', () => {
  const status = arm('agent:context_status');
  const compacted = status.indexOf("data.reason === 'compacted'");
  const cli = status.indexOf("data.reason === 'cli_compacted'");
  assert.ok(compacted > 0 && cli > compacted, 'both reasons are handled, ours first');
  assert.match(status.slice(compacted, cli), /recordCompaction\(/);
  assert.doesNotMatch(status.slice(cli), /recordCompaction\(/);
  assert.match(status.slice(cli), /kind: 'cli_compacted'/);
});
