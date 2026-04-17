import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { trackEvent } from '@/shared/analytics';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import LanguageIcon from '@mui/icons-material/Language';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DownloadIcon from '@mui/icons-material/Download';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Collapse from '@mui/material/Collapse';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettings, closeSettingsModal, resetSystemPrompt, disconnectSubscription, AppSettings, DEFAULT_SYSTEM_PROMPT } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import { setChecking, setUpdateError, setInstalling } from '@/shared/state/updateSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';
import DirectoryBrowser from '@/app/components/DirectoryBrowser';
import { CommandsContent } from '@/app/pages/Commands/Commands';
import { API_BASE } from '@/shared/config';
import PlanPicker from '@/app/components/PlanPicker';
import type { OpenSwarmPlan } from '@/shared/subscription/checkout';

// NOTE: a standalone CopilotAuthButton component used to live here, but it
// referenced `/agents/copilot/{models,start-auth,poll-auth,disconnect}`
// endpoints that never existed on the backend. GitHub Copilot now flows
// through 9Router's `github` OAuth under the generic SubscriptionCard path
// below, so the dead component was removed.

// ── Subscription Provider Card ──
const SUBSCRIPTION_PROVIDERS = [
  { id: 'claude', name: 'Claude Pro / Max', desc: 'Sonnet 4.6, Opus 4.6, Haiku 4.5', color: '#E8927A', preview: false },
  { id: 'gemini-cli', name: 'Gemini Advanced', desc: 'Gemini 3 Pro, 3 Flash, 2.5 Pro, 2.5 Flash', color: '#4285F4', preview: false },
  { id: 'codex', name: 'ChatGPT Plus / Pro', desc: 'GPT-5.4, GPT-5.4 Mini, GPT-5.3 Codex', color: '#74AA9C', preview: false },
];

const SubscriptionCard: React.FC<{ provider: typeof SUBSCRIPTION_PROVIDERS[0]; connected: boolean; onConnect: () => void; onDisconnect: () => void; connecting: boolean; userCode?: string; disconnecting?: boolean }> = ({ provider, connected, onConnect, onDisconnect, connecting, userCode, disconnecting }) => {
  const c = useClaudeTokens();
  const isPreview = (provider as any).preview;
  return (
    <Box sx={{
      p: 1.5, borderRadius: `${c.radius.md}px`,
      border: `1px solid ${connected ? c.status.success + '30' : connecting ? c.accent.primary + '30' : c.border.subtle}`,
      bgcolor: connected ? `${c.status.success}04` : connecting ? `${c.accent.primary}04` : 'transparent',
      opacity: isPreview ? 0.5 : 1,
      transition: 'all 0.3s ease',
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            bgcolor: connected ? c.status.success : connecting ? c.accent.primary : c.border.medium,
            transition: 'background-color 0.3s ease',
            ...(connecting ? {
              animation: 'pulse-dot 1.5s ease-in-out infinite',
              '@keyframes pulse-dot': {
                '0%, 100%': { opacity: 1, transform: 'scale(1)' },
                '50%': { opacity: 0.4, transform: 'scale(0.8)' },
              },
            } : {}),
          }} />
          <Box>
            <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: c.text.primary }}>{provider.name}</Typography>
            <Typography sx={{ fontSize: '0.65rem', color: connecting ? c.accent.primary : c.text.muted, transition: 'color 0.3s ease' }}>
              {connecting ? 'Waiting for authorization...' : provider.desc}
            </Typography>
          </Box>
        </Box>
        {isPreview ? (
          <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, fontStyle: 'italic' }}>
            Coming soon
          </Typography>
        ) : connected ? (
          disconnecting ? (
            <CircularProgress size={14} sx={{ color: c.text.ghost }} />
          ) : (
            <Typography onClick={onDisconnect} sx={{ fontSize: '0.68rem', color: c.text.tertiary, cursor: 'pointer', '&:hover': { color: c.status.error }, transition: 'color 0.2s ease' }}>
              Disconnect
            </Typography>
          )
        ) : connecting && userCode ? (
          <Box sx={{ textAlign: 'right' }}>
            <Typography sx={{ fontSize: '0.68rem', color: c.text.muted }}>Enter code:</Typography>
            <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: c.accent.primary, fontFamily: 'monospace', letterSpacing: '0.1em' }}>{userCode}</Typography>
          </Box>
        ) : connecting ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
            <CircularProgress size={14} sx={{ color: c.accent.primary }} />
            <Typography sx={{ fontSize: '0.68rem', color: c.accent.primary }}>Connecting...</Typography>
          </Box>
        ) : (
          <Button onClick={onConnect} variant="outlined" size="small" sx={{ textTransform: 'none', fontSize: '0.7rem', color: c.text.primary, borderColor: c.border.medium, minWidth: 70, '&:hover': { borderColor: c.accent.primary }, transition: 'all 0.2s ease' }}>
            Connect
          </Button>
        )}
      </Box>
    </Box>
  );
};

// ── OpenSwarm Pro managed-subscription card ──
//
// Renders either a "Subscribe" CTA (when not connected) or a live usage +
// Manage/Disconnect card (when connection_mode === 'openswarm-pro'). All
// billing details come from /api/subscription/status at runtime — no
// pricing is hardcoded in this OSS repo.
interface OpenSwarmProStatus {
  connected: boolean;
  connection_mode?: string;
  plan?: string | null;
  status?: string | null;
  expires?: string | null;
  // When the cloud reports the bearer as revoked (401) or the sub as past
  // its grace period (402), backend clears local state and returns
  // connected=false with a reason + last_plan so the UI can distinguish
  // "your subscription ended" from "never subscribed."
  reason?: 'revoked' | 'expired' | null;
  last_plan?: string | null;
  usage?: {
    // Live utilization from Claude's /api/oauth/usage — 0-100 percent of the
    // shared pool subscription's 5h window consumed. Updated every ~30s.
    utilization?: number;
    window_hours?: number;
    window_ends_at?: number;
    pool_active_accounts?: number;
  } | null;
}

// Clamp an arbitrary plan name from the cloud to one of the three picker
// tiers. Falls back to pro_plus so the "recommended" default stays selected
// if the user's prior plan was hobby or an unknown value.
const clampPickerPlan = (plan: string | null | undefined): OpenSwarmPlan => {
  if (plan === 'pro' || plan === 'pro_plus' || plan === 'ultra') return plan;
  return 'pro_plus';
};

