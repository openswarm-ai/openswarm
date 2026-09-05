import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toolUiBubblePropsEqual } from './toolUiBubbleEqual';

// The transcript rebuilds every pair object on every streamed delta (the pair list is a useMemo on
// the messages array), so a memo on pair identity would never bail. The messages inside keep their
// identity across deltas, and that is what the comparator reads.
const call = { id: 'c1', role: 'tool_call', content: { tool: 'ShowUI', input: {} } } as never;
const result = { id: 'r1', role: 'tool_result', content: 'ok' } as never;
const base = { pair: { type: 'tool_pair' as const, id: 'p', call, result }, sessionId: 's', isPending: false, suppressReveal: false, sessionRunning: false };

test('a rebuilt pair around the same messages is equal', () => {
  assert.equal(toolUiBubblePropsEqual(base, { ...base, pair: { ...base.pair } }), true);
});

test('a new result object, a pending flip, or a run-state flip is not equal', () => {
  assert.equal(toolUiBubblePropsEqual(base, { ...base, pair: { ...base.pair, result: { ...(result as object) } as never } }), false);
  assert.equal(toolUiBubblePropsEqual(base, { ...base, isPending: true }), false);
  assert.equal(toolUiBubblePropsEqual(base, { ...base, sessionRunning: true }), false);
});

test('the bubble is exported through React.memo with that comparator and parses the payload off the messages', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/tool-ui/ToolUiBubble.tsx'), 'utf8');
  assert.ok(src.includes("export default perfBaselineFor('ambient') ? ToolUiBubble : React.memo(ToolUiBubble, toolUiBubblePropsEqual)"));
  assert.ok(src.includes('useMemo(() => parseShowUiPayload(pair), [pair.call, pair.result])'));
});
