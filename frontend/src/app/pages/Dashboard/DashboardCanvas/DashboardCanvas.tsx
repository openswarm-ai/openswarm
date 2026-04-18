import React from 'react';
import { AnimatePresence } from 'framer-motion';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AgentCard from './cards/AgentCard/AgentCard';
import AppCard from './cards/AppCard/AppCard';
import BrowserCard from './cards/BrowserCard/BrowserCard';
import CanvasControls from './components/CanvasControls';
import DashboardToolbar from './components/DashboardToolbar/DashboardToolbar';
import DashboardHeader from './components/DashboardHeader/DashboardHeader';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { EXPANDED_CARD_MIN_H, DEFAULT_CARD_W, GRID_GAP } from '@/shared/state/dashboardLayoutSlice';
import { type CardType, type CanvasActions, type TetherInfo } from '@/app/pages/Dashboard/_shared/types';

const TETHER_FADE_MS = 2500;

interface DashboardCanvasProps {
  panX: number; panY: number; zoom: number;
  isPanning: boolean; spaceHeld: boolean; cmdHeld: boolean;
  viewportRef: React.RefObject<HTMLDivElement>; contentRef: React.RefObject<HTMLDivElement>;
  sessions: Record<string, any>; sessionList: any[];
  cards: Record<string, any>; viewCards: Record<string, any>; browserCards: Record<string, any>;
  outputs: Record<string, any>; expandedSessionIds: string[]; glowingAgentCards: Record<string, any>;
  marquee: { x: number; y: number; width: number; height: number } | null;
  isSelected: (id: string) => boolean; multiDragDelta: { dx: number; dy: number } | null;
  handleCardSelect: (id: string, type: CardType, shiftKey: boolean) => void;
  handleCardDragStart: (id: string, type: CardType) => void;
  handleCardDragMove: (dx: number, dy: number) => void;
  handleCardDragEnd: (dx: number, dy: number, didDrag: boolean) => void;
  handleBringToFront: (id: string, type: CardType) => void;
  handleBranchFromCard: (sourceId: string, newId: string) => void;
  handleFocusRequest: (sessionId: string) => void; handleFocusExit: () => void;
  focusedCardId: string | null; highlightedCardId: string | null; autoFocusSessionId: string | null;
  tethers: TetherInfo[]; toolbarRef: React.RefObject<HTMLDivElement>; toolbarOpen: boolean;
  handleNewAgent: () => void; handleToolbarCancel: () => void;
  handleToolbarSend: (...args: any[]) => void; handleAddView: (outputId: string) => void;
  handleHistoryResume: (sessionId: string) => void; handleAddBrowser: () => void; handleTidy: () => void;
  canvasActions: CanvasActions; dashboardId: string | undefined; dashboardName: string | undefined;
  onHighlightCard: (cardId: string) => void; handleMeasuredHeight: (sessionId: string, height: number) => void;
  spawnOriginsRef: React.MutableRefObject<Record<string, { x: number; y: number; type?: 'branch' }>>;
  revealSpawnedRef: React.MutableRefObject<Set<string>>; measuredHeightsRef: React.RefObject<Record<string, number>>;
  handleViewportMouseDown: (e: React.MouseEvent) => void;
  handleViewportMouseMove: (e: React.MouseEvent) => void;
  handleViewportMouseUp: (e: React.MouseEvent) => void;
}

function getAgentCardExtras(
  sessionId: string, cards: Record<string, any>, glowingAgentCards: Record<string, any>,
  expandedSessionIds: string[], measuredHeightsRef: React.RefObject<Record<string, number>>,
  spawnOriginsRef: React.MutableRefObject<Record<string, { x: number; y: number; type?: 'branch' }>>,
  revealSpawnedRef: React.MutableRefObject<Set<string>>,
) {
  let origin = spawnOriginsRef.current[sessionId];
  if (origin) {
    delete spawnOriginsRef.current[sessionId];
  } else {
    const glow = glowingAgentCards[sessionId];
    if (glow && !revealSpawnedRef.current.has(sessionId)) {
      revealSpawnedRef.current.add(sessionId);
      const srcCard = cards[glow.sourceId];
      if (srcCard) {
        const srcH = (measuredHeightsRef.current ?? {})[glow.sourceId]
          ?? (expandedSessionIds.includes(glow.sourceId) ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height) : srcCard.height);
        origin = { x: srcCard.x + srcCard.width, y: srcCard.y + srcH / 2, type: 'branch' as const };
      }
    }
  }
  let exitTarget: { x: number; y: number } | undefined;
  let snapColumn: { x: number; width: number } | undefined;
  const glow = glowingAgentCards[sessionId];
  if (glow) {
    const srcCard = cards[glow.sourceId];
    if (srcCard) {
      const srcH = (measuredHeightsRef.current ?? {})[glow.sourceId]
        ?? (expandedSessionIds.includes(glow.sourceId) ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height) : srcCard.height);
      exitTarget = { x: srcCard.x + srcCard.width, y: srcCard.y + srcH / 2 };
      snapColumn = { x: srcCard.x + srcCard.width + GRID_GAP * 12, width: DEFAULT_CARD_W };
    }
  }
  return { origin, exitTarget, snapColumn };
}

