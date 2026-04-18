import React, { useState, useCallback, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { expandSession, collapseSession } from '@/shared/state/agentsSlice';
import { GET_SESSION } from '@/shared/backend-bridge/apps/agents';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { placeCard, removeCard, setGlowingAgentCard, clearGlowingAgentCard, DEFAULT_CARD_W, DEFAULT_CARD_H, EXPANDED_CARD_MIN_H, GRID_GAP } from '@/shared/state/dashboardLayoutSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ElapsedTimer } from './ElapsedTimer';
import {
  ToolCallBubbleProps, ensureToolCallKeyframes, getToolData, formatElapsed,
  parseToolResult, getResultSummary, parseInvokedSessionId,
  parseInvokeAgentResult, parseCreateAgentResult,
} from './toolCallUtils';

function useRevealAgent(
  revealTargetSessionId: string | null, sessionId: string | undefined,
  bubbleRef: React.RefObject<HTMLDivElement | null>, label: string,
) {
  const dispatch = useAppDispatch();
  const cards = useAppSelector((s) => s.dashboardLayout.cards);
  const sessions = useAppSelector((s) => s.agents.sessions);
  return useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!revealTargetSessionId || !sessionId) return;
    if (cards[revealTargetSessionId]) {
      dispatch(collapseSession(revealTargetSessionId));
      dispatch(removeCard(revealTargetSessionId));
      setTimeout(() => dispatch(clearGlowingAgentCard(revealTargetSessionId)), 500);
      return;
    }
    let sourceYRatio: number | undefined;
    if (bubbleRef.current) {
      const cardEl = bubbleRef.current.closest('[data-select-type="agent-card"]') as HTMLElement | null;
      if (cardEl) {
        const cr = cardEl.getBoundingClientRect(), br = bubbleRef.current.getBoundingClientRect();
        sourceYRatio = Math.max(0, Math.min(1, (br.top + br.height / 2 - cr.top) / cr.height));
      }
    }
    const doPlace = () => {
      const parentCard = cards[sessionId];
      const targetX = parentCard ? parentCard.x + parentCard.width + GRID_GAP * 12 : 40;
      let targetY = parentCard ? parentCard.y : 100;
      if (parentCard) {
        const colCards = Object.values(cards).filter((c) => Math.abs(c.x - targetX) < 50 && c.session_id !== revealTargetSessionId);
        if (colCards.length > 0) targetY = Math.max(...colCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height))) + GRID_GAP;
      }
      dispatch(placeCard({ sessionId: revealTargetSessionId, x: targetX, y: targetY, width: DEFAULT_CARD_W, height: DEFAULT_CARD_H }));
      dispatch(expandSession(revealTargetSessionId));
      dispatch(setGlowingAgentCard({ sessionId: revealTargetSessionId, sourceId: sessionId, sourceYRatio, label }));
    };
    if (!sessions[revealTargetSessionId]) dispatch(GET_SESSION(revealTargetSessionId)).then(doPlace);
    else doPlace();
  }, [revealTargetSessionId, sessionId, cards, sessions, dispatch, label, bubbleRef]);
}

