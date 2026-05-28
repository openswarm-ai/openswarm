import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { DURATION_MS, EASE, pulseKeyframes } from '@/shared/styles/motionTokens';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';

/** Loading primitives: Skeleton (block load), InlineSpinner (inline waits), EmptyState (no-items). */

interface SkeletonProps {
  variant?: 'card' | 'line' | 'circle' | 'custom';
  width?: number | string;
  height?: number | string;
  /** Default 100ms; pass 0 to render immediately */
  delayMs?: number;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'line',
  width,
  height,
  delayMs = 100,
}) => {
  const c = useClaudeTokens();
  const reduced = useReducedMotion();
  const [show, setShow] = useState(delayMs === 0);

  useEffect(() => {
    if (delayMs === 0) return;
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  if (!show) return null;

  const dimensions: React.CSSProperties = {
    width: width ?? (variant === 'card' ? '100%' : variant === 'circle' ? 24 : '60%'),
    height: height ?? (variant === 'card' ? 80 : variant === 'circle' ? 24 : 12),
  };

  const radius = variant === 'circle'
    ? '50%'
    : variant === 'card'
      ? 8
      : 4;

  return (
    <Box
      sx={{
        ...dimensions,
        borderRadius: `${typeof radius === 'number' ? `${radius}px` : radius}`,
        bgcolor: c.border.subtle,
        opacity: 0.5,
        animation: reduced ? 'none' : `openswarmPulse ${DURATION_MS.ambient}ms ${EASE.pulse} infinite`,
        ...pulseKeyframes,
      }}
    />
  );
};

interface InlineSpinnerProps {
  /** 14 / 16 / 18; defaults to 16 */
  size?: 14 | 16 | 18 | 20;
  color?: string;
}

export const InlineSpinner: React.FC<InlineSpinnerProps> = ({ size = 16, color }) => {
  const c = useClaudeTokens();
  return <CircularProgress size={size} sx={{ color: color ?? c.text.tertiary }} />;
};

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  /** Show after N ms; keeps "Loading..." flash off fast paths. */
  delayMs?: number;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, hint, delayMs = 100 }) => {
  const c = useClaudeTokens();
  const [show, setShow] = useState(delayMs === 0);

  useEffect(() => {
    if (delayMs === 0) return;
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  if (!show) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        py: 6,
        px: 3,
        color: c.text.tertiary,
        textAlign: 'center',
      }}
    >
      {icon && <Box sx={{ opacity: 0.5, fontSize: 32 }}>{icon}</Box>}
      <Typography sx={{ fontSize: '0.9rem', fontWeight: 500, color: c.text.muted }}>
        {title}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost, maxWidth: 320 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
};
