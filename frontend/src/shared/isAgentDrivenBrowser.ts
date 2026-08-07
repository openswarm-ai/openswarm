import { store } from '@/shared/state/store';

// A browser an agent is actively working: its guest clicks are the AGENT's, not the user's, so they
// must not steal selection, last-interacted targeting (Ctrl+R, zoom, dictation fallback), or z-order.
export function isAgentDrivenBrowser(browserId: string): boolean {
  const st = store.getState();
  const working = (s?: { status?: string }) => !!s && (s.status === 'running' || s.status === 'waiting_approval');
  const glow = st.dashboardLayout.glowingBrowserCards[browserId];
  return (
    Object.values(st.agents.sessions).some((s) => s.browser_id === browserId && working(s)) ||
    (!!glow && !glow.fading && working(st.agents.sessions[glow.sourceId]))
  );
}
