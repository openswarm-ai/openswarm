// Operational state sync; ships opaque objects the cloud interprets.

import { API_BASE } from './config';

/** Submission id per call so retries get deduped downstream. */
function _newSubmissionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let _lastTs = Date.now();
let _appStart = Date.now();

const _queue: Record<string, unknown>[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

// Bounded ring buffer of recent report() calls; ErrorBoundary attaches as breadcrumb context.
const _RECENT_CAP = 20;
const _recentReports: Array<{ s: string; a: string; ts: number }> = [];

function _record(surface: string, action: string): void {
  _recentReports.push({ s: surface, a: action, ts: Date.now() });
  if (_recentReports.length > _RECENT_CAP) {
    _recentReports.splice(0, _recentReports.length - _RECENT_CAP);
  }
}

/** Snapshot recent report() entries for breadcrumb context in error paths. */
export function getRecentActions(limit = 10): Array<{ s: string; a: string; ms_ago: number }> {
  const now = Date.now();
  const slice = _recentReports.slice(-Math.max(1, Math.min(limit, _RECENT_CAP)));
  return slice.map((r) => ({ s: r.s, a: r.a, ms_ago: now - r.ts }));
}

function _flush(): void {
  if (_queue.length === 0) return;
  const batch = _queue.splice(0);
  // Ship whole queue in one POST; /service/submit accepts a single object or array.
  const body = JSON.stringify(batch.length === 1 ? batch[0] : batch);
  // keepalive lets the request outlive a closing window, so the last batch isn't eaten on quit.
  fetch(`${API_BASE}/service/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => _flush());
}

export function sync(data: Record<string, unknown> = {}, opts: { immediate?: boolean } = {}): void {
  _lastTs = Date.now();
  // Stamp submission id + client ts so the cloud dedupes retries and orders by happen-time.
  const stamped: Record<string, unknown> = {
    ...data,
    submission_id: typeof data.submission_id === 'string' ? data.submission_id : _newSubmissionId(),
    t: typeof data.t === 'number' ? data.t : Date.now(),
  };
  if (opts.immediate) {
    _queue.push(stamped);
    _flush();
    return;
  }
  _queue.push(stamped);
  if (_flushTimer == null) {
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      _flush();
    }, 1000);
  }
}

/** Ship-an-event helper: same wire shape as sync(), reads as a UI surface verb in callers. */
export function report(
  surface: string,
  action: string,
  props?: Record<string, unknown>,
  opts: { immediate?: boolean } = {},
): void {
  _record(surface, action);
  sync({ s: surface, a: action, p: props || {} }, opts);
}

let _openedSent = false;

/**
 * Report the app launch with the browser's canonical timezone + locale (the
 * Intl API gives the same values Electron does, but works in dev and the
 * open-source build too, where Electron's env injection never runs). The backend
 * persists these and emits analytics `app_lifecycle.opened` from them.
 *
 * Guarded so a remount won't re-send within one page load; the backend also
 * dedupes per process, so a hard reload can't double-count an app launch.
 */
export function reportAppOpened(): void {
  if (_openedSent) return;
  _openedSent = true;
  let timezone = '';
  let locale = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch { /* leave empty; backend resolver/fallback handles it */ }
  try {
    locale = (typeof navigator !== 'undefined' && navigator.language) || '';
  } catch { /* leave empty */ }
  report('app', 'opened', { timezone, locale }, { immediate: true });
}

export function getSessionTraceState(): {
  appStartTs: number;
  lastTs: number;
  currentPage: string;
} {
  return {
    appStartTs: _appStart,
    lastTs: _lastTs,
    currentPage: typeof window === 'undefined' ? '' : (window.location.hash || window.location.pathname),
  };
}

const serviceClient = { sync, report, reportAppOpened, getSessionTraceState, getRecentActions };
export default serviceClient;
