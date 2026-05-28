import React, { useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { tierIntelligence, tierSpeed, tierCost } from './modelPicker';

export function useModelTooltip(c: ClaudeTokens) {
  const buildModelTooltip = useCallback((opt: any): React.ReactNode => {
    const [intel, speed, cost] = (Array.isArray(opt.tiers) && opt.tiers.length === 3)
      ? opt.tiers
      : [tierIntelligence(opt), tierSpeed(opt), tierCost(opt)];
    const billingKind: 'paid' | 'subscription' | 'free' = opt.billing_kind || (opt.is_free ? 'free' : 'paid');
    const Bars = ({ filled, palette }: { filled: number; palette: string[] }) => {
      const TOTAL_CELLS = 15;
      const filledCells = Math.round((filled / 5) * TOTAL_CELLS);
      return (
        <Box sx={{ display: 'inline-flex', gap: '1px', alignItems: 'center' }}>
          {Array.from({ length: TOTAL_CELLS }, (_, i) => {
            const on = i < filledCells;
            const colorIdx = on
              ? Math.min(palette.length - 1, Math.floor((i / Math.max(filledCells - 1, 1)) * (palette.length - 1)))
              : 0;
            return (
              <Box
                key={i}
                sx={{
                  width: 5, height: 5,
                  bgcolor: on ? palette[colorIdx] : c.border.subtle,
                  opacity: on ? 1 : 0.3,
                  transformOrigin: 'center',
                  animation: on
                    ? `pixelPop 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.018}s both`
                    : 'none',
                  '@keyframes pixelPop': {
                    '0%':   { transform: 'scale(0)', opacity: 0 },
                    '60%':  { transform: 'scale(1.2)', opacity: 1 },
                    '100%': { transform: 'scale(1)', opacity: 1 },
                  },
                }}
              />
            );
          })}
        </Box>
      );
    };
    const INTEL_PALETTE  = ['#6D5BBE', '#8870D5', '#A78BFA', '#BFA3FF', '#D5BFFF'];
    const SPEED_PALETTE  = ['#2DBFAA', '#42D6BF', '#5EEAD4', '#7FF1DF', '#A3F7E9'];
    const COST_PALETTE   = ['#C7752E', '#DD8A3D', '#F59E0B', '#FAB23C', '#FCC773'];
    const capabilities = [
      opt.reasoning && 'Reasoning',
      'Tools',
      billingKind === 'free' && 'Free tier',
      billingKind === 'subscription' && 'Subscription',
      (opt.context_window ?? 0) >= 1_000_000 && '1M+ context',
    ].filter(Boolean).join(' · ');
    return (
      <Box sx={{ fontSize: '0.74rem', lineHeight: 1.55, minWidth: 256 }}>
        <Box sx={{
          fontWeight: 600, fontSize: '0.85rem', mb: 0.85,
          color: c.text.primary,
          letterSpacing: '-0.01em',
          pb: 0.6,
          borderBottom: `1px solid ${c.border.subtle}`,
        }}>
          {opt.label}
        </Box>
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 1.75, rowGap: 0.5,
          alignItems: 'center',
          color: c.text.muted,
        }}>
          <span>Intelligence</span><Bars filled={intel} palette={INTEL_PALETTE} />
          <span>Speed</span><Bars filled={speed} palette={SPEED_PALETTE} />
          {billingKind === 'subscription' ? null : (
            <>
              <span>Cost</span>
              {billingKind === 'free'
                ? <Box component="span" sx={{ color: '#10b981', fontWeight: 600 }}>Free</Box>
                : <Bars filled={cost} palette={COST_PALETTE} />}
            </>
          )}
          <span>Context</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: c.text.secondary }}>
            {(opt.context_window ?? 0).toLocaleString()}
          </span>
          {billingKind === 'paid' && (opt.input_cost_per_1m || opt.output_cost_per_1m) ? (
            <>
              <span>Pricing</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: c.text.secondary }}>
                ${opt.input_cost_per_1m?.toFixed(2)}/M in · ${opt.output_cost_per_1m?.toFixed(2)}/M out
              </span>
            </>
          ) : null}
          {capabilities && (
            <>
              <span>Capabilities</span>
              <span style={{ color: c.text.secondary }}>{capabilities}</span>
            </>
          )}
        </Box>
      </Box>
    );
  }, [c]);

  const tooltipSlotProps = useMemo(() => ({
    tooltip: {
      sx: {
        bgcolor: c.bg.elevated,
        color: c.text.primary,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: `${c.radius.md}px`,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.32)',
        padding: '12px 14px',
        maxWidth: 340,
        fontSize: '0.78rem',
        fontFamily: c.font.sans,
      },
    },
    arrow: { sx: { color: c.bg.elevated, '&:before': { border: `1px solid ${c.border.subtle}` } } },
  }), [c]);

  return { buildModelTooltip, tooltipSlotProps };
}
