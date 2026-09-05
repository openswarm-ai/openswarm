// Run: npm test (frontend/scripts/run-tests.mjs)
//
// A 5,000-row data-table in one expanded chat was 742,090 of the page's 793,776 React fibers (census,
// 2026-09-05): every row rendered, and twice, because the auto layout mounted the table AND the card view
// and hid one with a container query. Rows are now handed out a window at a time and one layout mounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderedRowCount, pickLayout, RENDER_ROW_WINDOW, CARD_LAYOUT_MAX_WIDTH } from './utilities.ts';

test('rows come in windows; a short table is whole, a long one is one window until asked for more', () => {
  assert.equal(renderedRowCount(5, 1), 5);
  assert.equal(renderedRowCount(5000, 1), RENDER_ROW_WINDOW);
  assert.equal(renderedRowCount(5000, 2), 2 * RENDER_ROW_WINDOW);
  assert.equal(renderedRowCount(70, 2), 70);
  assert.equal(renderedRowCount(5000, 0), RENDER_ROW_WINDOW, 'zero windows still shows the first');
});

test('one layout is picked from the measured width; unmeasured is the wide one, explicit layouts are honoured', () => {
  assert.equal(pickLayout('auto', null), 'table');
  assert.equal(pickLayout('auto', CARD_LAYOUT_MAX_WIDTH), 'table');
  assert.equal(pickLayout('auto', CARD_LAYOUT_MAX_WIDTH - 1), 'cards');
  assert.equal(pickLayout('cards', 2000), 'cards');
  assert.equal(pickLayout('table', 100), 'table');
});

test('the component maps the windowed rows, never the whole payload, and no longer mounts the hidden twin', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/toolui/components/data-table/data-table.tsx'), 'utf8');
  assert.doesNotMatch(src, /@md:(block|hidden)/, 'the pair-and-hide container query is what doubled every row');
  assert.match(src, /<TableBody>\s*\{rows\.map\(/, 'the table body maps the window');
  assert.doesNotMatch(src, /\{data\.map\(\(row/, 'nothing maps the full payload into the DOM');
  assert.match(src, /renderedRowCount\(data\.length, windows\)/);
});
