// The child-frame half of the structural composer finder, kept separate from browserCommandHandler because it is the piece with real logic in it and the piece worth testing directly. deepMatch pierces shadow DOM but starts at `document` and recurses only into shadowRoot, so an iframe is a wall to it: the composer of every embedded widget (Disqus, a helpdesk box, an embedded compose view) is invisible to the top-document search even though the AX walk can see into those frames.
// The evaluator is injected rather than imported so this module knows nothing about webviews or CDP, which is what lets findComposerFrames.test.ts exercise the real function instead of re-implementing its contract and drifting from it.

/** One child frame of the page, as the CDP bridge reports it. */
export interface ChildFrame {
  sessionId: string;
  url: string;
}

/** What the in-page composer search returns, plus the frame it was found in once known. */
export interface FrameHit {
  found: boolean;
  selector?: string;
  frameSessionId?: string;
  frameUrl?: string;
  [key: string]: unknown;
}

/** Runs the composer search inside one frame; may reject, which counts as that frame missing. */
export type FrameEval = (sessionId: string) => Promise<FrameHit | null>;

// Searched CONCURRENTLY: sequentially this is O(frames x eval timeout) and an ad-heavy page carries a dozen frames, so the sweep cost the caller's whole 30s BrowserFindComposer budget and was killed before reaching the frame holding the composer (measured 2026-08-06 on dpaste and disqus, which logged "trying child frames anyway" nine times and "found in child frame" zero times).
// Every frame still has to settle before a winner is named, because document order decides, not arrival order: this is max-instead-of-sum, deliberately not first-hit-wins, so a late-loading frame cannot outrank an earlier one that also matched.
export async function sweepChildFrames(
  children: ChildFrame[],
  evalInFrame: FrameEval,
): Promise<FrameHit | null> {
  const hits: Array<FrameHit | null> = await Promise.all(
    children.map(async (child): Promise<FrameHit | null> => {
      try {
        const found = await evalInFrame(child.sessionId);
        // A frame that answers "no composer" and a frame that throws are the same answer here; only a positive hit carries its frame identity forward, because a selector is meaningless without the document it resolves in.
        return found && found.found
          ? { ...found, frameSessionId: child.sessionId, frameUrl: child.url }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.find((hit): hit is FrameHit => hit !== null) || null;
}
