import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CheckIcon from '@mui/icons-material/Check';
import CircularProgress from '@mui/material/CircularProgress';
import { report } from '@/shared/serviceClient';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  subscribeToPlan,
  OpenSwarmPlan,
  BillingInterval,
  CheckoutSource,
} from '@/shared/subscription/checkout';

// Pricing table; keep in sync with Stripe price IDs on api.openswarm.com.
interface PlanDef {
  id: OpenSwarmPlan;
  name: string;
  tagline: string;
  monthly: number;
  /** Monthly-equivalent when billed annually. */
  annual: number;
  featuresHeader: string;
  features: string[];
  recommended?: boolean;
}

const PLANS: PlanDef[] = [
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Research, code, and organize',
    monthly: 20,
    annual: 17,
    featuresHeader: 'Everything in Hobby and:',
    features: [
      'All Claude models (Sonnet, Opus, Haiku)',
      'Claude Code + Cowork',
      'Higher usage limits',
      'Browser agents that complete tasks end-to-end',
    ],
  },
  {
    id: 'pro_plus',
    name: 'Pro+',
    tagline: 'Higher limits, priority access',
    monthly: 100,
    annual: 85,
    featuresHeader: 'Everything in Pro, plus:',
    features: [
      'Up to 5\u00d7 more usage than Pro*',
      'Higher output limits per response',
      'Priority access at busy times',
    ],
    recommended: true,
  },
  {
    id: 'ultra',
    name: 'Ultra',
    tagline: 'Maximum headroom',
    monthly: 200,
    annual: 170,
    featuresHeader: 'Everything in Pro+, plus:',
    features: [
      'Up to 20\u00d7 more usage than Pro*',
      'Highest output limits',
      'First-in-line priority access',
    ],
  },
];

interface PlanPickerProps {
  source: CheckoutSource;
  defaultPlan?: OpenSwarmPlan;
  defaultInterval?: BillingInterval;
  compact?: boolean;
  /** User's current tier; drives Resubscribe/Upgrade/Downgrade CTA copy. */
  currentPlan?: OpenSwarmPlan;
  onSubscribed?: (plan: OpenSwarmPlan) => void;
}

const TIER_RANK: Record<OpenSwarmPlan, number> = {
  pro: 1,
  pro_plus: 2,
  ultra: 3,
};

function ctaLabel(cardId: OpenSwarmPlan, cardName: string, currentPlan?: OpenSwarmPlan): string {
  if (!currentPlan) return `Subscribe to ${cardName}`;
  if (currentPlan === cardId) return `Resubscribe to ${cardName}`;
  return TIER_RANK[cardId] > TIER_RANK[currentPlan]
    ? `Upgrade to ${cardName}`
    : `Downgrade to ${cardName}`;
}

