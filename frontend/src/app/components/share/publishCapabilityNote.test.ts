// The publish limits are stated on EVERY path to publish, not just the clean one (ENG-293).
//
// A published app is a static bundle plus two same-origin bridges, so anything that fetches its own
// backend works in preview and 404s the moment it is live. Acceptance 3 on the issue is that the user
// learns this BEFORE they commit. The note shipped on the "looks good" screen only, so a user with
// security findings, who reaches the same Publish button through the warning screen, never saw it.
// This is a source assertion rather than a render test because the component is one static block with
// no state: the only way it can regress is by being dropped from a branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src/app/components/share/PublishModal.tsx'), 'utf8');

test('every review branch that can reach Publish also states the limits', () => {
  const uses = src.match(/<CapabilityNote\b/g) || [];
  assert.ok(uses.length >= 2, `both the clean and the findings review screens must carry it, saw ${uses.length}`);
});

test('the note names what is missing in the words a user would search for', () => {
  const note = src.slice(src.indexOf('const CapabilityNote'), src.indexOf('const PublishModal'));
  for (const word of ['static', 'server', 'database', 'backend']) {
    assert.match(note, new RegExp(word, 'i'), `the note must say "${word}" plainly`);
  }
});

test('it does not promise a backend that publishing cannot carry', () => {
  const note = src.slice(src.indexOf('const CapabilityNote'), src.indexOf('const PublishModal'));
  assert.ok(!/will work once/i.test(note), 'no reassurance the deploy cannot back');
});
