// A user who cannot update needs to be told what to DO.
//
// Every failure that was not a Chromium net:: error used to collapse into "Update check failed.
// Please try again later." A real 1.5.9 user sat on that message with a perfectly healthy release
// feed: the release, its ymls, checksums, signature and notarization all verified good. The cause
// was local and permanent, and the app told them to wait.
//
// Run: cd electron && node --test updateErrorMessage.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { friendlyUpdateError } = require('./updateErrorMessage');

const GENERIC = 'Update check failed. Please try again later.';

test('running from the disk image tells the user to move the app', () => {
  const msg = friendlyUpdateError(new Error('Cannot update while running on a read-only volume'), false);
  assert.match(msg, /Applications folder/);
  assert.notEqual(msg, GENERIC);
});

test('a Gatekeeper-translocated copy gets the same advice', () => {
  const msg = friendlyUpdateError(new Error('app is translocated'), false);
  assert.match(msg, /Applications folder/);
});

test('a quarantined Windows updater says so instead of "try again"', () => {
  const msg = friendlyUpdateError(new Error('Can not find Squirrel'), false);
  assert.match(msg, /antivirus/);
  assert.notEqual(msg, GENERIC);
});

test('an HTTP refusal reads as reachability, not as an unexplained failure', () => {
  for (const raw of ['HTTP error: Forbidden', 'ECONNRESET', 'unable to verify the first certificate']) {
    const msg = friendlyUpdateError(new Error(raw), false);
    assert.match(msg, /VPN or network/, `"${raw}" should read as reachability`);
  }
});

test('a full disk names the disk', () => {
  assert.match(friendlyUpdateError(new Error('ENOSPC: no space left on device'), false), /disk space/);
});

test('network errors keep their existing message', () => {
  const msg = friendlyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'), false);
  assert.match(msg, /Check your connection/);
});

test('the experimental-channel 404 still wins when prerelease is on, and NEVER claims latest', () => {
  const msg = friendlyUpdateError(new Error('404 Not Found: latest-mac.yml'), true);
  assert.match(msg, /Could not fetch the experimental build feed/);
  // A 404 usually means a release mid-publish (a dangling draft tag); asserting "you are on the
  // latest version" told users the opposite of the truth during every publish window.
  assert.doesNotMatch(msg, /latest version/);
});

test('the same 404 is NOT the experimental message when prerelease is off', () => {
  const msg = friendlyUpdateError(new Error('404 Not Found: latest-mac.yml'), false);
  assert.doesNotMatch(msg, /experimental build feed/);
});

test('a genuinely unknown failure still falls through to the generic message', () => {
  // The discriminating half. If everything matched something, the buckets would be meaningless.
  assert.equal(friendlyUpdateError(new Error('something nobody predicted'), false), GENERIC);
});

test('a null error does not throw', () => {
  assert.equal(typeof friendlyUpdateError(null, false), 'string');
  assert.equal(typeof friendlyUpdateError(undefined, true), 'string');
});
