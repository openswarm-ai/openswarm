import React from 'react';
import { createRoot } from 'react-dom/client';
import Main from './app/Main';
import ErrorBoundary from './app/components/ErrorBoundary';

// Render-health beacons the OpenSwarm host reads (via the forwarded preview
// console) to decide, at the end of an agent turn, whether the app renders.
// The ErrorBoundary covers React render crashes; the listeners here cover
// what never reaches a boundary: module-load / pre-mount throws and vite
// transform errors.
function reportRender(ok: boolean, detail?: string) {
  if (ok) {
    window.__openswarm_rendered = true;
    // eslint-disable-next-line no-console
    console.log('[openswarm:app-ready]');
  } else {
    // eslint-disable-next-line no-console
    console.error('[openswarm:app-error]', detail ?? '');
  }
}

// Gate on __openswarm_rendered so a throw inside a click handler after a good
// render (a bug, but not "the app won't render") doesn't block the turn.
window.addEventListener('error', (e) => {
  if (!window.__openswarm_rendered) reportRender(false, e.message || String(e.error ?? e));
});
window.addEventListener('unhandledrejection', (e) => {
  if (!window.__openswarm_rendered) reportRender(false, String(e.reason ?? e));
});

if (import.meta.hot) {
  const hot = import.meta.hot;
  hot.on('vite:error', (payload) => {
    const err = payload?.err;
    reportRender(false, err?.message || err?.plugin || 'vite error');
  });
  // Re-assert the real state after every HMR update: if the ErrorBoundary is
  // still showing its fallback, report the error again (an unrelated edit that
  // didn't fix it must not flip the gate to "ready"); otherwise report ready.
  hot.on('vite:afterUpdate', () => {
    if (window.__openswarm_render_failed) {
      reportRender(false, window.__openswarm_last_error || 'app still failing to render');
    } else {
      reportRender(true);
    }
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  console.error('[openswarm:app-error]', '#root element not found in DOM');
} else {
  // Wrap Main in an ErrorBoundary so any runtime crash from agent
  // edits (missing imports, hook-rules violations, etc.) shows a
  // readable error card in the preview pane instead of unmounting
  // to a blank screen. The boundary forwards the error via
  // console.error + postMessage so the agent sees it on its next turn.
  createRoot(rootEl).render(
    <ErrorBoundary>
      <Main />
    </ErrorBoundary>,
  );
  // Defer a frame so a synchronous render crash sets __openswarm_render_failed
  // (via the boundary) before we'd wrongly report ready.
  requestAnimationFrame(() => {
    if (window.__openswarm_render_failed) return;
    reportRender(true);
  });
}
