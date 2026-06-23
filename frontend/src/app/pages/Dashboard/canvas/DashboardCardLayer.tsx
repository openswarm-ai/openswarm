import React, { type RefObject } from 'react';
import { AnimatePresence } from 'framer-motion';
import AgentCard from '../cards/AgentCard';
import DashboardViewCard from '../cards/DashboardViewCard';
import BrowserCard from '../cards/BrowserCard';
import NoteCard from '../cards/NoteCard';
import WorkflowsAppCard from '@/app/pages/Workflows/app/WorkflowsAppCard';
import RunMonitor from '@/app/pages/Workflows/app/RunMonitor';
import {
  EXPANDED_CARD_MIN_H,
  DEFAULT_CARD_W,
  GRID_GAP,
  type CardPosition,
  type ViewCardPosition,
  type BrowserCardPosition,
  type NotePosition,
  type WorkflowCardPosition,
  type WorkflowsHubPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { closeWorkflowMonitor } from '@/shared/state/dashboardLayoutSlice';
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
  notes: Record<string, NotePosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  outputs: Record<string, Output>;
  glowingAgentCards: Record<string, GlowingAgentCard>;
  expandedSessionIds: string[];
  zoom: number;
  panX: number;
  panY: number;
  cmdHeld: boolean;
  selection: Selection;
  highlightedCardId: string | null;
  autoFocusSessionId: string | null;
  focusedCardId: string | null;
  pendingFocusNoteId: string | null;
  multiDragDelta: { dx: number; dy: number } | null;
  shakeDirection: Direction | null;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  revealSpawnedRef: RefObject<Set<string>>;
  measuredHeightsRef: RefObject<Record<string, number>>;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  onCardSelect: (id: string, type: CardType, shiftKey: boolean) => void;
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
  notes,
  workflowCards,
  workflowsHub,
  outputs,
  glowingAgentCards,
  expandedSessionIds,
  zoom,
  panX,
  panY,
  cmdHeld,
  selection,
  highlightedCardId,
  autoFocusSessionId,
  focusedCardId,
  pendingFocusNoteId,
  multiDragDelta,
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
  const dispatch = useAppDispatch();
  const monitorCard = useAppSelector((s) => s.dashboardLayout.workflowsMonitorCard);
  const monitorWorkflowId = useAppSelector((s) => s.dashboardLayout.workflowsMonitorId);
  const monitorWorkflow = useAppSelector((s) => (monitorWorkflowId ? s.workflows.items[monitorWorkflowId] : undefined));
  // The monitor's workflow vanished (trashed/deleted) while open: tear the card
  // + its tether down instead of leaving an orange line pointing at nothing.
  React.useEffect(() => {
    if (monitorCard && !monitorWorkflow) dispatch(closeWorkflowMonitor());
  }, [monitorCard, monitorWorkflow, dispatch]);
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
                ?? (expandedSessionIds.includes(glow.sourceId)
                  ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height)
                  : srcCard.height);
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
              ?? (expandedSessionIds.includes(glow.sourceId)
                ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height)
                : srcCard.height);
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
            // Only selected cards need the live drag delta; passing
            // it to everyone broke memo equality for unselected
            // cards on every mouse-move during multi-drag.
            multiDragDelta={isSel ? multiDragDelta : null}
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
      {Object.values(viewCards).map((vc) => {
        const output = outputs[vc.output_id];
        if (!output) return null;
        return (
          <DashboardViewCard
            key={`view-${vc.output_id}`}
            output={output}
            cardX={vc.x}
            cardY={vc.y}
            cardWidth={vc.width}
            cardHeight={vc.height}
            cardZOrder={vc.zOrder ?? 0}
            zoom={zoom}
            panX={panX}
            panY={panY}
            cmdHeld={cmdHeld}
            isSelected={selection.isSelected(vc.output_id)}
            isHighlighted={highlightedCardId === vc.output_id}
            multiDragDelta={multiDragDelta}
            onCardSelect={onCardSelect}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onDoubleClick={onDoubleClick}
            onBringToFront={onBringToFront}
          />
        );
      })}
      {Object.values(browserCards).map((bc) => (
        <BrowserCard
          key={`browser-${bc.browser_id}`}
          browserId={bc.browser_id}
          tabs={bc.tabs}
          activeTabId={bc.activeTabId}
          cardX={bc.x}
          cardY={bc.y}
          cardWidth={bc.width}
          cardHeight={bc.height}
          cardZOrder={bc.zOrder ?? 0}
          zoom={zoom}
          panX={panX}
          panY={panY}
          cmdHeld={cmdHeld}
          isSelected={selection.isSelected(bc.browser_id)}
          isHighlighted={highlightedCardId === bc.browser_id}
          multiDragDelta={multiDragDelta}
          onCardSelect={onCardSelect}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDoubleClick={onDoubleClick}
          onBringToFront={onBringToFront}
        />
      ))}
      {Object.values(notes).map((n) => (
        <NoteCard
          key={`note-${n.note_id}`}
          noteId={n.note_id}
          cardX={n.x}
          cardY={n.y}
          cardWidth={n.width}
          cardHeight={n.height}
          cardZOrder={n.zOrder ?? 0}
          zoom={zoom}
          panX={panX}
          panY={panY}
          cmdHeld={cmdHeld}
          content={n.content}
          color={n.color}
          isSelected={selection.isSelected(n.note_id)}
          isHighlighted={highlightedCardId === n.note_id}
          multiDragDelta={multiDragDelta}
          autoFocus={pendingFocusNoteId === n.note_id}
          onCardSelect={onCardSelect}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onBringToFront={onBringToFront}
        />
      ))}
      {workflowsHub && (
        <WorkflowsAppCard
          cardX={workflowsHub.x}
          cardY={workflowsHub.y}
          cardWidth={workflowsHub.width}
          cardHeight={workflowsHub.height}
          cardZOrder={workflowsHub.zOrder ?? 0}
          zoom={zoom}
          panX={panX}
          panY={panY}
          isSelected={selection.isSelected('workflows-hub')}
          isHighlighted={highlightedCardId === 'workflows-hub'}
          multiDragDelta={selection.isSelected('workflows-hub') ? multiDragDelta : null}
          onCardSelect={onCardSelect}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onBringToFront={onBringToFront}
        />
      )}
      {monitorCard && monitorWorkflow && (
        <RunMonitor
          workflow={monitorWorkflow}
          cardX={monitorCard.x}
          cardY={monitorCard.y}
          cardWidth={monitorCard.width}
          cardHeight={monitorCard.height}
          cardZOrder={monitorCard.zOrder ?? 0}
          zoom={zoom}
          panX={panX}
          panY={panY}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        />
      )}
      {/* Marquee selection rectangle */}
      {selection.marquee && (
        <div
          style={{
            position: 'absolute',
            left: selection.marquee.x,
            top: selection.marquee.y,
            width: selection.marquee.width,
            height: selection.marquee.height,
            border: '1.5px dashed rgba(59, 130, 246, 0.6)',
            background: 'rgba(59, 130, 246, 0.08)',
            borderRadius: 2,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        />
      )}
    </>
  );
};

export default DashboardCardLayer;
