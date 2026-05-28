import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettings, closeSettingsModal, resetSystemPrompt, disconnectSubscription, signOut, activateSignin, fetchSettings, setDraft, clearDraft, AppSettings, CustomProvider, DEFAULT_SYSTEM_PROMPT } from '@/shared/state/settingsSlice';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { fetchModels } from '@/shared/state/modelsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useThemeMode, useClaudeTokens } from '@/shared/styles/ThemeContext';
import DirectoryBrowser from '@/app/components/editor/DirectoryBrowser';
import { CommandsContent } from '@/app/pages/Commands/Commands';
import GeneralTab from './sections/general/GeneralTab';
import ModelsTab from './sections/models/ModelsTab';
import UsageStats from './sections/usage/UsageStats';
import SettingsHeader from './sections/SettingsHeader';
import SettingsFooter from './sections/SettingsFooter';
import ConfirmDiscardDialog from './sections/ConfirmDiscardDialog';
import { makeSettingsStyles } from './sections/settingsStyles';

// Brand colors for provider group headers; mirrors ChatInput picker.
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#E8927A',
  openai: '#74AA9C',
  google: '#4285F4',
  gemini: '#4285F4',
  xai: '#8B949E',
  meta: '#0866FF',
  deepseek: '#4D6BFE',
  mistral: '#FF7000',
  qwen: '#A974FF',
  cohere: '#FF7759',
};
const OPENSWARM_GRADIENT =
  'linear-gradient(135deg, #8FB3FF 0%, #E56BC4 45%, #FFA85C 100%)';

const DEFAULT_MODEL_FALLBACK = [
  { value: 'sonnet', label: 'Claude Sonnet 4.6' },
  { value: 'opus', label: 'Claude Opus 4.6' },
  { value: 'haiku', label: 'Claude Haiku 4.5' },
];

