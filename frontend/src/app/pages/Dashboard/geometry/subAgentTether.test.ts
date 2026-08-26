// ENG-412: the sub-agent arrow was the one tether family with no anchor search. It left the parent's
// RIGHT edge and entered the child's LEFT edge unconditionally, which is only correct while the child
// sits in its spawn column; drag it left or above and the line looped back across both cards and read
// as an orange thread attached to nothing. Screenshot from production 1.7.9, 2026-08-26.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentCardHeight } from './agentCardHeight';
import { EXPANDED_CARD_MIN_H } from '@/shared/state/dashboardLayoutSlice';

const here = path.join(process.cwd(), 'src/app/pages/Dashboard/geometry');
const tethers = fs.readFileSync(path.join(here, 'dashboardTethers.ts'), 'utf8');

test('the sub-agent arrow goes through the shared anchor search', () => {
  const i = tethers.indexOf('const agentTethers =');
  assert.ok(i > 0, 'agentTethers must still exist');
  const body = tethers.slice(i, i + 400);
  assert.ok(body.includes('cardTether('), 'it must reuse the builder that picks anchors');
  assert.ok(!body.includes('srcX + src.width'), 'no hardcoded right-edge exit survives');
});

test('every tether family reads one height formula, so none can drift', () => {
  // Four hand-rolled copies disagreed on the expanded case; that is why the arrow anchored where
  // the card was not and the sibling stack cursor left cards overlapping.
  assert.equal(tethers.match(/Math\.max\(EXPANDED_CARD_MIN_H/g), null);
  assert.ok(tethers.match(/agentCardHeight\(/g)!.length >= 4);
  const restack = fs.readFileSync(
    path.join(process.cwd(), 'src/app/pages/Dashboard/hooks/lifecycle/useSiblingRestack.ts'), 'utf8');
  assert.ok(restack.includes('agentCardHeight('), 'the restack must agree with the tether by construction');
  assert.equal(restack.match(/Math\.max\(EXPANDED_CARD_MIN_H/g), null);
});

test('a measured height wins over the stored envelope, in both states', () => {
  assert.equal(agentCardHeight('a', 280, true, { a: 940 }), 940);
  assert.equal(agentCardHeight('a', 280, false, { a: 96 }), 96);
});

test('an unmeasured card falls back to the rendered envelope', () => {
  assert.equal(agentCardHeight('a', 280, true, {}), EXPANDED_CARD_MIN_H);
  assert.equal(agentCardHeight('a', 280, false, null), 280);
  // A browser card is never in the map, so its stored height must come back untouched.
  assert.equal(agentCardHeight('browser-1', 512, false, { 'chat-1': 900 }), 512);
});

test('a zero reading is a card mid-mount, not a flat card', () => {
  assert.equal(agentCardHeight('a', 280, true, { a: 0 }), EXPANDED_CARD_MIN_H);
});
