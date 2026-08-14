// Run: npm test (frontend/scripts/run-tests.mjs)
//
// Measured live on the packaged 1.7.8-exp.4 build: with the old `-EDGE / 2` geometry only 6 of 8
// handles were hittable at their own centre, because every card root clips with `overflow: hidden`
// and the outward half of each handle was clipped away. Anchoring them inside took it to 8/8.
//
// This is the cheap guard for that, so nobody reintroduces the outward offset because it looks
// tidier straddling the border.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESIZE_HANDLE_DEFS, RESIZE_CURSOR, type ResizeDir } from './cardResizeHandles.ts';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const ALL_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

test('no handle hangs outside the card, because overflow:hidden would clip it into a dead zone', () => {
  for (const { dir, css } of RESIZE_HANDLE_DEFS) {
    for (const side of SIDES) {
      const v = css[side];
      if (v === undefined) continue;
      assert.ok(
        typeof v === 'number' && v >= 0,
        `handle "${dir}" sets ${side}=${String(v)}; a negative offset is clipped away and unclickable`,
      );
    }
  }
});

test('every direction is present exactly once, so no edge silently loses its handle', () => {
  const dirs = RESIZE_HANDLE_DEFS.map((h) => h.dir);
  assert.equal(dirs.length, ALL_DIRS.length);
  assert.deepEqual([...dirs].sort(), [...ALL_DIRS].sort());
});

test('every direction has a cursor, so the affordance matches the behaviour', () => {
  for (const dir of ALL_DIRS) assert.ok(RESIZE_CURSOR[dir], `no cursor for "${dir}"`);
});

test('each handle is anchored to the edges it actually resizes', () => {
  const anchored = (dir: ResizeDir): string[] => {
    const def = RESIZE_HANDLE_DEFS.find((h) => h.dir === dir);
    assert.ok(def, `missing ${dir}`);
    return SIDES.filter((s) => def.css[s] === 0);
  };
  assert.deepEqual(anchored('n'), ['top']);
  assert.deepEqual(anchored('s'), ['bottom']);
  assert.deepEqual(anchored('e'), ['right']);
  assert.deepEqual(anchored('w'), ['left']);
  assert.deepEqual(anchored('se'), ['right', 'bottom']);
  assert.deepEqual(anchored('nw'), ['top', 'left']);
});

test('edge handles keep a real grab thickness rather than a hairline', () => {
  for (const dir of ['n', 's'] as ResizeDir[]) {
    const def = RESIZE_HANDLE_DEFS.find((h) => h.dir === dir);
    assert.ok(Number(def?.css.height) >= 6, `"${dir}" is too thin to hit`);
  }
  for (const dir of ['e', 'w'] as ResizeDir[]) {
    const def = RESIZE_HANDLE_DEFS.find((h) => h.dir === dir);
    assert.ok(Number(def?.css.width) >= 6, `"${dir}" is too thin to hit`);
  }
});
