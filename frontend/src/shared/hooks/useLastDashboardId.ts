import { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

const STORAGE_KEY = 'openswarm_last_dashboard_id';
const WINDOW_KEY = '__openswarm_last_dashboard_id';

/** Sticky last-visited dashboard id so Dashboard stays mounted across non-dashboard nav. */
export function useLastDashboardId(): [string | null, (id: string | null) => void] {
  const location = useLocation();
  const [lastId, setLastIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  // Watch URL; update sticky id on /dashboard/:id. Do NOT clear when URL stops matching.
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
