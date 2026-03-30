import { useCallback, MutableRefObject } from 'react';
import { API_BASE } from '@/shared/config';

interface UseSubscriptionConnectParams {
  pollTimerRef: MutableRefObject<any>;
  msgHandlerRef: MutableRefObject<any>;
  setConnecting: (v: string | null) => void;
  advanceToTools: () => void;
}

export function useSubscriptionConnect({
  pollTimerRef, msgHandlerRef, setConnecting, advanceToTools,
}: UseSubscriptionConnectParams) {
  const handleConnect = useCallback(async (providerId: string) => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(providerId);

    await new Promise(r => setTimeout(r, 1000));

    try {
      const r = await fetch(`${API_BASE}/subscriptions/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!r.ok) {
        setConnecting(null);
        return;
      }
      const data = await r.json();

      if (data.flow === 'device_code') {
        if (data.verification_uri) window.open(data.verification_uri, '_blank');

        const timer = setInterval(async () => {
          try {
            const pr = await fetch(`${API_BASE}/subscriptions/poll`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: providerId,
                device_code: data.device_code,
                code_verifier: data.code_verifier,
                extra_data: data.extra_data,
              }),
            });
            const pd = await pr.json();
            if (pd.success) {
              clearInterval(timer);
              pollTimerRef.current = null;
              advanceToTools();
            }
          } catch {}
        }, 5000);
        pollTimerRef.current = timer;
        setTimeout(() => { clearInterval(timer); pollTimerRef.current = null; setConnecting(null); }, 30000);

      } else if (data.flow === 'authorization_code') {
        const popup = window.open(data.auth_url, 'oauth_connect', 'width=600,height=700');
        let resolved = false;
        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          clearInterval(statusPoller);
          pollTimerRef.current = null;
          if (msgHandlerRef.current) {
            window.removeEventListener('message', msgHandlerRef.current);
            msgHandlerRef.current = null;
          }
          if (popup && !popup.closed) popup.close();
        };
        const msgHandler = (event: MessageEvent) => {
          const d = event.data;
          if (d?.type === 'oauth_callback' && d?.data?.connected) {
            cleanup();
            advanceToTools();
          }
        };
        window.addEventListener('message', msgHandler);
        msgHandlerRef.current = msgHandler;
        const statusPoller = setInterval(async () => {
          try {
            if (popup?.closed && !resolved) {
              await new Promise(r => setTimeout(r, 1000));
              cleanup();
              advanceToTools();
              return;
            }
            const sr = await fetch(`${API_BASE}/subscriptions/status`);
            const sd = await sr.json();
            const connections = sd.providers?.connections || [];
            if (connections.some((p: any) => p.provider === providerId && p.isActive)) {
              cleanup();
              advanceToTools();
            }
          } catch {}
        }, 2000);
        pollTimerRef.current = statusPoller;
        setTimeout(() => { cleanup(); setConnecting(null); }, 120000);

      } else {
        setConnecting(null);
      }
    } catch {
      setConnecting(null);
    }
  }, [pollTimerRef, msgHandlerRef, setConnecting, advanceToTools]);

  return handleConnect;
}
