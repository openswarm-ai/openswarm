// Native notifications for agent completion; fires only when document is hidden (user switched away).
import { store } from '@/shared/state/store';
import { notifyWanted, notifyOn, notifyAllowedNow, type NotifyPrefs } from './notifyWanted';

function prefs(): NotifyPrefs {
  return store.getState().settings.data as NotifyPrefs;
}

const on = notifyOn;
const wanted = (kind: 'agent' | 'workflow', bad: boolean): boolean => notifyWanted(prefs(), kind, bad);

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

/** Fire one renderer notification. The caller owns the "does the user want this?" decision, so the
 *  workflow fallback below cannot be silenced by the AGENT toggles the way it used to be. */
function p_fire(args: { title: string; body: string; tag: string; sessionId: string; dashboardId?: string }): void {
  if (typeof document === 'undefined' || typeof Notification === 'undefined') return;
  // Same-window: skip noise (hidden = tab-switched, minimized, or another BrowserWindow in front),
  // unless the user asked to be told regardless.
  if (!notifyAllowedNow(prefs(), document.hidden)) return;
  if (ensurePermission() !== 'granted') return;

  // Per-target debounce: collapse rapid completed/error/completed flips.
  if (FIRED_RECENTLY.has(args.tag)) return;
  FIRED_RECENTLY.add(args.tag);
  setTimeout(() => FIRED_RECENTLY.delete(args.tag), COOLDOWN_MS);

  try {
    const n = new Notification(args.title, {
      body: args.body,
      tag: args.sessionId,
      silent: !on(prefs().notify_sound),
    });
    n.onclick = () => {
      try { window.focus(); } catch {}
      window.dispatchEvent(new CustomEvent('openswarm:notification-click', {
        detail: { sessionId: args.sessionId, dashboardId: args.dashboardId },
      }));
      n.close();
    };
  } catch {
    // Notification API can throw if sandboxed or headless; fail silently.
  }
}

export function notifyAgentCompletion(p: AgentCompletionPayload): void {
  if (!wanted('agent', p.status === 'error')) return;
  p_fire({
    title: p.status === 'error' ? `${p.sessionName} hit an error` : `${p.sessionName} finished`,
    body: (p.bodyExcerpt || '').slice(0, 140),
    tag: `${p.sessionId}:${p.status}`,
    sessionId: p.sessionId,
    dashboardId: p.dashboardId,
  });
}

export type WorkflowNotificationOutcome = 'open' | 'ack' | 'rerun' | 'edit';

export interface WorkflowRunNotification {
  workflowId: string;
  workflowTitle: string;
  runId?: string;
  sessionId?: string;
  status: string;
  tierKind?: string;
  fallback?: boolean;
}

const SUCCESS_TITLES = ['{name} is done', '{name} just wrapped up', 'Heads up: {name} finished', '{name} is ready'];
const FAILURE_TITLES = ['{name} hit a snag', "{name} couldn't finish", 'Something went sideways on {name}'];
const LATE_TITLES = ['{name} caught up late', '{name} ran late but made it'];

function workflowTitleFor(p: WorkflowRunNotification): string {
  const name = p.workflowTitle || 'Workflow';
  const pool = p.status === 'success' ? SUCCESS_TITLES
    : p.status === 'failure' ? FAILURE_TITLES
      : p.status === 'ran_late' ? LATE_TITLES
        : null;
  if (!pool) return `${name}: ${p.status}`;
  // Seed by workflow id + current minute so two workflows pick different copy while one workflow stays stable across a few minutes.
  const seed = Math.abs((p.workflowId.length + Math.floor(Date.now() / 60_000)) | 0);
  return pool[seed % pool.length].replace('{name}', name);
}

function workflowBodyFor(p: WorkflowRunNotification): string {
  if (p.tierKind && p.fallback) {
    return `Would have ${p.tierKind === 'call' ? 'called' : 'texted'} you. (Cloud SMS not wired yet.)`;
  }
  const verb = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'Tap' : 'Click';
  if (p.status === 'success') return `${verb} to see what it did.`;
  if (p.status === 'failure') return `${verb} to see what went wrong.`;
  return `${verb} to open the run.`;
}

/** Native OS notification for a finished workflow run. Prefers the Electron main process, which reaches Notification Center even with the window hidden or the renderer backgrounded; the renderer's own Notification API is the browser-only fallback and it only fires when the tab is hidden. */
export function notifyWorkflowRun(p: WorkflowRunNotification): void {
  if (!wanted('workflow', p.status === 'failure')) return;
  const bridge = typeof window !== 'undefined' ? window.openswarm : undefined;
  if (!bridge?.notify) {
    // Straight to the firer, never back through notifyAgentCompletion: that re-asked the AGENT
    // toggles, so switching agent notifications off silently took workflow ones with it.
    p_fire({
      title: workflowTitleFor(p),
      body: workflowBodyFor(p),
      tag: `${p.workflowId}:${p.status}`,
      sessionId: p.sessionId || p.workflowId,
    });
    return;
  }
  bridge.notify({
    title: workflowTitleFor(p),
    body: workflowBodyFor(p),
    deepLink: `openswarm://workflow/${p.workflowId}/run/${p.runId || ''}`,
    runId: p.runId,
    workflowId: p.workflowId,
    actions: [
      { text: 'Looks good', outcome: 'ack' },
      { text: 'Re-run', outcome: 'rerun' },
      { text: 'Adjust', outcome: 'edit' },
    ],
  }).catch(() => { /* the OS refused it; the run is still on the canvas */ });
}
