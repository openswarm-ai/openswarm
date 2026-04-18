import React, { useState, useEffect, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { motion } from 'framer-motion';
import { AgentSession, toggleExpandSession, collapseSession } from '@/shared/state/agentsSlice';
import { CLOSE_SESSION } from '@/shared/backend-bridge/apps/agents';
import { setCardPosition, setCardSize, fadeGlowingAgentCard, clearGlowingAgentCard, removeCard } from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useOverlayScrollPassthrough } from '@/app/pages/Dashboard/useOverlayScrollPassthrough';
import { type ResizeDir, DRAG_THRESHOLD, CURSOR_MAP, HANDLE_DEFS } from '@/app/pages/Dashboard/cardLayoutConstants';
import CardGlowOverlay from './components/CardGlowOverlay';
import AgentCardCollapsed from './components/AgentCardCollapsed';
import { formatDuration, getStatusColors, getPreviewContent } from './components/agentCardUtils';

interface Props {
  session: AgentSession; expanded: boolean;
  cardX: number; cardY: number; cardWidth: number; cardHeight: number;
  zoom?: number; spawnFrom?: { x: number; y: number; type?: 'branch' };
  exitTarget?: { x: number; y: number }; isSelected?: boolean; isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view') => void;
  onDragMove?: (dx: number, dy: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBranch?: (sourceSessionId: string, newSessionId: string) => void;
  onMeasuredHeight?: (sessionId: string, height: number) => void;
  snapColumn?: { x: number; width: number }; autoFocusInput?: boolean;
  cardZOrder?: number; onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  isFocused?: boolean; onFocusRequest?: (sessionId: string) => void; onFocusExit?: () => void;
}

const MIN_W = 480, MIN_H = 120, EXPANDED_OVERLAY_H = 620;
const SPAWN_SPRING = { type: 'spring' as const, stiffness: 400, damping: 28, mass: 0.6 };
const BRANCH_SPRING = { type: 'spring' as const, stiffness: 300, damping: 26, mass: 0.8 };
const EXIT_SPRING = { type: 'spring' as const, stiffness: 350, damping: 30, mass: 0.7 };
const GLOW_FADE_MS = 2500, SNAP_THRESHOLD = 60;

const AgentCard: React.FC<Props> = ({
  session, expanded, cardX, cardY, cardWidth, cardHeight, zoom = 1, spawnFrom, exitTarget,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  onBranch, onMeasuredHeight, snapColumn, autoFocusInput, cardZOrder = 0, onBringToFront,
  isFocused = false, onFocusRequest, onFocusExit,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const hasApiKey = !!useAppSelector((s) => s.settings.data.anthropic_api_key);
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);
  const cardBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardBoxRef.current;
    if (!el || !onMeasuredHeight) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) onMeasuredHeight(session.session_id, entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [session.session_id, onMeasuredHeight]);
  const glowEntry = useAppSelector((s) => s.dashboardLayout.glowingAgentCards[session.session_id]);
  const isGlowingRedux = !!glowEntry;
  const glowFading = glowEntry?.fading ?? false;
  const glowFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissGlow = useCallback(() => {
    if (!isGlowingRedux || glowFading) return;
    dispatch(fadeGlowingAgentCard(session.session_id));
    glowFadeTimer.current = setTimeout(() => dispatch(clearGlowingAgentCard(session.session_id)), GLOW_FADE_MS + 300);
  }, [isGlowingRedux, glowFading, dispatch, session.session_id]);
  useEffect(() => () => { if (glowFadeTimer.current) clearTimeout(glowFadeTimer.current); }, []);
  const accentColor = c.accent.primary, accentHover = c.accent.hover;
  const statusStyle = getStatusColors(c)[session.status] || { color: c.text.tertiary, bg: c.bg.secondary };
  const [, setTick] = useState(0);
  const isDraft = session.status === 'draft';
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false); const justDraggedRef = useRef(false);
  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
    didDrag.current = false; setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(session.session_id, 'agent');
  }, [cardX, cardY, onDragStart, session.session_id]);
  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX, rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const dx = rawDx / zoom, dy = rawDy / zoom;
    setLocalDragPos({ x: dragState.current.origX + dx, y: dragState.current.origY + dy });
    onDragMove?.(dx, dy);
  }, [zoom, onDragMove]);
  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = (e.clientX - dragState.current.startX) / zoom, dy = (e.clientY - dragState.current.startY) / zoom;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx; const finalY = dragState.current.origY + dy;
      if (snapColumn && Math.abs(finalX - snapColumn.x) < SNAP_THRESHOLD) {
        finalX = snapColumn.x;
        dispatch(setCardSize({ sessionId: session.session_id, width: snapColumn.width, height: cardHeight }));
      }
      dispatch(setCardPosition({ sessionId: session.session_id, x: finalX, y: finalY }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null; didDrag.current = false; setLocalDragPos(null); setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [zoom, dispatch, session.session_id, onDragEnd, snapColumn, cardHeight]);
  const resizeRef = useRef<{ dir: ResizeDir; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const handleResizeDown = useCallback((dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const effectiveW = Math.max(cardWidth, MIN_W), effectiveH = expanded ? Math.max(EXPANDED_OVERLAY_H, cardHeight) : cardHeight;
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY, origW: effectiveW, origH: effectiveH };
    setIsResizing(true); (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, cardWidth, cardHeight, expanded]);
  const computeResize = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return null;
    const { dir, startX, startY, origX, origY, origW, origH } = resizeRef.current;
    const dx = (e.clientX - startX) / zoom, dy = (e.clientY - startY) / zoom;
    let newX = origX, newY = origY, newW = origW, newH = origH;
    if (dir.includes('e')) newW = origW + dx;
    if (dir.includes('w')) { newW = origW - dx; newX = origX + dx; }
    if (dir.includes('s')) newH = origH + dy;
    if (dir.includes('n')) { newH = origH - dy; newY = origY + dy; }
    if (newW < MIN_W) { if (dir.includes('w')) newX = origX + origW - MIN_W; newW = MIN_W; }
    if (newH < MIN_H) { if (dir.includes('n')) newY = origY + origH - MIN_H; newH = MIN_H; }
    return { x: newX, y: newY, w: newW, h: newH };
  }, [zoom]);
  const handleResizeMove = useCallback((e: React.PointerEvent) => { const r = computeResize(e); if (r) setLocalResize(r); }, [computeResize]);
  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = computeResize(e);
    if (r) { dispatch(setCardPosition({ sessionId: session.session_id, x: r.x, y: r.y })); dispatch(setCardSize({ sessionId: session.session_id, width: r.w, height: r.h })); }
    resizeRef.current = null; setLocalResize(null); setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, session.session_id]);
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    dispatch(collapseSession(session.session_id)); dispatch(removeCard(session.session_id));
    if (glowEntry) setTimeout(() => dispatch(clearGlowingAgentCard(session.session_id)), 500);
    else dispatch(CLOSE_SESSION(session.session_id));
  };
  useEffect(() => {
    if (session.status === 'running' || session.status === 'waiting_approval') {
      const interval = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(interval);
    }
  }, [session.status]);
  const { content: previewContent, isStreaming } = getPreviewContent(session);
  const hasPending = session.pending_approvals.length > 0;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);
  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const activeX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const activeY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const activeW = localResize?.w ?? cardWidth, activeH = localResize?.h ?? cardHeight;
  const isBranchSpawn = spawnFrom?.type === 'branch';
  const spawnInitial = spawnFrom
    ? isBranchSpawn ? { opacity: 0.5, scale: 0.92, left: spawnFrom.x, top: spawnFrom.y } : { opacity: 0, scale: 0.3, left: spawnFrom.x, top: spawnFrom.y }
    : false;
  const spawnTransition = noTransition || !spawnFrom ? { duration: 0 }
    : isBranchSpawn ? { left: BRANCH_SPRING, top: BRANCH_SPRING, scale: BRANCH_SPRING, opacity: { duration: 0.25 } }
    : { left: SPAWN_SPRING, top: SPAWN_SPRING, scale: SPAWN_SPRING, opacity: { duration: 0.12 } };
  const exitAnimation = exitTarget
    ? { opacity: 0, scale: 0.3, left: exitTarget.x, top: exitTarget.y, transition: { left: EXIT_SPRING, top: EXIT_SPRING, scale: EXIT_SPRING, opacity: { duration: 0.2 } } }
    : { opacity: 0, scale: 0.85, transition: { duration: 0.2 } };

  if (isFocused) {
    return (
      <Box ref={cardBoxRef} sx={{ width: '100%', height: '100%', bgcolor: c.bg.surface, border: `1px solid ${c.border.strong}`, borderRadius: 3, p: 2, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}>
        <Box onDoubleClick={(e) => { e.stopPropagation(); onFocusExit?.(); }} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexShrink: 0, cursor: 'default' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name || 'Agent'}</Typography>
            <Chip label={session.status} size="small" sx={{ fontSize: '0.7rem', height: 20, bgcolor: session.status === 'running' ? c.status.info : session.status === 'completed' ? c.status.success : c.bg.elevated, color: c.text.secondary }} />
            <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>{session.model} · {formatDuration(session.created_at, undefined, session.status)}</Typography>
          </Box>
          <IconButton size="small" onClick={() => onFocusExit?.()} sx={{ color: c.text.ghost }}><CloseIcon sx={{ fontSize: 18 }} /></IconButton>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><AgentChat sessionId={session.session_id} autoFocus={true} embedded={true} /></Box>
      </Box>
    );
  }

  return (
    <motion.div layout={false} initial={spawnInitial} animate={{ opacity: 1, scale: 1, left: activeX, top: activeY }} exit={exitAnimation} transition={spawnTransition} onPointerDownCapture={() => onBringToFront?.(session.session_id, 'agent')} style={{ position: 'absolute', zIndex: isDragging || isResizing ? 999999 : cardZOrder }}>
    <Box ref={cardBoxRef} data-select-type="agent-card" data-select-id={session.session_id} data-select-meta={JSON.stringify({ name: session.name || session.session_id, status: session.status, model: session.model, mode: session.mode })}
      onClick={(e: React.MouseEvent) => { if (justDraggedRef.current) return; if (!isSelected && !e.shiftKey) dispatch(toggleExpandSession(session.session_id)); onCardSelect?.(session.session_id, 'agent', e.shiftKey); }}
      sx={{
        position: 'relative', width: localResize ? activeW : Math.max(cardWidth, MIN_W), height: localResize ? activeH : (expanded ? Math.max(EXPANDED_OVERLAY_H, cardHeight) : 'auto'),
        bgcolor: c.bg.surface,
        border: isHighlighted ? `2px solid ${c.accent.primary}` : (isGlowingRedux && !glowFading) ? `2px solid ${accentColor}` : isSelected ? '2px solid #3b82f6' : hasPending && !expanded ? `1px solid ${c.status.warning}` : expanded ? `1px solid ${c.border.strong}` : `1px solid ${c.border.subtle}`,
        borderRadius: 3, p: 2, cursor: expanded ? 'default' : 'pointer',
        transition: noTransition ? 'none' : glowFading ? `border ${GLOW_FADE_MS}ms ease-out, box-shadow ${GLOW_FADE_MS}ms ease-out` : c.transition,
        boxShadow: isHighlighted ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15` : (isGlowingRedux && !glowFading) ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15` : isDragging ? c.shadow.lg : isSelected ? `0 0 0 1px #3b82f6, ${c.shadow.md}` : expanded ? c.shadow.md : c.shadow.sm,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        ...(isHighlighted && { animation: 'card-highlight-pulse 2s ease-out forwards', '@keyframes card-highlight-pulse': { '0%': { boxShadow: `0 0 0 3px ${c.accent.primary}70, 0 0 24px ${c.accent.primary}50, 0 0 48px ${c.accent.primary}25` }, '25%': { boxShadow: `0 0 0 4px ${c.accent.primary}55, 0 0 30px ${c.accent.primary}40, 0 0 56px ${c.accent.primary}20` }, '50%': { boxShadow: `0 0 0 3px ${c.accent.primary}45, 0 0 22px ${c.accent.primary}30, 0 0 44px ${c.accent.primary}15` }, '75%': { boxShadow: `0 0 0 2px ${c.accent.primary}25, 0 0 14px ${c.accent.primary}18, 0 0 28px ${c.accent.primary}08` }, '100%': { boxShadow: c.shadow.sm } } }),
        ...(!isHighlighted && isGlowingRedux && !glowFading && { animation: 'agent-card-glow-pulse 2s ease-in-out infinite', '@keyframes agent-card-glow-pulse': { '0%, 100%': { boxShadow: `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15` }, '50%': { boxShadow: `0 0 0 3px ${accentColor}60, 0 0 28px ${accentColor}45, 0 0 56px ${accentColor}25` } } }),
        ...(!isHighlighted && !(isGlowingRedux && !glowFading) && !expanded && !isDragging && !isSelected && { '&:hover': { boxShadow: c.shadow.md, borderColor: hasPending ? c.status.warning : c.border.strong } }),
      }}>
      {isGlowingRedux && <CardGlowOverlay accentColor={accentColor} accentHover={accentHover} glowFading={glowFading} glowFadeMs={GLOW_FADE_MS} />}
      {!isFocused && HANDLE_DEFS.map(({ dir, sx }) => (
        <Box key={dir} onPointerDown={handleResizeDown(dir)} onPointerMove={handleResizeMove} onPointerUp={handleResizeUp} onClick={(e) => e.stopPropagation()} sx={{ position: 'absolute', ...sx, cursor: CURSOR_MAP[dir], zIndex: 20, userSelect: 'none', touchAction: 'none' }} />
      ))}
      {isSelected && (
        <Box ref={scrollOverlayRef} onPointerDown={handleDragPointerDown} onPointerMove={handleDragPointerMove} onPointerUp={handleDragPointerUp}
          onClick={(e: React.MouseEvent) => { if (justDraggedRef.current) return; onCardSelect?.(session.session_id, 'agent', e.shiftKey); }}
          sx={{ position: 'absolute', inset: 0, zIndex: 15, cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }} />
      )}
      <Box onPointerDown={handleDragPointerDown} onPointerMove={handleDragPointerMove} onPointerUp={handleDragPointerUp} onDoubleClick={(e) => { e.stopPropagation(); onFocusRequest?.(session.session_id); }} sx={{ position: 'relative', zIndex: 16, mx: -2, mt: -2, px: 2, pt: 2, pb: 1.5, cursor: isFocused ? 'default' : isDragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none', flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexShrink: 0 }}>
          <Box className="drag-handle" sx={{ display: 'flex', alignItems: 'center', mr: 0.5, color: c.text.ghost }}><DragIndicatorIcon sx={{ fontSize: 16 }} /></Box>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1, borderRadius: 1 }}>
            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name}</Typography>
            <Chip label={session.status.replace('_', ' ')} size="small" sx={{ bgcolor: statusStyle.bg, color: statusStyle.color, fontWeight: 600, fontSize: '0.7rem', height: 22, flexShrink: 0 }} />
          </Box>
          <Box onPointerDown={(e) => e.stopPropagation()} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0, ml: 0.5 }}>
            <Tooltip title={isDraft ? 'Remove' : 'Close chat'}><IconButton size="small" onClick={handleRemove} onMouseDown={(e) => e.stopPropagation()} sx={{ color: c.text.ghost, p: 0.5, '&:hover': { color: c.status.error, bgcolor: `${c.status.errorBg}` } }}><CloseIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
          </Box>
        </Box>
        <Box sx={{ display: isDraft && !expanded ? 'none' : 'flex', gap: 1.5, flexShrink: 0, ...(isDraft && { visibility: 'hidden' }) }}>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>{session.model}</Typography>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>{session.mode}</Typography>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>{formatDuration(session.created_at, (session as any).closed_at, session.status)}</Typography>
          {session.cost_usd > 0 && hasApiKey && <Typography variant="caption" sx={{ color: c.accent.primary }}>${session.cost_usd.toFixed(4)}</Typography>}
        </Box>
      </Box>
      {expanded && (
        <Box onClick={(e) => e.stopPropagation()} sx={{ mx: -2, mb: -2, flex: 1, minHeight: 0, borderTop: `1px solid ${c.border.subtle}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <AgentChat key={session.session_id} sessionId={session.session_id} onClose={() => dispatch(collapseSession(session.session_id))} embedded autoFocus={autoFocusInput} isGlowing={isGlowingRedux && !glowFading} onDismissGlow={dismissGlow} onBranch={onBranch ? (newId: string) => onBranch(session.session_id, newId) : undefined} />
        </Box>
      )}
      {!expanded && <AgentCardCollapsed session={session} previewContent={previewContent} isStreaming={isStreaming} hasPending={hasPending} statusStyle={statusStyle} c={c} />}
    </Box>
    </motion.div>
  );
};

export default React.memo(AgentCard);
