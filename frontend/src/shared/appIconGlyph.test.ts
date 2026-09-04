// Run: npm test (frontend/scripts/run-tests.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIconGlyph } from './appIconGlyph.ts';

test('an emoji is an icon; the stored default, words, initials and empties are not', () => {
  assert.equal(appIconGlyph('🚀'), '🚀');
  assert.equal(appIconGlyph(' 🇫🇷 '), '🇫🇷');
  assert.equal(appIconGlyph('👨‍💻'), '👨‍💻');
  assert.equal(appIconGlyph('view_quilt'), null);
  assert.equal(appIconGlyph('rocket'), null);
  assert.equal(appIconGlyph('A'), null);
  assert.equal(appIconGlyph('42'), null);
  assert.equal(appIconGlyph(''), null);
  assert.equal(appIconGlyph(undefined), null);
});
