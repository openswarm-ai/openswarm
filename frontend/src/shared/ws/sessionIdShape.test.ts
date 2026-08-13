// Run: npm test
//
// ENG-205. A user saw `/api/agents/sessions/ae8813e9d5d20fb7.1 -> 404` plus a WS close. Measured
// across 248 real sessions: zero ids of that shape, and neither side constructs one. The point of
// this check is that the NEXT occurrence names its own producer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCanonicalSessionId,
  warnIfNotCanonicalSessionId,
  resetSessionIdWarnings,
} from './sessionIdShape.ts';

const REAL = 'ae8813e9d5d20fb7ae8813e9d5d20fb7';       // 32 hex, the shape we issue
const REPORTED = 'ae8813e9d5d20fb7.1';                  // exactly what the user's console showed

test('a real session id passes', () => {
  assert.equal(isCanonicalSessionId(REAL), true);
});

test('the id from the report is rejected', () => {
  assert.equal(isCanonicalSessionId(REPORTED), false, 'the reported id must be recognised as foreign');
});

test('the near misses are all caught, since the point is the SHAPE', () => {
  for (const bad of [
    'ae8813e9d5d20fb7',                       // 16 hex, half length
    'ae8813e9d5d20fb7ae8813e9d5d20fb7.1',     // full length plus a suffix
    'AE8813E9D5D20FB7AE8813E9D5D20FB7',       // uppercase
    'ae8813e9d5d20fb7ae8813e9d5d20fbg',       // non-hex char
    '',
  ]) {
    assert.equal(isCanonicalSessionId(bad), false, `${JSON.stringify(bad)} should not pass`);
  }
});

test('warning fires once per id, so a reconnect loop cannot flood the console', () => {
  resetSessionIdWarnings();
  const seen: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { seen.push(a); };
  try {
    warnIfNotCanonicalSessionId(REPORTED, 'createSessionWs');
    warnIfNotCanonicalSessionId(REPORTED, 'createSessionWs');
    warnIfNotCanonicalSessionId(REPORTED, 'createSessionWs');
  } finally {
    console.warn = orig;
  }
  assert.equal(seen.length, 1, `warned ${seen.length} times for one id`);
  assert.match(String(seen[0][0]), /ENG-205/);
  assert.match(String(seen[0][0]), /never issue/);
});

test('a good id never warns', () => {
  resetSessionIdWarnings();
  let warned = 0;
  const orig = console.warn;
  console.warn = () => { warned += 1; };
  try {
    assert.equal(warnIfNotCanonicalSessionId(REAL, 'createSessionWs'), true);
  } finally {
    console.warn = orig;
  }
  assert.equal(warned, 0, 'a legitimate id must be silent, or the warning becomes noise');
});
