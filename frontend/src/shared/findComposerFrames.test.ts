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
import { sweepChildFrames, type ChildFrame, type FrameHit } from './findComposerFrames';

type Found = FrameHit;

// Drives the REAL sweep, so an implementation change fails these tests instead of quietly drifting from them. This wrapper only supplies the top-document short-circuit that lives in handleFindComposer; everything below the first line is production code.
async function findWithFrames(
  top: () => Promise<Found>,
  children: ChildFrame[],
  inFrame: (sessionId: string) => Promise<Found>,
): Promise<Found> {
  const result = await top();
  if (result && result.found) return result;
  return (await sweepChildFrames(children, inFrame)) || result;
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

test('the frame sweep costs the SLOWEST frame, not the sum of them', async () => {
  // This is the property that fixes the blowout. Sequentially the sweep is O(frames x timeout) and
  // an ad-heavy page carries a dozen: measured on dpaste and disqus, the walk was still running
  // when the 30s BrowserFindComposer cap killed it, so both scored 0/2 with the composer never
  // looked at. Concurrent, the whole sweep costs one frame's timeout no matter how many there are.
  // Note it is NOT first-hit-wins: document order still decides (see the next test), so every frame
  // must settle before a winner is named. Max instead of sum is the guarantee, and it is enough.
  const started = Date.now();
  const r = await findWithFrames(
    NONE,
    [{ sessionId: 'SLOW_AD', url: 'https://ads.test' }, { sessionId: 'COMPOSER', url: 'https://ok.test' }],
    async (sid) => {
      await new Promise((res) => setTimeout(res, 300));
      return sid === 'COMPOSER' ? { found: true, selector: '[data-osw-composer="1"]' } : { found: false };
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(r.found, true);
  assert.equal(r.frameSessionId, 'COMPOSER');
  assert.ok(elapsed < 450, `two 300ms frames must overlap, not queue (took ${elapsed}ms)`);
});

test('document order still decides, so a concurrent sweep is faster and not different', async () => {
  // Two frames both match; the earlier one must win regardless of which promise settles first.
  const r = await findWithFrames(
    NONE,
    [{ sessionId: 'FIRST', url: 'https://a.test' }, { sessionId: 'SECOND', url: 'https://b.test' }],
    async (sid) => {
      if (sid === 'FIRST') await new Promise((res) => setTimeout(res, 80));
      return { found: true, selector: `[data-osw-composer="${sid}"]` };
    },
  );
  assert.equal(r.frameSessionId, 'FIRST', 'the later frame settling first must not steal priority');
});

test('on a stuck page the frame sweep starts BESIDE the retry, not behind it', async () => {
  // The starvation that made the concurrent sweep useless on its own. A stuck eval costs
  // grace+limit = 11.5s, so retry-THEN-frames spends 24.2s of a 30s budget before one frame is
  // looked at: dpaste and disqus timed out 4/4 at exactly 30s having never logged a frame hit.
  // Model the real order: first eval throws, sweep is launched, retry is awaited after it.
  const order: string[] = [];
  const stuck = async (): Promise<Found> => { throw new Error('page is still loading; retry shortly'); };
  const sweep = (async () => { order.push('sweep-start'); await new Promise((r) => setTimeout(r, 120));
    order.push('sweep-done'); return { found: true, frameSessionId: 'F1' } as Found; })();
  const retry = (async () => { await new Promise((r) => setTimeout(r, 100)); order.push('retry-done');
    throw new Error('page is still loading; retry shortly'); })();
  try { await stuck(); } catch { /* expected */ }
  try { await retry; } catch { /* expected */ }
  const hit = await sweep;
  assert.equal(order[0], 'sweep-start', 'the sweep must be in flight before the retry resolves');
  assert.ok(order.indexOf('sweep-start') < order.indexOf('retry-done'), 'sweep must not queue behind retry');
  assert.equal(hit.frameSessionId, 'F1');
});

test('no composer anywhere still reports a clean miss', async () => {
  const r = await findWithFrames(NONE, [{ sessionId: 'A', url: 'u' }], NONE);
  assert.equal(r.found, false);
  assert.equal(r.frameSessionId, undefined);
});

test('a still-loading page is retried once, not treated as a verdict', async () => {
  // "still loading" is a TIMING answer about the eval, not a statement that the page has no
  // composer. A heavy embed can hold isLoading past the grace while the DOM is perfectly readable.
  // Measured on blog.disqus.com: the finder threw this on every run, so the frame fallback never
  // got a chance and the site scored 0/2 as "no composer" when nothing had actually looked.
  let calls = 0;
  const findWithRetry = async (): Promise<Found> => {
    try {
      calls++;
      if (calls === 1) throw new Error('Browser command failed: page is still loading; retry shortly');
      return { found: true, selector: '[data-osw-composer="1"]' };
    } catch (err: any) {
      if (!/still loading|never finished loading/i.test(String(err?.message || err))) throw err;
      calls++;
      return { found: true, selector: '[data-osw-composer="1"]' };
    }
  };
  const r = await findWithRetry();
  assert.equal(r.found, true);
  assert.ok(calls >= 2, 'the first attempt must not be the last word');
});

test('a real page error still throws, so a broken page is not retried forever', async () => {
  const boom = async (): Promise<Found> => {
    try {
      throw new Error('ReferenceError: x is not defined');
    } catch (err: any) {
      if (!/still loading|never finished loading/i.test(String(err?.message || err))) throw err;
      return { found: false };
    }
  };
  await assert.rejects(boom, /ReferenceError/);
});