const OpenSwarmProCard: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<OpenSwarmProStatus | null>(null);
  const [busy, setBusy] = useState<'manage' | 'disconnect' | null>(null);
  // Track which usage thresholds we've already fired this session so the
  // event doesn't spam PostHog every 30s while the counter hovers past
  // the threshold. Reset implicitly on page unmount (settings close).
  const firedUsageThresholds = useRef<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/subscription/status`);
      if (r.ok) setStatus(await r.json());
    } catch {
      // silently ignore — cloud might be offline
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleManage = async () => {
    trackEvent('subscription.manage_clicked', {
      plan: status?.plan ?? null,
      status: status?.status ?? null,
    });
    setBusy('manage');
    try {
      const r = await fetch(`${API_BASE}/subscription/portal`, { method: 'POST' });
      if (r.ok) {
        const { url } = await r.json();
        const api = (window as any).openswarm;
        if (url && api?.openExternal) api.openExternal(url);
        else if (url) window.open(url, '_blank');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    setBusy('disconnect');
    try {
      await dispatch(disconnectSubscription()).unwrap();
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // Fire subscription.usage_warning exactly once per threshold per session
  // when utilization crosses 80% / 90%. Placed before the early return so
  // the hook chain stays stable.
  useEffect(() => {
    if (!status?.connected) return;
    const rawPct = status.usage?.utilization ?? 0;
    const current = Math.max(0, Math.min(100, Math.round(rawPct)));
    for (const threshold of [80, 90] as const) {
      if (current >= threshold && !firedUsageThresholds.current.has(threshold)) {
        firedUsageThresholds.current.add(threshold);
        trackEvent('subscription.usage_warning', {
          plan: status.plan ?? null,
          utilization: current,
          threshold,
        });
      }
    }
  }, [status]);

  // Loading state — don't flash a CTA that disappears on first fetch.
  if (!status) return null;

  const isConnected = !!status.connected;
  const usage = status.usage;
  // Pool utilization is live data from Claude's own /api/oauth/usage endpoint
  // — a 0-100 percentage for the current 5h window of the subscription we're
  // routing this user through.
  const pct = Math.max(0, Math.min(100, Math.round(usage?.utilization ?? 0)));
  const windowEndsAt = usage?.window_ends_at;

  const expiresLabel = (() => {
    if (!status.expires) return null;
    try {
      const d = new Date(status.expires);
      return d.toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch {
      return null;
    }
  })();

  const planLabel = (() => {
    if (!status.plan) return 'Pro';
    return status.plan
      .replace(/_/g, '+')
      .replace(/\b\w/g, (s) => s.toUpperCase());
  })();

  return (
    <Box
      sx={{
        p: 2.5,
        borderRadius: `${c.radius.lg}px`,
        border: `1px solid ${isConnected ? c.accent.primary : c.border.subtle}`,
        bgcolor: isConnected ? `${c.accent.primary}08` : c.bg.surface,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: isConnected ? 1.5 : 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: c.text.primary }}>
            OpenSwarm Pro
          </Typography>
          {isConnected && (
            <Box
              component="img"
              src="./logo.png"
              alt={planLabel}
              title={planLabel}
              sx={{ width: 18, height: 18, borderRadius: 0.5 }}
            />
          )}
          {!isConnected && (
            <Box sx={{ px: 0.9, py: 0.2, borderRadius: 999, bgcolor: `${c.accent.primary}15` }}>
              <Typography sx={{ fontSize: '0.65rem', color: c.accent.primary, fontWeight: 600 }}>
                RECOMMENDED
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {isConnected ? (
        <>
          {/* Canceled-in-grace banner: user canceled in Stripe but still
              inside the paid period. Show a clear "scheduled to cancel"
              state so they're not surprised when access stops. */}
          {status.status === 'canceled' && (
            <Box sx={{
              px: 1.2, py: 0.6, mb: 1.2, borderRadius: `${c.radius.sm}px`,
              bgcolor: `${c.status.warning}15`, border: `1px solid ${c.status.warning}40`,
            }}>
              <Typography sx={{ fontSize: '0.72rem', color: c.status.warning, fontWeight: 500 }}>
                Subscription canceled — you still have access until {expiresLabel || 'the end of the period'}.
              </Typography>
            </Box>
          )}

          {/* Usage bar — percentage only, no raw counts */}
          <Box sx={{ mb: 1.2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.5 }}>
              <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, fontWeight: 500 }}>
                Current usage
              </Typography>
              <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>
                {pct}% used
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{
                height: 6,
                borderRadius: 999,
                bgcolor: `${c.accent.primary}15`,
                '& .MuiLinearProgress-bar': {
                  bgcolor: pct >= 90 ? c.status.warning : pct >= 70 ? c.status.info : c.accent.primary,
                  borderRadius: 999,
                },
              }}
            />
            {windowEndsAt && (
              <Typography sx={{ fontSize: '0.68rem', color: c.text.muted, mt: 0.4 }}>
                Resets {(() => {
                  const diff = windowEndsAt - Date.now();
                  if (diff <= 0) return 'soon';
                  const hrs = Math.floor(diff / 3600000);
                  const mins = Math.floor((diff % 3600000) / 60000);
                  if (hrs > 0) return `in ${hrs} hr ${mins} min`;
                  return `in ${mins} min`;
                })()}
              </Typography>
            )}
          </Box>
          {expiresLabel && status.status !== 'canceled' && (
            <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, mb: 1.5 }}>
              Renews on {expiresLabel}
            </Typography>
          )}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              onClick={handleManage}
              disabled={busy !== null}
              size="small"
              variant={status.status === 'canceled' ? 'outlined' : 'contained'}
              sx={{ textTransform: 'none', fontSize: '0.78rem', borderRadius: `${c.radius.md}px` }}
            >
              {busy === 'manage' ? 'Opening…' : 'Manage in Stripe'}
            </Button>
          </Box>

          {/* Canceled-in-grace: show the 3-tier picker inline so users can
              pick a plan and resubscribe without clicking through a dialog.
              Active (non-canceled) subscribers don't get the picker —
              mid-subscription plan changes go through Stripe's Customer
              Portal via "Manage in Stripe". */}
          {status.status === 'canceled' && (
            <>
              <Box sx={{ mt: 2.5, mb: 1.5, borderTop: `1px solid ${c.border.subtle}`, pt: 2 }}>
                <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, fontWeight: 500, mb: 0.3 }}>
                  Resubscribe to keep access past {expiresLabel || 'your end date'}
                </Typography>
                <Typography sx={{ fontSize: '0.7rem', color: c.text.muted }}>
                  Pick any plan below — you can keep your current tier or switch.
                </Typography>
              </Box>
              <PlanPicker
                source="settings"
                defaultPlan={clampPickerPlan(status.plan ?? status.last_plan)}
                currentPlan={clampPickerPlan(status.plan ?? status.last_plan)}
              />
            </>
          )}
        </>
      ) : status.reason === 'expired' && status.last_plan ? (
        // Truly expired: the bearer's subscription ended past its grace
        // period. Show the 3-tier picker so the user can pick the same plan
        // or upgrade; their prior plan is preselected visually.
        <>
          <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, mb: 1.5 }}>
            Your OpenSwarm Pro subscription has ended. Pick a plan to keep using Claude Sonnet, Opus, and Haiku without a Claude account.
          </Typography>
          <PlanPicker
            source="settings"
            defaultPlan={clampPickerPlan(status.last_plan)}
            currentPlan={clampPickerPlan(status.last_plan)}
          />
        </>
      ) : status.reason === 'revoked' && status.last_plan ? (
        // Token revoked but subscription existed — different CTA language
        // so the user knows this isn't a billing issue.
        <>
          <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, mb: 1.5 }}>
            Your OpenSwarm Pro access token was revoked. Pick a plan to reconnect.
          </Typography>
          <PlanPicker
            source="settings"
            defaultPlan={clampPickerPlan(status.last_plan)}
            currentPlan={clampPickerPlan(status.last_plan)}
          />
        </>
      ) : (
        // Genuine new user — never had a subscription on this machine.
        <>
          <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 1.5 }}>
            One subscription, no Claude account needed. We handle everything behind the scenes.
          </Typography>
          <PlanPicker source="settings" defaultPlan="pro_plus" />
        </>
      )}
    </Box>
  );
};

const SubscriptionCards: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<any>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [userCode, setUserCode] = useState('');
  const [pollTimer, setPollTimer] = useState<any>(null);

  // `preserveTransient` keeps a previously-seen `running: true` state when a
  // refresh comes back with `running: false`. The backend's is_running() probe
  // has a short sync timeout that can be exceeded while 9Router is streaming
  // inference, producing false negatives that would otherwise flip these
  // cards into a "Starting subscription service..." spinner mid-session.
  const fetchStatus = useCallback(async (opts?: { preserveTransient?: boolean }) => {
    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/status`);
      const data = await r.json();
      setStatus((prev: any) => {
        if (opts?.preserveTransient && prev?.running && !data?.running) return prev;
        return data;
      });
      return data;
    } catch {
      setStatus((prev: any) => prev ?? { running: false, providers: [], models: [] });
      return null;
    }
  }, []);

  // Refresh the chat model picker whenever subscription connection state
  // changes — GET /agents/models intersects BUILTIN_MODELS with 9Router's
  // live connected-provider set, so newly-connected subscriptions surface
  // their models in the dropdown immediately.
  const refreshPickerModels = () => { dispatch(fetchModels()); };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Retry initial load — a single transient probe miss on mount would
      // otherwise wedge the UI on the loading spinner until the user closes
      // and reopens Settings.
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

  const isConnected = (providerId: string) => {
    if (!status?.providers) return false;
    const connections = status.providers?.connections || (Array.isArray(status.providers) ? status.providers : []);
    return connections.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'));
  };

  const handleConnect = async (providerId: string) => {
    // Cancel any previous attempt first
    if (pollTimer) { clearInterval(pollTimer); setPollTimer(null); }
    setConnecting(providerId);
    setUserCode('');

    // Small delay if retrying — avoids hitting Claude's rate limit
    await new Promise(r => setTimeout(r, 500));

    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!r.ok) { setConnecting(null); return; }
      const data = await r.json();

      if (data.flow === 'device_code') {
        const code = data.user_code || '';
        setUserCode(code);
        // Use a named window with features (not `_blank`) so Electron's
        // setWindowOpenHandler sees `new-window` disposition and spawns a
        // BrowserWindow popup — matching the Anthropic/Codex flow. With
        // `_blank` the disposition becomes `foreground-tab` and our main.js
        // handler routes it into the dashboard as a webview tab, which is
        // what we saw for GitHub before this change.
        //
        // Keep a reference to the popup so we can auto-close it when the
        // backend poll detects success, instead of leaving the user to
        // dismiss the "Congratulations, you're all set" page manually.
        let devicePopup: Window | null = null;
        if (data.verification_uri) {
          devicePopup = window.open(data.verification_uri, 'oauth_connect', 'width=600,height=720');
        }

        // Shared cleanup — whichever detection path fires first calls this.
        let stopped = false;
        const onDeviceSuccess = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(devicePollTimer);
          clearInterval(statusPollTimer);
          setPollTimer(null);
          setConnecting(null);
          setUserCode('');
          fetchStatus();
          refreshPickerModels();
          // Auto-close popup 2s after success so user briefly sees the
          // "Congratulations" page then it goes away automatically.
          setTimeout(() => {
            if (devicePopup && !devicePopup.closed) {
              try { devicePopup.close(); } catch {}
            }
          }, 2000);
        };

        // Path 1: device-code poll — asks backend to poll the provider's
        // token endpoint via 9Router. Primary path when it works.
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
        pollOnce(); // immediate first attempt
        const devicePollTimer = setInterval(pollOnce, 5000);

        // Path 2: status poller — checks 9Router's connection list
        // directly every 2s. Catches the connection even if the
        // device-code poll silently errors (e.g. 9Router 500 from
        // postExchange or createProviderConnection). Same pattern
        // the authorization_code flow already uses.
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

        // Detect when the user returns to the main window after
        // interacting with the popup. In Electron, `popup.closed` is
        // unreliable (the WindowProxy may not update when the child
        // BrowserWindow is destroyed). Listening for `focus` on the
        // main window is more robust — it fires when the user closes
        // the popup, switches tabs, or clicks back on the app.
        let focusCheckDone = false;
        const onFocus = async () => {
          if (stopped || focusCheckDone) return;
          focusCheckDone = true;
          window.removeEventListener('focus', onFocus);
          // Give 9Router 3 seconds to process the token exchange
          await new Promise(r => setTimeout(r, 3000));
          if (stopped) return;
          // Final status check
          try {
            const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
            const sd = await sr.json();
            const connections = sd.providers?.connections || [];
            if (connections.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'))) {
              onDeviceSuccess();
              return;
            }
          } catch {}
          // Connection not found — reset card
          stopped = true;
          clearInterval(devicePollTimer);
          clearInterval(statusPollTimer);
          setPollTimer(null);
          setConnecting(null);
          setUserCode('');
          fetchStatus();
        };
        // Delay registering the focus listener so the initial popup
        // open doesn't immediately trigger it (opening a popup blurs
        // then refocuses the parent in some cases).
        setTimeout(() => {
          if (!stopped) window.addEventListener('focus', onFocus);
        }, 2000);

        // 5-minute hard timeout — clean up everything.
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

      } else if (data.flow === 'authorization_code') {
        // Some providers (currently Gemini/Google) enforce an anti-embedded-
        // browser policy on their OAuth consent page that no amount of
        // user-agent spoofing defeats. For those, the backend sets
        // `use_external_browser: true` and we open the auth URL in the
        // user's default browser via shell.openExternal. The callback then
        // lands on OpenSwarm's own /api/subscriptions/callback endpoint
        // (backend/main.py:138) which performs the exchange itself and
        // shows a "Connected!" page. Detection happens via the status
        // poller below — no postMessage handoff possible because the
        // system browser has no window.opener relationship back to us.
        const useExternal = !!data.use_external_browser;
        let popup: Window | null = null;
        if (useExternal && (window as any).openswarm?.openExternal) {
          (window as any).openswarm.openExternal(data.auth_url);
        } else {
          popup = window.open(data.auth_url, 'oauth_connect', 'width=600,height=700');
        }

        // Status polling — primary for external-browser flow, secondary
        // (fast postMessage path below) for popup flow.
        const statusPoller = setInterval(async () => {
          try {
            const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
            const sd = await sr.json();
            const connections = sd.providers?.connections || [];
            if (connections.some((p: any) => p.provider === providerId && (p.isActive || p.testStatus === 'active'))) {
              clearInterval(statusPoller);
              setPollTimer(null);
              if (!useExternal) window.removeEventListener('message', msgHandler);
              setConnecting(null);
              fetchStatus();
              refreshPickerModels();
            }
          } catch {}
        }, 2000);
        setPollTimer(statusPoller);

        // postMessage listener — only wired up for the Electron popup flow
        // since the system-browser flow has no opener relationship.
        const msgHandler = async (event: MessageEvent) => {
          const d = event.data;
          const callbackData = d?.type === 'oauth_callback' ? d.data : d;
          if (callbackData?.code) {
            window.removeEventListener('message', msgHandler);
            clearInterval(statusPoller);
            setPollTimer(null);
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
            fetchStatus();
            refreshPickerModels();
          }
        };
        if (!useExternal) window.addEventListener('message', msgHandler);

        // Timeout: 30s for popup flow (user finishes auth in a few seconds),
        // 5 minutes for external-browser flow (user has to tab-switch, log
        // in, consent — takes much longer in practice).
        const timeoutMs = useExternal ? 300_000 : 30_000;
        setTimeout(() => {
          clearInterval(statusPoller);
          setPollTimer(null);
          if (!useExternal) window.removeEventListener('message', msgHandler);
          setConnecting(null);
        }, timeoutMs);

      } else {
        setConnecting(null);
      }
    } catch { setConnecting(null); }
  };

  const handleDisconnect = async (providerId: string) => {
    setDisconnecting(providerId);
    try {
      await fetch(`${API_BASE}/agents/subscriptions/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
    } catch {}
    // Wait briefly for 9Router to process, then refresh both the
    // subscription status and the chat model picker.
    setTimeout(() => {
      fetchStatus();
      refreshPickerModels();
      setDisconnecting(null);
    }, 500);
  };

  if (!status) {
    // Initial loading — show skeleton cards
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

// ── Pixel Bar ──
const PIXEL_SALMON = ['#C46B57', '#D4795F', '#E8927A', '#F0A088', '#F5B49E'];
const PIXEL_BLUE = ['#445588', '#5577AA', '#6688BB', '#7799CC', '#88AADD'];

const PixelBarOuter: React.FC<{ value: number; max: number; width?: number; palette?: string[]; tokens: any }> = ({ value, max, width = 16, palette = PIXEL_SALMON, tokens: c }) => {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
  return (
    <Box sx={{ display: 'flex', gap: '1px', mt: 0.25 }}>
      {Array.from({ length: width }, (_, i) => (
        <Box
          key={i}
          sx={{
            width: 5,
            height: 5,
            bgcolor: i < filled
              ? palette[Math.min(palette.length - 1, Math.floor((i / Math.max(filled - 1, 1)) * (palette.length - 1)))]
              : c.border.subtle,
            opacity: i < filled ? 1 : 0.3,
          }}
        />
      ))}
    </Box>
  );
};

// ── Usage Stats Component ──
const UsageStats: React.FC = () => {
  const c = useClaudeTokens();
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    fetch(`${API_BASE}/analytics/usage-summary`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) {
    // Skeleton loading state
    const skeletonPulse = {
      animation: 'skeleton-pulse 1.5s ease-in-out infinite',
      '@keyframes skeleton-pulse': { '0%, 100%': { opacity: 0.5 }, '50%': { opacity: 0.25 } },
    };
    const skeletonCard = {
      p: 1.5, borderRadius: `${c.radius.md}px`, bgcolor: c.bg.elevated,
      border: `1px solid ${c.border.subtle}`, ...skeletonPulse,
    };
    return (
      <Box sx={{ mb: 2.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Box key={i} sx={skeletonCard}>
              <Box sx={{ width: 60, height: 8, bgcolor: c.border.subtle, borderRadius: 1, mb: 1 }} />
              <Box sx={{ width: 50, height: 18, bgcolor: c.border.subtle, borderRadius: 1, mb: 0.5 }} />
              <Box sx={{ width: 90, height: 8, bgcolor: c.border.subtle, borderRadius: 1 }} />
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1.5 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Box key={i} sx={skeletonCard}>
              <Box sx={{ width: 70, height: 8, bgcolor: c.border.subtle, borderRadius: 1, mb: 1 }} />
              <Box sx={{ width: 45, height: 18, bgcolor: c.border.subtle, borderRadius: 1, mb: 0.5 }} />
              <Box sx={{ width: 80, height: 8, bgcolor: c.border.subtle, borderRadius: 1 }} />
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
          {Array.from({ length: 2 }, (_, i) => (
            <Box key={i} sx={{ ...skeletonCard, p: 2 }}>
              <Box sx={{ width: 80, height: 8, bgcolor: c.border.subtle, borderRadius: 1, mb: 2 }} />
              {Array.from({ length: 3 }, (_, j) => (
                <Box key={j} sx={{ mb: 1.5 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Box sx={{ width: 60 + j * 15, height: 10, bgcolor: c.border.subtle, borderRadius: 1 }} />
                    <Box sx={{ width: 35, height: 10, bgcolor: c.border.subtle, borderRadius: 1 }} />
                  </Box>
                  <Box sx={{ display: 'flex', gap: '1px' }}>
                    {Array.from({ length: 16 }, (_, k) => (
                      <Box key={k} sx={{ width: 5, height: 5, bgcolor: c.border.subtle, opacity: k < 8 - j * 2 ? 0.6 : 0.2 }} />
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  const formatCost = (v: number) => {
    if (v === 0) return '$0.00';
    if (v < 0.001) return `$${v.toFixed(6)}`;
    if (v < 0.01) return `$${v.toFixed(5)}`;
    if (v < 1) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  };
  const formatDuration = (s: number) => {
    if (s === 0) return '0s';
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const formatTotalTime = (s: number) => {
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)} min`;
    return `${(s / 3600).toFixed(1)} hrs`;
  };

  const cardSx = {
    p: 1.5,
    borderRadius: `${c.radius.md}px`,
    bgcolor: c.bg.elevated,
    border: `1px solid ${c.border.subtle}`,
  };
  const labelSx = { fontSize: '0.58rem', fontWeight: 700, color: c.text.ghost, textTransform: 'uppercase' as const, letterSpacing: '0.06em', mb: 0.25 };
  const valueSx = { fontSize: '1.05rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.2 };
  const subSx = { fontSize: '0.62rem', color: c.text.tertiary, mt: 0.25 };

  const modelEntries = Object.entries(stats.models_used || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
  const providerEntries = Object.entries(stats.providers_used || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
  const toolEntries = Object.entries(stats.top_tools || {}).slice(0, 10) as [string, number][];
  const maxToolCount = toolEntries.length > 0 ? Math.max(...toolEntries.map(([, c]) => c)) : 1;
  const statusEntries = Object.entries(stats.status_breakdown || {}) as [string, string][];

  // Pixel bar helper that passes tokens
  const PixelBar: React.FC<{ value: number; max: number; width?: number; palette?: string[] }> = (props) => (
    <PixelBarOuter {...props} tokens={c} />
  );

  const totalTime = stats.avg_duration_seconds * stats.total_sessions;
  const msgsPerSession = stats.total_sessions > 0 ? (stats.total_messages / stats.total_sessions).toFixed(1) : '0';
  const toolsPerSession = stats.total_sessions > 0 ? (stats.total_tool_calls / stats.total_sessions).toFixed(1) : '0';
  const formatTokens = (n: number) => {
    if (n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  };
  const isSubscription = stats.cost_source === '9router';
  const costSourceLabel = isSubscription ? 'saved with your subscription' : stats.cost_source === 'sdk' ? 'via API' : '';

  return (
    <Box sx={{ mb: 2.5 }}>
      {/* Row 1: Core metrics */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1 }}>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Sessions</Typography>
          <Typography sx={valueSx}>{stats.total_sessions.toLocaleString()}</Typography>
          <Typography sx={subSx}>
            {statusEntries.map(([s, n]) => `${n} ${s}`).join(', ') || 'no sessions'}
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>{isSubscription ? 'You Saved' : 'Total Cost'}</Typography>
          <Typography sx={valueSx}>{formatCost(stats.total_cost_usd)}</Typography>
          <Typography sx={subSx}>
            {isSubscription
              ? `${formatCost(stats.avg_cost_per_session)} avg · saved with your subscription`
              : costSourceLabel ? `${formatCost(stats.avg_cost_per_session)} avg · ${costSourceLabel}` : 'no cost data'}
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Messages</Typography>
          <Typography sx={valueSx}>{stats.total_messages.toLocaleString()}</Typography>
          <Typography sx={subSx}>
            {msgsPerSession} avg per session
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Tool Calls</Typography>
          <Typography sx={valueSx}>{stats.total_tool_calls.toLocaleString()}</Typography>
          <Typography sx={subSx}>
            {toolsPerSession} avg per session
          </Typography>
        </Box>
      </Box>

      {/* Row 2: Time + efficiency + tokens */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1.5 }}>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Run Time</Typography>
          <Typography sx={valueSx}>{formatTotalTime(totalTime)}</Typography>
          <Typography sx={subSx}>across all sessions</Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Avg Session</Typography>
          <Typography sx={valueSx}>{formatDuration(stats.avg_duration_seconds)}</Typography>
          <Typography sx={subSx}>per session duration</Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Completion Rate</Typography>
          <Typography sx={valueSx}>{(stats.completion_rate * 100).toFixed(1)}%</Typography>
          <Typography sx={subSx}>
            sessions finished successfully
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Tokens Used</Typography>
          <Typography sx={valueSx}>
            {stats.total_prompt_tokens || stats.total_completion_tokens
              ? formatTokens((stats.total_prompt_tokens || 0) + (stats.total_completion_tokens || 0))
              : Object.keys(stats.providers_used || {}).length}
          </Typography>
          <Typography sx={subSx}>
            {stats.total_prompt_tokens || stats.total_completion_tokens
              ? `${formatTokens(stats.total_prompt_tokens || 0)} in · ${formatTokens(stats.total_completion_tokens || 0)} out`
              : providerEntries.map(([p]) => p).join(', ') || 'none'}
          </Typography>
        </Box>
      </Box>

      {/* Model + Provider + Tool breakdown */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
        {/* Models & Providers */}
        <Box sx={{ ...cardSx, p: 2 }}>
          <Typography sx={{ ...labelSx, mb: 1.5 }}>Models Used</Typography>
          {modelEntries.length > 0 ? modelEntries.map(([model, count]) => {
            const pct = stats.total_sessions > 0 ? ((count / stats.total_sessions) * 100).toFixed(0) : '0';
            return (
              <Box key={model} sx={{ mb: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0 }}>
                  <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, fontWeight: 500 }}>{model}</Typography>
                  <Typography sx={{ fontSize: '0.68rem', color: c.text.tertiary, fontFamily: c.font.mono }}>
                    {count} ({pct}%)
                  </Typography>
                </Box>
                <PixelBar value={count} max={stats.total_sessions} palette={PIXEL_BLUE} />
              </Box>
            );
          }) : <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>No sessions yet</Typography>}
        </Box>

        {/* Tools */}
        <Box sx={{ ...cardSx, p: 2 }}>
          <Typography sx={{ ...labelSx, mb: 1.5 }}>Top Tools</Typography>
          {toolEntries.length > 0 ? toolEntries.map(([tool, count]) => {
            const shortName = tool.includes('__') ? tool.split('__').pop() : tool;
            const pct = stats.total_tool_calls > 0 ? ((count / stats.total_tool_calls) * 100).toFixed(0) : '0';
            return (
              <Box key={tool} sx={{ mb: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0 }}>
                  <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, fontWeight: 500 }}>{shortName}</Typography>
                  <Typography sx={{ fontSize: '0.62rem', color: c.text.tertiary, fontFamily: c.font.mono }}>
                    {count} call{count !== 1 ? 's' : ''} ({pct}%)
                  </Typography>
                </Box>
                <PixelBar value={count} max={maxToolCount} />
              </Box>
            );
          }) : <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>No tool calls yet</Typography>}
        </Box>
      </Box>
    </Box>
  );
};

