import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importNeedsConfirm } from './importNeedsConfirm';
import type { ImportPreflight } from './shareTypes';

function preflight(rootType: string, includes: string[] = [], review: ImportPreflight['review'] = null): ImportPreflight {
  return {
    summary: {
      root: { type: rootType, name: 'x' },
      includes: includes.map((type) => ({ type, name: type })),
      requirements: [],
    },
    review,
  } as unknown as ImportPreflight;
}

test('a skill never imports silently: it rides every future agent turn', () => {
  assert.equal(importNeedsConfirm(preflight('skill')), true);
  assert.equal(importNeedsConfirm(preflight('dashboard', ['skill'])), true);
});

test('inert data still imports straight away', () => {
  assert.equal(importNeedsConfirm(preflight('dashboard')), false);
  assert.equal(importNeedsConfirm(preflight('workflow', ['dashboard'])), false);
});

test('apps and failed reviews keep their confirm', () => {
  assert.equal(importNeedsConfirm(preflight('app')), true);
  assert.equal(importNeedsConfirm(preflight('dashboard', [], { verdict: 'flagged', findings: ['x'], scanned_files: [] })), true);
});
