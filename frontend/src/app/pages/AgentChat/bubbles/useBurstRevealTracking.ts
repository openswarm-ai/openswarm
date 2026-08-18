import React, { useRef } from 'react';

// Burst-reveal bookkeeping: ids present at open (or after a session/branch hop) are HISTORY and
// never animate; only ids that appear later, while the agent is working, type themselves out. The
// ref is seeded lazily by the first item render after a hop (TranscriptItem), and reset here in the
// same layout phase as the scroll subsystem's session/branch reset (useMessageScroll).
export function useBurstRevealTracking(id: string | undefined, activeBranchId: string | undefined) {
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  React.useLayoutEffect(() => {
    seenMessageIdsRef.current = null;
  }, [id, activeBranchId]);
  return seenMessageIdsRef;
}
