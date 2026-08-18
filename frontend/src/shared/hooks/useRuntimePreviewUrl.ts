// Hides legacy /serve/ vs new-mode Vite-runtime split for preview URLs; ref-counted spawn.

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, getAuthToken } from '@/shared/config';
import { isSafeMode } from '@/shared/safeMode';
import { createRuntimeRequestPool } from './createRuntimeRequestPool';
import { createRuntimeAttachmentId, createRuntimeUrlBuilder } from './runtimePreviewLease';
import { planRuntimeRequest, shouldStartAfterAmbiguousRestart, type RuntimeAttachmentState, type RuntimeStatusPayload } from './runtimePreviewRetry';

const FAILURE_MESSAGE = "Preview couldn't start.";
const HYDRATION_DELAY_MS = 150;
const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 60_000;

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
  error: string | null;
  retry: () => void;
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
  const [error, setError] = useState<string | null>(null);
  // Pin latest onLog so callback identity changes don't tear down/respawn the runtime.
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const retryRef = useRef<() => void>(() => {});
  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    if (!workspaceId || !enabled) {
      retryRef.current = () => {};
      setFrontendUrl(null);
      setIsNewMode(false);
      setIsHydrating(false);
      setError(null);
      return;
    }
    const attachmentId = createRuntimeAttachmentId();
    let cancelled = false;
    let ws: WebSocket | null = null;
    let attemptId = 0;
    let attachmentState: RuntimeAttachmentState = 'none';
    let attemptFailed = false;
    let previewResolved = false;
    let probeInFlight = false;
    let hydrationTimer: ReturnType<typeof setTimeout> | null = null;
    let probeTimer: ReturnType<typeof setTimeout> | null = null;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    const requestPool = createRuntimeRequestPool();

    const auth = getAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const runtimeUrl = createRuntimeUrlBuilder(API_BASE, workspaceId, instance, attachmentId);

    const clearTimers = () => {
      if (hydrationTimer) clearTimeout(hydrationTimer);
      if (probeTimer) clearTimeout(probeTimer);
      if (startupTimer) clearTimeout(startupTimer);
      hydrationTimer = null;
      probeTimer = null;
      startupTimer = null;
    };

    const closeSocket = () => {
      if (!ws) return;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch (_) {}
      ws = null;
    };

    const isCurrent = (id: number): boolean => !cancelled && id === attemptId;
    const isActive = (id: number): boolean => isCurrent(id) && !attemptFailed;

    const fail = (id: number) => {
      if (!isActive(id)) return;
      attemptFailed = true;
      clearTimers();
      closeSocket();
      requestPool.abortAll();
      probeInFlight = false;
      setFrontendUrl(null);
      setIsHydrating(false);
      setError(FAILURE_MESSAGE);
    };

    const applyStatus = (id: number, status: RuntimeStatusPayload): boolean => {
      if (!isActive(id)) return false;
      const nextFrontendUrl = status.frontend_url || null;
      const nextIsNewMode = !!status.is_new_mode;
      setFrontendUrl(nextFrontendUrl);
      setIsNewMode(nextIsNewMode);
      setIsHydrating(false);
      previewResolved = !nextIsNewMode || !!nextFrontendUrl;
      if (previewResolved) {
        requestPool.abortAll();
        if (probeTimer) clearTimeout(probeTimer);
        if (startupTimer) clearTimeout(startupTimer);
        probeTimer = null;
        startupTimer = null;
        setError(null);
      }
      return previewResolved;
    };

    let scheduleProbe: (id: number, delayMs: number) => void;

    const probeStatus = async (id: number): Promise<void> => {
      if (!isActive(id) || previewResolved || probeInFlight) return;
      probeInFlight = true;
      let shouldContinue = false;
      try {
        const response = await requestPool.fetch(runtimeUrl('status'), { headers }, PROBE_TIMEOUT_MS);
        if (!response.ok) throw new Error(`Status probe failed (${response.status})`);
        const status = await response.json() as RuntimeStatusPayload;
        if (!isActive(id) || previewResolved) return;
        shouldContinue = !applyStatus(id, status);
      } catch (_) {
        shouldContinue = isActive(id) && !previewResolved;
      } finally {
        if (isCurrent(id)) {
          probeInFlight = false;
          if (shouldContinue && isActive(id)) scheduleProbe(id, PROBE_INTERVAL_MS);
        }
      }
    };

    scheduleProbe = (id: number, delayMs: number) => {
      if (!isActive(id) || previewResolved || probeInFlight) return;
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = setTimeout(() => {
        probeTimer = null;
        void probeStatus(id);
      }, delayMs);
    };

    const openSocket = (id: number) => {
      if (!isActive(id)) return;
      try {
        const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '');
        const url = `${wsBase}/ws/outputs/runtime/${workspaceId}/logs?token=${encodeURIComponent(auth || '')}&instance=${instance}`;
        ws = new WebSocket(url);
        ws.onmessage = (event) => {
          if (!isActive(id)) return;
          try {
            const message = JSON.parse(event.data);
            if (message.event === 'runtime:status') {
              applyStatus(id, message.data || {});
            } else if (message.event === 'runtime:log') {
              const stream = message.data?.stream || 'stdout';
              const text = message.data?.text || '';
              const source: RuntimeLogLine['source'] = stream === 'runtime' ? 'runtime' : 'backend';
              onLogRef.current?.({ source, stream, text });
            } else if (message.event === 'runtime:not_attached') {
              scheduleProbe(id, 0);
            }
          } catch (_) {
            // Malformed frames are ignored; the bounded HTTP probe remains authoritative for startup.
          }
        };
        const recoverStatus = () => {
          if (!previewResolved) scheduleProbe(id, 0);
        };
        ws.onerror = recoverStatus;
        ws.onclose = recoverStatus;
      } catch (_) {
        scheduleProbe(id, 0);
      }
    };

    const beginAttempt = async (retryAttempt: boolean): Promise<void> => {
      attemptId += 1;
      const id = attemptId;
      clearTimers();
      closeSocket();
      requestPool.abortAll();
      attemptFailed = false;
      previewResolved = false;
      probeInFlight = false;
      setFrontendUrl(null);
      setIsNewMode(false);
      setIsHydrating(true);
      setError(null);
      hydrationTimer = setTimeout(() => {
        if (isCurrent(id)) setIsHydrating(false);
      }, HYDRATION_DELAY_MS);
      startupTimer = setTimeout(() => fail(id), STARTUP_TIMEOUT_MS);

      try {
        const requestPlan = planRuntimeRequest(retryAttempt, attachmentState);
        // Safe mode (ENG-228): after repeated dirty exits, app runtimes don't auto-boot on card mount; the card's restart button is the explicit resume. Only the mount-time start is gated; an explicit restart is the user's call.
        if (requestPlan.action === 'start' && !retryAttempt && isSafeMode()) {
          if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
          if (isCurrent(id)) setIsHydrating(false);
          openSocket(id);
          return;
        }
        const requestRuntime = async (requestAction: 'restart' | 'start'): Promise<RuntimeStatusPayload | null> => {
          if (requestAction === 'start') {
            // attach() increments before runtime startup completes, so a client-side timeout is ambiguous: claim the attachment before dispatch and let only a definitive HTTP failure clear it — retries then use restart (which does not increment the refcount), and teardown always balances a start that may have reached the backend.
            attachmentState = 'possible';
          }
          const response = await requestPool.fetch(
            runtimeUrl(requestAction),
            { method: 'POST', headers },
            REQUEST_TIMEOUT_MS,
          );
          if (!isActive(id)) return null;
          if (!response.ok) {
            if (requestAction === 'start') attachmentState = 'none';
            throw new Error(`Runtime ${requestAction} failed (${response.status})`);
          }
          if (requestAction === 'start') attachmentState = 'confirmed';
          return await response.json() as RuntimeStatusPayload;
        };

        let status = await requestRuntime(requestPlan.action);
        if (!status) return;
        if (shouldStartAfterAmbiguousRestart(requestPlan, status)) {
          // The timed-out start never reached the manager, so its possible attachment is phantom: one fresh start is both necessary and the only request allowed to increment here.
          attachmentState = 'none';
          status = await requestRuntime('start');
        }
        if (!status) return;
        if (!isActive(id)) return;
        const ready = applyStatus(id, status);
        if (!ready) scheduleProbe(id, PROBE_INTERVAL_MS);
        openSocket(id);
      } catch (_) {
        fail(id);
      }
    };

    retryRef.current = () => { void beginAttempt(true); };
    void beginAttempt(false);

    return () => {
      cancelled = true;
      attemptId += 1;
      retryRef.current = () => {};
      clearTimers();
      closeSocket();
      requestPool.abortAll();
      // detach is ref-counted on the backend; fire-and-forget.
      if (attachmentState !== 'none') {
        fetch(runtimeUrl('stop'), { method: 'POST', headers }).catch(() => {});
      }
    };
  }, [workspaceId, enabled, instance]);

  return { frontendUrl, isNewMode, isHydrating, error, retry };
}
