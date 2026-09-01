import { useCallback } from 'react';
import { useDispatch, useStore } from 'react-redux';
import { addBrowserCard, setTiledCard } from '@/shared/state/dashboardLayoutSlice';
import type { RootState } from '@/shared/state/store';

/** Opens a widget link as an in-app browser card. From a FULLSCREEN chat the browser takes the
 * fullscreen slot, the same swap the sidebar already does for apps ("otherwise the new card would
 * land invisibly behind it"). The old version instead dropped fullscreen and left the card on the
 * canvas behind the chat, which read as a click that glitched and did nothing; the page only turned
 * up later, after leaving fullscreen by hand (ENG-234 fixed the visibility, not the destination). */
export function useOpenUrlInBrowserCard(): (url: string) => void {
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  return useCallback(
    (url: string) => {
      if (!/^https?:\/\//i.test(url)) return;
      // Lazy read, no subscription: this fires on a click, and widgets must not re-render on every tile change.
      const tiled = store.getState().dashboardLayout.tiledCards || {};
      const wasFullscreen = Object.values(tiled).some((zone) => zone === 'fullscreen');
      dispatch(addBrowserCard({ url }));
      if (!wasFullscreen) return;
      // The reducer mints the id, so the handle comes back through pendingFocusBrowserId; tiling it
      // fullscreen evicts the chat's own fullscreen in the SAME reducer, so there is no un-tile
      // frame to flicker through and nothing for a re-tile to race against.
      const openedId = store.getState().dashboardLayout.pendingFocusBrowserId;
      if (openedId) dispatch(setTiledCard({ cardId: openedId, zone: 'fullscreen' }));
    },
    [dispatch, store],
  );
}
