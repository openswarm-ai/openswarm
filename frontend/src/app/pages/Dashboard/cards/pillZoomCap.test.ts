import { test } from 'node:test';
import assert from 'node:assert/strict';

// Haik, exp.9 at 18% zoom: the collapsed pill counter-zoomed up to 4x and dwarfed the cards it sat beside.
test('the collapsed pill counter-zooms to at most twice its size', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const here = url.fileURLToPath(new URL('.', import.meta.url));
  // The test runs from .test-build, so resolve the source next to it by name (both separators, Windows CI).
  const candidates = [
    here + 'AgentCard.tsx',
    here.replace(/([\\/])\.test-build([\\/])/, '$1src$2') + 'AgentCard.tsx',
  ];
  const path = candidates.find((p) => fs.existsSync(p));
  assert.ok(path, `could not locate AgentCard.tsx from ${here}`);
  const src = fs.readFileSync(path as string, 'utf8');
  const rule = src.match(/zoom: 'max\(1, min\((\d+), calc\(0\.9 \/ var\(--canvas-zoom, 1\)\)\)\)'/);
  assert.ok(rule, 'the pill zoom rule must still be the one map-pin expression');
  assert.equal(Number(rule![1]), 2);
});
