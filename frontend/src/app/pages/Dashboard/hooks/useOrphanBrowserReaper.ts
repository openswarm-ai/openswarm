import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import { markBrowserCardEnding } from '@/shared/state/dashboardLayoutSlice';

// The event-driven despawn (WebSocketManager marks a finished agent's browsers ending) misses any
// terminal event the renderer never saw: a reload mid-run, a workflow finishing while the app was
// closed. Those cards then live forever, which is Haik's 20-browser pile-up (ENG-248). This sweep is
// the belt: anything owned by a session the STORE can see is terminal gets the same fade + Keep pill
// the event path uses. A session missing from the store entirely is left alone on purpose; before
// sessions load, "missing" means "not fetched yet", and axing on that would kill live cards at boot.
const SWEEP_MS = 45_000;
const FIRST_SWEEP_MS = 7_000;

export function useOrphanBrowserReaper(): void {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const sweep = (): void => {
      const st = store.getState();
      const sessions = st.agents.sessions;
      for (const card of Object.values(st.dashboardLayout.browserCards)) {
        if (!card.spawned_by || card.keep_open) continue;
        if (st.dashboardLayout.endingBrowserCards[card.browser_id]) continue;
        const owner = sessions[card.spawned_by];
        if (!owner) continue;
        // 'stopped' is skipped, same as the event path: a manual stop keeps the browser for inspection.
        if (owner.status === 'completed' || owner.status === 'error') {
          dispatch(markBrowserCardEnding({ browserId: card.browser_id, status: owner.status }));
        }
      }
    };
    const first = window.setTimeout(sweep, FIRST_SWEEP_MS);
    const timer = window.setInterval(sweep, SWEEP_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [dispatch]);
}
