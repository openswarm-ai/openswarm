// Haik's repro: 2 of 4 navigations never moved yet all 4 reported OK. These pin the verdict table
// so a nav that leaves the document parked on the old URL can only ever read as a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationOutcome, sameDoc } from './navigationOutcome';

test('a landed URL equal to the old page is stuck, never ok', () => {
  const v = navigationOutcome('https://en.wikipedia.org/wiki/Helium', 'https://en.wikipedia.org/wiki/Argon', 'https://en.wikipedia.org/wiki/Argon');
  assert.equal(v.kind, 'stuck');
});

test('an empty landed URL (webview gave nothing back) is stuck', () => {
  const v = navigationOutcome('https://a.com/x', 'https://a.com/y', '');
  assert.equal(v.kind, 'stuck');
});

test('landing on the requested URL is ok', () => {
  const v = navigationOutcome('https://a.com/x', 'https://a.com/y', 'https://a.com/x');
  assert.deepEqual(v, { kind: 'ok', url: 'https://a.com/x' });
});

test('landing elsewhere is reported as a redirect, not a silent ok', () => {
  const v = navigationOutcome('https://site.com/settings', 'https://site.com/home', 'https://site.com/login?next=settings');
  assert.equal(v.kind, 'redirected');
  assert.equal(v.url, 'https://site.com/login?next=settings');
});

test('re-navigating to the current page is ok (reload, no moved-document requirement)', () => {
  const v = navigationOutcome('https://a.com/x', 'https://a.com/x/', 'https://a.com/x');
  assert.equal(v.kind, 'ok');
});

test('no before URL (mid-mount card) degrades to ok rather than a false failure', () => {
  const v = navigationOutcome('https://a.com/x', '', '');
  assert.deepEqual(v, { kind: 'ok', url: 'https://a.com/x' });
});

test('sameDoc ignores only the trailing slash', () => {
  assert.equal(sameDoc('https://a.com', 'https://a.com/'), true);
  assert.equal(sameDoc('https://a.com/x', 'https://a.com/x#frag'), false);
});
