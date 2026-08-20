import React, { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Fade from '@mui/material/Fade';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { fetchModels } from '@/shared/state/modelsSlice';
import {
  fetchSubscriptionStatus,
  setSubscriptionStatus,
  markSubscriptionConnected,
  selectSubscriptionConnections,
  type SubscriptionConnection,
} from '@/shared/state/subscriptionsSlice';
import { API_BASE } from '@/shared/config';
import { SUBSCRIPTION_PROVIDERS } from './subscriptionProviders';
import SubscriptionCard from './SubscriptionCard';
import { runConnectFlow } from './subscriptionConnect';
import { performDisconnect } from './subscriptionDisconnect';

function isProviderActive(connections: SubscriptionConnection[], providerId: string): boolean {
  return connections.some((p) => p.provider === providerId && (p.isActive || p.testStatus === 'active'));
}

function friendlyConnectError(detail: string): string {
  const d = (detail || '').trim();
  const lower = d.toLowerCase();
  if (!d) return 'Could not start the login. Please try again.';
  if (lower.includes('1455') || lower.includes('1457') || lower.includes('codex login ports')) return d;
  if (lower.includes('import name') || lower.includes('traceback') || lower.includes('/backend/') || lower.includes('backend.')) {
    return 'Could not start the login. Please try again.';
  }
  return d.length > 180 ? 'Could not start the login. Please try again.' : d;
}

const SubscriptionCards: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // status + connections live in subscriptionsSlice so the onboarding gate (hasModelConnected) sees OAuth connections immediately.
  const status = useAppSelector((s) => s.subscriptions.status);
  const connections = useAppSelector(selectSubscriptionConnections);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<{ provider: string; message: string } | null>(null);
  const [userCode, setUserCode] = useState('');
  const [pollTimer, setPollTimer] = useState<any>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Thin wrapper that returns the resolved status so call sites inspecting the payload keep working.
  const fetchStatus = useCallback(
    async (opts?: { preserveTransient?: boolean }) => {
      return dispatch(fetchSubscriptionStatus(opts)).unwrap();
    },
    [dispatch],
  );

  // Refetch model picker after sub changes so newly-connected providers surface in the dropdown immediately.
  const refreshPickerModels = () => { dispatch(fetchModels()); };

  const markConnected = useCallback((provider: string) => {
    dispatch(markSubscriptionConnected({ provider }));
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Retry initial load; a single transient probe miss would otherwise wedge the spinner until reopen.
      for (const delay of [0, 800, 2000]) {
        if (cancelled) return;
        if (delay) await new Promise(r => setTimeout(r, delay));
        const data = await fetchStatus();
        if (data?.running) break;
      }
    })();
    const interval = setInterval(() => fetchStatus({ preserveTransient: true }), 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [fetchStatus]);

  const isConnected = (providerId: string) => isProviderActive(connections, providerId);

  // A pending confirm on a lane that died some other way (reconnect, cascade wipe) would pop back on reconnect.
  useEffect(() => {
    if (confirmingDisconnect && !isProviderActive(connections, confirmingDisconnect)) setConfirmingDisconnect(null);
  }, [confirmingDisconnect, connections]);

  const handleConnect = async (providerId: string) => {
    if (pollTimer) { clearInterval(pollTimer); setPollTimer(null); }
    setConnectError(null);
    setConfirmingDisconnect(null);
    setDisconnectError(null);
    setConnecting(providerId);
    setUserCode('');

    // Small delay on retry to avoid Claude's rate limit.
    await new Promise(r => setTimeout(r, 500));

    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!r.ok) {
        // Surface an actionable reason (e.g. the ChatGPT :1455 port is held by another app)
        // instead of silently dropping the spinner.
        let detail = '';
        try { detail = (await r.json())?.detail || ''; } catch {}
        setConnectError(friendlyConnectError(detail));
        setConnecting(null);
        return;
      }
      const data = await r.json();
      runConnectFlow({ providerId, data, setConnecting, setUserCode, setPollTimer, fetchStatus, refreshPickerModels, markConnected, setConnectError });
    } catch { setConnecting(null); }
  };

  const handleDisconnect = async (providerId: string) => {
    if (disconnecting) return;
    setConfirmingDisconnect(null);
    // No settle delay: the backend only answers ok after re-reading 9Router, so the lane is already gone.
    // Body lives in subscriptionDisconnect.ts so the "spinner always releases" invariant is reachable
    // by the test runner, which has no DOM on purpose.
    await performDisconnect({
      providerId,
      apiBase: API_BASE,
      fetchStatus,
      refreshPickerModels,
      setDisconnectError,
      setDisconnecting,
    });
  };

  // 4s safety-net poller while connecting; clears Connecting state whenever 9Router reports the provider isActive (handles Windows postMessage failures).
  useEffect(() => {
    if (!connecting) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/agents/subscriptions/status`);
        const d = await r.json();
        if (cancelled) return;
        const conns = d?.providers?.connections || [];
        if (conns.some((p: any) => p.provider === connecting && (p.isActive || p.testStatus === 'active'))) {
          dispatch(setSubscriptionStatus(d));
          setConnecting(null);
          setUserCode('');
          refreshPickerModels();
        }
      } catch {}
    };
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting]);

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
        <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mb: 0.5 }}>
          Starting subscription service...
        </Typography>
        <Typography sx={{ fontSize: '0.625rem', color: c.text.ghost }}>
          This connects your existing AI subscriptions. If this doesn't load, make sure Node.js is installed.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Fade in={!!connectError} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
        <Box sx={{
          display: 'flex', alignItems: 'flex-start', gap: 1, px: 1.5, py: 1,
          borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
          bgcolor: c.bg.surface,
        }}>
          <Typography sx={{ fontSize: '0.75rem', color: c.text.secondary, flex: 1, lineHeight: 1.4 }}>
            {connectError}
          </Typography>
          <Box
            role="button"
            aria-label="Dismiss"
            onClick={() => setConnectError(null)}
            sx={{ color: c.text.muted, cursor: 'pointer', fontSize: '0.875rem', lineHeight: 1, px: 0.3, '&:hover': { color: c.text.secondary } }}
          >
            ×
          </Box>
        </Box>
      </Fade>
      {SUBSCRIPTION_PROVIDERS.map(p => (
        <SubscriptionCard
          key={p.id}
          provider={p}
          connected={isConnected(p.id)}
          onConnect={() => handleConnect(p.id)}
          onRequestDisconnect={() => { setDisconnectError(null); setConfirmingDisconnect(p.id); }}
          onCancelDisconnect={() => setConfirmingDisconnect(null)}
          onDisconnect={() => handleDisconnect(p.id)}
          connecting={connecting === p.id}
          confirmingDisconnect={confirmingDisconnect === p.id}
          disconnecting={disconnecting === p.id}
          error={disconnectError?.provider === p.id ? disconnectError.message : undefined}
          userCode={connecting === p.id ? userCode : undefined}
        />
      ))}
    </Box>
  );
};

export default SubscriptionCards;
