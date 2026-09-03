import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TerminalIcon from '@mui/icons-material/Terminal';
import CheckIcon from '@mui/icons-material/Check';
import CircularProgress from '@mui/material/CircularProgress';
import { summarizeToolGroup } from './summarizeToolGroup';
import { COLLAPSE_MS, COLLAPSE_EASE, chevronSx, shimmerTextSx, railEnterSx, pressSx, keepRowAnchored } from './toolRowMotion';
import { AgentMessage, ToolGroupMeta } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useMountReveal } from './useMountReveal';
import { sanitizeSvgString } from '@/shared/sanitizeSvg';
import { parseMcpToolName, getWorkflowToolLabel } from '@/shared/mcpToolMeta';
import ToolCallBubble, { ToolPair } from './ToolCallBubble';
import { SourceFavicons, domainFromUrl } from './SourceFavicons';

export type ToolGroupEntry =
  | { kind: 'pair'; pair: ToolPair }
  | { kind: 'note'; id: string; text: string };

export interface ToolGroup {
  type: 'tool_group';
  id: string;
  pairs: ToolPair[];
  label: string;
  callCount: number;
  mcpServer?: string;
  /** Pairs interleaved with the folded mid-phase narration; present only when narration was absorbed. */
  entries?: ToolGroupEntry[];
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
  const reveal = useMountReveal(); // JS-driven slide-in; see useMountReveal (was a fragile mount keyframe)
  const isMcp = !!group.mcpServer;
  // MCP groups auto-expand only WHILE the run is live; a finished transcript rests as the quiet row.
  const [expanded, setExpanded] = useState(isMcp && isSessionRunning);
  const userToggledRef = React.useRef(false);
  React.useEffect(() => {
    if (!isSessionRunning && !userToggledRef.current) setExpanded(false);
  }, [isSessionRunning]);

  const completedCount = group.pairs.filter((p) => p.result !== null).length;
  const pendingCount = group.pairs.filter((p) => p.result === null).length;
  const deniedCount = group.pairs.filter(
    (p) => typeof p.call.content === 'object' && p.call.content.approved === false
  ).length;
  const allDone = pendingCount === 0 || !isSessionRunning;

