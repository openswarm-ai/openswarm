import { test } from 'node:test';
import assert from 'node:assert/strict';
import { darkTokens, lightTokens } from '@/shared/styles/claudeTokens';

// The box you type an answer into used to be painted `bg.secondary`, which on the DARK palette sits
// BELOW the surface it lands on (#1f1e1b against #262624). Text contrast was never the problem
// (15.8:1); the tone was, and the one interactive element in the widget read as a recessed well.
//
// Asserted as a PROPERTY of the tokens, not as "the file says elevated": a palette edit that
// re-inverts the relationship has to fail here, which naming the token would not catch.

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('on dark, an input surface is never darker than the surface it sits on', () => {
  assert.ok(
    luminance(darkTokens.bg.elevated) > luminance(darkTokens.bg.surface),
    'bg.elevated must read as raised on dark, or the answer box is a well again',
  );
  assert.ok(
    luminance(darkTokens.bg.secondary) < luminance(darkTokens.bg.surface),
    'this pins WHY secondary was wrong here; if it ever rises above surface, revisit the choice',
  );
});

test('on light, the step is gentler than the one it replaced', () => {
  // Honest scope: this holds on LIGHT (0.053 vs 0.098) and NOT on dark, where elevated is a bigger
  // step than secondary was (0.0101 vs 0.0063) in the opposite direction. Direction is the fix on
  // dark; softness is the bonus on light. An earlier version of this test claimed both palettes and
  // was wrong, which is the whole reason it asserts numbers instead of a token name.
  const wasStep = Math.abs(luminance(lightTokens.bg.secondary) - luminance(lightTokens.bg.surface));
  const nowStep = Math.abs(luminance(lightTokens.bg.elevated) - luminance(lightTokens.bg.surface));
  assert.ok(nowStep < wasStep, `light tone step got harsher: ${nowStep} >= ${wasStep}`);
});

test('on light it still reads as a distinct panel, not an invisible one', () => {
  // The other direction of the same trade: soften it too far and the box stops being a box.
  const step = Math.abs(luminance(lightTokens.bg.elevated) - luminance(lightTokens.bg.surface));
  assert.ok(step > 0.02, `the panel vanished into the surface: step ${step}`);
});

test('text stays comfortably readable on it, which was never the bug but must not become one', () => {
  assert.ok(contrast(darkTokens.bg.elevated, darkTokens.text.primary) >= 7);
  assert.ok(contrast(lightTokens.bg.elevated, lightTokens.text.primary) >= 7);
});
