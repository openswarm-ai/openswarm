// Run: npm test (frontend/scripts/run-tests.mjs)
//
// Eric's 1.7.8-exp.3 screenshot: the collapsed pill's question widget rendered visibly cut off,
// because "question" matched no family rule and fell to the 320px fallback while its option rows
// carry multi-sentence descriptions plus a composer. The frame must give ask-shaped widgets the
// wide family, and the width table stays ordered so the specific rules win before the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultWidthFor } from './PillArtifactFrame.tsx';

test('question and ask widgets get the wide family, not the 320 fallback', () => {
  assert.equal(defaultWidthFor('question'), 560);
  assert.equal(defaultWidthFor('question-flow'), 560);
  assert.equal(defaultWidthFor('ask'), 560);
});

test('tables keep their width and unknown names keep the fallback', () => {
  assert.equal(defaultWidthFor('data-table'), 560);
  assert.equal(defaultWidthFor('weather-widget'), 320);
});
