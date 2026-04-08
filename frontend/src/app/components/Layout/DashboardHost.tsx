import React, { useEffect } from 'react';
import { DashboardActiveProvider } from '@/shared/hooks/useDashboardActive';

interface DashboardHostProps {
  visible: boolean;
  children: React.ReactNode;
}

/**
 * Wraps the Dashboard component in a stable container that toggles visibility
 * via CSS instead of unmounting. This is what keeps the embedded webviews
 * alive across non-dashboard route navigation.
 *
 * Why this approach (vs. display: none or unmount):
 *  - `visibility: hidden` preserves webview state without triggering Chromium
 *    to mark the page as hidden (so background sub-agents keep working).
 *  - `display: none` would trigger full layout recalc on toggle and may pause
 *    pages that check `document.hidden`.
 *  - Unmount destroys the webview DOM element, tearing down its Chromium tab.
 *
 * Also provides DashboardActiveContext to all children so they can gate
 * expensive work (canvas rendering, screenshot capture, etc.) on visibility.
 */
const DashboardHost: React.FC<DashboardHostProps> = ({ visible, children }) => {
  // When transitioning from visible -> hidden, blur any focused element so
  // a focused webview doesn't keep stealing keyboard input behind the scenes.
  useEffect(() => {
    if (!visible) {
      const el = document.activeElement;
      if (el instanceof HTMLElement) {
        el.blur();
      }
    }
  }, [visible]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        // Negative z-index when hidden so any visible Outlet content sits above
        zIndex: visible ? 10 : -1,
        visibility: visible ? 'visible' : 'hidden',
        // Belt-and-suspenders: even if z-index ordering glitches, no clicks land
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <DashboardActiveProvider value={visible}>
        {children}
      </DashboardActiveProvider>
    </div>
  );
};

export default DashboardHost;
