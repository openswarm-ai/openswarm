// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// ENG-281: the question flow's "Other..." box rendered black text on a black field, because a bare
// <TextField> uses MUI's palette rather than ours. The defence is at the theme, so the assertion
// that matters is not "this field is styled" but "text and background can never be the same value".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputStyleOverrides } from './inputOverrides.ts';
import type { ClaudeTokens } from './claudeTokens';

// Two grounds, because the bug only showed on one of them and a light-only fix would have "passed".
const dark = {
  text: { primary: '#ECECEC', tertiary: '#8A8A8A', ghost: '#5A5A5A' },
  bg: { surface: '#1E1E1E' },
  border: { medium: '#333', strong: '#555' },
  accent: { primary: '#D97757' },
} as unknown as ClaudeTokens;

const light = {
  text: { primary: '#141414', tertiary: '#767676', ghost: '#A0A0A0' },
  bg: { surface: '#FFFFFF' },
  border: { medium: '#DDD', strong: '#BBB' },
  accent: { primary: '#D97757' },
} as unknown as ClaudeTokens;

for (const [name, tokens] of [['dark', dark], ['light', light]] as const) {
  test(`${name}: typed text is never the same colour as the surface it sits on`, () => {
    const root = inputStyleOverrides(tokens).root as Record<string, string>;
    const surface = (tokens as unknown as { bg: { surface: string } }).bg.surface;
    assert.notEqual(root.color, surface, 'text colour equals the surface behind the field');
  });

  test(`${name}: the override changes ONLY colour, never geometry or fill`, () => {
    // Regression guard on my own scope creep: an earlier version restyled 74 controls to fix a
    // contrast bug. Anything here that is not a colour is out of bounds.
    const root = inputStyleOverrides(tokens).root as Record<string, unknown>;
    for (const banned of ['borderRadius', 'backgroundColor', 'border', 'padding', 'height', 'fontSize']) {
      assert.equal(root[banned], undefined, `override sets ${banned}, which is not a readability fix`);
    }
  });

  test(`${name}: the inner input and textarea inherit the readable colour, not MUI's`, () => {
    const root = inputStyleOverrides(tokens).root as Record<string, Record<string, string>>;
    assert.equal(root['& input, & textarea'].color, (tokens as unknown as { text: { primary: string } }).text.primary);
  });

  test(`${name}: the placeholder is readable and not left on inherited opacity`, () => {
    const root = inputStyleOverrides(tokens).root as Record<string, Record<string, string | number>>;
    const ph = root['& input::placeholder, & textarea::placeholder'];
    assert.equal(ph.opacity, 1, 'MUI dims placeholders via opacity on an already-wrong colour');
    assert.notEqual(ph.color, (tokens as unknown as { bg: { surface: string } }).bg.surface);
  });
}

test('the override actually sets a colour at all, so a future empty return fails here', () => {
  const root = inputStyleOverrides(dark).root as Record<string, unknown>;
  assert.ok(root.color, 'override returned nothing to inherit');
  assert.ok(root['& input, & textarea'], 'inner input rule missing');
});
