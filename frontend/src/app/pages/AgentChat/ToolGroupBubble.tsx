import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import TerminalIcon from '@mui/icons-material/Terminal';
import { AgentMessage, ToolGroupMeta } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { sanitizeSvgString } from '@/shared/sanitizeSvg';
import ToolCallBubble, { ToolPair } from './ToolCallBubble';

export interface ToolGroup {
  type: 'tool_group';
  id: string;
  pairs: ToolPair[];
  label: string;
  callCount: number;
  mcpServer?: string;
}

export type RenderItem = AgentMessage | ToolGroup | ToolPair;

export function isToolGroup(item: RenderItem): item is ToolGroup {
  return (item as ToolGroup).type === 'tool_group';
}

export function isToolPair(item: RenderItem): item is ToolPair {
  return (item as ToolPair).type === 'tool_pair';
}

const GeneratedSvgIcon: React.FC<{ svg: string; size?: number; color: string }> = ({ svg, size = 16, color }) => {
  const sanitized = useMemo(() => sanitizeSvgString(svg), [svg]);
  if (!sanitized) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flexShrink: 0, color }}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
};

const SkeletonPulse: React.FC<{ width: number; height: number; borderRadius?: number }> = ({ width, height, borderRadius = 4 }) => (
  <Box
    sx={{
      width,
      height,
      borderRadius: `${borderRadius}px`,
      bgcolor: 'currentColor',
      opacity: 0.1,
      animation: 'pulse 1.5s ease-in-out infinite',
      '@keyframes pulse': {
        '0%, 100%': { opacity: 0.1 },
        '50%': { opacity: 0.2 },
      },
    }}
  />
);

interface Props {
  group: ToolGroup;
  isSessionRunning?: boolean;
  meta?: ToolGroupMeta;
  sessionId?: string;
}

const ToolGroupBubble: React.FC<Props> = React.memo(({ group, isSessionRunning = false, meta, sessionId }) => {
  const c = useClaudeTokens();
  const isMcp = !!group.mcpServer;
  const [expanded, setExpanded] = useState(isMcp);

  const completedCount = group.pairs.filter((p) => p.result !== null).length;
  const pendingCount = group.pairs.filter((p) => p.result === null).length;
  const deniedCount = group.pairs.filter(
    (p) => typeof p.call.content === 'object' && p.call.content.approved === false
  ).length;
  const allDone = pendingCount === 0 || !isSessionRunning;

  const displayName = meta?.name || group.label;
  const hasSvg = !!meta?.svg;

  const toolNames = group.pairs.map((p) => {
    const c2 = typeof p.call.content === 'object' ? p.call.content : {};
    return c2.tool || 'unknown';
  });

  return (
    <Box
      data-select-type="tool-group"
      data-select-id={group.id}
      data-select-meta={JSON.stringify({ label: displayName, callCount: group.callCount, tools: toolNames })}
      sx={{
        maxWidth: '85%',
        my: 0.5,
        // contain: stops new tool rows from reflowing the whole transcript.
        contain: 'layout style',
      }}
    >
      <Box
        sx={{
          bgcolor: c.bg.elevated,
          border: `1px solid ${c.border.subtle}`,
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <Box
          onClick={() => setExpanded(!expanded)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.5,
            py: 0.7,
            cursor: 'pointer',
            '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' },
          }}
        >
          {!meta ? (
            <SkeletonPulse width={15} height={15} borderRadius={8} />
          ) : hasSvg ? (
            <GeneratedSvgIcon svg={meta.svg} size={15} color={c.accent.primary} />
          ) : (
            <TerminalIcon sx={{ fontSize: 15, color: c.accent.primary, flexShrink: 0 }} />
          )}

          {!meta ? (
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
              <SkeletonPulse width={100} height={12} />
            </Box>
          ) : (
            <Typography
              sx={{
                color: c.accent.primary,
                fontSize: '0.8rem',
                fontWeight: 600,
                flex: 1,
              }}
            >
              {displayName}
            </Typography>
          )}

          {deniedCount > 0 && (
            <Typography sx={{ color: c.status.error, fontSize: '0.68rem' }}>
              {deniedCount} denied
            </Typography>
          )}
          {/* Single fraction renders progress AND total; the green color
              alone signals completion, and the fraction's denominator
              makes the separate ×N chip redundant. tabular-nums +
              minWidth keep the position stable as digits change. */}
          {allDone && completedCount > 0 && (
            <Typography sx={{ color: c.status.success, fontSize: '0.68rem', fontVariantNumeric: 'tabular-nums', fontFamily: c.font.mono, minWidth: 36, textAlign: 'right' }}>
              {completedCount}/{group.callCount}
            </Typography>
          )}
          {!allDone && pendingCount > 0 && (
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.68rem', fontFamily: c.font.mono, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
              {completedCount}/{group.callCount}
            </Typography>
          )}
          <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.15 }}>
            {expanded ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Box>

        <Collapse in={expanded}>
          <Box
            sx={{
              borderTop: `0.5px solid ${c.border.medium}`,
              '& > *': {
                animation: 'toolRowFadeIn 140ms ease-out',
              },
              '@keyframes toolRowFadeIn': {
                from: { opacity: 0, transform: 'translateY(-2px)' },
                to: { opacity: 1, transform: 'translateY(0)' },
              },
            }}
          >
            {group.pairs.map((pair) => (
              <ToolCallBubble
                key={pair.id}
                call={pair.call}
                result={pair.result}
                isPending={pair.result === null && isSessionRunning}
                mcpCompact
                sessionId={sessionId}
              />
            ))}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
});

export default ToolGroupBubble;
