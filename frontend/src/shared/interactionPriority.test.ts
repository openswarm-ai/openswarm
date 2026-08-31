// ENG-301: mid-gesture stream deltas must yield to the hand. Pins the decay contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markInteraction, interactionActive, installInteractionListeners } from './interactionPriority';

test('quiet by default', () => {
  assert.equal(interactionActive(), false);
});

test('active immediately after a gesture, decays after 350ms', async () => {
  markInteraction();
  assert.equal(interactionActive(), true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(interactionActive(), false);
});

// The bug this file caused: a blanket capture-phase wheel listener marked EVERY wheel, so scrolling
// the transcript of the answer you were reading paused that answer and then dumped it in one burst
// ("streams halfway, stops, then re-streams everything super fast"). The canvas owns that decision
// now and calls markInteraction() itself; nothing here may listen for wheel again.
test('installing listeners does NOT claim wheel: a transcript scroll must never stall the stream', () => {
  const seen: string[] = [];
  const g = globalThis as { window?: unknown };
  const realWindow = g.window;
  g.window = { addEventListener: (type: string) => { seen.push(type); } };
  try {
    installInteractionListeners();
  } finally {
    g.window = realWindow;
  }
  assert.ok(seen.length > 0, 'the install must actually have run (it latches after the first call)');
  assert.equal(seen.includes('wheel'), false, 'wheel must be claimed by the canvas, not globally');
  assert.equal(seen.includes('pointerdown'), true, 'a card drag must still suppress streaming');
  assert.equal(seen.includes('pointermove'), true);
});

test('the canvas is the one that marks a wheel, at the point it commits to handling it', () => {
  // Resolved from cwd, not from import.meta.url: the runner bundles tests into .test-build/, so a
  // URL relative to the bundle points at a directory that holds no sources.
  const src = readFileSync(
    'src/app/pages/Dashboard/hooks/interaction/useCanvasControls.ts',
    'utf8',
  );
  const mark = src.indexOf('markInteraction();');
  assert.ok(mark > 0, 'the canvas must mark its own gesture');
  // Ordering, not just presence: every "another surface owns this wheel" branch returns above the
  // mark, which is exactly what leaves a transcript scroll unmarked.
  assert.ok(src.indexOf('gesture.owner = windowEl;') < mark, 'app-window branch returns before the mark');
  assert.ok(src.indexOf('gesture.owner = CANVAS_OWNER;') < mark, 'the canvas claim precedes the mark');
  assert.ok(src.indexOf('e.preventDefault();', mark) - mark < 200, 'the mark sits with the canvas handling');
});
