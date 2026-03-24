import React, { useState, useEffect } from 'react';
import { Box, Typography, Modal, Button } from '@mui/material';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';

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
  const [dismissed, setDismissed] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [nineRouterStatus, setNineRouterStatus] = useState<any>(null);

  // Check if user has any credentials configured
  const hasAnyKey = !!(
    settings.anthropic_api_key ||
    settings.openai_api_key ||
    settings.google_api_key ||
    settings.openrouter_api_key
  );

  // Check 9Router subscription status
  useEffect(() => {
    fetch(`${API_BASE}/agents/subscriptions/status`)
      .then((r) => r.json())
      .then(setNineRouterStatus)
      .catch(() => setNineRouterStatus(null));
  }, []);

  const hasSubscription = (() => {
    if (!nineRouterStatus?.running) return false;
    const connections = nineRouterStatus?.providers?.connections || [];
    return connections.some((p: any) => p.isActive);
  })();

  // Show modal if no keys AND no subscriptions AND not dismissed
  useEffect(() => {
    if (!hasAnyKey && !hasSubscription && !dismissed && nineRouterStatus !== null) {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [hasAnyKey, hasSubscription, dismissed, nineRouterStatus]);

  const handleConnect = async (providerId: string) => {
    setConnecting(providerId);
    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await r.json();

      if (data.flow === 'device_code') {
        const verifyUrl = data.verification_uri;
        if (verifyUrl) window.open(verifyUrl, '_blank');
        // Poll for completion
        const timer = setInterval(async () => {
          try {
            const pr = await fetch(`${API_BASE}/agents/subscriptions/poll`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: providerId, device_code: data.device_code, code_verifier: data.code_verifier, extra_data: data.extra_data }),
            });
            const pd = await pr.json();
            if (pd.success) {
              clearInterval(timer);
              setConnecting(null);
              setOpen(false);
            }
          } catch {}
        }, 5000);
        setTimeout(() => { clearInterval(timer); setConnecting(null); }, 300000);
      } else if (data.flow === 'authorization_code') {
        // Open auth URL as popup — window.opener lets callback page postMessage back
        const popup = window.open(data.auth_url, 'oauth_connect', 'width=600,height=700');

        // Listen for postMessage from 9Router's callback page
        // 9Router sends: { type: "oauth_callback", data: { code, state, ... } }
        const msgHandler = async (event: MessageEvent) => {
          const d = event.data;
          const callbackData = d?.type === 'oauth_callback' ? d.data : d;
          if (callbackData?.code) {
            window.removeEventListener('message', msgHandler);
            clearInterval(statusPoller);
            if (popup && !popup.closed) popup.close();
            try {
              await fetch(`${API_BASE}/agents/subscriptions/exchange`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  provider: providerId, code: callbackData.code,
                  redirect_uri: data.redirect_uri, code_verifier: data.code_verifier,
                  state: callbackData.state || data.state,
                }),
              });
            } catch {}
            setConnecting(null);
            setOpen(false);
          }
        };
        window.addEventListener('message', msgHandler);

        // Also poll status as fallback (in case postMessage doesn't work in Electron)
        const statusPoller = setInterval(async () => {
          try {
            const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
            const sd = await sr.json();
            const conns = sd.providers?.connections || [];
            if (conns.some((p: any) => p.provider === providerId && p.isActive)) {
              clearInterval(statusPoller);
              window.removeEventListener('message', msgHandler);
              setConnecting(null);
              setOpen(false);
            }
          } catch {}
        }, 2000);
        setTimeout(() => { clearInterval(statusPoller); window.removeEventListener('message', msgHandler); setConnecting(null); }, 300000);
      }
    } catch {
      setConnecting(null);
    }
  };

  const handleApiKey = () => {
    setDismissed(true);
    setOpen(false);
    // User will manually go to Settings → Models to add API keys
  };

  const handleSkip = () => {
    setDismissed(true);
    setOpen(false);
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={handleSkip} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Box sx={{
        width: 480, maxWidth: '90vw', bgcolor: c.bg.surface, borderRadius: `${c.radius.xl}px`,
        border: `1px solid ${c.border.subtle}`, p: 3.5, outline: 'none',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
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
              onClick={() => !p.preview && !connecting && handleConnect(p.id)}
              sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
                cursor: p.preview ? 'default' : connecting ? 'wait' : 'pointer',
                opacity: p.preview ? 0.5 : 1,
                transition: 'border-color 0.15s, background 0.15s',
                ...(!p.preview && { '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` } }),
              }}
            >
              <Box>
                <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.primary }}>{p.name}</Typography>
                <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>{p.desc}</Typography>
              </Box>
              <Typography sx={{ fontSize: '0.68rem', color: p.preview ? c.text.ghost : connecting === p.id ? c.accent.primary : c.text.tertiary, fontStyle: p.preview ? 'italic' : 'normal' }}>
                {p.preview ? 'Coming soon' : connecting === p.id ? 'Connecting...' : 'Connect →'}
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
            Go to Settings → Models to enter your key
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
      </Box>
    </Modal>
  );
};

export default OnboardingModal;
