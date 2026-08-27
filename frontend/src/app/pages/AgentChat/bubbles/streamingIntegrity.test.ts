// ENG-415: streamed answers corrupted themselves as they rendered. Two defects in one handoff.
//
// 1. `useSmoothText` paints the 60fps motion OUTSIDE React, writing into the last DOM text node,
//    while React's markdown re-parse writes the same text every 150ms. Two writers, synchronised
//    only by a length counter. A re-parse that moved the tail (a closing backtick, a list item, a
//    link) left `baseRef` describing a node that no longer held it, and `base + pending` then
//    re-emitted text the DOM already had at the wrong offset. Users pasted the result back:
//    "recallsByVehicle" arriving a second time as "ecallsByVehicle", "lsByVehicle".
//
// 2. `isOversizedInViewport` started false, so a long message on a FRESH mount rendered `{text: ''}`
//    until a measure pass rescued it. The stream handoff mounts a fresh bubble by construction, so
//    every long answer flashed blank and re-typed at the end of the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = path.join(process.cwd(), 'src/app/pages/AgentChat/bubbles');
const smooth = fs.readFileSync(path.join(here, 'useSmoothText.ts'), 'utf8');
const bubble = fs.readFileSync(path.join(here, 'MessageBubble.tsx'), 'utf8');

test('React is the ONLY writer of the revealed text', () => {
  // v2 tried to keep the 60fps imperative append and guard it with an anchor-freshness check.
  // DRILLED in a real Chromium DOM 2026-08-27: still corrupted 5 of 6 runs. React reconciles a text
  // node against ITS OWN previous value, not the live DOM, so once the node is mutated behind its
  // back React can skip the update and the injected characters survive. No guard can fix that,
  // because the damage is done before any guard could look.
  assert.ok(!/\.data\s*=/.test(smooth), 'nothing may write a DOM text node directly');
  assert.ok(!smooth.includes('createTreeWalker'), 'and nothing needs to go hunting for one');
  assert.ok(!smooth.includes('useLayoutEffect'), 'the re-apply effect went with it');
});

test('the reveal still advances, it just advances on commits', () => {
  assert.ok(smooth.includes('setCommittedLen(shown);'), 'the velocity model still drives it');
  assert.ok(/const COMMIT_MS = \d+;/.test(smooth));
  const ms = Number(smooth.match(/const COMMIT_MS = (\d+);/)![1]);
  assert.ok(ms <= 100, `commits ARE the reveal now; ${ms}ms would read as stepped`);
});

test('the typed feel is kept rather than dropped', () => {
  // hermes renders streamed text with a memoised parse, a caret, and no pacing at all. That is the
  // same conclusion one step further; the velocity model is what makes this read like typing.
  for (const knob of ['TARGET_LAG_S', 'RATE_SMOOTH_S', 'MAX_CPS']) {
    assert.ok(smooth.includes(knob), `${knob} is part of the feel this exists for`);
  }
});

test('an oversized bubble starts rendered and can only downgrade', () => {
  const i = bubble.indexOf('const [isOversizedInViewport, setIsOversizedInViewport] = useState(');
  assert.ok(i > 0);
  const decl = bubble.slice(i, i + 120);
  assert.ok(decl.includes('useState(true)'),
    'starting false blanks every fresh mount of a long message until a measure rescues it');
});

test('the measure can still place a message off-screen', () => {
  // The seed must not disable the placeholder; it only changes which direction the race resolves.
  assert.ok(bubble.includes('setIsOversizedInViewport(false)'), 'the downgrade path must survive');
  assert.ok(bubble.includes('IntersectionObserver'));
});

test('streaming still forces markdown on, regardless of length', () => {
  // isOversized is gated on !isStreaming; a streaming bubble must never take the placeholder path.
  const i = bubble.indexOf('const isOversized =');
  assert.ok(bubble.slice(i, i + 160).includes('!isStreaming'));
});
