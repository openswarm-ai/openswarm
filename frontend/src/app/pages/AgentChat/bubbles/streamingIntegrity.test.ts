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

test('the imperative append verifies its anchor before writing', () => {
  const i = smooth.indexOf('nodeRef.current.data = baseRef.current + pending;');
  assert.ok(i > 0, 'the fast path must still exist');
  const guard = smooth.slice(smooth.lastIndexOf('} else if', i), i);
  assert.ok(guard.includes('p_anchorIsFresh()'),
    'a length counter alone cannot tell that the markdown re-parse moved the node');
});

test('the freshness check compares live DOM data, not a counter', () => {
  const fn = smooth.slice(smooth.indexOf('const p_anchorIsFresh'), smooth.indexOf('const findLastTextNode'));
  assert.ok(fn.includes('node.data === baseRef.current'), 'the base must still describe the node');
  assert.ok(fn.includes('node.isConnected'), 'a detached node is not an anchor');
});

test('a stale anchor commits instead of silently skipping the frame', () => {
  // Skipping would stall the reveal; committing hands the whole string back to React, which cannot
  // corrupt it. The failure direction has to be "one extra render", never "wrong text".
  const i = smooth.indexOf('p_anchorIsFresh()');
  const branch = smooth.slice(i, i + 900);
  assert.ok(branch.includes('setCommittedLen(shown);'), 'the stale path must commit');
  assert.ok(!/else\s*\{\s*\}/.test(branch), 'no empty else');
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
