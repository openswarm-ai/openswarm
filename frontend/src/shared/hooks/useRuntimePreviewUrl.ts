// Hides legacy /serve/ vs new-mode Vite-runtime split for preview URLs; ref-counted spawn.

import { useEffect, useRef, useState } from 'react';
import { API_BASE, getAuthToken } from '@/shared/config';

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
}

export interface RuntimePreviewOptions {
  workspaceId: string | null | undefined;
  /** Gate the spawn so callers can defer paying runtime cost until preview is wanted. */
  enabled?: boolean;
  onLog?: (line: RuntimeLogLine) => void;
}

export function useRuntimePreviewUrl(opts: RuntimePreviewOptions): RuntimePreviewState {
  const { workspaceId, enabled = true, onLog } = opts;
  const [frontendUrl, setFrontendUrl] = useState<string | null>(null);
  const [isNewMode, setIsNewMode] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
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

    (async () => {
      try {
        await fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/start`, {
          method: 'POST',
          headers,
        });
      } catch (_) {
        // Spawn errors surface via the log WS; don't double-report.
      }
      if (cancelled) return;
      try {
        const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '');
        const url = `${wsBase}/ws/outputs/runtime/${workspaceId}/logs?token=${encodeURIComponent(auth || '')}`;
        ws = new WebSocket(url);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.event === 'runtime:status') {
              const fu = msg.data?.frontend_url ?? null;
              setFrontendUrl(fu || null);
              setIsNewMode(!!msg.data?.is_new_mode);
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
      } catch (_) {
        // WS construction failed; caller stays in "no preview yet" state.
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(hydrationTimer);
      try { ws?.close(); } catch (_) {}
      setFrontendUrl(null);
      setIsNewMode(false);
      setIsHydrating(true);
      // detach is ref-counted on the backend; fire-and-forget.
      fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/stop`, {
        method: 'POST',
        headers,
      }).catch(() => {});
    };
  }, [workspaceId, enabled]);

  return { frontendUrl, isNewMode, isHydrating };
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
