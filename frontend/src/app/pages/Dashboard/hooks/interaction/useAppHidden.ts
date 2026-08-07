import { useEffect, useState } from 'react';

// Arc's tab-archiving tradeoff: back after a long absence pays a page reload, back quickly pays nothing.
const APP_HIDDEN_SUSPEND_MS = 10 * 60 * 1000;

/** True once the app has been hidden for 10 minutes straight; the suspend loop parks every idle webview then. */
export function useAppHidden(enabled: boolean): boolean {
  const [appHidden, setAppHidden] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onVis = (): void => {
      if (t) { clearTimeout(t); t = null; }
      if (document.hidden) t = setTimeout(() => setAppHidden(true), APP_HIDDEN_SUSPEND_MS);
      else setAppHidden(false);
    };
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => { document.removeEventListener('visibilitychange', onVis); if (t) clearTimeout(t); };
  }, [enabled]);
  return appHidden;
}
