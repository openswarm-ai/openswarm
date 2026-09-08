import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerRetryHint, providerRetryLabel } from './providerRetryLabel';

test('the pill names what the CLI is waiting on', () => {
  assert.equal(providerRetryLabel('unreachable', 3), "Can't reach the model, retrying (attempt 3)");
  assert.equal(providerRetryLabel('provider_error', 1), 'Provider error, retrying (attempt 1)');
  assert.equal(providerRetryLabel('rate_limit', null), 'Rate limited, retrying');
  assert.equal(providerRetryLabel('auth', 2), 'Login rejected, retrying (attempt 2)');
});

test('an older backend that sends no kind still reads as before', () => {
  assert.equal(providerRetryLabel(null, 4), 'Provider busy, retrying (attempt 4)');
  assert.equal(providerRetryLabel(undefined, null), 'Provider busy, retrying');
});

test('the hover says whose fault it is', () => {
  assert.match(providerRetryHint('unreachable'), /router on this machine/);
  assert.match(providerRetryHint('auth'), /reconnect/);
  assert.match(providerRetryHint(null), /hiccup/);
});
