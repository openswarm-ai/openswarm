// Native notifications for agent completion; fires only when document is hidden (user switched away).
const FIRED_RECENTLY = new Set<string>();
const COOLDOWN_MS = 30_000;

let permissionRequested = false;

function ensurePermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  if (!permissionRequested) {
    permissionRequested = true;
    Notification.requestPermission().catch(() => {});
  }
  return 'default';
}

export interface AgentCompletionPayload {
  sessionId: string;
  sessionName: string;
  dashboardId?: string;
  status: 'completed' | 'error';
  bodyExcerpt?: string;
}

export function notifyAgentCompletion(p: AgentCompletionPayload): void {
  if (typeof document === 'undefined') return;
  // Same-window: skip noise (hidden = tab-switched, minimized, or another BrowserWindow in front).
  if (!document.hidden) return;
  if (typeof Notification === 'undefined') return;
  const perm = ensurePermission();
  if (perm !== 'granted') return;

  // Per-session debounce: collapse rapid completed/error/completed flips.
  const key = `${p.sessionId}:${p.status}`;
  if (FIRED_RECENTLY.has(key)) return;
  FIRED_RECENTLY.add(key);
  setTimeout(() => FIRED_RECENTLY.delete(key), COOLDOWN_MS);

  const title = p.status === 'error'
    ? `${p.sessionName} hit an error`
    : `${p.sessionName} finished`;
  const body = (p.bodyExcerpt || '').slice(0, 140);

  try {
    const n = new Notification(title, {
      body,
      tag: p.sessionId,
      silent: false,
    });
    n.onclick = () => {
      try { window.focus(); } catch {}
      window.dispatchEvent(new CustomEvent('openswarm:notification-click', {
        detail: { sessionId: p.sessionId, dashboardId: p.dashboardId },
      }));
      n.close();
    };
  } catch {
    // Notification API can throw if sandboxed or headless; fail silently.
  }
}
