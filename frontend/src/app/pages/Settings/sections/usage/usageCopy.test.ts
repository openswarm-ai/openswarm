import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Chuya (1.7.9, 2026-09-04) read "$0.40 API value covered" as money she was being charged and filmed it
// going to $0.41 as proof the app was billing her instead of using her subscription. The figure is an
// estimate at pay-per-use rates; the label has to say so where the number is, not in a docs page.
test('the usage dollar figure says it is an estimate, not a bill, right under the number', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Settings/sections/usage/UsageStats.tsx'), 'utf8');
  assert.ok(!src.includes('API value covered'), 'the old label read as a charge');
  assert.ok(src.includes('Worth at API prices, not billed'), 'the label under the dollar figure must say it is not billed');
  assert.ok(src.includes('not a charge'), 'the section caption must say the figure is not a charge');
});
