import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ambientShape, AMBIENT_TABLE_ROWS } from './showUiAmbient';

// A collapsed pill on the drill board rendered a 5,000-row data-table in full: 370K of 424K fibers,
// paid on every layout pass by every chat (ENG-467/468). The resting artifact gets a screenful.
test('a pill data-table is cut to a screenful and says how much it left out', () => {
  const data = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row ${i}` }));
  const shaped = ambientShape('data-table', { columns: [{ key: 'name' }], data });
  assert.equal((shaped.props.data as unknown[]).length, AMBIENT_TABLE_ROWS);
  assert.equal(shaped.note, 'Showing 8 of 5,000 rows. Open the chat for the whole table.');
  assert.equal(data.length, 5000, 'the original props are not mutated');
});

test('a short table and other widgets pass through untouched', () => {
  const small = { columns: [], data: [{ id: 1 }, { id: 2 }] };
  assert.equal(ambientShape('data-table', small).props, small);
  assert.equal(ambientShape('data-table', small).note, null);
  const chart = { series: Array.from({ length: 5000 }, (_, i) => i) };
  assert.equal(ambientShape('line-chart', chart).props, chart);
});

test('a pill stats card is asked for its compact density', () => {
  const shaped = ambientShape('stats-display', { stats: [] });
  assert.equal(shaped.props.compact, true);
});

test('the widget view applies the shaping only on the ambient surface, and is memoized', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/tool-ui/ShowUiWidgetView.tsx'), 'utf8');
  assert.ok(src.includes("ambient && !perfBaselineFor('ambient') ? ambientShape(payload.name, raw)"), 'the chat keeps the whole table; only the pill is shaped');
  assert.ok(src.includes("export default perfBaselineFor('ambient') ? ShowUiWidgetView : React.memo(ShowUiWidgetView)"));
});
