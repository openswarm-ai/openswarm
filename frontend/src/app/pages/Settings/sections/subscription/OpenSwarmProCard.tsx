import React, { useState, useEffect, useCallback, useRef } from 'react';
import { report } from '@/shared/serviceClient';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import PlanPickerModal from '@/app/components/overlays/PlanPickerModal';
import type { OpenSwarmPlan } from '@/shared/subscription/checkout';

/** Pro managed subscription: compact provider-style row when disconnected, live usage + Manage when active. */
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
  const [status, setStatus] = useState<OpenSwarmProStatus | null>(null);
  const [managing, setManaging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
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
    setManaging(true);
    try {
      const r = await fetch(`${API_BASE}/subscription/portal`, { method: 'POST' });
      if (r.ok) {
        const { url } = await r.json();
        const api = (window as any).openswarm;
        if (url && api?.openExternal) api.openExternal(url);
        else if (url) window.open(url, '_blank');
      }
    } finally {
      setManaging(false);
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

  const lastPlan = clampPickerPlan(status.plan ?? status.last_plan);

  if (!status.connected) {
    const copy = (() => {
      if (status.reason === 'expired' && status.last_plan) {
        return {
          desc: 'Your subscription ended. Pick a plan to get back in.',
          cta: 'Resubscribe',
          title: 'Resubscribe to OpenSwarm Pro',
          subtitle: 'Keep using Claude Sonnet, Opus, and Haiku without a Claude account.',
          currentPlan: lastPlan,
        };
      }
      if (status.reason === 'revoked' && status.last_plan) {
        return {
          desc: 'Your access token was revoked. Pick a plan to reconnect.',
          cta: 'Reconnect',
          title: 'Reconnect OpenSwarm Pro',
          subtitle: 'Pick a plan to restore access.',
          currentPlan: lastPlan,
        };
      }
      return {
        desc: 'Claude Sonnet, Opus, and Haiku. No Claude account needed.',
        cta: 'Subscribe',
        title: 'Choose your plan',
        subtitle: 'One subscription, we handle everything behind the scenes. Cancel anytime.',
        currentPlan: undefined,
      };
    })();

    return (
      <>
        <Box sx={{ p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: c.border.medium }} />
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                  <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: c.text.primary }}>
                    OpenSwarm Pro
                  </Typography>
                  <Box sx={{ px: 0.7, py: 0.15, borderRadius: 999, bgcolor: `${c.accent.primary}15` }}>
                    <Typography sx={{ fontSize: '0.6rem', color: c.accent.primary, fontWeight: 600 }}>
                      RECOMMENDED
                    </Typography>
                  </Box>
                </Box>
                <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>
                  {copy.desc}
                </Typography>
              </Box>
            </Box>
            <Button
              onClick={() => setPickerOpen(true)}
              variant="contained"
              size="small"
              sx={{
                textTransform: 'none', fontSize: '0.7rem', minWidth: 70,
                borderRadius: `${c.radius.md}px`,
                bgcolor: c.accent.primary, boxShadow: 'none',
                '&:hover': { bgcolor: c.accent.hover, boxShadow: 'none' },
              }}
            >
              {copy.cta}
            </Button>
          </Box>
        </Box>
        <PlanPickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title={copy.title}
          subtitle={copy.subtitle}
          source="settings"
          defaultPlan={copy.currentPlan}
          currentPlan={copy.currentPlan}
          onSubscribed={() => setPickerOpen(false)}
        />
      </>
    );
  }

  const usage = status.usage;
  // Pool utilization (0-100%) for the current 5h window of the routed subscription.
  const pct = Math.max(0, Math.min(100, Math.round(usage?.utilization ?? 0)));
  const windowEndsAt = usage?.window_ends_at;
  const isCanceled = status.status === 'canceled';

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
    <>
      <Box
        sx={{
          p: 2.5,
          borderRadius: `${c.radius.lg}px`,
          border: `1px solid ${c.accent.primary}`,
          bgcolor: `${c.accent.primary}08`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: c.text.primary }}>
            OpenSwarm Pro
          </Typography>
          <Box
            component="img"
            src="./logo.png"
            alt={planLabel}
            title={planLabel}
            sx={{ width: 18, height: 18, borderRadius: 0.5 }}
          />
        </Box>

        {/* Canceled-in-grace banner: canceled in Stripe but still inside paid period. */}
        {isCanceled && (
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
        {expiresLabel && !isCanceled && (
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, mb: 1.5 }}>
            Renews on {expiresLabel}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 1 }}>
          {isCanceled && (
            <Button
              onClick={() => setPickerOpen(true)}
              size="small"
              variant="contained"
              sx={{ textTransform: 'none', fontSize: '0.78rem', borderRadius: `${c.radius.md}px` }}
            >
              Resubscribe
            </Button>
          )}
          <Button
            onClick={handleManage}
            disabled={managing}
            size="small"
            variant={isCanceled ? 'outlined' : 'contained'}
            sx={{ textTransform: 'none', fontSize: '0.78rem', borderRadius: `${c.radius.md}px` }}
          >
            {managing ? 'Opening…' : 'Manage in Stripe'}
          </Button>
        </Box>
      </Box>

      {/* Canceled-in-grace resubscribe; active subs use Stripe's portal instead. */}
      {isCanceled && (
        <PlanPickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title="Resubscribe to OpenSwarm Pro"
          subtitle={`Keep access past ${expiresLabel || 'your end date'}. Keep your current tier or switch.`}
          source="settings"
          defaultPlan={lastPlan}
          currentPlan={lastPlan}
          onSubscribed={() => setPickerOpen(false)}
        />
      )}
    </>
  );
};

export default OpenSwarmProCard;
