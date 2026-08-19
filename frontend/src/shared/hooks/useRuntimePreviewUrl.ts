// Hides legacy /serve/ vs new-mode Vite-runtime split for preview URLs; ref-counted spawn.

import { useEffect, useRef, useState } from 'react';
import { API_BASE, getAuthToken } from '@/shared/config';
import { isSafeMode } from '@/shared/safeMode';

export interface RuntimeLogLine {
  source: 'backend' | 'runtime';
  stream: string;
  text: string;
}

export interface RuntimePreviewState {
  frontendUrl: string | null;
  isNewMode: boolean;
  // True until the runtime:status frame lands; prevents placeholder flash on remount when Vite is up.
  isHydrating: boolean;
  // The bind poll gave up: the spinner must become an honest failure state, not spin forever.
  bootFailed: boolean;
}

export interface RuntimePreviewOptions {
  workspaceId: string | null | undefined;
  /** Gate the spawn so callers can defer paying runtime cost until preview is wanted. */
  enabled?: boolean;
  onLog?: (line: RuntimeLogLine) => void;
  /** Which independent instance of the app to attach (1 = primary). Each instance is its own process on its own ports. */
  instance?: number;
}

export function useRuntimePreviewUrl(opts: RuntimePreviewOptions): RuntimePreviewState {
  const { workspaceId, enabled = true, onLog, instance = 1 } = opts;
  const [frontendUrl, setFrontendUrl] = useState<string | null>(null);
  const [isNewMode, setIsNewMode] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [bootFailed, setBootFailed] = useState(false);
  // Pin latest onLog so callback identity changes don't tear down/respawn the runtime.
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  useEffect(() => {
    if (!workspaceId || !enabled) {
      setIsHydrating(false);
      return;
    }
    let cancelled = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setFrontendUrl(null);
    setIsNewMode(false);
    setIsHydrating(true);
    // 150ms: warm starts deliver status in 20-100ms; long enough to skip placeholder flash, short enough to not stall cold starts.
    const hydrationTimer = setTimeout(() => {
      if (!cancelled) setIsHydrating(false);
    }, 150);

    const auth = getAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      // Safe mode (ENG-228): after repeated dirty exits, app runtimes don't auto-boot on card mount; the card's restart button is the explicit resume, so a crash loop can't respawn the surface storm.
      if (!isSafeMode()) {
        try {
          await fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/start?instance=${instance}`, {
            method: 'POST',
            headers,
          });
        } catch (_) {
          // Spawn errors surface via the log WS; don't double-report.
        }
      }
      if (cancelled) return;
      try {
        const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '');
        const url = `${wsBase}/ws/outputs/runtime/${workspaceId}/logs?token=${encodeURIComponent(auth || '')}&instance=${instance}`;
        ws = new WebSocket(url);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.event === 'runtime:status') {
              const fu = msg.data?.frontend_url ?? null;
              setFrontendUrl(fu || null);
              setIsNewMode(!!msg.data?.is_new_mode);
              setBootFailed(!!msg.data?.boot_failed && !fu);
              setIsHydrating(false);
            } else if (msg.event === 'runtime:log') {
              const stream = msg.data?.stream || 'stdout';
              const text = msg.data?.text || '';
              const source: RuntimeLogLine['source'] = stream === 'runtime' ? 'runtime' : 'backend';
              onLogRef.current?.({ source, stream, text });
            }
          } catch (_) {
            // Malformed frame; safe to drop.
          }
        };
        // A backend restart kills the runtime AND this socket; without re-attaching the card sits
        // on a dead port forever, so drop the stale URL (placeholder over a dead webview) and retry.
        ws.onclose = () => {
          if (cancelled) return;
          setFrontendUrl(null);
          retryTimer = setTimeout(() => { void connect(); }, 2000);
        };
      } catch (_) {
        retryTimer = setTimeout(() => { void connect(); }, 2000);
      }
    };
    void connect();

    return () => {
      cancelled = true;
      clearTimeout(hydrationTimer);
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch (_) {}
      setFrontendUrl(null);
      setIsNewMode(false);
      setIsHydrating(true);
      // detach is ref-counted on the backend; fire-and-forget.
      fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/stop?instance=${instance}`, {
        method: 'POST',
        headers,
      }).catch(() => {});
    };
  }, [workspaceId, enabled, instance]);

  return { frontendUrl, isNewMode, isHydrating, bootFailed };
}

export interface PickPreviewUrlOptions {
  workspaceId: string | null | undefined;
  /** Pre-new-mode URL the component used (serve/index.html); overridden by frontendUrl when ready. */
  legacyUrl: string | undefined;
  frontendUrl: string | null;
  isNewMode: boolean;
}

export interface PickPreviewUrlResult {
  /** undefined => render placeholder (new-mode and Vite not bound yet). */
  url: string | undefined;
  isBooting: boolean;
}

export function pickPreviewUrl(opts: PickPreviewUrlOptions): PickPreviewUrlResult {
  const { legacyUrl, frontendUrl, isNewMode, workspaceId } = opts;
  if (!workspaceId) {
    return { url: legacyUrl, isBooting: false };
  }
  if (isNewMode && !frontendUrl) {
    return { url: undefined, isBooting: true };
  }
  return { url: frontendUrl ?? legacyUrl, isBooting: false };
}
