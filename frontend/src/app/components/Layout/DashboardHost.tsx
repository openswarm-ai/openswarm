import React, { useEffect } from 'react';
import { DashboardActiveProvider } from '@/shared/hooks/useDashboardActive';

interface DashboardHostProps {
  visible: boolean;
  children: React.ReactNode;
}

/** Stable container that hides Dashboard via CSS so embedded webviews survive non-dashboard nav. */
const DashboardHost: React.FC<DashboardHostProps> = ({ visible, children }) => {
  // Blur focused element on hide so a focused webview can't keep stealing keyboard input.
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
        zIndex: visible ? 10 : -1,
        visibility: visible ? 'visible' : 'hidden',
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
