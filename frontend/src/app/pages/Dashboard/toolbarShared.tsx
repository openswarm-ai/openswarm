import React from 'react';
import Tooltip, { tooltipClasses } from '@mui/material/Tooltip';
import { styled } from '@mui/material/styles';
import { motion } from 'framer-motion';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { ContextPath } from '@/shared/state/agentsTypes';

export interface Props {
  inputOpen: boolean;
  onNewAgent: () => void;
  onCancel: () => void;
  onSend: (
    prompt: string,
    mode: string,
    model: string,
    images?: Array<{ data: string; media_type: string }>,
    contextPaths?: ContextPath[],
    forcedTools?: string[],
    attachedSkills?: Array<{ id: string; name: string; content: string }>,
    selectedBrowserIds?: string[],
  ) => void;
  onAddView: (outputId: string) => void;
  onHistoryResume: (sessionId: string) => void;
  onAddBrowser: () => void;
  dashboardId?: string;
}

export const TOOLBAR_OWNER_ID = '__toolbar__';
export const BTN = 40;
export const HISTORY_PAGE_SIZE = 20;

export const WarmTooltip = styled(
  ({ className, ...props }: React.ComponentProps<typeof Tooltip> & { className?: string }) => (
    <Tooltip {...props} classes={{ popper: className }} />
  )
)<{ tokens: ClaudeTokens }>(({ tokens: c }) => ({
  [`& .${tooltipClasses.tooltip}`]: {
    backgroundColor: c.bg.inverse,
    color: c.text.inverse,
    fontFamily: c.font.sans,
    fontSize: '0.78rem',
    fontWeight: 500,
    padding: '6px 12px',
    borderRadius: c.radius.md,
    boxShadow: c.shadow.md,
    letterSpacing: '0.01em',
  },
  [`& .${tooltipClasses.arrow}`]: {
    color: c.bg.inverse,
  },
}));

export const MotionBox = motion.div;

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