const API_KEY_STEPS = [
  {
    title: 'Open the Anthropic Console',
    detail: 'Visit console.anthropic.com — create a free account if you don\'t have one yet.',
    link: 'https://console.anthropic.com',
  },
  {
    title: 'Navigate to API Keys',
    detail: 'In the dashboard, click "Settings" in the left sidebar, then select "API Keys".',
  },
  {
    title: 'Create a new key',
    detail: 'Click the "Create Key" button. Name it anything you like (e.g. "OpenSwarm").',
  },
  {
    title: 'Copy your key',
    detail: 'Click the copy icon next to your new key. It will start with sk-ant-api03-…',
  },
  {
    title: 'Paste it above & save',
    detail: 'Paste the key into the field above, then hit Save. You\'re all set!',
  },
];

const Settings: React.FC = () => {
  const open = useAppSelector((s) => s.settings.modalOpen);
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const modes = useAppSelector((s) => s.modes.items);
  const { setMode: setThemeMode } = useThemeMode();

  const modesList = useMemo(() => Object.values(modes), [modes]);

  const updateStatus = useAppSelector((s) => s.update.status);
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const downloadPercent = useAppSelector((s) => s.update.downloadPercent);
  const updateError = useAppSelector((s) => s.update.error);
  const installing = useAppSelector((s) => s.update.installing);

  const initialTab = useAppSelector((s) => s.settings.initialTab);
  const [activeTab, setActiveTab] = useState<'general' | 'models' | 'usage' | 'commands'>('general');
  const [form, setForm] = useState<AppSettings>({ ...settings });

  // When the modal opens with a requested tab (e.g., from the warning
  // banner's "Configure models" link), switch to it.
  useEffect(() => {
    if (initialTab && ['general', 'models', 'usage', 'commands'].includes(initialTab)) {
      setActiveTab(initialTab as typeof activeTab);
    }
  }, [initialTab]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showApiHelp, setShowApiHelp] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    // Reset to the General tab on open, but NOT when the caller has
    // explicitly requested a tab via openSettingsModal(<tab>) — e.g. the
    // "Configure models" link in the warning banner dispatches
    // openSettingsModal('models') and expects to land on Models. The
    // separate `initialTab` effect above handles the targeted case;
    // without this guard, that effect's write gets clobbered on the same
    // render because React runs effects in declaration order.
    if (open && !initialTab) setActiveTab('general');
  }, [open, initialTab]);

  useEffect(() => {
    if (loaded) {
      setForm({ ...settings });
    }
  }, [loaded, settings]);

  const handleCheckForUpdates = async () => {
    dispatch(setChecking());
    const timeout = setTimeout(() => {
      dispatch(setUpdateError('Update check timed out. Please try again.'));
    }, 15000);
    try {
      await (window as any).openswarm?.checkForUpdates();
    } catch {
      /* error handled via IPC event listener */
    } finally {
      clearTimeout(timeout);
    }
  };

  const handleDownloadUpdate = async () => {
    try {
      await (window as any).openswarm?.downloadUpdate();
    } catch {
      /* error handled via IPC event listener */
    }
  };

  const handleInstallUpdate = () => {
    if (installing) return;
    dispatch(setInstalling());
    (window as any).openswarm?.installUpdate();
  };

  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings);

  const handleSave = async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) {
      setThemeMode(form.theme);
    }
    dispatch(fetchModels());
    setSaved(true);
  };

  const handleRequestClose = useCallback(() => {
    if (hasChanges) {
      setConfirmDiscard(true);
    } else {
      dispatch(closeSettingsModal());
    }
  }, [hasChanges, dispatch]);

  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscard(false);
    setForm({ ...settings });
    dispatch(closeSettingsModal());
  }, [settings, dispatch]);

  const handleSaveAndClose = useCallback(async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) {
      setThemeMode(form.theme);
    }
    dispatch(fetchModels());
    setSaved(true);
    setConfirmDiscard(false);
    dispatch(closeSettingsModal());
  }, [dispatch, form, settings, setThemeMode]);

  const fieldSx = {
    '& .MuiOutlinedInput-root': {
      fontSize: '0.85rem',
    },
  };

  const sectionSx = {
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: c.text.tertiary,
    mb: 0.5,
    mt: 0.5,
  };

  const rowSx = {
    py: 2,
    borderBottom: `1px solid ${c.border.subtle}`,
  };

  const rowLastSx = {
    py: 2,
  };

  const inlineRowSx = {
    ...rowSx,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const inlineRowLastSx = {
    ...rowLastSx,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const labelSx = {
    color: c.text.primary,
    fontWeight: 500,
    fontSize: '0.875rem',
    lineHeight: 1.4,
  };

  const descSx = {
    color: c.text.tertiary,
    fontSize: '0.75rem',
    lineHeight: 1.4,
  };

  return (
    <>
    <Dialog
      open={open}
      onClose={handleRequestClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 780,
          height: '85vh',
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          transition: 'none',
        },
      }}
    >
      <DialogTitle
        sx={{
          px: 3,
          py: 0,
          borderBottom: `1px solid ${c.border.subtle}`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pt: 1.5, pb: 0.5 }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
            Settings
          </Typography>
          <IconButton onClick={handleRequestClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
        <Tabs
          value={activeTab}
          onChange={(_, v) => setActiveTab(v)}
          sx={{
            minHeight: 36,
            '& .MuiTab-root': {
              minHeight: 36,
              textTransform: 'none',
              fontSize: '0.85rem',
              fontWeight: 500,
              color: c.text.muted,
              px: 1.5,
              '&.Mui-selected': { color: c.accent.primary, fontWeight: 600 },
            },
            '& .MuiTabs-indicator': { backgroundColor: c.accent.primary, height: 2 },
          }}
        >
          <Tab label="General" value="general" disableRipple />
          <Tab label="Models" value="models" disableRipple />
          <Tab label="Usage" value="usage" disableRipple />
          <Tab label="Commands" value="commands" disableRipple />
        </Tabs>
      </DialogTitle>

      <DialogContent sx={{
        px: 3,
        py: 0,
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}>
      {activeTab === 'general' ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>

        {/* ── Agent Defaults ── */}
        <Typography sx={sectionSx}>Agent Defaults</Typography>

        <Box sx={rowSx}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography sx={labelSx}>System prompt</Typography>
            {form.default_system_prompt !== DEFAULT_SYSTEM_PROMPT && (
              <Button
                size="small"
                startIcon={<RestartAltIcon sx={{ fontSize: 14 }} />}
                onClick={async () => {
                  await dispatch(resetSystemPrompt());
                  setForm((prev) => ({ ...prev, default_system_prompt: DEFAULT_SYSTEM_PROMPT }));
                }}
                sx={{
                  color: c.accent.primary,
                  textTransform: 'none',
                  fontSize: '0.75rem',
                  py: 0.25,
                  '&:hover': { bgcolor: `${c.accent.primary}10` },
                }}
              >
                Reset to default
              </Button>
            )}
          </Box>
          <Typography sx={{ ...descSx, mb: 1.5 }}>
            Prepended to every agent session before mode-specific instructions. Modes can override with their own.
          </Typography>
          <TextField
            value={form.default_system_prompt ?? DEFAULT_SYSTEM_PROMPT}
            onChange={(e) => setForm({ ...form, default_system_prompt: e.target.value || null })}
            multiline
            minRows={3}
            maxRows={8}
            fullWidth
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                fontFamily: c.font.mono,
                fontSize: '0.8rem',
                lineHeight: 1.6,
                color: c.text.secondary,
              },
            }}
          />
        </Box>

        <Box sx={rowSx}>
          <Typography sx={labelSx}>Working directory</Typography>
          <Typography sx={{ ...descSx, mb: 1.5 }}>
            Default folder agents start in. Modes can override per-mode.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              value={form.default_folder ?? ''}
              onChange={(e) => setForm({ ...form, default_folder: e.target.value || null })}
              size="small"
              fullWidth
              placeholder="Not set (uses project root)"
              sx={{
                ...fieldSx,
                '& .MuiOutlinedInput-root': {
                  ...fieldSx['& .MuiOutlinedInput-root'],
                  fontFamily: c.font.mono,
                },
              }}
            />
            <Button
              variant="outlined"
              onClick={() => setBrowseOpen(true)}
              startIcon={<FolderOpenIcon sx={{ fontSize: 16 }} />}
              sx={{
                color: c.text.tertiary,
                borderColor: c.border.medium,
                textTransform: 'none',
                whiteSpace: 'nowrap',
                minWidth: 'auto',
                fontSize: '0.8rem',
                '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
              }}
            >
              Browse
            </Button>
          </Box>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Model</Typography>
            <Typography sx={descSx}>Default model for new sessions.</Typography>
          </Box>
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <Select
              value={form.default_model}
              onChange={(e) => setForm({ ...form, default_model: e.target.value })}
              sx={{ fontSize: '0.85rem' }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              <MenuItem value="sonnet">Sonnet 4.6</MenuItem>
              <MenuItem value="opus">Opus 4.6</MenuItem>
              <MenuItem value="haiku">Haiku 3.5</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Mode</Typography>
            <Typography sx={descSx}>Default interaction mode for new sessions.</Typography>
          </Box>
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <Select
              value={form.default_mode}
              onChange={(e) => setForm({ ...form, default_mode: e.target.value })}
              sx={{ fontSize: '0.85rem' }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              {modesList.map((m) => (
                <MenuItem key={m.id} value={m.id}>{m.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box sx={inlineRowLastSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Max turns</Typography>
            <Typography sx={descSx}>Auto-stop after this many turns. Empty = unlimited.</Typography>
          </Box>
          <TextField
            type="number"
            value={form.default_max_turns ?? ''}
            onChange={(e) => setForm({ ...form, default_max_turns: e.target.value ? parseInt(e.target.value) : null })}
            size="small"
            placeholder="∞"
            inputProps={{ min: 1 }}
            sx={{ ...fieldSx, width: 100 }}
          />
        </Box>

        {/* ── Interface ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>Interface</Typography>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Theme</Typography>
            <Typography sx={descSx}>Application color scheme.</Typography>
          </Box>
          <ToggleButtonGroup
            value={form.theme}
            exclusive
            onChange={(_, v) => { if (v) setForm({ ...form, theme: v }); }}
            size="small"
            sx={{
              '& .MuiToggleButton-root': {
                color: c.text.muted,
                borderColor: c.border.medium,
                textTransform: 'none',
                px: 2,
                py: 0.5,
                gap: 0.5,
                fontSize: '0.8rem',
                '&.Mui-selected': {
                  bgcolor: `${c.accent.primary}15`,
                  color: c.accent.primary,
                  borderColor: c.accent.primary,
                  '&:hover': { bgcolor: `${c.accent.primary}20` },
                },
              },
            }}
          >
            <ToggleButton value="light">
              <LightModeIcon sx={{ fontSize: 16 }} /> Light
            </ToggleButton>
            <ToggleButton value="dark">
              <DarkModeIcon sx={{ fontSize: 16 }} /> Dark
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box sx={rowSx}>
          <Typography sx={labelSx}>Zoom sensitivity</Typography>
          <Typography sx={{ ...descSx, mb: 1 }}>
            Scroll-to-zoom responsiveness. Lower for trackpads, higher for mouse wheels.
          </Typography>
          <Box sx={{ px: 1 }}>
            <Slider
              value={form.zoom_sensitivity}
              onChange={(_, v) => setForm({ ...form, zoom_sensitivity: v as number })}
              min={1}
              max={100}
              step={1}
              valueLabelDisplay="auto"
              marks={[
                { value: 1, label: 'Low' },
                { value: 50, label: 'Default' },
                { value: 100, label: 'High' },
              ]}
              sx={{
                color: c.accent.primary,
                '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.7rem' },
                '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
              }}
            />
          </Box>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>New agent shortcut</Typography>
            <Typography sx={descSx}>Keyboard shortcut to create an agent.</Typography>
          </Box>
          <Box
            tabIndex={0}
            onKeyDown={(e) => {
              if (!recordingShortcut) return;
              if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
              e.preventDefault();
              const parts: string[] = [];
              if (e.metaKey) parts.push('Meta');
              if (e.ctrlKey) parts.push('Ctrl');
              if (e.altKey) parts.push('Alt');
              if (e.shiftKey) parts.push('Shift');
              parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
              setForm({ ...form, new_agent_shortcut: parts.join('+') });
              setRecordingShortcut(false);
            }}
            onBlur={() => setRecordingShortcut(false)}
            onClick={() => setRecordingShortcut(true)}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: 0.75,
              borderRadius: `${c.radius.sm}px`,
              border: `1px solid ${recordingShortcut ? c.accent.primary : c.border.medium}`,
              cursor: 'pointer',
              outline: 'none',
              transition: 'border-color 0.15s',
              '&:hover': { borderColor: c.accent.primary },
            }}
          >
            <KeyboardIcon sx={{ fontSize: 16, color: recordingShortcut ? c.accent.primary : c.text.tertiary }} />
            {recordingShortcut ? (
              <Typography sx={{ fontSize: '0.8rem', color: c.accent.primary, fontWeight: 500 }}>
                Press shortcut…
              </Typography>
            ) : (
              <Typography sx={{ fontSize: '0.8rem', color: c.text.primary, fontFamily: c.font.mono, fontWeight: 500 }}>
                {form.new_agent_shortcut
                  .split('+')
                  .map((p) => {
                    if (p === 'Meta') return '⌘';
                    if (p === 'Ctrl') return 'Ctrl';
                    if (p === 'Alt') return '⌥';
                    if (p === 'Shift') return '⇧';
                    return p.toUpperCase();
                  })
                  .join(' + ')}
              </Typography>
            )}
          </Box>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Auto-enable element selection</Typography>
            <Typography sx={descSx}>Automatically enter element selection mode when creating a new agent.</Typography>
          </Box>
          <Switch
            checked={form.auto_select_mode_on_new_agent}
            onChange={(e) => setForm({ ...form, auto_select_mode_on_new_agent: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Default agent spawn state in dashboard</Typography>
            <Typography sx={descSx}>When enabled, new agents spawn expanded instead of collapsed.</Typography>
          </Box>
          <Switch
            checked={form.expand_new_chats_in_dashboard}
            onChange={(e) => setForm({ ...form, expand_new_chats_in_dashboard: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        <Box sx={inlineRowLastSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Auto-reveal sub-agents on dashboard</Typography>
            <Typography sx={descSx}>Automatically show sub-agent cards (from CreateAgent / InvokeAgent) tethered to their parent on the dashboard.</Typography>
          </Box>
          <Switch
            checked={form.auto_reveal_sub_agents}
            onChange={(e) => setForm({ ...form, auto_reveal_sub_agents: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        {/* ── Browser ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>Browser</Typography>

        <Box sx={rowLastSx}>
          <Typography sx={labelSx}>Default homepage</Typography>
          <Typography sx={{ ...descSx, mb: 1.5 }}>
            URL loaded when opening a new browser card on the dashboard.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <LanguageIcon sx={{ fontSize: 18, color: c.text.tertiary, flexShrink: 0 }} />
            <TextField
              value={form.browser_homepage}
              onChange={(e) => setForm({ ...form, browser_homepage: e.target.value })}
              size="small"
              fullWidth
              placeholder="https://www.google.com"
              sx={{
                ...fieldSx,
                '& .MuiOutlinedInput-root': {
                  ...fieldSx['& .MuiOutlinedInput-root'],
                  fontFamily: c.font.mono,
                },
              }}
            />
          </Box>
        </Box>

        {/* ── Advanced ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>Advanced</Typography>

        <Box sx={inlineRowLastSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Developer mode</Typography>
            <Typography sx={descSx}>Show transport details, environment variables, raw configs, and other technical metadata throughout the app.</Typography>
          </Box>
          <Switch
            checked={form.dev_mode}
            onChange={(e) => setForm({ ...form, dev_mode: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        {/* ── About ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>About</Typography>

        <Box sx={rowSx}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box>
              <Typography sx={labelSx}>Version</Typography>
              <Typography sx={{ ...descSx, fontFamily: c.font.mono }}>
                {appVersion ?? '—'}
              </Typography>
            </Box>
          </Box>
        </Box>

        <Box sx={rowLastSx}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: updateStatus === 'downloading' ? 1 : 0 }}>
            <Box>
              <Typography sx={labelSx}>Software update</Typography>
              <Typography sx={descSx}>
                {updateStatus === 'checking' && 'Checking for updates…'}
                {updateStatus === 'not-available' && 'You\'re on the latest version.'}
                {updateStatus === 'available' && `Version ${availableVersion} is available.`}
                {updateStatus === 'downloading' && `Downloading update… ${Math.round(downloadPercent)}%`}
                {updateStatus === 'downloaded' && `Version ${availableVersion} is ready to install.`}
                {updateStatus === 'error' && (updateError || 'Update check failed.')}
                {updateStatus === 'idle' && 'Check for new versions of OpenSwarm.'}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, ml: 2 }}>
              {updateStatus === 'checking' && (
                <CircularProgress size={18} sx={{ color: c.text.tertiary }} />
              )}
              {updateStatus === 'not-available' && (
                <CheckCircleOutlineIcon sx={{ fontSize: 18, color: c.status.success }} />
              )}
              {updateStatus === 'error' && (
                <ErrorOutlineIcon sx={{ fontSize: 18, color: c.status.error }} />
              )}
              {(updateStatus === 'idle' || updateStatus === 'not-available' || updateStatus === 'error') && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleCheckForUpdates}
                  startIcon={<SystemUpdateAltIcon sx={{ fontSize: 15 }} />}
                  sx={{
                    color: c.text.secondary,
                    borderColor: c.border.medium,
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    whiteSpace: 'nowrap',
                    '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
                  }}
                >
                  Check for Updates
                </Button>
              )}
              {updateStatus === 'available' && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleDownloadUpdate}
                  startIcon={<DownloadIcon sx={{ fontSize: 15 }} />}
                  sx={{
                    color: c.accent.primary,
                    borderColor: c.accent.primary,
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    whiteSpace: 'nowrap',
                    '&:hover': { bgcolor: `${c.accent.primary}10` },
                  }}
                >
                  Download
                </Button>
              )}
              {updateStatus === 'downloaded' && (
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleInstallUpdate}
                  disabled={installing}
                  startIcon={installing
                    ? <CircularProgress size={14} sx={{ color: '#fff' }} />
                    : <RestartAltIcon sx={{ fontSize: 15 }} />}
                  sx={{
                    bgcolor: c.accent.primary,
                    '&:hover': { bgcolor: c.accent.pressed },
                    '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.7 },
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    whiteSpace: 'nowrap',
                    borderRadius: 1.5,
                  }}
                >
                  {installing ? 'Restarting…' : 'Restart & Update'}
                </Button>
              )}
            </Box>
          </Box>
          {updateStatus === 'downloading' && (
            <LinearProgress
              variant="determinate"
              value={downloadPercent}
              sx={{
                height: 3,
                borderRadius: 2,
                bgcolor: `${c.accent.primary}20`,
                '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary, borderRadius: 2 },
              }}
            />
          )}
        </Box>

      </Box>
      ) : activeTab === 'models' ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, gap: 2.5, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>

          {/* ── OPENSWARM PRO (managed) ── */}
          <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            One Subscription, No Setup
          </Typography>

          <Typography sx={{ ...descSx, mb: 0 }}>
            Don't have a Claude account? We'll handle it for you. One simple subscription covers Claude Sonnet, Opus, and Haiku.
          </Typography>

          <OpenSwarmProCard />

          {/* ── USE EXISTING SUBSCRIPTIONS ── */}
          <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mt: 1 }}>
            Or Use Your Existing Subscriptions
          </Typography>

          <Typography sx={{ ...descSx, mb: 0 }}>
            Already paying for Claude, ChatGPT, or Gemini? Connect your subscription — no API key needed, no extra cost.
          </Typography>

          <SubscriptionCards />

          {/* ── API KEYS ── */}
          <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mt: 1 }}>
            Or Connect With API Keys
          </Typography>

          <Typography sx={{ ...descSx, mb: -1 }}>
            Pay per use. Each key is stored locally on your device.
          </Typography>

          {/* Anthropic */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={labelSx}>Anthropic</Typography>
              {form.anthropic_api_key ? (
                <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: c.status.success, bgcolor: `${c.status.success}15`, px: 0.75, py: 0.15, borderRadius: '3px' }}>CONNECTED</Typography>
              ) : null}
            </Box>
            <Typography sx={{ ...descSx, mb: 1 }}>Claude Sonnet, Opus, Haiku.</Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                type={showApiKey ? 'text' : 'password'}
                value={form.anthropic_api_key ?? ''}
                onChange={(e) => setForm({ ...form, anthropic_api_key: e.target.value || null })}
                size="small"
                fullWidth
                placeholder="sk-ant-..."
                sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small" sx={{ color: c.text.tertiary }}>
                        {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <Typography
                component="a"
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener"
                sx={{ color: c.accent.primary, fontSize: '0.72rem', whiteSpace: 'nowrap', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 0.3, '&:hover': { textDecoration: 'underline' } }}
              >
                Get key <OpenInNewIcon sx={{ fontSize: 11 }} />
              </Typography>
            </Box>
          </Box>

          {/* OpenAI */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={labelSx}>OpenAI</Typography>
              {form.openai_api_key ? (
                <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: c.status.success, bgcolor: `${c.status.success}15`, px: 0.75, py: 0.15, borderRadius: '3px' }}>CONNECTED</Typography>
              ) : null}
            </Box>
            <Typography sx={{ ...descSx, mb: 1 }}>GPT-5.4, GPT-5.4 Mini, o-series reasoning models.</Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                type={showApiKey ? 'text' : 'password'}
                value={form.openai_api_key ?? ''}
                onChange={(e) => setForm({ ...form, openai_api_key: e.target.value || null })}
                size="small"
                fullWidth
                placeholder="sk-..."
                sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small" sx={{ color: c.text.tertiary }}>
                        {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <Typography
                component="a"
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener"
                sx={{ color: c.accent.primary, fontSize: '0.72rem', whiteSpace: 'nowrap', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 0.3, '&:hover': { textDecoration: 'underline' } }}
              >
                Get key <OpenInNewIcon sx={{ fontSize: 11 }} />
              </Typography>
            </Box>
          </Box>

          {/* Google */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={labelSx}>Google</Typography>
              {form.google_api_key ? (
                <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: c.status.success, bgcolor: `${c.status.success}15`, px: 0.75, py: 0.15, borderRadius: '3px' }}>CONNECTED</Typography>
              ) : null}
            </Box>
            <Typography sx={{ ...descSx, mb: 1 }}>Gemini 3 Pro, Gemini 3 Flash, Gemini 2.5 Pro.</Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                type={showApiKey ? 'text' : 'password'}
                value={form.google_api_key ?? ''}
                onChange={(e) => setForm({ ...form, google_api_key: e.target.value || null })}
                size="small"
                fullWidth
                placeholder="AIza..."
                sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small" sx={{ color: c.text.tertiary }}>
                        {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <Typography
                component="a"
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener"
                sx={{ color: c.accent.primary, fontSize: '0.72rem', whiteSpace: 'nowrap', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 0.3, '&:hover': { textDecoration: 'underline' } }}
              >
                Get key <OpenInNewIcon sx={{ fontSize: 11 }} />
              </Typography>
            </Box>
          </Box>

          {/* OpenRouter */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={labelSx}>OpenRouter</Typography>
              {form.openrouter_api_key ? (
                <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: c.status.success, bgcolor: `${c.status.success}15`, px: 0.75, py: 0.15, borderRadius: '3px' }}>CONNECTED</Typography>
              ) : null}
            </Box>
            <Typography sx={{ ...descSx, mb: 1 }}>300+ models from xAI, Meta, DeepSeek, Mistral, Qwen, and more.</Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                type={showApiKey ? 'text' : 'password'}
                value={form.openrouter_api_key ?? ''}
                onChange={(e) => setForm({ ...form, openrouter_api_key: e.target.value || null })}
                size="small"
                fullWidth
                placeholder="sk-or-..."
                sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small" sx={{ color: c.text.tertiary }}>
                        {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <Typography
                component="a"
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener"
                sx={{ color: c.accent.primary, fontSize: '0.72rem', whiteSpace: 'nowrap', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 0.3, '&:hover': { textDecoration: 'underline' } }}
              >
                Get key <OpenInNewIcon sx={{ fontSize: 11 }} />
              </Typography>
            </Box>
          </Box>

      </Box>
      ) : activeTab === 'usage' ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <UsageStats />
      </Box>
      ) : (
      <Box sx={{ pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <CommandsContent />
      </Box>
      )}
      </DialogContent>

      {(activeTab === 'general' || activeTab === 'models') && (
      <DialogActions sx={{ borderTop: `1px solid ${c.border.subtle}`, px: 3, py: 1.5, justifyContent: 'flex-end' }}>
        <Button
          onClick={handleRequestClose}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon sx={{ fontSize: 16 }} />}
          onClick={handleSave}
          disabled={!hasChanges}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
            textTransform: 'none',
            borderRadius: 1.5,
            px: 2.5,
            fontSize: '0.85rem',
          }}
        >
          Save
        </Button>
      </DialogActions>
      )}

      <DirectoryBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(item) => setForm({ ...form, default_folder: item.path })}
        initialPath={form.default_folder ?? ''}
      />

      <Snackbar
        open={saved}
        autoHideDuration={3000}
        onClose={() => setSaved(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSaved(false)} severity="success" sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.status.success}` }}>
          Settings saved
        </Alert>
      </Snackbar>
    </Dialog>

    <Dialog
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      PaperProps={{
        sx: {
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          maxWidth: 380,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', pb: 0.5, px: 3, pt: 2.5 }}>
        Unsaved changes
      </DialogTitle>
      <DialogContent sx={{ px: 3 }}>
        <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>
          You have unsaved changes. Would you like to save them before closing?
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          onClick={handleConfirmDiscard}
          sx={{ color: c.status.error, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Discard
        </Button>
        <Button
          onClick={() => setConfirmDiscard(false)}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSaveAndClose}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            textTransform: 'none',
            borderRadius: 1.5,
            fontSize: '0.85rem',
          }}
        >
          Save & Close
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
};

export default Settings;
