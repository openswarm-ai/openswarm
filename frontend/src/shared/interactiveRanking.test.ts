// Run: node --test frontend/src/shared/interactiveRanking.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankAndCapInteractives, goalKeywords, type RankItem } from './interactiveRanking.ts';

const mk = (role: string, name: string, id = 0): RankItem => ({ role, name, backendNodeId: id });

test('consecutive twins with same role+name collapse', () => {
  const { shown } = rankAndCapInteractives([
    mk('button', 'Like', 1),
    mk('button', 'Like', 2),
    mk('button', 'Like', 3),
    mk('button', 'Share', 4),
  ]);
  assert.deepEqual(shown.map((x) => x.backendNodeId), [1, 4]);
});

test('same role+name in different frames (sessionId) is NOT collapsed at the seam', () => {
  const root: RankItem = { role: 'button', name: 'Close', backendNodeId: 1 };
  const child: RankItem = { role: 'button', name: 'Close', backendNodeId: 2, sessionId: 'frameA' };
  const { shown } = rankAndCapInteractives([root, child]);
  // both survive: they are genuinely different elements across a frame boundary
  assert.equal(shown.length, 2);
  assert.ok(shown.some((x) => x.sessionId === 'frameA'));
});

test('non-consecutive same name is preserved (real list items)', () => {
  const { shown } = rankAndCapInteractives([
    mk('button', 'Add to cart', 1),
    mk('link', 'Widget A', 2),
    mk('button', 'Add to cart', 3),
    mk('link', 'Widget B', 4),
    mk('button', 'Add to cart', 5),
  ]);
  // all three "Add to cart" survive because they are not back-to-back
  const carts = shown.filter((x) => x.name === 'Add to cart');
  assert.equal(carts.length, 3);
});

test('display order is DOCUMENT order, not rank order (so ordinals can be counted)', () => {
  const { shown } = rankAndCapInteractives([
    mk('option', 'opt', 1),
    mk('checkbox', 'agree', 2),
    mk('button', 'Go', 3),
    mk('textbox', 'email', 4),
  ]);
  // all survive the cap; they render top-to-bottom as they appear on the page,
  // NOT re-sorted by role (which would scramble "the 4th thing")
  assert.deepEqual(shown.map((x) => x.backendNodeId), [1, 2, 3, 4]);
});

test('rank still decides cap SURVIVAL: a high-priority input buried in options is kept', () => {
  const items = [
    ...Array.from({ length: 40 }, (_, i) => mk('option', `opt${i}`, i)),
    mk('textbox', 'email', 900),
    ...Array.from({ length: 40 }, (_, i) => mk('option', `optb${i}`, 100 + i)),
  ];
  const { shown } = rankAndCapInteractives(items, { cap: 30 });
  assert.ok(shown.some((x) => x.backendNodeId === 900), 'the input survives the cap by rank');
});

test('preserves document order within the same priority tier', () => {
  const { shown } = rankAndCapInteractives([
    mk('button', 'First', 1),
    mk('link', 'Second', 2),
    mk('button', 'Third', 3),
  ]);
  // button and link share tier 1; original order First, Second, Third holds
  assert.deepEqual(shown.map((x) => x.backendNodeId), [1, 2, 3]);
});

test('caps to N and reports the truncated remainder', () => {
  const items = Array.from({ length: 150 }, (_, i) => mk('link', `L${i}`, i));
  const { shown, truncated } = rankAndCapInteractives(items, { cap: 60 });
  assert.equal(shown.length, 60);
  assert.equal(truncated, 90);
});

test('cap of 0 means no cap', () => {
  const items = Array.from({ length: 5 }, (_, i) => mk('link', `L${i}`, i));
  const { shown, truncated } = rankAndCapInteractives(items, { cap: 0 });
  assert.equal(shown.length, 5);
  assert.equal(truncated, 0);
});

test('goal-matched element survives the cap and displays IN PLACE (document order)', () => {
  const items = Array.from({ length: 100 }, (_, i) => mk('link', `Item ${i}`, i));
  items.push(mk('button', 'Checkout now', 999));  // last on the page
  const { shown } = rankAndCapInteractives(items, { cap: 30, goal: 'click checkout' });
  // it survives the cap (rank kept it)...
  assert.ok(shown.some((x) => x.backendNodeId === 999), 'checkout should be retained');
  // ...and renders at its real position (last), not floated to [0]
  assert.equal(shown[shown.length - 1].backendNodeId, 999);
});

test('display order stays document order with no goal', () => {
  const { shown } = rankAndCapInteractives([
    mk('option', 'opt', 1),
    mk('button', 'Go', 2),
    mk('textbox', 'email', 3),
  ]);
  assert.deepEqual(shown.map((x) => x.backendNodeId), [1, 2, 3]);
});

test('goalKeywords strips stopwords, action verbs, and short tokens', () => {
  assert.deepEqual(goalKeywords('Click the Submit button to send'), ['submit', 'send']);
  assert.deepEqual(goalKeywords('type into the search box'), ['search']);
  assert.deepEqual(goalKeywords(''), []);
});

test('empty input yields empty result', () => {
  const { shown, truncated } = rankAndCapInteractives([]);
  assert.equal(shown.length, 0);
  assert.equal(truncated, 0);
});

test('unknown role is not dropped (survives the cap), displayed in document order', () => {
  const { shown } = rankAndCapInteractives([
    mk('option', 'opt', 1),
    mk('weirdrole', 'mystery', 2),
    mk('textbox', 'field', 3),
  ]);
  assert.deepEqual(shown.map((x) => x.backendNodeId), [1, 2, 3]);
  assert.ok(shown.some((x) => x.role === 'weirdrole'));
});
