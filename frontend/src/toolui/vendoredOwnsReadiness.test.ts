import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 2026-09-05: with the ShowUI bubble memoized on message identity, a data-table rendered under React.lazy + Suspense
// stayed a skeleton forever: the chunk had loaded and the lazy had resolved, but the boundary's retry never ran, and the
// only thing that drew the table was a later prop change through the memo. A lazily loaded widget must own its readiness.

test('the vendored loader delivers the component through state, never through Suspense', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/toolui/VendoredToolUi.tsx'), 'utf8');
  assert.ok(!/\bSuspense\b/.test(src), 'no Suspense boundary in the vendored path');
  assert.ok(!/\blazy\(/.test(src), 'no React.lazy in the vendored path');
  assert.ok(src.includes('setComponent(() => Loaded)'), 'the loaded component lands in state');
  assert.ok(src.includes("if (gate.state === 'pending' || !Component)"), 'the skeleton stays until BOTH the schema and the component are here');
});

test('every registry entry exposes a plain loader and none is a React.lazy', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/toolui/registry.tsx'), 'utf8');
  assert.ok(!/\blazy\(/.test(src));
  const entries = (src.match(/^\s+'[a-z-]+': \{/gm) || []).length;
  const loaders = (src.match(/^\s+load: \(\) => import\(/gm) || []).length;
  assert.equal(entries, 26);
  assert.equal(loaders, entries, 'one load() per entry');
});