// ── Subscription Provider Card ──
const SUBSCRIPTION_PROVIDERS = [
  { id: 'claude', name: 'Claude Pro / Max', desc: 'Sonnet 4.6, Opus 4.6, Haiku 4.5', color: '#E8927A', preview: false },
  // We route "Gemini" through Antigravity OAuth — same Google sign-in,
  // but a different backend lane with a much higher preview quota than
  // Gemini CLI's Code Assist free tier (which 429s after ~5 req/min).
  // Users with Google AI Pro/Ultra automatically get "priority" limits
  // on the Antigravity side; no extra action required from them.
  { id: 'antigravity', name: 'Gemini Advanced', desc: 'Gemini 3 Pro, 3 Flash, 2.5 Pro, 2.5 Flash', color: '#4285F4', preview: false },
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

// ── Account card ──
//
// Shown at the top of the General tab. Three states:
//   - Signed in (settings.user_id present): show email + signin method
//     + Sign out button.
//   - Paid user with no signed-in identity yet (bearer set, user_id null):
//     same email shown, with a one-click "Link your account" CTA that
//     fires a Google sign-in so analytics finally has a Person row.
//   - Not signed in: small "Sign in to OpenSwarm" CTA that opens the gate.
const AccountCard: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Narrow selectors: each subscribes to one primitive so unrelated
  // settings edits (e.g. theme toggle) don't re-render this card.
  const userEmail = useAppSelector((s) => s.settings.data.user_email ?? null);
  const userId = useAppSelector((s) => s.settings.data.user_id ?? null);
  const signinMethod = useAppSelector((s) => s.settings.data.signin_method ?? null);
  const hasBearer = useAppSelector((s) => Boolean(s.settings.data.openswarm_bearer_token));
  const installId = useAppSelector((s) => s.settings.data.installation_id ?? '');
  const proxyUrl = useAppSelector((s) => s.settings.data.openswarm_proxy_url || OPENSWARM_DEFAULT_PROXY_URL);
  const [signingOut, setSigningOut] = useState(false);

  const methodLabel = (() => {
    switch (signinMethod) {
      case 'google': return 'Signed in with Google';
      case 'email': return 'Signed in with email code';
      case 'stripe': return 'Signed in via Stripe checkout';
      default: return null;
    }
  })();

  const onSignOut = async () => {
    setSigningOut(true);
    try {
      await dispatch(signOut()).unwrap();
    } catch (e) {
      console.error('Sign out failed:', e);
    } finally {
      setSigningOut(false);
    }
  };

  const onSignIn = () => {
    // Pass local_port so the bearer-handoff page POSTs to the right
    // backend port (Electron may bind anything in 8324..8424).
    const localPort = (window as any).__OPENSWARM_PORT__ || 8324;
    const params = new URLSearchParams({
      install_id: installId,
      local_port: String(localPort),
    });
    const api = (window as any).openswarm;
    if (api?.openExternal) {
      const startUrl = proxyUrl.replace(/\/$/, '') + '/api/auth/google/start?' + params.toString();
      api.openExternal(startUrl);
    }
    else {
      // Plain browser mode cannot consume openswarm:// deep links. Use the
      // localhost OAuth callback; Electron remains on the cloud/deep-link path.
      const startUrl = `${API_BASE}/auth/google/start?${params.toString()}`;
      const popup = window.open(startUrl, 'openswarm-google-signin', 'width=560,height=720');
      const cloudOrigin = new URL(proxyUrl.replace(/\/$/, '')).origin;
      const localOrigin = new URL(API_BASE).origin;

      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        if (popup && !popup.closed) popup.close();
      };

      const onMessage = async (event: MessageEvent) => {
        if (event.origin !== cloudOrigin && event.origin !== localOrigin) return;
        const payload = event.data;
        const callbackData = payload?.type === 'oauth_callback' ? payload.data : payload;
        const token = callbackData?.token || callbackData?.bearer || callbackData?.access_token;
        if ((callbackData?.ok || callbackData?.local) && !token) {
          await dispatch(fetchSettings()).unwrap();
          cleanup();
          return;
        }
        if (!token) return;
        try {
          await dispatch(activateSignin({ token, email: callbackData?.email || callbackData?.user_email || undefined, signin_method: 'google' })).unwrap();
          cleanup();
        } catch (err) {
          cleanup();
          console.error('[settings] Google sign-in activation failed:', err);
        }
      };

      window.addEventListener('message', onMessage);
      window.setTimeout(cleanup, 180000);
    }
  };

  // Not signed in at all (no bearer, no user_id) — small inline CTA.
  if (!userId && !hasBearer) {
    return (
      <Box sx={{ p: 2, mb: 2, borderRadius: `${c.radius.lg}px`, border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface }}>
        <Typography sx={{ fontSize: '0.85rem', color: c.text.primary, mb: 0.5 }}>Not signed in</Typography>
        <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 1.25 }}>
          Sign in to sync settings across devices and back up your data.
        </Typography>
        <Button
          variant="outlined"
          size="small"
          onClick={onSignIn}
          sx={{
            textTransform: 'none',
            fontSize: '0.8rem',
            borderColor: c.border.medium,
            color: c.text.primary,
            '&:hover': { borderColor: c.accent.primary, color: c.accent.primary, bgcolor: 'transparent' },
          }}
        >
          Sign in to OpenSwarm
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, mb: 2, borderRadius: `${c.radius.lg}px`, border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {userEmail || 'Signed in'}
          </Typography>
          {methodLabel && (
            <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, mt: 0.25 }}>{methodLabel}</Typography>
          )}
          {!userId && hasBearer && (
            <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, mt: 0.25 }}>
              Subscription connected. Sign in to also link this device to your account.
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {!userId && hasBearer && (
            <Button
              variant="outlined"
              size="small"
              onClick={onSignIn}
              sx={{
                textTransform: 'none',
                fontSize: '0.75rem',
                borderColor: c.border.medium,
                color: c.text.primary,
                '&:hover': { borderColor: c.accent.primary, color: c.accent.primary, bgcolor: 'transparent' },
              }}
            >
              Link account
            </Button>
          )}
          <Button
            variant="text"
            size="small"
            onClick={onSignOut}
            disabled={signingOut}
            sx={{
              textTransform: 'none',
              fontSize: '0.75rem',
              color: c.text.muted,
              '&:hover': { color: c.status.error, bgcolor: 'transparent' },
            }}
          >
            {signingOut ? <CircularProgress size={14} sx={{ color: c.text.muted }} /> : 'Sign out'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
};