const mdSx = (c: any) => ({
  borderTop: `1px solid ${c.border.subtle}`, px: 1.5, py: 1.25, maxHeight: 400,
  overflowY: 'auto', overflowX: 'hidden', color: c.text.secondary, fontFamily: c.font.sans,
  fontSize: '0.78rem', lineHeight: 1.65, overflowWrap: 'anywhere', wordBreak: 'break-word',
  '& p': { m: 0, mb: 0.75, '&:last-child': { mb: 0 } },
  '& h1, & h2, & h3, & h4': { color: c.text.primary, fontFamily: c.font.sans, mt: 1, mb: 0.5, '&:first-of-type': { mt: 0 } },
  '& h1': { fontSize: '0.88rem' }, '& h2': { fontSize: '0.84rem' }, '& h3': { fontSize: '0.8rem' }, '& h4': { fontSize: '0.78rem' },
  '& strong': { color: c.text.primary, fontWeight: 600 },
  '& a': { color: c.accent.primary, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
  '& ul, & ol': { pl: 2, mb: 0.75, mt: 0 }, '& li': { mb: 0.2 },
  '& blockquote': { m: 0, mb: 0.75, pl: 1, ml: 0, borderLeft: `2px solid ${c.border.subtle}`, color: c.text.tertiary, fontStyle: 'italic' },
  '& code': { bgcolor: c.bg.secondary, px: 0.4, py: 0.15, borderRadius: 0.5, fontSize: '0.72rem', fontFamily: c.font.mono },
  '& pre': { bgcolor: c.bg.secondary, borderRadius: 1, p: 1, overflow: 'auto', fontSize: '0.72rem', fontFamily: c.font.mono, m: 0, mb: 0.75 },
  '& pre code': { bgcolor: 'transparent', p: 0 },
  '& hr': { border: 'none', borderTop: `1px solid ${c.border.subtle}`, my: 0.75 },
  '&::-webkit-scrollbar': { width: 5 }, '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
} as const);

function useAgentBubbleState(call: any, result: any, isPending: boolean, isStreaming: boolean) {
  const c = useClaudeTokens();
  const [expanded, setExpanded] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const { toolName, input, isDenied } = getToolData(call);
  const showTimer = isPending && !isDenied && !isStreaming;
  const resultContent = result?.content;
  const hasSR = resultContent && typeof resultContent === 'object' && 'text' in resultContent;
  const resultRawText: string = hasSR ? resultContent.text : typeof resultContent === 'string' ? resultContent : resultContent ? JSON.stringify(resultContent, null, 2) : '';
  const resultElapsedMs: number | null = hasSR ? resultContent.elapsed_ms ?? null : null;
  const parsedResult = useMemo(() => (result ? parseToolResult(toolName, resultRawText) : null), [result, toolName, resultRawText]);
  const resultSummary = result ? getResultSummary(toolName, resultRawText) : null;
  const isError = resultSummary?.startsWith('✗') || (parsedResult?.type === 'bash' && parsedResult.exitCode !== null && parsedResult.exitCode !== 0) || (parsedResult?.type === 'text' && parsedResult.isError);
  const toggle = useCallback(() => { if (!isStreaming) setExpanded((v) => !v); }, [isStreaming]);
  const accentRgb = c.accent.primary.replace('#', '').match(/.{2}/g)?.map((h) => parseInt(h, 16)).join(', ') || '189, 100, 57';
  const selectAttrs = { 'data-select-type': 'tool-call' as const, 'data-select-id': call.id, 'data-select-meta': JSON.stringify({ tool: toolName, inputSummary: '' }) };
  return { c, expanded, bubbleRef, toolName, input, isDenied, showTimer, resultRawText, resultElapsedMs, isError, toggle, accentRgb, selectAttrs };
}

export const InvokeAgentBubble: React.FC<ToolCallBubbleProps> = ({ call, result = null, isPending = false, isStreaming = false, sessionId }) => {
  ensureToolCallKeyframes();
  const s = useAgentBubbleState(call, result, isPending, isStreaming);
  const invokeAgentParsed = useMemo(() => (result ? parseInvokeAgentResult(s.resultRawText) : null), [result, s.resultRawText]);
  const invokedSessionId = useMemo(() => (result ? parseInvokedSessionId(s.resultRawText) : null), [result, s.resultRawText]);
  const handleRevealAgent = useRevealAgent(invokedSessionId, sessionId, s.bubbleRef, 'Invoke Agent');
  const agentName = invokeAgentParsed?.agentName || s.input?.session_id || 'Agent';
  const responsePreview = invokeAgentParsed?.response || '';
  const costLabel = invokeAgentParsed?.cost ? `$${invokeAgentParsed.cost}` : null;
  const hasResponse = !!invokeAgentParsed;

  return (
    <Box ref={s.bubbleRef} {...s.selectAttrs} sx={{ maxWidth: '85%', my: 0.5 }}>
      <Box sx={{ '--glow-rgb': s.accentRgb, bgcolor: s.c.bg.elevated, border: `1px solid ${isPending ? s.c.accent.primary : s.isDenied ? s.c.status.error + '60' : s.c.border.subtle}`, borderRadius: 2, overflow: 'hidden', animation: isPending ? 'border-glow 2s ease-in-out infinite' : 'none', transition: 'border-color 0.3s, box-shadow 0.3s' } as any}>
        <Box onClick={s.toggle} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, cursor: hasResponse ? 'pointer' : 'default', '&:hover': hasResponse ? { bgcolor: 'rgba(0,0,0,0.02)' } : {} }}>
          <CallSplitIcon sx={{ fontSize: 15, color: s.c.accent.primary, flexShrink: 0 }} />
          <Typography sx={{ color: s.c.accent.primary, fontSize: '0.8rem', fontWeight: 600, flexShrink: 0 }}>InvokeAgent</Typography>
          <Box sx={{ display: 'inline-flex', alignItems: 'center', bgcolor: `${s.c.accent.primary}14`, borderRadius: 1, px: 0.75, py: 0.15, maxWidth: 180, overflow: 'hidden' }}>
            <Typography noWrap sx={{ fontSize: '0.72rem', fontWeight: 500, color: s.c.text.secondary, fontFamily: s.c.font.sans }}>{agentName}</Typography>
          </Box>
          {!hasResponse && !s.showTimer && <Box sx={{ flex: 1 }} />}
          {hasResponse && responsePreview && !s.expanded && <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '0.73rem', color: s.c.text.tertiary, fontFamily: s.c.font.sans }}>{responsePreview.slice(0, 100)}{responsePreview.length > 100 ? '…' : ''}</Typography>}
          {s.expanded && <Box sx={{ flex: 1 }} />}
          {s.isDenied && <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}><BlockIcon sx={{ fontSize: 13, color: s.c.status.error }} /><Typography sx={{ color: s.c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>denied</Typography></Box>}
          {hasResponse && !s.isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {s.isError ? <ErrorOutlineIcon sx={{ fontSize: 13, color: s.c.status.error }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 13, color: s.c.status.success }} />}
              {s.resultElapsedMs != null && <Typography sx={{ fontSize: '0.65rem', fontFamily: s.c.font.mono, color: s.c.text.tertiary }}>{formatElapsed(s.resultElapsedMs)}</Typography>}
              {costLabel && <Typography sx={{ fontSize: '0.63rem', fontFamily: s.c.font.mono, color: s.c.text.tertiary }}>{costLabel}</Typography>}
            </Box>
          )}
          {s.showTimer && <ElapsedTimer startTime={call.timestamp} />}
          {invokedSessionId && <Tooltip title="Reveal on dashboard" arrow><IconButton size="small" onClick={handleRevealAgent} sx={{ color: s.c.accent.primary, p: 0.25, flexShrink: 0, '&:hover': { bgcolor: `${s.c.accent.primary}18` } }}><CallSplitIcon sx={{ fontSize: 15, transform: 'rotate(180deg)' }} /></IconButton></Tooltip>}
          {hasResponse && <IconButton size="small" sx={{ color: s.c.text.tertiary, p: 0.25, flexShrink: 0 }}>{s.expanded ? <ExpandLessIcon sx={{ fontSize: 18 }} /> : <ExpandMoreIcon sx={{ fontSize: 18 }} />}</IconButton>}
        </Box>
        <Collapse in={s.expanded && hasResponse}>
          <Box sx={mdSx(s.c)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props}>{children}</a> }}>{responsePreview}</ReactMarkdown>
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
};

