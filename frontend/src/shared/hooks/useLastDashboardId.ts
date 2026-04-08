import { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

const STORAGE_KEY = 'openswarm_last_dashboard_id';
const WINDOW_KEY = '__openswarm_last_dashboard_id';

/**
 * Tracks the last visited dashboard id in a "sticky" way: once a dashboard
 * has been visited, the id stays set even when the user navigates to other
 * routes. This is the foundation for keeping the Dashboard component mounted
 * across non-dashboard route navigation (hide-don't-unmount pattern).
 *
 * The Dashboard component reads its dashboardId from this hook (via a prop
 * passed by AppShell) instead of from `useParams()`, so the id never goes
 * undefined when the URL changes to /actions etc. This prevents the
 * dashboardId useEffect from re-firing on every incidental route change,
 * which would cause `resetLayout` + `fetchLayout` and visibly reload the
 * browser cards.
 *
 * Returns a tuple of `[lastDashboardId, setLastDashboardId]`. The setter
 * is exposed so explicit dashboard close/delete handlers can clear it
 * (which causes the Dashboard to fully unmount and tear down its webviews).
 */
export function useLastDashboardId(): [string | null, (id: string | null) => void] {
  const location = useLocation();
  const [lastId, setLastIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  // Watch the URL — when it matches /dashboard/:id, update the sticky id.
  // Critically: do NOT clear the sticky id when the URL stops matching.
  useEffect(() => {
    const match = location.pathname.match(/^\/dashboard\/([^/]+)/);
    if (match && match[1] && match[1] !== lastId) {
      setLastIdState(match[1]);
      try {
        localStorage.setItem(STORAGE_KEY, match[1]);
      } catch {}
      (window as any)[WINDOW_KEY] = match[1];
    }
  }, [location.pathname, lastId]);

  const setLastId = useCallback((id: string | null) => {
    setLastIdState(id);
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, id);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
    if (id) {
      (window as any)[WINDOW_KEY] = id;
    } else {
      delete (window as any)[WINDOW_KEY];
    }
  }, []);

  return [lastId, setLastId];
}