const DashboardCanvas: React.FC<DashboardCanvasProps> = (p) => {
  const c = useClaudeTokens();
  const dotSize = Math.max(1, 1.5 * p.zoom);
  const dotSpacing = 24 * p.zoom;

  return (
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, pointerEvents: 'none',
        p: 3, pb: 0, background: `linear-gradient(to bottom, ${c.bg.page} 60%, transparent)` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
          <DashboardHeader dashboardName={p.dashboardName} sessions={p.sessions} cards={p.cards}
            viewCards={p.viewCards} browserCards={p.browserCards} outputs={p.outputs}
            dashboardId={p.dashboardId} canvasActions={p.canvasActions} onHighlightCard={p.onHighlightCard} />
        </Box>
      </Box>

      <Box ref={p.viewportRef} onMouseDown={p.handleViewportMouseDown} onMouseMove={p.handleViewportMouseMove}
        onMouseUp={p.handleViewportMouseUp} onContextMenu={(e) => e.preventDefault()}
        sx={{ position: 'absolute', inset: 0, overflow: 'hidden',
          cursor: p.isPanning ? 'grabbing' : (p.spaceHeld || p.cmdHeld) ? 'grab' : p.marquee ? 'crosshair' : 'default' }}>
        <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: `radial-gradient(circle, ${c.border.medium} ${dotSize}px, transparent ${dotSize}px)`,
          backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
          backgroundPosition: `${p.panX % dotSpacing}px ${p.panY % dotSpacing}px` }} />

        {p.sessionList.length === 0 && Object.keys(p.viewCards).length === 0 && Object.keys(p.browserCards).length === 0 ? (
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>No agents running</Typography>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.9rem' }}>
              Click &quot;New Agent&quot; to launch your first Claude Code instance</Typography>
          </Box>
        ) : (
          <div ref={p.contentRef} style={{ transform: `translate(${p.panX}px, ${p.panY}px) scale(${p.zoom})`,
            transformOrigin: '0 0', willChange: 'transform', position: 'relative' }}>
            {p.tethers.length > 0 && (
              <svg style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1,
                overflow: 'visible', pointerEvents: 'none', zIndex: 10 }}>
                <defs>
                  <filter id="tether-glow-f" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                  <marker id="tether-arrow" viewBox="0 0 10 10" refX="10" refY="5"
                    markerWidth="10" markerHeight="10" orient="auto">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill={c.accent.primary} opacity={0.8} />
                  </marker>
                </defs>
                <style>{`@keyframes tether-flow { to { stroke-dashoffset: -16; } }
                  @keyframes tether-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }`}</style>
                {p.tethers.map((t) => (
                  <g key={t.key} style={{ opacity: t.fading ? 0 : 1, transition: `opacity ${TETHER_FADE_MS}ms ease-out` }}>
                    <path d={t.path} fill="none" stroke={c.accent.primary} strokeWidth={8}
                      strokeLinecap="round" strokeLinejoin="round" opacity={0.2} filter="url(#tether-glow-f)" />
                    <path d={t.path} fill="none" stroke={c.accent.primary} strokeWidth={2}
                      strokeLinecap="round" strokeLinejoin="round" opacity={0.65} markerEnd="url(#tether-arrow)"
                      style={{ animation: 'tether-pulse 2s ease-in-out infinite' }} />
                    <path d={t.path} fill="none" stroke={c.accent.primary} strokeWidth={1.5}
                      strokeLinecap="round" strokeLinejoin="round" strokeDasharray="8 8" opacity={0.9}
                      style={{ animation: 'tether-flow 0.6s linear infinite' }} />
                    {t.label && (
                      <g transform={`translate(${t.labelX},${t.labelY})`}>
                        <rect x={-4} y={-14} width={t.label.length * 7.5 + 8} height={20} rx={4}
                          fill={c.bg.surface} stroke={c.accent.primary} strokeWidth={1} opacity={0.95} />
                        <text x={t.label.length * 7.5 / 2} y={1} textAnchor="middle" fontSize={11}
                          fontWeight={600} fontFamily="inherit" fill={c.accent.primary}>{t.label}</text>
                      </g>
                    )}
                  </g>
                ))}
              </svg>
            )}
            <AnimatePresence>
            {Object.values(p.cards).map((card: any) => {
              const session = p.sessions[card.session_id];
              if (!session || p.focusedCardId === session.session_id) return null;
              const extras = getAgentCardExtras(session.session_id, p.cards, p.glowingAgentCards,
                p.expandedSessionIds, p.measuredHeightsRef, p.spawnOriginsRef, p.revealSpawnedRef);
              return (
                <AgentCard key={session.session_id} session={session} expanded={p.expandedSessionIds.includes(session.session_id)}
                  cardX={card.x} cardY={card.y} cardWidth={card.width} cardHeight={card.height}
                  cardZOrder={card.z_order ?? 0} zoom={p.zoom} spawnFrom={extras.origin}
                  exitTarget={extras.exitTarget} isSelected={p.isSelected(session.session_id)}
                  isHighlighted={p.highlightedCardId === session.session_id} multiDragDelta={p.multiDragDelta}
                  onCardSelect={p.handleCardSelect} onDragStart={p.handleCardDragStart}
                  onDragMove={p.handleCardDragMove} onDragEnd={p.handleCardDragEnd}
                  onBranch={p.handleBranchFromCard} onMeasuredHeight={p.handleMeasuredHeight}
                  snapColumn={extras.snapColumn} autoFocusInput={p.autoFocusSessionId === session.session_id}
                  onBringToFront={p.handleBringToFront} isFocused={false}
                  onFocusRequest={p.handleFocusRequest} onFocusExit={p.handleFocusExit} />
              );
            })}
            </AnimatePresence>
            {Object.values(p.viewCards).map((vc: any) => {
              const output = p.outputs[vc.output_id];
              if (!output) return null;
              return (
                <AppCard key={`view-${vc.output_id}`} output={output}
                  cardX={vc.x} cardY={vc.y} cardWidth={vc.width} cardHeight={vc.height}
                  cardZOrder={vc.z_order ?? 0} zoom={p.zoom} cmdHeld={p.cmdHeld}
                  isSelected={p.isSelected(vc.output_id)} isHighlighted={p.highlightedCardId === vc.output_id}
                  multiDragDelta={p.multiDragDelta} onCardSelect={p.handleCardSelect}
                  onDragStart={p.handleCardDragStart} onDragMove={p.handleCardDragMove}
                  onDragEnd={p.handleCardDragEnd} onBringToFront={p.handleBringToFront} />
              );
            })}
            {Object.values(p.browserCards).map((bc: any) => (
              <BrowserCard key={`browser-${bc.browser_id}`} browserId={bc.browser_id}
                tabs={bc.tabs} activeTabId={bc.activeTabId}
                cardX={bc.x} cardY={bc.y} cardWidth={bc.width} cardHeight={bc.height}
                cardZOrder={bc.z_order ?? 0} zoom={p.zoom} cmdHeld={p.cmdHeld}
                isSelected={p.isSelected(bc.browser_id)} isHighlighted={p.highlightedCardId === bc.browser_id}
                multiDragDelta={p.multiDragDelta} onCardSelect={p.handleCardSelect}
                onDragStart={p.handleCardDragStart} onDragMove={p.handleCardDragMove}
                onDragEnd={p.handleCardDragEnd} onBringToFront={p.handleBringToFront} />
            ))}
            {p.marquee && (
              <div style={{ position: 'absolute', left: p.marquee.x, top: p.marquee.y,
                width: p.marquee.width, height: p.marquee.height,
                border: '1.5px dashed rgba(59, 130, 246, 0.6)', background: 'rgba(59, 130, 246, 0.08)',
                borderRadius: 2, pointerEvents: 'none', zIndex: 9999 }} />
            )}
          </div>
        )}
      </Box>

      <Box sx={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <DashboardToolbar ref={p.toolbarRef} inputOpen={p.toolbarOpen} onNewAgent={p.handleNewAgent}
          onCancel={p.handleToolbarCancel} onSend={p.handleToolbarSend} onAddView={p.handleAddView}
          onHistoryResume={p.handleHistoryResume} onAddBrowser={p.handleAddBrowser} dashboardId={p.dashboardId} />
      </Box>

      {!p.focusedCardId && (
        <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
          <CanvasControls zoom={p.zoom} actions={p.canvasActions} onTidy={p.handleTidy} />
        </Box>
      )}

      {p.focusedCardId && (() => {
        const focusedCard = p.cards[p.focusedCardId];
        const focusedSession = focusedCard ? p.sessions[focusedCard.session_id] : null;
        if (!focusedSession || !focusedCard) return null;
        return (
          <>
            <Box onClick={p.handleFocusExit} sx={{ position: 'fixed', inset: 0,
              bgcolor: 'rgba(0, 0, 0, 0.5)', zIndex: 1200, cursor: 'pointer' }} />
            <Box sx={{ position: 'fixed', inset: 48, zIndex: 1250 }}>
              <AgentCard session={focusedSession} expanded={true} cardX={0} cardY={0}
                cardWidth={0} cardHeight={0} cardZOrder={100000} zoom={1}
                isSelected={false} isHighlighted={false}
                onCardSelect={() => {}} onMeasuredHeight={() => {}} onBringToFront={() => {}}
                isFocused={true} onFocusRequest={p.handleFocusRequest} onFocusExit={p.handleFocusExit}
                autoFocusInput={true} />
            </Box>
          </>
        );
      })()}
    </Box>
  );
};

export default DashboardCanvas;
