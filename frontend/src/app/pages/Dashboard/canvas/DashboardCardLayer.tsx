import React, { type RefObject } from 'react';
import { AnimatePresence } from 'framer-motion';
import MarqueeRect from './MarqueeRect';
import AgentCard from '../cards/AgentCard';
import DashboardViewCard from '../cards/DashboardViewCard';
import BrowserCard from '../cards/BrowserCard';
import DashboardWindowCards from './DashboardWindowCards';
import {
  EXPANDED_CARD_MIN_H,
  renderedAgentCardHeight,
  DEFAULT_CARD_W,
  GRID_GAP,
  type CardPosition,
  type ViewCardPosition,
  type BrowserCardPosition,
  type WorkflowCardPosition,
  type WorkflowsHubPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';
import type { CardType, useDashboardSelection } from '../hooks/state/useDashboardSelection';

type Selection = ReturnType<typeof useDashboardSelection>;
type SpawnOrigin = { x: number; y: number; type?: 'branch' };
type GlowingAgentCard = { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string };
type Direction = 'left' | 'right' | 'up' | 'down';

interface DashboardCardLayerProps {
  dashboardId: string;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  keepAliveBrowserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  outputs: Record<string, Output>;
  glowingAgentCards: Record<string, GlowingAgentCard>;
  expandedSessionIds: string[];
  cmdHeld: boolean;
  selection: Selection;
  highlightedCardId: string | null;
  autoFocusSessionId: string | null;
  focusedCardId: string | null;
  multiDragActive: boolean;
  shakeDirection: Direction | null;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  revealSpawnedRef: RefObject<Set<string>>;
  measuredHeightsRef: RefObject<Record<string, number>>;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  onCardSelect: (id: string, type: CardType, shiftKey: boolean, originTarget?: EventTarget | null) => void;
  onDragStart: (id: string, type: CardType) => void;
  onDragMove: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd: (dx: number, dy: number, didDrag: boolean) => void;
  onDoubleClick: (id: string, type: CardType) => void;
  onBringToFront: (id: string, type: CardType) => void;
  onBranch: (sourceSessionId: string, newSessionId: string) => void;
  onMeasuredHeight: (sessionId: string, height: number) => void;
}

const DashboardCardLayer: React.FC<DashboardCardLayerProps> = ({
  dashboardId,
  cards,
  viewCards,
  browserCards,
  keepAliveBrowserCards,
  workflowCards,
  workflowsHub,
  outputs,
  glowingAgentCards,
  expandedSessionIds,
  cmdHeld,
  selection,
  highlightedCardId,
  autoFocusSessionId,
  focusedCardId,
  multiDragActive,
  shakeDirection,
  spawnOriginsRef,
  revealSpawnedRef,
  measuredHeightsRef,
  getCanvasState,
  onCardSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDoubleClick,
  onBringToFront,
  onBranch,
  onMeasuredHeight,
}) => {
  return (
    <>
      <AnimatePresence>
      {Object.values(cards).map((card) => {
        const sid = card.session_id;

        let origin = spawnOriginsRef.current![sid];
        if (origin) {
          delete spawnOriginsRef.current![sid];
        } else {
          const glow = glowingAgentCards[sid];
          if (glow && !revealSpawnedRef.current!.has(sid)) {
            revealSpawnedRef.current!.add(sid);
            const srcCard = cards[glow.sourceId];
            if (srcCard) {
              const srcH = measuredHeightsRef.current![glow.sourceId]
                ?? renderedAgentCardHeight(srcCard.height, expandedSessionIds.includes(glow.sourceId));
              origin = {
                x: srcCard.x + srcCard.width,
                y: srcCard.y + srcH / 2,
                type: 'branch' as const,
              };
            }
          }
        }

        let exitTarget: { x: number; y: number } | undefined;
        const glow = glowingAgentCards[sid];
        if (glow) {
          const srcCard = cards[glow.sourceId];
          if (srcCard) {
            const srcH = measuredHeightsRef.current![glow.sourceId]
              ?? renderedAgentCardHeight(srcCard.height, expandedSessionIds.includes(glow.sourceId));
            exitTarget = {
              x: srcCard.x + srcCard.width,
              y: srcCard.y + srcH / 2,
            };
          }
        }

        let snapColumn: { x: number; width: number } | undefined;
        if (glow) {
          const srcCard = cards[glow.sourceId];
          if (srcCard) {
            snapColumn = {
              x: srcCard.x + srcCard.width + GRID_GAP * 12,
              width: DEFAULT_CARD_W,
            };
          }
        }

        const isSel = selection.isSelected(sid);
        return (
          <AgentCard
            key={sid}
            sessionId={sid}
            expanded={expandedSessionIds.includes(sid)}
            getCanvasState={getCanvasState}
            spawnFrom={origin}
            exitTarget={exitTarget}
            isSelected={isSel}
            isHighlighted={highlightedCardId === sid}
            // Only selected cards need the live drag delta; passing it to everyone broke memo equality for unselected cards on every mouse-move during multi-drag.
            multiDragActive={isSel && multiDragActive}
            onCardSelect={onCardSelect}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onBranch={onBranch}
            onMeasuredHeight={onMeasuredHeight}
            snapColumn={snapColumn}
            autoFocusInput={autoFocusSessionId === sid}
            onDoubleClick={onDoubleClick}
            onBringToFront={onBringToFront}
            shakeDirection={focusedCardId === sid ? shakeDirection : null}
          />
        );
      })}
      </AnimatePresence>
      {Object.entries(viewCards).map(([cardKey, vc]) => {
        const output = outputs[vc.output_id];
        if (!output) return null;
        return (
          <DashboardViewCard
            key={`view-${cardKey}`}
            cardKey={cardKey}
            instance={vc.instance ?? 1}
            output={output}
            cardX={vc.x}
            cardY={vc.y}
            cardWidth={vc.width}
            cardHeight={vc.height}
            cardZOrder={vc.zOrder ?? 0}
            getCanvasState={getCanvasState}
            cmdHeld={cmdHeld}
            isSelected={selection.isSelected(cardKey)}
            isHighlighted={highlightedCardId === cardKey}
            multiDragActive={multiDragActive}
            onCardSelect={onCardSelect}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onDoubleClick={onDoubleClick}
            onBringToFront={onBringToFront}
          />
        );
      })}
      {/* One map over active + keep-alive cards: a card switching from active to hidden keeps its key + tree slot, so React never remounts it (a remount = new webview = lost session). Cross-dashboard ones render keepAliveHidden. */}
      {Object.values({ ...browserCards, ...keepAliveBrowserCards }).map((bc) => (
        <BrowserCard
          key={`browser-${bc.browser_id}`}
          keepAliveHidden={!!bc.dashboard_id && bc.dashboard_id !== dashboardId}
          browserId={bc.browser_id}
          tabs={bc.tabs}
          activeTabId={bc.activeTabId}
          cardX={bc.x}
          cardY={bc.y}
          cardWidth={bc.width}
          cardHeight={bc.height}
          cardZOrder={bc.zOrder ?? 0}
          getCanvasState={getCanvasState}
          cmdHeld={cmdHeld}
          isSelected={selection.isSelected(bc.browser_id)}
          isHighlighted={highlightedCardId === bc.browser_id}
          multiDragActive={selection.isSelected(bc.browser_id) && multiDragActive}
          onCardSelect={onCardSelect}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDoubleClick={onDoubleClick}
          onBringToFront={onBringToFront}
        />
      ))}
      <DashboardWindowCards
        workflowsHub={workflowsHub}
        selection={selection}
        highlightedCardId={highlightedCardId}
        multiDragActive={multiDragActive}
        getCanvasState={getCanvasState}
        onCardSelect={onCardSelect}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onBringToFront={onBringToFront}
      />
      {/* Marquee selection rectangle: mounted once per sweep, moved imperatively off the channel */}
      {selection.marquee && <MarqueeRect initial={selection.marquee} />}
    </>
  );
};

export default React.memo(DashboardCardLayer);
