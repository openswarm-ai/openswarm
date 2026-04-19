import React, { useState, useEffect, useRef } from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import {
  SUBSCRIPTIONS_STATUS,
  SUBSCRIPTIONS_CONNECT,
  SUBSCRIPTIONS_POLL,
  SUBSCRIPTIONS_DISCONNECT,
} from '@/shared/backend-bridge/apps/subscriptions';
import SubscriptionCard, { SUBSCRIPTION_PROVIDERS } from './SubscriptionCard';

const SubscriptionCards: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<any>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [userCode, setUserCode] = useState('');
  const [pollTimer, setPollTimer] = useState<any>(null);
  const retryRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchStatus = () => {
    dispatch(SUBSCRIPTIONS_STATUS()).unwrap()
      .then(setStatus)
      .catch(() => setStatus({ running: false, providers: [], models: [] }));
  };
  const fetchStatusWithRetry = () => {
    fetchStatus();
    setTimeout(fetchStatus, 1000);
    setTimeout(fetchStatus, 3000);
  };
  useEffect(() => {
    fetchStatus();
    retryRef.current = setInterval(fetchStatus, 3000);
    return () => { if (retryRef.current) clearInterval(retryRef.current); };
  }, []);
  useEffect(() => {
    if (status?.running && retryRef.current) {
      clearInterval(retryRef.current);
      retryRef.current = null;
    }
  }, [status?.running]);
  const isConnected = (providerId: string) => {
    if (!status?.providers) return false;
    const connections = status.providers?.connections || (Array.isArray(status.providers) ? status.providers : []);
    return connections.some((p: any) => p.provider === providerId && p.isActive);
  };
  const handleConnect = async (providerId: string) => {
    if (pollTimer) { clearInterval(pollTimer); setPollTimer(null); }
    setConnecting(providerId);
    setUserCode('');
    await new Promise(r => setTimeout(r, 500));
    try {
      const data = await dispatch(SUBSCRIPTIONS_CONNECT(providerId)).unwrap();
      if (data.flow === 'device_code') {
        const code = (data.user_code as string) || '';
        setUserCode(code);
        if (data.verification_uri) window.open(data.verification_uri as string, '_blank');
        const timer = setInterval(async () => {
          try {
            const pd = await dispatch(SUBSCRIPTIONS_POLL({
              provider: providerId,
              device_code: data.device_code as string,
              code_verifier: data.code_verifier as string | undefined,
              extra_data: data.extra_data as Record<string, unknown> | undefined,
            })).unwrap();
            if ((pd as any).success) {
              clearInterval(timer);
              setPollTimer(null);
              setConnecting(null);
              setUserCode('');
              fetchStatusWithRetry();
            }
          } catch {}
        }, 5000);
        setPollTimer(timer);
        setTimeout(() => { clearInterval(timer); setPollTimer(null); setConnecting(null); setUserCode(''); }, 300000);
      } else if (data.flow === 'authorization_code') {
        const popup = window.open(data.auth_url as string, 'oauth_connect', 'width=600,height=700');
        let resolved = false;
        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          clearInterval(statusPoller);
          setPollTimer(null);
          window.removeEventListener('message', msgHandler);
          if (popup && !popup.closed) popup.close();
          setConnecting(null);
          fetchStatusWithRetry();
        };
        const msgHandler = (event: MessageEvent) => {
          const d = event.data;
          if (d?.type === 'oauth_callback' && d?.data?.connected) cleanup();
        };
        window.addEventListener('message', msgHandler);
        const statusPoller = setInterval(async () => {
          try {
            if (popup?.closed && !resolved) {
              await new Promise(r => setTimeout(r, 1000));
              cleanup();
              return;
            }
            const sd = await dispatch(SUBSCRIPTIONS_STATUS()).unwrap();
            const connections = (sd.providers as any)?.connections || [];
            if (connections.some((p: any) => p.provider === providerId && p.isActive)) {
              cleanup();
            }
          } catch {}
        }, 2000);
        setPollTimer(statusPoller);
        setTimeout(cleanup, 120000);
      } else {
        setConnecting(null);
      }
    } catch { setConnecting(null); }
  };
  const handleDisconnect = async (providerId: string) => {
    setDisconnecting(providerId);
    try {
      await dispatch(SUBSCRIPTIONS_DISCONNECT(providerId)).unwrap();
    } catch {}
    setTimeout(() => { fetchStatusWithRetry(); setDisconnecting(null); }, 500);
  };
  if (!status) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {SUBSCRIPTION_PROVIDERS.map(p => (
          <Box key={p.id} sx={{
            p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
            display: 'flex', alignItems: 'center', gap: 1,
            animation: 'skeleton-pulse 1.5s ease-in-out infinite',
            '@keyframes skeleton-pulse': { '0%, 100%': { opacity: 0.5 }, '50%': { opacity: 0.25 } },
          }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: c.border.medium, flexShrink: 0 }} />
            <Box sx={{ flex: 1 }}>
              <Box sx={{ width: 100, height: 12, bgcolor: c.border.subtle, borderRadius: 1, mb: 0.5 }} />
              <Box sx={{ width: 180, height: 10, bgcolor: c.border.subtle, borderRadius: 1 }} />
            </Box>
          </Box>
        ))}
      </Box>
    );
  }
  if (!status?.running) {
    return (
      <Box sx={{ p: 2, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`, textAlign: 'center' }}>
        <CircularProgress size={18} sx={{ color: c.text.ghost, mb: 1 }} />
        <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 0.5 }}>
          Starting subscription service...
        </Typography>
        <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost }}>
          This connects your existing AI subscriptions. If this doesn't load, make sure Node.js is installed.
        </Typography>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {SUBSCRIPTION_PROVIDERS.map(p => (
        <SubscriptionCard
          key={p.id}
          provider={p}
          connected={isConnected(p.id)}
          onConnect={() => handleConnect(p.id)}
          onDisconnect={() => handleDisconnect(p.id)}
          connecting={connecting === p.id}
          disconnecting={disconnecting === p.id}
          userCode={connecting === p.id ? userCode : undefined}
        />
      ))}
    </Box>
  );
};

export default SubscriptionCards;
