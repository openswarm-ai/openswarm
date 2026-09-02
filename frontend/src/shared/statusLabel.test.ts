import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardStatusWord, friendlyStatusLabel } from './statusLabel';

const at = new Date().toISOString();

test('the raw enum reads as plain English', () => {
  assert.equal(friendlyStatusLabel('running'), 'working');
  assert.equal(friendlyStatusLabel('waiting_approval'), 'needs your OK');
  assert.equal(friendlyStatusLabel('error'), 'needs attention');
});

test('the admission gate no longer shares the word "queued" with the composer chip', () => {
  assert.equal(cardStatusWord({ status: 'running', queued: true }), 'waiting to start');
  assert.equal(cardStatusWord({ status: 'running', queued: false }), 'working');
});

test('a pill the collapsed card cannot show becomes its status word', () => {
  assert.equal(cardStatusWord({ status: 'running', reconnect_wait: { at } }), 'waiting for connection');
  assert.equal(cardStatusWord({ status: 'running', rate_limited: { at } }), 'rate limited');
  assert.equal(cardStatusWord({ status: 'running', provider_retrying: { at } }), 'provider busy');
  // Lost connection outranks a throttle: nothing else can progress until it is back.
  assert.equal(cardStatusWord({ status: 'running', reconnect_wait: { at }, rate_limited: { at } }), 'waiting for connection');
});

test('stale pill state on a finished session never overrides its real status', () => {
  assert.equal(cardStatusWord({ status: 'completed', reconnect_wait: { at }, queued: true }), 'done');
  assert.equal(cardStatusWord({ status: 'error', rate_limited: { at } }), 'needs attention');
});
