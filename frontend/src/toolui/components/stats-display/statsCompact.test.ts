import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Under a collapsed pill the vendored stats card stacked its three cells into a 336 px column (its grid
// minimum is 220 px per cell and the pill is 380 px wide). Compact density puts them side by side.
test('compact density narrows the grid minimum and the cell so three stats fit a pill', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/toolui/components/stats-display/stats-display.tsx'), 'utf8');
  assert.ok(src.includes('compact ? "repeat(auto-fit, minmax(110px, 1fr))" : "repeat(auto-fit, minmax(220px, 1fr))"'));
  assert.ok(src.includes('compact ? "min-h-16 px-3" : "min-h-28 px-6"'));
  assert.ok(src.includes('compact={compact}'), 'the density reaches every cell');
  assert.ok(src.includes('compact ? "min-w-0" : "min-w-80"'), 'the 320 px floor would overflow the pill');
});
