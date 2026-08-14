// Run: npm test (frontend/scripts/run-tests.mjs)
//
// ENG-290. App cards could only be resized on the preview tab: the code/terminal/history panel fills
// the card and sat ABOVE the resize handles, so the grab strips were buried the moment you switched
// tabs. The bug was purely an ordering mistake between two numbers written 700 lines apart, which is
// the kind of thing nobody re-derives while reading a component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_OVERLAY_Z, RESIZE_HANDLE_Z } from './cardLayers.ts';

test('resize handles sit above any content that fills the card', () => {
  assert.ok(
    RESIZE_HANDLE_Z > CONTENT_OVERLAY_Z,
    `handles at ${RESIZE_HANDLE_Z} are under the content overlay at ${CONTENT_OVERLAY_Z}, so the `
    + 'card cannot be resized wherever that content shows',
  );
});

test('the two layers are distinct, so neither can silently absorb the other', () => {
  assert.notEqual(RESIZE_HANDLE_Z, CONTENT_OVERLAY_Z);
});