const OpenSwarmProCard: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<OpenSwarmProStatus | null>(null);
  const [busy, setBusy] = useState<'manage' | 'disconnect' | null>(null);
  // Track which usage thresholds we've already fired this session so the
  // event doesn't spam every 30s while the counter hovers past
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
    report('subscription', 'manage_clicked', {
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
        report('subscription', 'usage_warning', {
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
  // `status` and the polymorphic-shape `connections` array now live in the
  // subscriptionsSlice. The onboarding gate (hasModelConnected in
  // skipPredicates.ts) reads the same slice, so OAuth-driven connections
  // unstick step 1 the moment they land — previously this card kept the
  // status in local useState, which the onboarding predicate could never
  // observe.
  const status = useAppSelector((s) => s.subscriptions.status);
  const connections = useAppSelector(selectSubscriptionConnections);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [userCode, setUserCode] = useState('');
  const [pollTimer, setPollTimer] = useState<any>(null);

  // Thin wrapper around the slice thunk — returns the resolved status so
  // call sites that inspect the payload (e.g. the initial-load retry loop
  // checking `data?.running`) keep working unchanged.
  const fetchStatus = useCallback(
    async (opts?: { preserveTransient?: boolean }) => {
      return dispatch(fetchSubscriptionStatus(opts)).unwrap();
    },
    [dispatch],
  );

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

  const isConnected = (providerId: string) =>
    connections.some(
      (p: any) =>
        p.provider === providerId && (p.isActive || p.testStatus === 'active'),
    );

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

        // Shared exchange helper — called from whichever relay path
        // (postMessage or Electron IPC) delivers the code first.
        let exchanged = false;
        const runExchange = async (code: string, state?: string) => {
          if (exchanged) return;
          exchanged = true;
          window.removeEventListener('message', msgHandler);
          if (ipcUnsub) ipcUnsub();
          clearInterval(statusPoller);
          setPollTimer(null);
          if (popup && !popup.closed) popup.close();
          try {
            await fetch(`${API_BASE}/agents/subscriptions/exchange`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: providerId, code,
                redirect_uri: data.redirect_uri, code_verifier: data.code_verifier,
                state: state || data.state,
              }),
            });
          } catch {}
          setConnecting(null);
          fetchStatus();
          refreshPickerModels();
        };

        // postMessage listener — works when the popup's /callback page can
        // reach window.opener. Silently no-ops on Anthropic flows where the
        // opener chain is severed by cross-origin redirects.
        const msgHandler = async (event: MessageEvent) => {
          const d = event.data;
          const callbackData = d?.type === 'oauth_callback' ? d.data : d;
          if (callbackData?.code) await runExchange(callbackData.code, callbackData.state);
        };
        if (!useExternal) window.addEventListener('message', msgHandler);

        // Electron IPC fallback — main.js captures any child webContents
        // navigating to localhost:20128/callback?code=... and forwards the
        // parsed params here, so we exchange the code even when opener
        // postMessage fails. No-op in non-Electron contexts.
        let ipcUnsub: (() => void) | null = null;
        const ow = (window as any).openswarm;
        if (ow && typeof ow.onOauthCallback === 'function') {
          ipcUnsub = ow.onOauthCallback(async (cb: { code?: string; state?: string; error?: string }) => {
            if (cb?.code) await runExchange(cb.code, cb.state);
          });
        }

        // Timeout: 3 minutes for popup flow (was 30s — too short for 2FA /
        // slow networks, and on Windows postMessage from the callback popup
        // can silently fail due to COOP / opener severing, leaving the only
        // exit as this timeout firing mid-flow). 5 minutes for external-
        // browser flow (user has to tab-switch, log in, consent — takes
        // much longer in practice). The connecting-side poller (see the
        // useEffect below `handleDisconnect`) is the authoritative safety
        // net — this timeout just bounds the Connecting… indicator.
        const timeoutMs = useExternal ? 300_000 : 180_000;
        setTimeout(() => {
          clearInterval(statusPoller);
          setPollTimer(null);
          if (!useExternal) window.removeEventListener('message', msgHandler);
          if (ipcUnsub) ipcUnsub();
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

  // Safety-net poller that runs whenever a connect attempt is in flight.
  // The handleConnect flow's own statusPoller exits as soon as isActive is
  // seen, and its 3-minute timeout unconditionally clears `connecting` —
  // but on Windows the OAuth popup's postMessage path can fail silently
  // (COOP severs opener, Defender interferes, etc.), so the ONLY way out
  // of "Connecting…" becomes that timeout, which flips the card back to
  // "Connect" even when the backend exchange succeeded. This separate
  // poller watches the same status endpoint every 4s and clears the
  // Connecting state the moment 9Router reports the provider isActive,
  // whether that's via Method 1 (postMessage → frontend exchange), the
  // 9Router callback page's Method 4 (server-side exchange), or the Codex
  // listener's new server-side exchange.
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
    // refreshPickerModels is stable (no deps), fetchStatus isn't used here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting]);

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
    fetch(`${API_BASE}/service/usage-summary`)
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

  // Model picker source matches the in-session ChatInput picker, so Settings reflects connected providers.
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);

  const modelOptions = useMemo(() => {
    if (!modelsLoaded || Object.keys(modelsByProvider).length === 0) {
      const key = settings.connection_mode === 'openswarm-pro' ? 'OpenSwarm Pro' : 'Anthropic';
      return {
        grouped: { [key]: DEFAULT_MODEL_FALLBACK },
        flat: DEFAULT_MODEL_FALLBACK.map((m) => ({ ...m, provider: key })),
      };
    }
    const grouped: Record<string, Array<{ value: string; label: string }>> = {};
    const flat: Array<{ value: string; label: string; provider: string }> = [];
    for (const [prov, models] of Object.entries(modelsByProvider)) {
      grouped[prov] = models.map((m) => ({ value: m.value, label: m.label }));
      for (const m of models) flat.push({ value: m.value, label: m.label, provider: prov });
    }
    return { grouped, flat };
  }, [modelsByProvider, modelsLoaded, settings.connection_mode]);

  const initialTab = useAppSelector((s) => s.settings.initialTab);
  // In-flight edits persisted to Redux so they survive modal close; cleared on save or explicit Discard.
  const draft = useAppSelector((s) => s.settings.draft);
  const draftTab = useAppSelector((s) => s.settings.draftTab);
  const TAB_VALUES = ['general', 'models', 'usage', 'commands'] as const;
  type SettingsTab = typeof TAB_VALUES[number];
  const isValidTab = (t: string | null | undefined): t is SettingsTab =>
    !!t && (TAB_VALUES as readonly string[]).includes(t);
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isValidTab(draftTab) ? draftTab : 'general',
  );
  const [form, setForm] = useState<AppSettings>({ ...settings, ...(draft || {}) });

  // Re-seed form on user change; otherwise the dirty detector falsely lights up Save/Discard.
  useEffect(() => {
    setForm({ ...settings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.user_id, settings.user_email]);

  // Switch to requested tab when modal opens (e.g. from the "Configure models" banner link).
  useEffect(() => {
    if (initialTab && (TAB_VALUES as readonly string[]).includes(initialTab)) {
      setActiveTab(initialTab as SettingsTab);
    }
  }, [initialTab]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    if (open) dispatch(fetchModels());
  }, [open, dispatch]);

  useEffect(() => {
    // On open, restore the last tab from draft; explicit initialTab is handled by the effect above.
    if (open && !initialTab) {
      setActiveTab(isValidTab(draftTab) ? draftTab : 'general');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  // Sync form on modal open + first load only; including `settings` in deps wipes in-flight edits on background fetches (issue #25).
  useEffect(() => {
    if (open && loaded) {
      setForm({ ...settings, ...(draft || {}) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  // Persist in-flight edits to Redux; compares to `settings` so a clean reopen doesn't keep a phantom draft.
  useEffect(() => {
    if (!open || !loaded) return;
    const dirty = JSON.stringify(form) !== JSON.stringify(settings);
    if (dirty) {
      dispatch(setDraft({ form, tab: activeTab }));
    } else if (draft !== null) {
      dispatch(clearDraft());
    }
  }, [form, activeTab, open, loaded, settings, draft, dispatch]);

  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings);

  const handleSave = async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) {
      setThemeMode(form.theme);
    }
    dispatch(fetchModels());
    setSaved(true);
  };

  // Non-destructive close; draft persists in Redux. Explicit discard lives on its own button.
  const handleRequestClose = useCallback(() => {
    dispatch(closeSettingsModal());
    onboardingBus.emit('settings:closed');
  }, [dispatch]);

  // Explicit discard wipes the draft so form snaps back to saved settings; modal stays open for verification.
  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscard(false);
    setForm({ ...settings });
    dispatch(clearDraft());
  }, [settings, dispatch]);

  const styles = makeSettingsStyles(c);

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
      <SettingsHeader
        activeTab={activeTab}
        onTabChange={(v) => setActiveTab(v)}
        onClose={handleRequestClose}
      />

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
        <GeneralTab
          form={form}
          setForm={setForm}
          styles={styles}
          setBrowseOpen={setBrowseOpen}
          modelOptions={modelOptions}
          modesList={modesList}
          providerColors={PROVIDER_COLORS}
          openswarmGradient={OPENSWARM_GRADIENT}
        />
      ) : activeTab === 'models' ? (
        <ModelsTab
          form={form}
          setForm={setForm}
          showApiKey={showApiKey}
          setShowApiKey={setShowApiKey}
          styles={styles}
        />
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
      <SettingsFooter
        hasChanges={hasChanges}
        onDiscard={() => setConfirmDiscard(true)}
        onClose={handleRequestClose}
        onSave={handleSave}
      />
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

    <ConfirmDiscardDialog
      open={confirmDiscard}
      onCancel={() => setConfirmDiscard(false)}
      onConfirm={handleConfirmDiscard}
    />
    </>
  );
};

export default Settings;