const PlanPicker: React.FC<PlanPickerProps> = ({
  source,
  defaultPlan,
  defaultInterval = 'annual',
  compact = false,
  currentPlan,
  onSubscribed,
}) => {
  const c = useClaudeTokens();
  const [interval, setInterval] = useState<BillingInterval>(defaultInterval);
  const [pending, setPending] = useState<OpenSwarmPlan | null>(null);

  React.useEffect(() => {
    report('subscription', 'plan_picker_opened', { source, default_plan: defaultPlan ?? 'pro_plus' });
  }, [source, defaultPlan]);

  const handleSubscribe = async (plan: OpenSwarmPlan) => {
    setPending(plan);
    try {
      await subscribeToPlan(plan, interval, source, { wasSubscribed: !!currentPlan });
      onSubscribed?.(plan);
    } finally {
      setPending(null);
    }
  };

  const handleIntervalChange = (_: React.MouseEvent<HTMLElement>, next: BillingInterval | null) => {
    if (!next) return;
    setInterval(next);
    report('subscription', 'billing_interval_toggled', { source, interval: next });
  };

  // Typography scale: smaller in compact mode (modal), same hierarchy.
  const sz = compact
    ? { name: '1.35rem', price: '2rem', tagline: '0.78rem', features: '0.78rem', cta: '0.82rem', micro: '0.7rem', sub: '0.68rem', hdr: '0.72rem', suffix: '0.78rem' }
    : { name: '1.75rem', price: '2.4rem', tagline: '0.85rem', features: '0.85rem', cta: '0.88rem', micro: '0.72rem', sub: '0.72rem', hdr: '0.78rem', suffix: '0.85rem' };

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ display: 'flex', justifyContent: 'center', mb: compact ? 2 : 2.5 }}>
        <ToggleButtonGroup
          value={interval}
          exclusive
          onChange={handleIntervalChange}
          size="small"
          sx={{
            '& .MuiToggleButton-root': {
              textTransform: 'none',
              fontSize: '0.78rem',
              fontWeight: 500,
              px: 2,
              py: 0.5,
              color: c.text.tertiary,
              borderColor: c.border.subtle,
              '&.Mui-selected': {
                bgcolor: `${c.accent.primary}15`,
                color: c.accent.primary,
                borderColor: `${c.accent.primary}60`,
                '&:hover': { bgcolor: `${c.accent.primary}20` },
              },
            },
          }}
        >
          <ToggleButton value="monthly">Monthly</ToggleButton>
          <ToggleButton value="annual">Annual, save 15%</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(3, 1fr)',
          gap: compact ? 1.5 : 2,
          alignItems: 'stretch',
        }}
      >
        {PLANS.map((plan) => {
          const price = interval === 'annual' ? plan.annual : plan.monthly;
          const isRecommended = !!plan.recommended;
          const isPending = pending === plan.id;
          const isDefault = defaultPlan === plan.id;

          return (
            <Box
              key={plan.id}
              sx={{
                position: 'relative',
                p: compact ? 2 : 2.5,
                borderRadius: `${c.radius.lg}px`,
                border: `1px solid ${isRecommended ? c.accent.primary : c.border.subtle}`,
                bgcolor: isRecommended ? `${c.accent.primary}08` : c.bg.surface,
                display: 'flex',
                flexDirection: 'column',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.8, mb: 0.4 }}>
                <Typography sx={{ fontSize: sz.name, fontWeight: 700, color: c.text.primary, lineHeight: 1.1 }}>
                  {plan.name}
                </Typography>
                {isDefault && (
                  <Typography sx={{ fontSize: sz.micro, color: c.text.muted, fontWeight: 500 }}>
                    your plan
                  </Typography>
                )}
              </Box>

              <Typography sx={{ fontSize: sz.tagline, color: c.text.muted, mb: 1.4, lineHeight: 1.35 }}>
                {plan.tagline}
              </Typography>

              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mb: 0.2 }}>
                <Typography sx={{ fontSize: sz.price, fontWeight: 700, color: c.text.primary, lineHeight: 1 }}>
                  ${price}
                </Typography>
                <Typography sx={{ fontSize: sz.suffix, color: c.text.muted, fontWeight: 500 }}>
                  /mo
                </Typography>
              </Box>
              <Typography sx={{ fontSize: sz.sub, color: c.text.ghost, mb: 1.8, lineHeight: 1.35 }}>
                {interval === 'annual' ? 'billed annually' : 'billed monthly'}
              </Typography>

              <Button
                onClick={() => handleSubscribe(plan.id)}
                disabled={pending !== null}
                variant={isRecommended ? 'contained' : 'outlined'}
                fullWidth
                sx={{
                  textTransform: 'none',
                  fontSize: sz.cta,
                  fontWeight: 600,
                  py: compact ? 0.85 : 1.05,
                  borderRadius: `${c.radius.md}px`,
                  ...(isRecommended
                    ? { bgcolor: c.accent.primary, color: '#fff', boxShadow: 'none', '&:hover': { bgcolor: c.accent.hover, boxShadow: 'none' } }
                    : { borderColor: c.border.medium, color: c.text.primary, '&:hover': { borderColor: c.accent.primary, bgcolor: `${c.accent.primary}06` } }),
                }}
              >
                {isPending ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.7 }}>
                    <CircularProgress size={14} sx={{ color: 'inherit' }} />
                    <span>Opening...</span>
                  </Box>
                ) : (
                  ctaLabel(plan.id, plan.name, currentPlan)
                )}
              </Button>

              <Typography
                sx={{
                  fontSize: sz.micro,
                  color: c.text.muted,
                  textAlign: 'center',
                  mt: 0.7,
                  minHeight: '1em',
                }}
              >
                {isRecommended
                  ? 'Most popular, cancel anytime'
                  : plan.id === 'ultra'
                    ? 'No commitment, cancel anytime'
                    : 'Cancel anytime'}
              </Typography>

              <Box
                sx={{
                  borderTop: `1px solid ${c.border.subtle}`,
                  mt: 1.8,
                  pt: 1.6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.8,
                  flex: 1,
                }}
              >
                <Typography sx={{ fontSize: sz.hdr, fontWeight: 600, color: c.text.secondary, mb: 0.2 }}>
                  {plan.featuresHeader}
                </Typography>
                {plan.features.map((f) => (
                  <Box key={f} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.8 }}>
                    <CheckIcon
                      sx={{
                        fontSize: compact ? 14 : 16,
                        color: isRecommended ? c.accent.primary : c.text.tertiary,
                        mt: '2px',
                        flexShrink: 0,
                      }}
                    />
                    <Typography sx={{ fontSize: sz.features, color: c.text.secondary, lineHeight: 1.45 }}>
                      {f}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          );
        })}
      </Box>

      <Typography
        sx={{
          fontSize: compact ? '0.65rem' : '0.7rem',
          color: c.text.ghost,
          textAlign: 'center',
          mt: 2,
          lineHeight: 1.5,
        }}
      >
        *Usage limits apply. Prices shown don't include applicable tax.
        {' '}Prices and plans are subject to change at OpenSwarm's discretion.
      </Typography>
    </Box>
  );
};

export default PlanPicker;
