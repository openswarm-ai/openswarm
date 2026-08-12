// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// The install id arrives with settings, so every sign-in button can be clicked before it exists.
// When that happened the app sent the user to the cloud with `install_id=` and they landed on a bare
// black page reading "install_id must be 8-128 chars" (seen live). A URL that cannot work should
// never be built in the first place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleStartUrl, isUsableInstallId } from './googleStartUrl.ts';

const PROXY = 'https://api.openswarm.com';
const REAL_ID = 'faec918d-6bda-42d5-9de9-f274eb49a8bc';

test('a real install id builds the URL the cloud expects', () => {
  const u = googleStartUrl(PROXY, REAL_ID, 8324);
  assert.equal(u, `https://api.openswarm.com/api/auth/google/start?install_id=${REAL_ID}&local_port=8324`);
});

test('settings not loaded yet refuses instead of building a doomed URL', () => {
  assert.equal(googleStartUrl(PROXY, '', 8324), null);
});

test('an id shorter than the cloud accepts is refused on this side of the network', () => {
  assert.equal(googleStartUrl(PROXY, '1234567', 8324), null, '7 chars is below the cloud minimum of 8');
  assert.notEqual(googleStartUrl(PROXY, '12345678', 8324), null, '8 chars is exactly the minimum and must pass');
});

test('an absurdly long id is refused too, matching the cloud bound', () => {
  assert.notEqual(googleStartUrl(PROXY, 'x'.repeat(128), 8324), null);
  assert.equal(googleStartUrl(PROXY, 'x'.repeat(129), 8324), null);
});

test('a trailing slash on the proxy does not produce a double slash', () => {
  const u = googleStartUrl('https://api.openswarm.com/', REAL_ID, 8324);
  assert.ok(u && !u.includes('.com//'), `double slash in ${u}`);
});

test('the port actually travels, since the bearer handoff POSTs back to it', () => {
  const u = googleStartUrl(PROXY, REAL_ID, 8411);
  assert.ok(u && u.includes('local_port=8411'));
});

test('the predicate agrees with the builder in both directions', () => {
  assert.equal(isUsableInstallId(undefined), false);
  assert.equal(isUsableInstallId(null), false);
  assert.equal(isUsableInstallId(''), false);
  assert.equal(isUsableInstallId(REAL_ID), true);
});
