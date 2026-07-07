// Run: node --test frontend/src/shared/clickEffect.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickEffect } from './clickEffect.ts';

test('a click that changed the page fingerprint = changed', () => {
  assert.equal(clickEffect('u1|1200|BUTTON|0', 'u1|1214|BUTTON|0'), 'changed'); // menu opened (+14 nodes)
  assert.equal(clickEffect('u1|1200|BUTTON|0', 'u2|1200|BUTTON|0'), 'changed'); // navigated
  assert.equal(clickEffect('u1|1200|DIVfalse|0', 'u1|1200|DIVtrue|0'), 'changed'); // aria-expanded toggled
  assert.equal(clickEffect('u1|1200|BODY|0', 'u1|1200|BODY|380'), 'changed'); // scrolled
});

test('a click that changed NOTHING = none (the invisible wrong/dead-element failure)', () => {
  assert.equal(clickEffect('u1|1200|BUTTON|0', 'u1|1200|BUTTON|0'), 'none');
});

test('an unreadable fingerprint (empty) is not counted as a real no-effect', () => {
  assert.equal(clickEffect('', 'u1|1200|BUTTON|0'), 'none');
  assert.equal(clickEffect('u1|1200|BUTTON|0', ''), 'none');
});
