import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Under a collapsed pill the vendored stats card stacked its three cells into a 336 px column (its grid
// minimum is 220 px per cell and the pill is 380 px wide). Compact density puts them side by side.
// A quarter-tiled chat column is under 440 px too, so the same density follows the CONTAINER width in the chat: dense
// cells and a 110 px minimum by default, the page's 220 px minimum only past 660 px (ENG-469 item 3).
test('density follows the container: dense by default, page density only in a wide container, compact forces dense', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/toolui/components/stats-display/stats-display.tsx'), 'utf8');
  assert.ok(src.includes('? "grid-cols-[repeat(auto-fit,minmax(110px,1fr))]"'));
  assert.ok(src.includes(': "grid-cols-[repeat(auto-fit,minmax(110px,1fr))] @[660px]:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]"'));
  assert.ok(src.includes('compact ? "min-h-16 px-3" : "min-h-16 px-3 @[440px]:min-h-28 @[440px]:px-6"'));
  assert.ok(src.includes('compact={compact}'), 'the density reaches every cell');
  assert.ok(src.includes('compact ? "min-w-0" : "min-w-80"'), 'the 320 px floor would overflow the pill');
});
