import { store } from '@/shared/state/store';
import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { getWebview } from '@/shared/browserRegistry';

// Which browser surface dictation would land in right now, as a hostname; null when the target is
// an in-app field. Mirrors injectAtFocus's browser tiers so the disable list judges the same
// destination injection would pick.
export function getFocusedSurfaceHost(): string | null {
  const active = document.activeElement as HTMLElement | null;
  let browserId: string | null = null;
  if (active && active.tagName === 'WEBVIEW') {
    const cards = store.getState().dashboardLayout.browserCards;
    for (const id of Object.keys(cards)) {
      if (getWebview(id) === (active as unknown)) { browserId = id; break; }
    }
  }
  if (!browserId) browserId = getLastInteractedBrowser();
  if (!browserId) return null;
  const card = store.getState().dashboardLayout.browserCards[browserId];
  const url = card?.tabs?.find((t) => t.id === card.activeTabId)?.url || card?.url;
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

// "slack.com, docs.google.com" -> does the focused surface match any entry (exact or suffix).
export function surfaceDisabled(disabledList: string, host: string | null): boolean {
  if (!host) return false;
  const entries = disabledList.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = host.toLowerCase();
  return entries.some((e) => h === e || h.endsWith(`.${e}`));
}
