import React from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Brief toast above the build chat's composer confirming a model switch also changes the model the scheduled workflow will run on. Holds the last label in a ref so the exit fade renders content instead of blanking mid-animation.
export function WorkflowModelNotice({ c, label }: { c: ReturnType<typeof useClaudeTokens>; label: string | null }) {
  const last = React.useRef<string | null>(null);
  if (label) last.current = label;
  const display = last.current;
  if (!display) return null;
  return (
    <Fade in={!!label} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box sx={{
        position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 8px)',
        display: 'flex', alignItems: 'center', gap: 1,
        bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
        boxShadow: c.shadow.md, borderRadius: '12px',
        px: 1.75, py: 1, zIndex: 6,
      }}>
        <SwapHorizRoundedIcon sx={{ fontSize: 17, color: c.accent.primary, flexShrink: 0 }} />
        <Box sx={{ fontSize: '0.8125rem', color: c.text.primary, lineHeight: 1.4 }}>
          This workflow will now be using <b>{display}</b>.
        </Box>
      </Box>
    </Fade>
  );
}

export function FreeTrialModelNotice({ c, notice }: { c: ReturnType<typeof useClaudeTokens>; notice: { kind: 'connect' | 'spent'; label: string } | null }) {
  const last = React.useRef<{ kind: 'connect' | 'spent'; label: string } | null>(null);
  if (notice) last.current = notice;
  const display = last.current;
  if (!display) return null;
  return (
    <Fade in={!!notice} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box sx={{
        position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 8px)',
        display: 'flex', alignItems: 'center', gap: 1,
        bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
        boxShadow: c.shadow.md, borderRadius: '12px',
        px: 1.75, py: 1, zIndex: 6,
      }}>
        <InfoOutlinedIcon sx={{ fontSize: 17, color: c.accent.primary, flexShrink: 0 }} />
        <Box sx={{ fontSize: '0.8125rem', color: c.text.primary, lineHeight: 1.4 }}>
          {display.kind === 'spent' ? (
            <>You're out of free runs, connect a model in Settings to use <b>{display.label}</b>.</>
          ) : (
            <>Connect a provider in Settings to use <b>{display.label}</b>.</>
          )}
        </Box>
      </Box>
    </Fade>
  );
}
