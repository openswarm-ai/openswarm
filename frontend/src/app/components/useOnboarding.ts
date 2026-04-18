import { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE } from '@/shared/config';
import { useAppDispatch } from '@/shared/hooks';
import { SUBSCRIPTIONS_STATUS } from '@/shared/backend-bridge/apps/subscriptions';
import { ToolIntegration } from './onboardingConstants';
import { useSubscriptionConnect } from './useSubscriptionConnect';

export function useOnboarding() {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'provider' | 'tools'>('provider');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [nineRouterReady, setNineRouterReady] = useState<boolean | null>(null);
  const [connectedTools, setConnectedTools] = useState<Set<string>>(new Set());
  const pollTimerRef = useRef<any>(null);
  const msgHandlerRef = useRef<any>(null);

  const advanceToTools = useCallback(() => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(null);
    setStep('tools');
  }, []);

  const handleConnect = useSubscriptionConnect({
    pollTimerRef, msgHandlerRef, setConnecting, advanceToTools,
  });

  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 15;
    const check = () => {
      dispatch(SUBSCRIPTIONS_STATUS()).unwrap()
        .then((data) => {
          if (data.running) {
            const connections = (data.providers as any)?.connections || [];
            if (connections.some((p: any) => p.isActive)) return;
            setTimeout(() => setNineRouterReady(true), 3000);
          } else {
            attempts++;
            if (attempts < maxAttempts) setTimeout(check, 2000);
            else setNineRouterReady(false);
          }
        })
        .catch(() => {
          attempts++;
          if (attempts < maxAttempts) setTimeout(check, 2000);
          else setNineRouterReady(false);
        });
    };
    check();
  }, []);

  useEffect(() => {
    const alreadySeen = localStorage.getItem('openswarm_onboarding_seen');
    if (alreadySeen === 'true') return;
    if (nineRouterReady === null) return;
    setOpen(true);
  }, [nineRouterReady]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (msgHandlerRef.current) window.removeEventListener('message', msgHandlerRef.current);
    };
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem('openswarm_onboarding_seen', 'true');
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(null);
    setOpen(false);
  }, []);

  const handleToolConnect = useCallback(async (integration: ToolIntegration) => {
    setConnecting(integration.name);
    try {
      const createRes = await fetch(`${API_BASE}/tools/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: integration.name,
          description: integration.desc,
          mcp_config: integration.mcp_config,
          auth_type: 'oauth2',
          auth_status: 'configured',
          oauth_provider: integration.oauthProvider,
        }),
      });
      if (!createRes.ok) { setConnecting(null); return; }
      const { tool } = await createRes.json();

      const oauthRes = await fetch(`${API_BASE}/tools/${tool.id}/oauth/start`, { method: 'POST' });
      if (!oauthRes.ok) { setConnecting(null); return; }
      const { auth_url } = await oauthRes.json();

      const popup = window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');

      const onMsg = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_complete' && event.data?.tool_id === tool.id) {
          window.removeEventListener('message', onMsg);
          setConnectedTools((prev) => new Set(prev).add(integration.name));
          setConnecting(null);
          fetch(`${API_BASE}/tools/${tool.id}/discover`, { method: 'POST' }).catch(() => {});
        }
      };
      window.addEventListener('message', onMsg);

      const poller = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(poller);
          window.removeEventListener('message', onMsg);
          fetch(`${API_BASE}/tools/${tool.id}`)
            .then(r => r.json())
            .then(data => {
              if (data.tool?.auth_status === 'connected') {
                setConnectedTools((prev) => new Set(prev).add(integration.name));
                fetch(`${API_BASE}/tools/${tool.id}/discover`, { method: 'POST' }).catch(() => {});
              }
            })
            .catch(() => {});
          setConnecting(null);
        }
      }, 1000);
      setTimeout(() => { clearInterval(poller); setConnecting(null); }, 60000);
    } catch {
      setConnecting(null);
    }
  }, []);

  const handleApiKey = useCallback(() => advanceToTools(), [advanceToTools]);
  const handleSkip = useCallback(() => dismiss(), [dismiss]);

  return {
    open, step, connecting, nineRouterReady, connectedTools,
    dismiss, handleConnect, handleToolConnect, handleApiKey, handleSkip,
  };
}
