// Run: node --test frontend/src/shared/findComposerFrames.test.ts
//
// The structural composer finder must look inside child frames, not only the top document.
//
// deepMatch pierces shadow DOM (Reddit's shreddit, Slack, WhatsApp all build composers there) but
// it starts at `document` and recurses only into shadowRoot, so an IFRAME is a wall to it. Measured
// on blog.disqus.com after the cross-origin attach fix: the AX perception reported textboxes=1
// while find_composer returned found:false, because the two were reading different documents. That
// is the whole embedded-widget class: Disqus threads, helpdesk boxes, embedded compose views.
//
// These tests pin the CONTRACT of the fallback rather than the DOM search itself: the frame sweep
// runs only on a miss, it takes the first frame that finds something, and it reports which frame,
// because a caller that fills a selector has to know which document that selector belongs to.
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Found { found: boolean; selector?: string; frameSessionId?: string; frameUrl?: string }

/** The fallback as implemented in handleFindComposer, isolated so its contract can be tested. */
async function findWithFrames(
  top: () => Promise<Found>,
  children: Array<{ sessionId: string; url: string }>,
  inFrame: (sessionId: string) => Promise<Found>,
): Promise<Found> {
  let result = await top();
  if (!result || !result.found) {
    for (const child of children) {
      let r: Found;
      try { r = await inFrame(child.sessionId); } catch { continue; }
      if (r && r.found) return { ...r, frameSessionId: child.sessionId, frameUrl: child.url };
    }
  }
  return result;
}

const NONE = async (): Promise<Found> => ({ found: false });

test('a composer in the top document short-circuits, no frames are touched', async () => {
  let framesTried = 0;
  const r = await findWithFrames(
    async () => ({ found: true, selector: '[data-osw-composer="1"]' }),
    [{ sessionId: 'S1', url: 'https://disqus.com/embed' }],
    async () => { framesTried++; return { found: true }; },
  );
  assert.equal(r.found, true);
  assert.equal(framesTried, 0, 'the common case must pay nothing for this fallback');
  assert.equal(r.frameSessionId, undefined, 'a top-document hit belongs to no frame');
});

test('the disqus shape: nothing up top, the composer is in a child frame', async () => {
  const r = await findWithFrames(
    NONE,
    [{ sessionId: 'S_disqus', url: 'https://disqus.com/embed/comments/' }],
    async () => ({ found: true, selector: '[data-osw-composer="1"]' }),
  );
  assert.equal(r.found, true);
  assert.equal(r.frameSessionId, 'S_disqus');
});

test('the frame is REPORTED, because a selector is meaningless without its document', async () => {
  // The caller fills `result.selector` afterwards. Handing back a selector that resolves in a
  // frame the caller does not know about is how you get "filled it" with nothing filled.
  const r = await findWithFrames(NONE, [{ sessionId: 'S9', url: 'https://x.test/f' }],
    async () => ({ found: true, selector: '[data-osw-composer="1"]' }));
  assert.equal(r.frameSessionId, 'S9');
  assert.equal(r.frameUrl, 'https://x.test/f');
});

test('a frame that throws is skipped, not fatal', async () => {
  // A cross-origin frame can detach mid-sweep; one dead frame must not lose a live one behind it.
  const r = await findWithFrames(NONE,
    [{ sessionId: 'DEAD', url: 'about:blank' }, { sessionId: 'LIVE', url: 'https://ok.test' }],
    async (sid) => { if (sid === 'DEAD') throw new Error('target closed'); return { found: true }; });
  assert.equal(r.found, true);
  assert.equal(r.frameSessionId, 'LIVE');
});

test('no composer anywhere still reports a clean miss', async () => {
  const r = await findWithFrames(NONE, [{ sessionId: 'A', url: 'u' }], NONE);
  assert.equal(r.found, false);
  assert.equal(r.frameSessionId, undefined);
});
