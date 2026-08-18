// Step-1 gate (AGENTCHAT_SPLIT_PLAN §6): pins the pure window math before any stateful extraction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_WINDOW_BUFFER_ITEMS,
  RENDER_ITEM_ESTIMATED_HEIGHT,
  WINDOW_BUFFER_SCREENS_PER_SIDE,
  computeDesiredWindow,
  estimateItemHeight,
  initialSeedItems,
  stringifyContent,
} from './messageWindow';
import type { RenderItem } from '../tool-bubbles/ToolGroupBubble';

const uniform = (h: number) => () => h;

test('initialSeedItems floors at the buffer minimum for tiny viewports', () => {
  assert.equal(initialSeedItems(0), MIN_WINDOW_BUFFER_ITEMS);
  assert.equal(initialSeedItems(1), MIN_WINDOW_BUFFER_ITEMS);
});

test('initialSeedItems seeds ONE screen (plus a quarter) at the shared row estimate, not the full buffer band', () => {
  // First paint mounts the minimum that fills the viewport; the post-settle recompute widens to the pixel band.
  const viewport = 1000;
  const expected = Math.ceil((1.25 * viewport) / RENDER_ITEM_ESTIMATED_HEIGHT);
  assert.equal(initialSeedItems(viewport), expected);
  assert.ok(expected < Math.ceil(((1 + WINDOW_BUFFER_SCREENS_PER_SIDE) * viewport) / RENDER_ITEM_ESTIMATED_HEIGHT));
});

test('computeDesiredWindow returns the empty window for an empty transcript', () => {
  assert.deepEqual(computeDesiredWindow(0, 500, 0, uniform(100), 1500), { start: 0, end: 0 });
});

test('computeDesiredWindow mounts everything when the keep band covers the transcript', () => {
  assert.deepEqual(computeDesiredWindow(0, 5000, 20, uniform(100), 1500), { start: 0, end: 20 });
});

test('computeDesiredWindow slices a pixel band around the viewport for a mid-scroll position', () => {
  // keepTop=500, keepBottom=4000 over 100px rows: first bottom>500 is index 5; last top<4000 is index 39.
  assert.deepEqual(computeDesiredWindow(2000, 500, 50, uniform(100), 1500), { start: 5, end: 40 });
});

test('computeDesiredWindow buffer is pixel-based, so tall items shrink the mounted count', () => {
  const tall = computeDesiredWindow(2000, 500, 50, uniform(500), 1500);
  const short = computeDesiredWindow(2000, 500, 50, uniform(100), 1500);
  assert.ok(tall.end - tall.start < short.end - short.start);
});

test('computeDesiredWindow reaches the item-count floor by pulling start back mid-transcript', () => {
  // keepTop=4000/keepBottom=4010 over 200px rows selects {20,21}; the floor pulls start back to 15.
  assert.deepEqual(computeDesiredWindow(4000, 10, 50, uniform(200), 0), { start: 15, end: 21 });
});

test('computeDesiredWindow floor is start-pullback only: near the top the window stays band-covering but smaller', () => {
  // The clamp never extends end forward, so at the transcript top {0,3} (600px mounted) is the contract.
  assert.deepEqual(computeDesiredWindow(400, 10, 50, uniform(200), 0), { start: 0, end: 3 });
});

test('computeDesiredWindow clamps a past-the-end scroll to a floored tail window', () => {
  // Content is 100px total; scrollTop far beyond it must not strand an empty window.
  assert.deepEqual(computeDesiredWindow(1000, 100, 10, uniform(10), 0), { start: 4, end: 10 });
});

test('stringifyContent passes strings through, empties null, serializes objects', () => {
  assert.equal(stringifyContent('hi'), 'hi');
  assert.equal(stringifyContent(null), '');
  assert.equal(stringifyContent(undefined), '');
  assert.equal(stringifyContent({ a: 1 }), '{"a":1}');
});

test('estimateItemHeight uses the collapsed fallback for tool rows', () => {
  const group = { type: 'tool_group' } as unknown as RenderItem;
  const pair = { type: 'tool_pair' } as unknown as RenderItem;
  assert.equal(estimateItemHeight(group, 800), 44);
  assert.equal(estimateItemHeight(pair, 800), 44);
});

test('estimateItemHeight uses the small flat estimate for thinking/system rows', () => {
  const thinking = { role: 'thinking', content: 'x' } as unknown as RenderItem;
  const system = { role: 'system', content: 'x' } as unknown as RenderItem;
  assert.equal(estimateItemHeight(thinking, 800), 60);
  assert.equal(estimateItemHeight(system, 800), 60);
});

test('estimateItemHeight scales message bubbles with content length', () => {
  const short = { role: 'assistant', content: 'hi' } as unknown as RenderItem;
  const long = { role: 'assistant', content: 'word '.repeat(500) } as unknown as RenderItem;
  assert.ok(estimateItemHeight(long, 800) > estimateItemHeight(short, 800));
});
