import React, { useState, useEffect, useCallback, useRef } from 'react';
import { report } from '@/shared/serviceClient';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import { useAppDispatch } from '@/shared/hooks';
import { disconnectSubscription } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import PlanPicker from '@/app/components/overlays/PlanPicker';
import type { OpenSwarmPlan } from '@/shared/subscription/checkout';

/** Pro managed-subscription card: Subscribe CTA when disconnected, live usage + Manage/Disconnect when active. */
interface OpenSwarmProStatus {
  connected: boolean;
  connection_mode?: string;
  plan?: string | null;
  status?: string | null;
  expires?: string | null;
  // Backend returns reason + last_plan on 401/402 so UI distinguishes "subscription ended" from "never subscribed".
  reason?: 'revoked' | 'expired' | null;
  last_plan?: string | null;
  usage?: {
    // Live utilization (0-100%) of the shared pool subscription's 5h window; polled ~30s.
    utilization?: number;
    window_hours?: number;
    window_ends_at?: number;
    pool_active_accounts?: number;
  } | null;
}

/** Clamp arbitrary cloud plan name to one of the three picker tiers; defaults to pro_plus. */
const clampPickerPlan = (plan: string | null | undefined): OpenSwarmPlan => {
  if (plan === 'pro' || plan === 'pro_plus' || plan === 'ultra') return plan;
  return 'pro_plus';
};

const OpenSwarmProCard: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<OpenSwarmProStatus | null>(null);
  const [busy, setBusy] = useState<'manage' | 'disconnect' | null>(null);
  // Track fired usage thresholds so the event doesn't spam every 30s while counter hovers past the line.
  const firedUsageThresholds = useRef<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/subscription/status`);
      if (r.ok) setStatus(await r.json());
    } catch {
      // silently ignore; cloud might be offline
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

  // Fire usage_warning once per threshold (80%, 90%); placed before the early return so hook chain stays stable.
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

  // Don't flash a CTA that disappears on first fetch.
  if (!status) return null;

  const isConnected = !!status.connected;
  const usage = status.usage;
  // Pool utilization (0-100%) for the current 5h window of the routed subscription.
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
          {/* Canceled-in-grace banner: canceled in Stripe but still inside paid period. */}
          {status.status === 'canceled' && (
            <Box sx={{
              px: 1.2, py: 0.6, mb: 1.2, borderRadius: `${c.radius.sm}px`,
              bgcolor: `${c.status.warning}15`, border: `1px solid ${c.status.warning}40`,
            }}>
              <Typography sx={{ fontSize: '0.72rem', color: c.status.warning, fontWeight: 500 }}>
                Subscription canceled. You still have access until {expiresLabel || 'the end of the period'}.
              </Typography>
            </Box>
          )}

          {/* Usage bar; percentage only, no raw counts. */}
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

          {/* Canceled-in-grace: 3-tier picker inline for resubscribe; active subs use Stripe's portal instead. */}
          {status.status === 'canceled' && (
            <>
              <Box sx={{ mt: 2.5, mb: 1.5, borderTop: `1px solid ${c.border.subtle}`, pt: 2 }}>
                <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, fontWeight: 500, mb: 0.3 }}>
                  Resubscribe to keep access past {expiresLabel || 'your end date'}
                </Typography>
                <Typography sx={{ fontSize: '0.7rem', color: c.text.muted }}>
                  Pick any plan below; you can keep your current tier or switch.
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
        // Expired: bearer's sub ended past grace; show picker with prior plan preselected.
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
        // Token revoked but sub existed; CTA language differs so user knows this isn't billing.
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
        // Genuine new user; never had a subscription on this machine.
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

export default OpenSwarmProCard;
