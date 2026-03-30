import React, { useState, useEffect, useRef } from 'react';
import { Box, Typography, Modal, Button, CircularProgress } from '@mui/material';
import LinkIcon from '@mui/icons-material/Link';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';

const ONBOARDING_TOOL_INTEGRATIONS = [
  { name: 'Google Workspace', desc: 'Gmail, Calendar, Drive, Docs, Sheets', color: '#4285F4', oauthProvider: 'google',
    mcp_config: { type: 'stdio', command: 'uvx', args: ['--from', 'google-workspace-mcp', 'google-workspace-worker'] } },
  { name: 'GitHub', desc: 'Repos, issues, pull requests', color: '#24292E', oauthProvider: 'github',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
  { name: 'Slack', desc: 'Channels, messages, search', color: '#4A154B', oauthProvider: 'slack',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] } },
  { name: 'Notion', desc: 'Pages, databases, search', color: '#000000', oauthProvider: 'notion',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] } },
];

const SUBSCRIPTION_PROVIDERS = [
  { id: 'claude', name: 'Claude', desc: 'Sonnet, Opus, Haiku', color: '#E8927A', preview: false },
  { id: 'gemini-cli', name: 'Gemini', desc: 'Gemini 2.5 Pro & Flash', color: '#4285F4', preview: true },
  { id: 'codex', name: 'ChatGPT', desc: 'GPT-5.4, o3, o4-mini', color: '#74AA9C', preview: true },
  { id: 'github', name: 'GitHub Copilot', desc: 'Claude + GPT models', color: '#8B949E', preview: true },
];