export const CreateAgentBubble: React.FC<ToolCallBubbleProps> = ({ call, result = null, isPending = false, isStreaming = false, sessionId }) => {
  ensureToolCallKeyframes();
  const s = useAgentBubbleState(call, result, isPending, isStreaming);
  const resultContent = result?.content;
  const hasSR = resultContent && typeof resultContent === 'object' && 'text' in resultContent;
  const createAgentResponse = useMemo(() => (result ? parseCreateAgentResult(s.resultRawText) : ''), [result, s.resultRawText]);
  const createAgentSessionId: string | null = useMemo(() => (hasSR && resultContent?.sub_session_id) ? resultContent.sub_session_id : null, [hasSR, resultContent]);
  const handleRevealAgent = useRevealAgent(createAgentSessionId, sessionId, s.bubbleRef, 'Create Agent');
  const taskPrompt = s.input?.prompt || s.input?.task || s.input?.message || '';
  const taskLabel = taskPrompt ? (taskPrompt.length > 40 ? taskPrompt.slice(0, 40) + '…' : taskPrompt) : 'Sub-agent';
  const hasResponse = !!createAgentResponse;

  return (
    <Box ref={s.bubbleRef} {...s.selectAttrs} sx={{ maxWidth: '85%', my: 0.5 }}>
      <Box sx={{ '--glow-rgb': s.accentRgb, bgcolor: s.c.bg.elevated, border: `1px solid ${isPending ? s.c.accent.primary : s.isDenied ? s.c.status.error + '60' : s.c.border.subtle}`, borderRadius: 2, overflow: 'hidden', animation: isPending ? 'border-glow 2s ease-in-out infinite' : 'none', transition: 'border-color 0.3s, box-shadow 0.3s' } as any}>
        <Box onClick={s.toggle} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, cursor: hasResponse ? 'pointer' : 'default', '&:hover': hasResponse ? { bgcolor: 'rgba(0,0,0,0.02)' } : {} }}>
          <CallSplitIcon sx={{ fontSize: 15, color: s.c.accent.primary, flexShrink: 0 }} />
          <Typography sx={{ color: s.c.accent.primary, fontSize: '0.8rem', fontWeight: 600, flexShrink: 0 }}>CreateAgent</Typography>
          <Box sx={{ display: 'inline-flex', alignItems: 'center', bgcolor: `${s.c.accent.primary}14`, borderRadius: 1, px: 0.75, py: 0.15, maxWidth: 180, overflow: 'hidden' }}>
            <Typography noWrap sx={{ fontSize: '0.72rem', fontWeight: 500, color: s.c.text.secondary, fontFamily: s.c.font.sans }}>{taskLabel}</Typography>
          </Box>
          {!hasResponse && !s.showTimer && <Box sx={{ flex: 1 }} />}
          {hasResponse && createAgentResponse && !s.expanded && <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '0.73rem', color: s.c.text.tertiary, fontFamily: s.c.font.sans }}>{createAgentResponse.slice(0, 100)}{createAgentResponse.length > 100 ? '…' : ''}</Typography>}
          {s.expanded && <Box sx={{ flex: 1 }} />}
          {s.isDenied && <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}><BlockIcon sx={{ fontSize: 13, color: s.c.status.error }} /><Typography sx={{ color: s.c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>denied</Typography></Box>}
          {hasResponse && !s.isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {s.isError ? <ErrorOutlineIcon sx={{ fontSize: 13, color: s.c.status.error }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 13, color: s.c.status.success }} />}
              {s.resultElapsedMs != null && <Typography sx={{ fontSize: '0.65rem', fontFamily: s.c.font.mono, color: s.c.text.tertiary }}>{formatElapsed(s.resultElapsedMs)}</Typography>}
            </Box>
          )}
          {s.showTimer && <ElapsedTimer startTime={call.timestamp} />}
          {createAgentSessionId && <Tooltip title="Reveal on dashboard" arrow><IconButton size="small" onClick={handleRevealAgent} sx={{ color: s.c.accent.primary, p: 0.25, flexShrink: 0, '&:hover': { bgcolor: `${s.c.accent.primary}18` } }}><CallSplitIcon sx={{ fontSize: 15, transform: 'rotate(180deg)' }} /></IconButton></Tooltip>}
          {hasResponse && <IconButton size="small" sx={{ color: s.c.text.tertiary, p: 0.25, flexShrink: 0 }}>{s.expanded ? <ExpandLessIcon sx={{ fontSize: 18 }} /> : <ExpandMoreIcon sx={{ fontSize: 18 }} />}</IconButton>}
        </Box>
        <Collapse in={s.expanded && hasResponse}>
          <Box sx={mdSx(s.c)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props}>{children}</a> }}>{createAgentResponse}</ReactMarkdown>
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
};
