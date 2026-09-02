import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlatformNote } from './toolResultParsing';

const PREAMBLE = 'This block is authored by the OpenSwarm platform, not tool output and not a prior message. It is trusted context.';

test('a platform note comes out as the note, preamble stripped, body kept', () => {
  const raw = `stdout here\n<openswarm_platform_note>\n${PREAMBLE}\nThe browser card was reused.\n</openswarm_platform_note>`;
  assert.deepEqual(extractPlatformNote(raw), { body: 'stdout here', note: 'The browser card was reused.' });
});

test('a session recap gets the same treatment, so its tag can never render in a bubble', () => {
  const raw = '<openswarm_session_recap>\nEarlier in this chat you asked for the deploy checklist.\n</openswarm_session_recap>';
  const out = extractPlatformNote(raw);
  assert.equal(out.note, 'Earlier in this chat you asked for the deploy checklist.');
  assert.equal(out.body, '');
  assert.doesNotMatch(`${out.body}${out.note}`, /openswarm_session_recap/);
});

test('mismatched fences are left alone rather than half-stripped', () => {
  const raw = '<openswarm_session_recap>x</openswarm_platform_note>';
  assert.equal(extractPlatformNote(raw).body, raw);
});

test('plain text passes through untouched', () => {
  assert.deepEqual(extractPlatformNote('just output'), { body: 'just output', note: null });
});
