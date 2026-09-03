import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// MUI Collapse keeps a hidden child MOUNTED. On a loaded board (2026-09-02) one expanded chat held 13,011
// elements with 21 transcript items mounted: 12,944 of them sat inside 221 collapsed tool bodies, and the
// page carried 116K elements with ten chats open, the multiplier behind every whole-subtree style cost.
const dir = path.join(process.cwd(), 'src/app/pages/AgentChat/tool-bubbles');

for (const file of ['DefaultToolBubble.tsx', 'CompactMcpBubble.tsx', 'ToolGroupBubble.tsx', 'AgentResponseBody.tsx']) {
  test(`${file}: every collapsed body leaves the DOM (unmountOnExit)`, () => {
    const src = readFileSync(path.join(dir, file), 'utf8');
    const opens = [...src.matchAll(/<Collapse\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(opens.length > 0, 'no Collapse found');
    for (const tag of opens) assert.ok(tag.includes('unmountOnExit'), `${file}: ${tag} keeps its hidden body mounted`);
  });
}
