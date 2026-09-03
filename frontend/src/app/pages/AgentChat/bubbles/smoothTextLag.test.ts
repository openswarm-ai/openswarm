import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lagForGap, nextGapEma } from './useSmoothText';

// The CLI hands text over in ~90-char lumps every ~580 ms; a fixed 0.35 s lag drained each lump and
// then idled, and a 60 ms commit painted 12 characters at a time, which together read as "chunky".
// The lag now tracks the arrival interval so the reveal always has the next lump in hand, and the
// reveal commits every frame (3 characters a frame, measured free on a 9,000-char reply).

test('a lumpy lane gets a lag longer than its interval; a fine lane keeps the floor', () => {
  assert.equal(lagForGap(0.58), 0.725);
  assert.equal(lagForGap(0.05), 0.3);
  assert.equal(lagForGap(null), 0.3);
  assert.equal(lagForGap(5), 0.9);
});

test('the interval estimate seeds on the first gap and eases toward later ones', () => {
  const first = nextGapEma(null, 0.6);
  assert.equal(first, 0.6);
  const second = nextGapEma(first, 0.2);
  assert.ok(second < 0.6 && second > 0.2, String(second));
});

test('the reveal commits every frame, not in 60 ms word-sized steps', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/bubbles/useSmoothText.ts'), 'utf8');
  const m = src.match(/const COMMIT_MS = (\d+);/);
  assert.ok(m && Number(m[1]) <= 17, `COMMIT_MS is ${m && m[1]}`);
});
