import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The OAuth claim lands on the backend after the popup closes and may never post back (system browser).
// The page settles on the backend's tools:updated broadcast, the popup's message, or a close-poll that
// keeps reading for 12 s, never on one status read at close time.

test('the socket refetches an updated tool and tells the page', () => {
  const ws = fs.readFileSync(path.join(process.cwd(), 'src/shared/ws/WebSocketManager.ts'), 'utf8');
  assert.match(ws, /case 'tools:updated':/);
  assert.match(ws, /store\.dispatch\(fetchToolStatus\(data\.tool_id\)\)/);
  assert.match(ws, /new CustomEvent\('openswarm:tool-updated'/);
});

test('the Tools page settles once, from three doors, and keeps checking after the popup closes', () => {
  const hook = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Tools/hooks/useToolConnections.ts'), 'utf8');
  assert.match(hook, /addEventListener\('openswarm:tool-updated', onUpdated\)/);
  assert.match(hook, /closedChecks >= 12/);
  assert.match(hook, /if \(settled\) return;/);
  assert.doesNotMatch(hook, /clearInterval\(pollInterval\);\s*afterConnect\(\);/, 'the one-shot read at close time must be gone');
});
