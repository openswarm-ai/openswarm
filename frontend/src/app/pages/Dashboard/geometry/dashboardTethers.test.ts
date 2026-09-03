// Run: npm test (frontend/scripts/run-tests.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSides, fanFractions, headPath, route, layoutLinks, HEAD_PX, type Rect } from './dashboardTethers.ts';

const r = (x: number, y: number, w = 200, h = 100): Rect => ({ x, y, width: w, height: h });

test('the facing edges are chosen by the wider gap, so a line never loops back across its own card', () => {
  assert.deepEqual(pickSides(r(0, 0), r(400, 0)), { src: 'right', dst: 'left' });
  assert.deepEqual(pickSides(r(400, 0), r(0, 0)), { src: 'left', dst: 'right' });
  assert.deepEqual(pickSides(r(0, 0), r(0, 400)), { src: 'bottom', dst: 'top' });
  assert.deepEqual(pickSides(r(0, 400), r(0, 0)), { src: 'top', dst: 'bottom' });
  // Above-right but far more above than right: vertical pair, not a sideways entry into a top edge.
  assert.deepEqual(pickSides(r(0, 800), r(60, 0)), { src: 'top', dst: 'bottom' });
});

test('one line leaves the middle spot; several fan out across the band in order of their targets', () => {
  assert.deepEqual(fanFractions(1), [0.54]);
  const three = fanFractions(3);
  assert.equal(three.length, 3);
  assert.ok(three[0] < three[1] && three[1] < three[2]);
  assert.ok(three[0] >= 0.4 && three[2] <= 0.72);
});

test('the head points the way the line enters and the line stops short of the tip', () => {
  const head = headPath({ x: 400, y: 50, side: 'left' }, 9);
  assert.ok(head.startsWith('M 400,50 L 391,'), head);
  const routed = route({ x: 200, y: 50, side: 'right' }, { x: 400, y: 50, side: 'left' }, 9);
  assert.ok(routed.path.endsWith(`H ${400 - 9 * 0.7}`), routed.path);
  const vertical = route({ x: 100, y: 100, side: 'bottom' }, { x: 100, y: 500, side: 'top' }, 9);
  assert.ok(vertical.path.startsWith('M 100,100 V'), vertical.path);
  assert.ok(vertical.path.endsWith(`V ${500 - 9 * 0.7}`), vertical.path);
});

test('three children of one chat leave its right edge at three different heights, sorted by where they sit', () => {
  const parent = r(0, 0, 300, 600);
  const links = [
    { key: 'c', srcId: 'p', src: parent, dstId: 'c', dst: r(600, 900), label: '', fading: false, glow: false },
    { key: 'a', srcId: 'p', src: parent, dstId: 'a', dst: r(600, -300), label: '', fading: false, glow: false },
    { key: 'b', srcId: 'p', src: parent, dstId: 'b', dst: r(600, 300), label: '', fading: false, glow: false },
  ];
  const out = layoutLinks(links, 1);
  const startY = (path: string): number => Number(path.match(/^M [\d.-]+,([\d.-]+)/)![1]);
  const byKey = Object.fromEntries(out.map((t) => [t.key, startY(t.path)]));
  assert.ok(byKey.a < byKey.b && byKey.b < byKey.c, JSON.stringify(byKey));
  assert.equal(new Set(Object.values(byKey)).size, 3);
});

test('head and label are sized against the committed zoom so they hold on screen', () => {
  const link = { key: 'k', srcId: 'p', src: r(0, 0), dstId: 'c', dst: r(400, 0), label: 'Sub-agent', fading: false, glow: true };
  const [zoomed] = layoutLinks([link], 0.5);
  const [flat] = layoutLinks([link], 1);
  assert.equal(zoomed.labelScale, 2);
  assert.equal(flat.labelScale, 1);
  // The head's base sits HEAD_PX / zoom behind the tip in canvas units.
  assert.ok(zoomed.head.includes(`L ${400 - HEAD_PX / 0.5},`), zoomed.head);
  assert.ok(flat.head.includes(`L ${400 - HEAD_PX},`), flat.head);
});
