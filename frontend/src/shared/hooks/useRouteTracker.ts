// Route-change tracker.
//
// Reports a `nav.route_changed` event on every React Router location
// change so the cloud can aggregate visits per route. Reuses the
// existing report() surface — no new outbound paths added. The desktop
// just sends the path; the cloud counts.
//
// Mount inside a Router (must be a child of HashRouter / BrowserRouter)
// so useLocation() resolves.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { report } from '@/shared/serviceClient';

export function useRouteTracker(): void {
  const location = useLocation();
  // Skip the very first render — the App opens at "/" and we don't want
  // to report a phantom navigation that didn't happen.
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
    // The path is a route name (e.g. /dashboard, /settings) — never the
    // full URL. No query strings, no hash fragments beyond the route id.
    report('nav', 'route_changed', { path });
  }, [location.hash, location.pathname]);
}
