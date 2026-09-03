import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hiddenCounts, TILE_MIN } from './useDockLayout';

// Sixty chats shrank the rail to 14px glyphs and the faded last tile read as "cut off hella" (Eric,
// 2026-09-03). The floor is legible, a wheel settles on whole tiles, and each edge says how many
// tiles are past it and pages that way on click.

test('the tile floor is legible', () => {
  assert.ok(TILE_MIN >= 20, `floor ${TILE_MIN}`);
});

test('hidden counts are whole tiles above and below the clip box', () => {
  const step = 26;
  assert.deepEqual(hiddenCounts(0, 520, 1560, step), { above: 0, below: 40 });
  assert.deepEqual(hiddenCounts(520, 520, 1560, step), { above: 20, below: 20 });
  assert.deepEqual(hiddenCounts(1040, 520, 1560, step), { above: 40, below: 0 });
  assert.deepEqual(hiddenCounts(0, 520, 400, step), { above: 0, below: 0 });
});

test('the column snaps to tiles and the edge chips carry the count and a click', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Dashboard/desktop/DesktopDock.tsx'), 'utf8');
  assert.match(src, /scrollSnapType: 'y proximity'/);
  assert.match(src, /scrollSnapAlign: 'start'/);
  assert.match(src, /data-dock-hidden=\{c\.count\}/);
  assert.match(src, /el\.scrollBy\(\{ top: direction/);
  assert.doesNotMatch(src, /pointerEvents: 'none',\s*zIndex: 40/, 'the edge chip must be clickable');
});