  const toolNames = group.pairs.map((p) => {
    const c2 = typeof p.call.content === 'object' ? p.call.content : {};
    return c2.tool || 'unknown';
  });
  const workflowGroupLabel = (() => {
    if (group.mcpServer !== 'openswarm-schedule') return null;
    const parsedLabels = Array.from(new Set(toolNames.map((name) => {
      const parsed = parseMcpToolName(name);
      return parsed.isMcp ? getWorkflowToolLabel(parsed.action) : null;
    }).filter(Boolean))) as string[];
    return parsedLabels.length === 1 ? parsedLabels[0] : 'Workflow actions';
  })();
  // A web group is a SEARCH, so it wears its sources: favicon stack + "Searched the web", the
  // Perplexity read (same special-case precedent as openswarm-schedule above).
  const webDomains = useMemo(() => {
    if (group.mcpServer !== 'openswarm-web') return null;
    const domains: string[] = [];
    for (const p of group.pairs) {
      const cc = typeof p.call.content === 'object' ? p.call.content : {};
      const url = (cc.input as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && url) {
        const d = domainFromUrl(url);
        if (d && !domains.includes(d)) domains.push(d);
      }
    }
    return domains;
  }, [group]);
  const webGroupLabel = webDomains ? 'Searched the web' : null;
  const restingLabel = webGroupLabel ?? workflowGroupLabel;
  const displayName = workflowGroupLabel || webGroupLabel || meta?.name || group.label;
  const hasSvg = !!meta?.svg && !workflowGroupLabel && !webGroupLabel;

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
        // Ease in instead of popping when a tool group appears mid-turn. Transform+opacity only, so it rides the compositor and never nudges layout or the scroll position. No streaming twin, so no handoff flash.
        ...reveal,
      }}
    >
      <Box>
        {/* Both states stay FLAT (the Claude/ChatGPT transition language): expanding never draws a
            box around the group, the detail hangs off a thin indent rail under the same quiet row. */}
        {!expanded ? (
          <Box
            onClick={(e: React.MouseEvent) => { keepRowAnchored(e.currentTarget as HTMLElement); userToggledRef.current = true; setExpanded(true); }}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              py: 0.4,
              cursor: 'pointer',
              color: c.text.tertiary,
              '&:hover': { color: c.text.secondary },
              ...pressSx,
            }}
          >
            {!allDone && <CircularProgress size={12} thickness={5} sx={{ color: c.accent.primary, flexShrink: 0 }} />}
            {webDomains && webDomains.length > 0 && <SourceFavicons domains={webDomains} size={16} />}
            <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500, color: 'inherit', ...(allDone ? {} : shimmerTextSx(c.accent.primary)) }}>
              {allDone ? (restingLabel ?? summarizeToolGroup(toolNames) ?? `Ran ${group.callCount} step${group.callCount === 1 ? '' : 's'}`) : (restingLabel ?? 'Working')}
            </Typography>
            {!allDone && group.callCount > 1 && (
              <Typography sx={{ fontSize: '0.6875rem', color: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                {completedCount} of {group.callCount}
              </Typography>
            )}
            {allDone && webDomains && webDomains.length > 0 && (
              <Typography sx={{ fontSize: '0.6875rem', color: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                {webDomains.length} source{webDomains.length === 1 ? '' : 's'}
              </Typography>
            )}
            {deniedCount > 0 && (
              <Typography sx={{ color: c.status.error, fontSize: '0.6875rem' }}>
                {deniedCount} denied
              </Typography>
            )}
            <ExpandMoreIcon sx={{ fontSize: 15, ...chevronSx(false) }} />
          </Box>
        ) : (
        <Box
          onClick={(e: React.MouseEvent) => { keepRowAnchored(e.currentTarget as HTMLElement); userToggledRef.current = true; setExpanded(false); }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            py: 0.4,
            cursor: 'pointer',
            '&:hover': { opacity: 0.85 },
            ...pressSx,
          }}
        >
          {!allDone ? (
            <CircularProgress size={13} thickness={5} sx={{ color: c.accent.primary, flexShrink: 0 }} />
          ) : webDomains && webDomains.length > 0 ? (
            <SourceFavicons domains={webDomains} size={16} />
          ) : !meta ? (
            <SkeletonPulse width={15} height={15} borderRadius={8} />
          ) : hasSvg ? (
            <GeneratedSvgIcon svg={meta.svg} size={15} color={c.text.secondary} />
          ) : (
            <TerminalIcon sx={{ fontSize: 15, color: c.text.secondary, flexShrink: 0 }} />
          )}

          {!meta && !webGroupLabel && !workflowGroupLabel ? (
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
              <SkeletonPulse width={100} height={12} />
            </Box>
          ) : (
            <Typography
              sx={{
                color: allDone ? c.text.secondary : c.accent.primary,
                fontSize: '0.8125rem',
                fontWeight: 600,
                flex: 1,
                transition: 'color 200ms ease',
                ...(allDone ? {} : shimmerTextSx(c.accent.primary)),
              }}
            >
              {displayName}
            </Typography>
          )}

          {deniedCount > 0 && (
            <Typography sx={{ color: c.status.error, fontSize: '0.6875rem' }}>
              {deniedCount} denied
            </Typography>
          )}
          {allDone && completedCount > 0 && <CheckIcon sx={{ fontSize: 14, color: c.status.success, flexShrink: 0 }} />}
          {!allDone && pendingCount > 0 && (
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.6875rem', fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
              {completedCount} of {group.callCount}
            </Typography>
          )}
          <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.15 }}>
            <ExpandMoreIcon sx={{ fontSize: 16, ...chevronSx(true) }} />
          </IconButton>
        </Box>
        )}

        {/* unmountOnExit: a collapsed group's rows (and their collapsed bodies) leave the DOM; the row you had opened inside comes back closed, the same as ChatGPT. */}
        <Collapse in={expanded} timeout={COLLAPSE_MS} easing={COLLAPSE_EASE} unmountOnExit>
          <Box
            sx={{
              // ChatGPT's indent rail: detail hangs off a thin rule under the row, no enclosing box.
              borderLeft: `2px solid ${c.border.medium}`,
              ml: 0.8,
              pl: 0.75,
              my: 0.25,
              ...railEnterSx(expanded),
              '& > *': {
                animation: `toolRowFadeIn ${COLLAPSE_MS}ms ${COLLAPSE_EASE} backwards`,
              },
              // Staggered entrance (assistant-ui's tool-group treatment): rows cascade instead of popping at once.
              '& > *:nth-of-type(2)': { animationDelay: '40ms' },
              '& > *:nth-of-type(3)': { animationDelay: '80ms' },
              '& > *:nth-of-type(4)': { animationDelay: '120ms' },
              '& > *:nth-of-type(n+5)': { animationDelay: '160ms' },
              '@keyframes toolRowFadeIn': {
                from: { opacity: 0, transform: 'translateY(-2px)' },
                to: { opacity: 1, transform: 'translateY(0)' },
              },
            }}
          >
            {(group.entries ?? group.pairs.map((pair) => ({ kind: 'pair' as const, pair }))).map((entry) =>
              entry.kind === 'pair' ? (
                <ToolCallBubble
                  key={entry.pair.id}
                  call={entry.pair.call}
                  result={entry.pair.result}
                  isPending={entry.pair.result === null && isSessionRunning}
                  mcpCompact
                  sessionId={sessionId}
                />
              ) : (
                <Typography
                  key={entry.id}
                  sx={{ px: 1.5, py: 0.5, fontSize: '0.75rem', color: c.text.tertiary }}
                >
                  {entry.text}
                </Typography>
              ),
            )}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
});

export default ToolGroupBubble;
