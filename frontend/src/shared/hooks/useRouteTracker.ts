// Reports nav.route_changed on each React Router location change. Mount inside a Router.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { report } from '@/shared/serviceClient';

export function useRouteTracker(): void {
  const location = useLocation();
  // Skip first render so the App's "/" open doesn't fire a phantom nav.
  const skippedFirst = useRef(false);
  const lastPath = useRef<string>('');

  useEffect(() => {
    const path = location.hash || location.pathname;
    if (!skippedFirst.current) {
      skippedFirst.current = true;
      lastPath.current = path;
      return;
    }
    if (path === lastPath.current) return;
    lastPath.current = path;
    report('nav', 'route_changed', { path });
  }, [location.hash, location.pathname]);
}
