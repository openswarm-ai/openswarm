import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySystemNotice } from './systemNoticeKind';

// The old renderer returned null for a raw dump, on the theory that a friendly card was shown "on the
// assistant side". It is not: system-role messages never reach parseOpenSwarmError, so the user got a
// "needs attention" status over a blank transcript. Every row here is a real backend string.

test('the SDK subprocess dump is a raw error', () => {
  assert.equal(
    classifySystemNotice('Error: Command failed with exit code 1\n\nRuntime log tail:\nCheck stderr output for details'),
    'raw_error',
  );
});

test('a CLI API Error payload is a raw error even behind a friendly headline', () => {
  // The headline is ours, the json after it is the runtime's; unanchored matching keeps the json behind Details.
  assert.equal(
    classifySystemNotice('The agent runtime reported this turn failed (stop_sequence). API Error: 400 {"error":{"message":"Tool cannot have both defer_loading=true and cache_ (reset after 15s)"}}'),
    'raw_error',
  );
  assert.equal(classifySystemNotice('{"type":"error","error":{"type":"invalid_request_error"}}'), 'raw_error');
});

test('the autocompact thrash card the backend writes is a notice, not a dump', () => {
  assert.equal(
    classifySystemNotice('Error: The agent runtime reported this turn failed (stop_sequence). Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.'),
    'notice',
  );
});

test('the silent-quit and shutdown notes survive as notices', () => {
  assert.equal(
    classifySystemNotice('The agent stopped before reporting back. Its work so far is above; send a message to carry on from there.'),
    'notice',
  );
  assert.equal(
    classifySystemNotice("This chat was still running when OpenSwarm's engine shut down, so it stopped here; that was not your Stop. Send a message to continue from where it left off."),
    'notice',
  );
});

test('prose that merely mentions an API error is a notice; the colon is the marker', () => {
  // Decision pinned: no anchoring, because the runtime prefix can sit mid-message; instead the
  // markers are the runtime's own literal phrases, which our prose never uses verbatim.
  assert.equal(classifySystemNotice('The provider returned an API error, so OpenSwarm retried on its own.'), 'notice');
  assert.equal(classifySystemNotice("You've used your free runs. Connect a model to keep going."), 'notice');
});