const OnboardingModal: React.FC = () => {
  const c = useClaudeTokens();
  const settings = useAppSelector((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'provider' | 'tools'>('provider');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [nineRouterReady, setNineRouterReady] = useState<boolean | null>(null);
  const [connectedTools, setConnectedTools] = useState<Set<string>>(new Set());
  const pollTimerRef = useRef<any>(null);
  const msgHandlerRef = useRef<any>(null);

  // Poll for 9Router readiness (it may still be starting when onboarding shows)
  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 15; // 30 seconds
    const check = () => {
      fetch(`${API_BASE}/subscriptions/status`)
        .then((r) => r.json())
        .then((data) => {
          if (data.running) {
            // Check if already has subscription
            const connections = data.providers?.connections || [];
            if (connections.some((p: any) => p.isActive)) {
              // Already connected — don't show onboarding
              return;
            }
            // Delay before marking ready — 9Router's OAuth needs time to warm up
            setTimeout(() => setNineRouterReady(true), 3000);
          } else {
            attempts++;
            if (attempts < maxAttempts) {
              setTimeout(check, 2000);
            } else {
              setNineRouterReady(false);
            }
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

  // Show once: if not previously dismissed
  useEffect(() => {
    const alreadySeen = localStorage.getItem('openswarm_onboarding_seen');
    if (alreadySeen === 'true') return;
    if (nineRouterReady === null) return; // still checking

    setOpen(true);
  }, [nineRouterReady]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (msgHandlerRef.current) window.removeEventListener('message', msgHandlerRef.current);
    };
  }, []);

  const dismiss = () => {
    localStorage.setItem('openswarm_onboarding_seen', 'true');
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(null);
    setOpen(false);
  };

  // Same connect logic as Settings/SubscriptionCards
  const handleConnect = async (providerId: string) => {
    // Cancel any previous attempt
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(providerId);

    // Delay before calling connect — avoids Claude OAuth rate limit on retries
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

        // Poll status as primary detection (works in Electron where postMessage may not)
        const statusPoller = setInterval(async () => {
          try {
            const sr = await fetch(`${API_BASE}/subscriptions/status`);
            const sd = await sr.json();
            const connections = sd.providers?.connections || [];
            if (connections.some((p: any) => p.provider === providerId && p.isActive)) {
              clearInterval(statusPoller);
              pollTimerRef.current = null;
              if (msgHandlerRef.current) {
                window.removeEventListener('message', msgHandlerRef.current);
                msgHandlerRef.current = null;
              }
              advanceToTools();
            }
          } catch {}
        }, 2000);
        pollTimerRef.current = statusPoller;

        // Also listen for postMessage from callback page (faster when it works)
        const msgHandler = async (event: MessageEvent) => {
          const d = event.data;
          const callbackData = d?.type === 'oauth_callback' ? d.data : d;
          if (callbackData?.code) {
            window.removeEventListener('message', msgHandler);
            msgHandlerRef.current = null;
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
            if (popup && !popup.closed) popup.close();
            try {
              await fetch(`${API_BASE}/subscriptions/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  provider: providerId,
                  code: callbackData.code,
                  redirect_uri: data.redirect_uri,
                  code_verifier: data.code_verifier,
                  state: callbackData.state || data.state,
                }),
              });
            } catch {}
            advanceToTools();
          }
        };
        window.addEventListener('message', msgHandler);
        msgHandlerRef.current = msgHandler;

        setTimeout(() => {
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
          if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
          setConnecting(null);
        }, 30000);

      } else {
        setConnecting(null);
      }
    } catch {
      setConnecting(null);
    }
  };

  const advanceToTools = () => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(null);
    setStep('tools');
  };

  const handleToolConnect = async (integration: typeof ONBOARDING_TOOL_INTEGRATIONS[0]) => {
    setConnecting(integration.name);
    try {
      // Create the tool
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

      // Start OAuth
      const oauthRes = await fetch(`${API_BASE}/tools/${tool.id}/oauth/start`, { method: 'POST' });
      if (!oauthRes.ok) { setConnecting(null); return; }
      const { auth_url } = await oauthRes.json();

      // Open popup
      const popup = window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');

      // Listen for completion
      const onMsg = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_complete' && event.data?.tool_id === tool.id) {
          window.removeEventListener('message', onMsg);
          setConnectedTools((prev) => new Set(prev).add(integration.name));
          setConnecting(null);
          // Trigger discovery in background
          fetch(`${API_BASE}/tools/${tool.id}/discover`, { method: 'POST' }).catch(() => {});
        }
      };
      window.addEventListener('message', onMsg);

      // Fallback: poll for popup close
      const poller = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(poller);
          window.removeEventListener('message', onMsg);
          // Check if connected
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
  };

  const handleApiKey = () => advanceToTools();
  const handleSkip = () => step === 'tools' ? dismiss() : dismiss();

  if (!open) return null;

  return (
    <Modal open={open} onClose={handleSkip} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Box sx={{
        width: 480, maxWidth: '90vw', bgcolor: c.bg.surface, borderRadius: `${c.radius.xl}px`,
        border: `1px solid ${c.border.subtle}`, p: 3.5, outline: 'none',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        {step === 'tools' ? (
          <>
            <Typography sx={{ fontSize: '1.3rem', fontWeight: 700, color: c.text.primary, mb: 0.5, textAlign: 'center' }}>
              Connect Your Accounts
            </Typography>
            <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 0.5, textAlign: 'center' }}>
              10+ tools already active with no setup needed
            </Typography>
            <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, mb: 3, textAlign: 'center' }}>
              Connect services below for even more capabilities
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 2.5 }}>
              {ONBOARDING_TOOL_INTEGRATIONS.map((ig) => {
                const isConnected = connectedTools.has(ig.name);
                const isConnecting = connecting === ig.name;
                return (
                  <Box
                    key={ig.name}
                    onClick={() => !isConnected && !isConnecting && !connecting && handleToolConnect(ig)}
                    sx={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      p: 1.5, borderRadius: `${c.radius.md}px`,
                      border: `1px solid ${isConnected ? `${ig.color}40` : c.border.subtle}`,
                      cursor: isConnected ? 'default' : connecting ? 'wait' : 'pointer',
                      bgcolor: isConnected ? `${ig.color}08` : 'transparent',
                      transition: 'border-color 0.15s, background 0.15s',
                      ...(!isConnected && !connecting && { '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}05` } }),
                    }}
                  >
                    <Box>
                      <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.primary }}>{ig.name}</Typography>
                      <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>{ig.desc}</Typography>
                    </Box>
                    {isConnected ? (
                      <CheckCircleIcon sx={{ fontSize: 18, color: ig.color }} />
                    ) : (
                      <Typography sx={{ fontSize: '0.68rem', color: isConnecting ? ig.color : c.text.tertiary }}>
                        {isConnecting ? 'Connecting...' : 'Connect \u2192'}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>

            <Button
              onClick={dismiss}
              fullWidth
              variant={connectedTools.size > 0 ? 'contained' : 'text'}
              sx={{
                textTransform: 'none', fontSize: '0.78rem', borderRadius: `${c.radius.md}px`,
                ...(connectedTools.size > 0
                  ? { bgcolor: c.accent.primary, color: '#fff', '&:hover': { bgcolor: c.accent.hover } }
                  : { color: c.text.ghost, '&:hover': { bgcolor: 'transparent', color: c.text.muted } }),
              }}
            >
              {connectedTools.size > 0 ? 'Done' : 'Skip for now'}
            </Button>
          </>
        ) : (
          <>
        <Typography sx={{ fontSize: '1.3rem', fontWeight: 700, color: c.text.primary, mb: 0.5, textAlign: 'center' }}>
          Welcome to OpenSwarm
        </Typography>
        <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 3, textAlign: 'center' }}>
          Connect an AI model to get started
        </Typography>

        {/* Subscription options */}
        <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
          Use your existing subscription
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 2.5 }}>
          {SUBSCRIPTION_PROVIDERS.map((p) => (
            <Box
              key={p.id}
              onClick={() => !p.preview && !connecting && nineRouterReady && handleConnect(p.id)}
              sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
                cursor: p.preview || !nineRouterReady ? 'default' : connecting ? 'wait' : 'pointer',
                opacity: p.preview ? 0.5 : !nineRouterReady ? 0.6 : 1,
                transition: 'border-color 0.15s, background 0.15s',
                ...(!p.preview && nineRouterReady && { '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` } }),
              }}
            >
              <Box>
                <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.primary }}>{p.name}</Typography>
                <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>{p.desc}</Typography>
              </Box>
              <Typography sx={{ fontSize: '0.68rem', color: p.preview ? c.text.ghost : connecting === p.id ? c.accent.primary : !nineRouterReady ? c.text.ghost : c.text.tertiary, fontStyle: p.preview ? 'italic' : 'normal' }}>
                {p.preview ? 'Coming soon' : connecting === p.id ? 'Connecting...' : !nineRouterReady && nineRouterReady !== false ? 'Starting...' : 'Connect \u2192'}
              </Typography>
            </Box>
          ))}
        </Box>

        {/* API key option */}
        <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
          Or use an API key
        </Typography>
        <Box
          onClick={handleApiKey}
          sx={{
            p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
            cursor: 'pointer', mb: 2.5,
            '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` },
          }}
        >
          <Typography sx={{ fontSize: '0.78rem', color: c.text.primary }}>
            I have an API key
          </Typography>
          <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>
            Go to Settings &rarr; Models to enter your key
          </Typography>
        </Box>

        {/* Skip */}
        <Button
          onClick={handleSkip}
          fullWidth
          sx={{ textTransform: 'none', fontSize: '0.72rem', color: c.text.ghost, '&:hover': { bgcolor: 'transparent', color: c.text.muted } }}
        >
          Skip for now
        </Button>
          </>
        )}
      </Box>
    </Modal>
  );
};

export default OnboardingModal;
