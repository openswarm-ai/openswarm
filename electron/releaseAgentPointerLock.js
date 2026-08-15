// The agent must never be able to swallow the user's real mouse (ENG-310).
//
// A CDP click is a trusted user gesture as far as Chromium is concerned, so a canvas app that calls
// requestPointerLock() from its mousedown handler (every mouse-look game does) captures and HIDES the
// physical cursor the instant the agent taps it. The user, who is off doing something else, finds
// their pointer welded to a dashboard card for the rest of the run. Measured directly: an agent-
// dispatched click on such a canvas left document.pointerLockElement=CANVAS.
//
// Denying the 'pointerLock' permission was the obvious fix and it is WRONG. Chromium caches that
// decision per origin and asks exactly once, so whoever clicks first decides for the whole session:
// deny for the agent and the user is denied too, forever, on their own app. Measured, both arms.
//
// So let the lock be granted and take it straight back off the agent's own click. Nothing about the
// user's path changes: they still get pointer lock, from the same cached grant, whenever they click
// it themselves. Exiting a lock needs no user gesture, which is what makes this side of it possible.

/** The one command that can end with the cursor captured: the release that completes a synthetic click. */
function isSyntheticClickRelease(method, params) {
  return method === 'Input.dispatchMouseEvent' && !!params && params.type === 'mouseReleased';
}

const EXIT_EXPRESSION = 'document.pointerLockElement ? (document.exitPointerLock(), true) : false';

/**
 * Give the cursor back after a synthetic click. Fire and forget: a failure here means the eval did
 * not land, which is no worse than not trying, and it must never fail the command it follows.
 */
function releaseAgentPointerLock(sendCdp, wcId, method, params) {
  if (!isSyntheticClickRelease(method, params)) return false;
  try {
    const p = sendCdp(wcId, 'Runtime.evaluate', { expression: EXIT_EXPRESSION, returnByValue: true });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // The surface went away mid-click; there is no cursor left to hand back.
  }
  return true;
}

module.exports = { releaseAgentPointerLock, isSyntheticClickRelease, EXIT_EXPRESSION };
