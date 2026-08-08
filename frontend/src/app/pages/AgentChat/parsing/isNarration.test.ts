// The answer must never be filed as tool chrome.
//
// Live case this exists for: an agent wrote a 1,060-word decision memo, then saved a memory. That
// one trailing tool call reclassified the memo as narration, so the card showed the user's question,
// a grey "3 tool calls" row, and nothing else. 0 of 1,060 words in the DOM. The run was marked done
// and charged $0.22. Expanding the row showed the memo as raw markdown in 12px grey, labelled with
// the file the agent had read.
//
// Run: cd frontend && npx tsx --test src/app/pages/AgentChat/parsing/isNarration.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNarration } from './isNarration.ts';

test('short passing remarks are narration', () => {
  for (const s of [
    'Let me check that.',
    'Found the session log. Setting up the monitor now.',
    'Good question, let me look at what the workflow actually does rather than answer from memory.',
    'One moment.',
  ]) {
    assert.equal(isNarration(s), true, `should absorb: ${s}`);
  }
});

test('a long answer is never narration', () => {
  const memo = 'The recommendation is to use a managed platform. '.repeat(12);
  assert.ok(memo.length > 240);
  assert.equal(isNarration(memo), false);
});

test('structure means it is a deliverable, however short', () => {
  for (const s of [
    '# Decision Memo',
    '## Bottom line\nManaged, not self-hosted.',
    '- Docusaurus\n- Astro Starlight',
    '1. First\n2. Second',
    '> A quoted conclusion.',
    '```\nkubectl apply -f .\n```',
    '| Platform | Cost |\n| --- | --- |',
  ]) {
    assert.equal(isNarration(s), false, `should stay visible: ${s.slice(0, 24)}`);
  }
});

test('the real memo opening is not narration', () => {
  const opening = '# Decision Memo: Kubernetes Hosting for a 12-Person Company\n\n'
    + '**Recommendation: use a managed platform. Do not self-host.**';
  assert.equal(isNarration(opening), false);
});

test('a bare sentence mentioning a dash is still narration', () => {
  // The structure test anchors to line starts, so prose containing a hyphen must not trip it.
  assert.equal(isNarration('Checking the well-known ports first.'), true);
});

test('empty and non-string content absorb rather than render an empty bubble', () => {
  assert.equal(isNarration(''), true);
  assert.equal(isNarration('   '), true);
  assert.equal(isNarration(null), true);
  assert.equal(isNarration(undefined), true);
  assert.equal(isNarration(42), true);
});

test('the asymmetry is respected at the boundary', () => {
  // Bias is deliberate: a redundant line costs noise, a hidden answer costs the whole run.
  assert.equal(isNarration('x'.repeat(240)), true);
  assert.equal(isNarration('x'.repeat(241)), false);
});
