// ENG-331: past the floor the bell curve is at its widest; the floor moved 14 -> 20 on 2026-09-03 (60 chats were unreadable)
// relative to the tile; these pin that the curve never crosses the entries/actions divider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMagnifyTransforms } from './useDockLayout';

// The curve math is exercised at the old 14px floor on purpose: the numbers below were tuned there and the function is pure.
const TILE = 14;
const STEP = 18;
const ENTRIES = 40;
const bases: number[] = [];
const groups: string[] = [];
for (let i = 0; i < ENTRIES; i += 1) {
  bases.push(7 + i * STEP + TILE / 2);
  groups.push('entries');
}
const actionsTop = 7 + ENTRIES * STEP + 9;
for (let i = 0; i < 5; i += 1) {
  bases.push(actionsTop + i * STEP + TILE / 2);
  groups.push('actions');
}

test('hovering an action button never inflates the neighboring chat entry', () => {
  const cy = bases[ENTRIES];
  const { transforms, scales } = computeMagnifyTransforms(bases, groups, cy, TILE);
  for (let i = 0; i < ENTRIES; i += 1) {
    assert.equal(scales[i], 1, `entry ${i} scaled to ${scales[i]}`);
    assert.equal(transforms[i], '');
  }
  assert.ok(scales[ENTRIES] > 2, `hovered action should magnify, got ${scales[ENTRIES]}`);
});

test('hovering the last chat entry never inflates the action buttons below the divider', () => {
  const cy = bases[ENTRIES - 1];
  const { transforms, scales } = computeMagnifyTransforms(bases, groups, cy, TILE);
  for (let i = ENTRIES; i < bases.length; i += 1) {
    assert.equal(scales[i], 1, `action ${i - ENTRIES} scaled to ${scales[i]}`);
    assert.equal(transforms[i], '');
  }
  assert.ok(scales[ENTRIES - 1] > 2, 'hovered entry should magnify');
  assert.ok(scales[ENTRIES - 2] > 1, 'in-group neighbor keeps the macOS curve');
});

test('the curve itself still works mid-rail (no regression from the group mask)', () => {
  const cy = bases[20];
  const { scales } = computeMagnifyTransforms(bases, groups, cy, TILE);
  assert.ok(scales[20] > 2.5, 'center tile approaches the 44px target');
  assert.ok(scales[19] > scales[17], 'falloff is monotone toward the cursor');
});
