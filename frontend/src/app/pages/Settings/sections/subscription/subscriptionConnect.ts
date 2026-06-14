import { API_BASE } from '@/shared/config';

interface ConnectCtx {
  providerId: string;
  data: any;
  setConnecting: (v: string | null) => void;
  setUserCode: (v: string) => void;
  setPollTimer: (v: any) => void;
  fetchStatus: (opts?: { preserveTransient?: boolean }) => Promise<any>;
  refreshPickerModels: () => void;
  markConnected: (provider: string) => void;
}

// Device-code OAuth flow: popup + dual poller (device-code + status) + focus-listener safety net + 5min hard timeout.
function runDeviceCodeFlow(ctx: ConnectCtx) {
  const { providerId, data, setConnecting, setUserCode, setPollTimer, fetchStatus, refreshPickerModels, markConnected } = ctx;
  const code = data.user_code || '';
  setUserCode(code);
  // Named window + features so Electron's setWindowOpenHandler spawns a BrowserWindow popup, not a webview tab.
  let devicePopup: Window | null = null;
  if (data.verification_uri) {
    devicePopup = window.open(data.verification_uri, 'oauth_connect', 'width=600,height=720');
  }

  // Shared cleanup; whichever detection path fires first calls this.
  let stopped = false;
  const onDeviceSuccess = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(devicePollTimer);
    clearInterval(statusPollTimer);
    setPollTimer(null);
    setConnecting(null);
    setUserCode('');
    markConnected(providerId);
    fetchStatus();
    refreshPickerModels();
    // Auto-close popup 2s after success so the "Congratulations" page is briefly visible then closes.
    setTimeout(() => {
      if (devicePopup && !devicePopup.closed) {
        try { devicePopup.close(); } catch {}
      }
    }, 2000);
  };

  // Path 1: device-code poll via backend/9Router; primary path.
  const pollOnce = async () => {
    if (stopped) return;
    try {
      const pr = await fetch(`${API_BASE}/agents/subscriptions/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, device_code: data.device_code, code_verifier: data.code_verifier, extra_data: data.extra_data }),
      });
      if (!pr.ok) {
        console.warn(`[subscription-poll] ${providerId}: HTTP ${pr.status}`);
        return;
      }
      const pd = await pr.json();
      if (pd.success) {
        onDeviceSuccess();
      } else if (!pd.pending) {
        console.warn(`[subscription-poll] ${providerId}: not success, not pending:`, pd);
      }
    } catch (e) {
      console.warn(`[subscription-poll] ${providerId}: error:`, e);
    }
  };
  pollOnce();
  const devicePollTimer = setInterval(pollOnce, 5000);

  // Path 2: status poller every 2s; catches connection even when device-code poll silently errors.
  const statusPollTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
      const sd = await sr.json();
      const connections = sd.providers?.connections || [];
      if (connections.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'))) {
        onDeviceSuccess();
      }
    } catch {}
  }, 2000);

  setPollTimer(devicePollTimer);

  // Listen for main-window focus; Electron's popup.closed is unreliable when child BrowserWindow is destroyed.
  let focusCheckDone = false;
  const onFocus = async () => {
    if (stopped || focusCheckDone) return;
    focusCheckDone = true;
    window.removeEventListener('focus', onFocus);
    // Give 9Router 3s to process the token exchange before the final status check.
    await new Promise(r => setTimeout(r, 3000));
    if (stopped) return;
    try {
      const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
      const sd = await sr.json();
      const connections = sd.providers?.connections || [];
      if (connections.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'))) {
        onDeviceSuccess();
        return;
      }
    } catch {}
    // Connection not found; reset card.
    stopped = true;
    clearInterval(devicePollTimer);
    clearInterval(statusPollTimer);
    setPollTimer(null);
    setConnecting(null);
    setUserCode('');
    fetchStatus();
  };
  // Delay focus listener; popup open can blur/refocus the parent and falsely trigger it.
  setTimeout(() => {
    if (!stopped) window.addEventListener('focus', onFocus);
  }, 2000);

  // 5-minute hard timeout; cleans up everything.
  setTimeout(() => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('focus', onFocus);
    clearInterval(devicePollTimer);
    clearInterval(statusPollTimer);
    setPollTimer(null);
    setConnecting(null);
    setUserCode('');
    if (devicePopup && !devicePopup.closed) {
      try { devicePopup.close(); } catch {}
    }
  }, 300000);
}

// Authorization-code flow: external-browser or popup + status poller + postMessage/IPC relay + bounded timeout.
function runAuthCodeFlow(ctx: ConnectCtx) {
  const { providerId, data, setConnecting, setPollTimer, fetchStatus, refreshPickerModels, markConnected } = ctx;
  // Gemini/Google block embedded browsers; backend sets use_external_browser and exchange happens server-side via /api/subscriptions/callback. Detect via status poller (no postMessage possible).
  const useExternal = !!data.use_external_browser;
  let popup: Window | null = null;
  if (useExternal && (window as any).openswarm?.openExternal) {
    (window as any).openswarm.openExternal(data.auth_url);
  } else {
    popup = window.open(data.auth_url, 'oauth_connect', 'width=600,height=700');
  }

  let stopped = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  // Status polling: primary for external-browser flow, secondary for popup flow (postMessage is faster).
  const statusPoller = setInterval(async () => {
    if (stopped) return;
    try {
      const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
      const sd = await sr.json();
      const connections = sd.providers?.connections || [];
      if (connections.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'))) {
        stopped = true;
        if (resetTimer) clearTimeout(resetTimer);
        clearInterval(statusPoller);
        setPollTimer(null);
        if (!useExternal) window.removeEventListener('message', msgHandler);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
        setConnecting(null);
        fetchStatus();
        refreshPickerModels();
      }
    } catch {}
  }, 2000);
  setPollTimer(statusPoller);

  // Shared exchange helper invoked by whichever relay path delivers the code first.
  let exchanged = false;
  const runExchange = async (code: string, state?: string) => {
    if (exchanged || stopped) return;
    exchanged = true;
    stopped = true;
    if (resetTimer) clearTimeout(resetTimer);
    window.removeEventListener('message', msgHandler);
    if (ipcUnsub) ipcUnsub();
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    clearInterval(statusPoller);
    setPollTimer(null);
    if (popup && !popup.closed) popup.close();
    let succeeded = false;
    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId, code,
          redirect_uri: data.redirect_uri, code_verifier: data.code_verifier,
          state: state || data.state,
        }),
      });
      let body: any = null;
      try { body = await r.json(); } catch {}
      succeeded = r.ok && !!body?.success;
    } catch {}
    // 9Router /providers lags /exchange; an immediate fetchStatus would clobber the UI.
    if (succeeded) markConnected(providerId);
    setConnecting(null);
    refreshPickerModels();
  };

  // postMessage listener; no-ops when cross-origin redirects sever window.opener.
  const msgHandler = async (event: MessageEvent) => {
    const d = event.data;
    const callbackData = d?.type === 'oauth_callback' ? d.data : d;
    if (callbackData?.code) await runExchange(callbackData.code, callbackData.state);
  };
  if (!useExternal) window.addEventListener('message', msgHandler);

  // Electron IPC fallback; main.js forwards callback params so exchange works when opener postMessage fails.
  let ipcUnsub: (() => void) | null = null;
  const ow = (window as any).openswarm;
  if (ow && typeof ow.onOauthCallback === 'function') {
    ipcUnsub = ow.onOauthCallback(async (cb: { code?: string; state?: string; error?: string }) => {
      if (cb?.code) await runExchange(cb.code, cb.state);
    });
  }

  // If the user comes back to openswarm without finishing OAuth (closed the browser, cancelled),
  // 3s of sustained focus + no active connection means abandoned; clear Connecting so they can retry.
  // A blur during the wait cancels, so brief tab-backs to check progress don't false-positive.
  const onBlur = () => {
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  };
  const onFocus = () => {
    if (stopped) return;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(async () => {
      resetTimer = null;
      if (stopped) return;
      try {
        const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
        const sd = await sr.json();
        const conns = sd.providers?.connections || [];
        if (conns.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'))) return;
      } catch {}
      if (stopped) return;
      stopped = true;
      clearInterval(statusPoller);
      setPollTimer(null);
      if (!useExternal) window.removeEventListener('message', msgHandler);
      if (ipcUnsub) ipcUnsub();
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      setConnecting(null);
    }, 3000);
  };
  // Delay attach; popup mode's window.open blurs/refocuses the parent and would false-trigger.
  setTimeout(() => {
    if (!stopped) {
      window.addEventListener('blur', onBlur);
      window.addEventListener('focus', onFocus);
    }
  }, 2000);

  // 3min popup / 5min external-browser; bounds the Connecting indicator, safety-net poller is the real exit.
  const timeoutMs = useExternal ? 300_000 : 180_000;
  setTimeout(() => {
    if (stopped) return;
    stopped = true;
    if (resetTimer) clearTimeout(resetTimer);
    clearInterval(statusPoller);
    setPollTimer(null);
    if (!useExternal) window.removeEventListener('message', msgHandler);
    if (ipcUnsub) ipcUnsub();
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    setConnecting(null);
  }, timeoutMs);
}

// Dispatch on the flow the backend chose; mirrors the original inline branch exactly.
export function runConnectFlow(ctx: ConnectCtx) {
  if (ctx.data.flow === 'device_code') {
    runDeviceCodeFlow(ctx);
  } else if (ctx.data.flow === 'authorization_code') {
    runAuthCodeFlow(ctx);
  } else {
    ctx.setConnecting(null);
  }
}
