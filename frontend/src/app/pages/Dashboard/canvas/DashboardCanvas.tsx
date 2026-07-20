import React, { useEffect, type RefObject } from 'react';
import Box from '@mui/material/Box';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearTiledCard, selectFullscreenCardId } from '@/shared/state/dashboardLayoutSlice';
import DashboardHeader from './DashboardHeader';
import TetherLayer from './TetherLayer';
import DashboardCardLayer from './DashboardCardLayer';
import DashboardOverlays from './DashboardOverlays';
import DashboardEmptyState from './DashboardEmptyState';
import DesktopWallpaper from '../desktop/DesktopWallpaper';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useThemeAccent, useThemeWash } from '@/shared/styles/ThemeContext';
import { GRAIN_URL } from '@/shared/styles/grainTexture';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
  NotePosition,
  WorkflowCardPosition,
  WorkflowsHubPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';
import type { CardType, useDashboardSelection } from '../hooks/state/useDashboardSelection';
import type { useCanvasControls } from '../hooks/interaction/useCanvasControls';
import { useWebviewSuspend } from '../hooks/interaction/useWebviewSuspend';
import type { Tether } from '../geometry/dashboardTethers';

type Selection = ReturnType<typeof useDashboardSelection>;
type Canvas = ReturnType<typeof useCanvasControls>;
type SpawnOrigin = { x: number; y: number; type?: 'branch' };
type GlowingAgentCard = { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string };
type Direction = 'left' | 'right' | 'up' | 'down';
type NeighborDirections = { left: boolean; right: boolean; up: boolean; down: boolean };

interface DashboardCanvasProps {
  c: ClaudeTokens;
  dashboardId: string;
  dashboardName?: string;
  canvas: Canvas;
  selection: Selection;
  sessions: Record<string, AgentSession>;
  sessionList: AgentSession[];
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  keepAliveBrowserCards: Record<string, BrowserCardPosition>;
  notes: Record<string, NotePosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  outputs: Record<string, Output>;
  glowingAgentCards: Record<string, GlowingAgentCard>;
  expandedSessionIds: string[];
  tethers: Tether[];
  highlightedCardId: string | null;
  autoFocusSessionId: string | null;
  focusedCardId: string | null;
  pendingFocusNoteId: string | null;
  multiDragDelta: { dx: number; dy: number } | null;
  shakeDirection: Direction | null;
  neighborDirections: NeighborDirections;
  toolbarOpen: boolean;
  searchPaletteOpen: boolean;
  newAgentBounce: boolean;
  toolbarRef: RefObject<HTMLDivElement>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  revealSpawnedRef: RefObject<Set<string>>;
  measuredHeightsRef: RefObject<Record<string, number>>;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  onViewportMouseDown: (e: React.MouseEvent) => void;
  onViewportMouseMove: (e: React.MouseEvent) => void;
  onViewportMouseUp: (e: React.MouseEvent) => void;
  onViewportDoubleClick: (e: React.MouseEvent) => void;
  onCardSelect: (id: string, type: CardType, shiftKey: boolean) => void;
  onDragStart: (id: string, type: CardType) => void;
  onDragMove: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd: (dx: number, dy: number, didDrag: boolean) => void;
  onCardDoubleClick: (id: string, type: CardType) => void;
  onBringToFront: (id: string, type: CardType) => void;
  onBranch: (sourceSessionId: string, newSessionId: string) => void;
  onMeasuredHeight: (sessionId: string, height: number) => void;
  onHighlightCard: (cardId: string) => void;
  onNewAgent: () => void;
  onToolbarCancel: () => void;
  onToolbarSend: (...args: any[]) => void;
  onStarter: (prompt: string, mode?: string) => void;
  toolbarPrefill?: string;
  toolbarPrefillMode?: string;
  onAddView: (outputId: string, opts?: { newInstance?: boolean }) => void;
  onHistoryResume: (sessionId: string) => void;
  onAddBrowser: () => void;
  onAddNote: () => void;
  onNewAgentBounceEnd: () => void;
  onFitToView: () => void;
  onTidy: () => void;
  onSearchPaletteClose: () => void;
}

const DashboardCanvas: React.FC<DashboardCanvasProps> = ({
  c,
  dashboardId,
  dashboardName,
  canvas,
  selection,
  sessions,
  sessionList,
  cards,
  viewCards,
  browserCards,
  keepAliveBrowserCards,
  notes,
  workflowCards,
  workflowsHub,
  outputs,
  glowingAgentCards,
  expandedSessionIds,
  tethers,
  highlightedCardId,
  autoFocusSessionId,
  focusedCardId,
  pendingFocusNoteId,
  multiDragDelta,
  shakeDirection,
  neighborDirections,
  toolbarOpen,
  searchPaletteOpen,
  newAgentBounce,
  toolbarRef,
  spawnOriginsRef,
  revealSpawnedRef,
  measuredHeightsRef,
  getCanvasState,
  onViewportMouseDown,
  onViewportMouseMove,
  onViewportMouseUp,
  onViewportDoubleClick,
  onCardSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onCardDoubleClick,
  onBringToFront,
  onBranch,
  onMeasuredHeight,
  onHighlightCard,
  onNewAgent,
  onToolbarCancel,
  onToolbarSend,
  onStarter,
  toolbarPrefill,
  toolbarPrefillMode,
  onAddView,
  onHistoryResume,
  onAddBrowser,
  onAddNote,
  onNewAgentBounceEnd,
  onFitToView,
  onTidy,
  onSearchPaletteClose,
}) => {
  const { gradient } = useThemeAccent();
  const { washOpacity, grain } = useThemeWash();
  const dotSize = Math.max(1, 1.5 * canvas.zoom);
  const dotSpacing = 24 * canvas.zoom;

  useWebviewSuspend(browserCards, canvas.panX, canvas.panY, canvas.zoom, canvas.viewportRef);

  // macOS full screen: one card owns the whole window, every piece of chrome steps aside; Esc exits.
  const dispatch = useAppDispatch();
  const fullscreenCardId = useAppSelector(selectFullscreenCardId);
  useEffect(() => {
    if (!fullscreenCardId) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dispatch(clearTiledCard(fullscreenCardId));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreenCardId, dispatch]);

  return (
    <>
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {/* Floating header overlay */}
      <Box
        sx={{
          display: fullscreenCardId ? 'none' : undefined,
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          pointerEvents: 'none',
          // p: 3 (24px) was leaving a chunky air gap between the sidebar edge and the dashboard header that read as "two disconnected panels" rather than one continuous surface. 0.75 (6px) tightens the inset so the header floats just inside the content area without losing its breathing room from the top-most pixel.
          p: 0.75,
          pb: 0,
          // No scrim: the header carries its own translucent pill (DashboardHeader), so a full-width
          // page->transparent fade here just read as a light-leak band over the themed canvas.
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
          <DashboardHeader
            dashboardName={dashboardName}
            sessions={sessions}
            cards={cards}
            viewCards={viewCards}
            browserCards={browserCards}
            workflowCards={workflowCards}
            workflowsHub={workflowsHub}
            notes={notes}
            expandedSessionIds={expandedSessionIds}
            outputs={outputs}
            dashboardId={dashboardId}
            canvasActions={canvas.actions}
            onHighlightCard={onHighlightCard}
          />
        </Box>
      </Box>

      {/* Canvas viewport */}
      <Box
        ref={canvas.viewportRef}
        data-canvas-viewport
        onMouseDown={onViewportMouseDown}
        onMouseMove={onViewportMouseMove}
        onMouseUp={onViewportMouseUp}
        onDoubleClick={onViewportDoubleClick}
        sx={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor: canvas.isPanning
            ? 'grabbing'
            : (canvas.spaceHeld || canvas.cmdHeld)
              ? 'grab'
              : selection.marquee
                ? 'crosshair'
                : 'default',
        }}
      >
        <DesktopWallpaper />

        {/* Gradient wash: the user's theme-pad stops tint the canvas, Arc-window style; intensity + grain come from the theme device; sits under the dot grid. */}
        {gradient && gradient.length > 1 && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background: `linear-gradient(115deg, ${gradient.map((hex, i) => `${hex}${Math.round(washOpacity * 255).toString(16).padStart(2, '0')} ${(i / (gradient.length - 1)) * 100}%`).join(', ')})`,
            }}
          />
        )}
        {grain > 0 && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              opacity: grain,
              backgroundImage: GRAIN_URL,
            }}
          />
        )}

        {/* Dot grid background */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `radial-gradient(circle, ${c.border.medium} ${dotSize}px, transparent ${dotSize}px)`,
            backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
            backgroundPosition: `${canvas.panX % dotSpacing}px ${canvas.panY % dotSpacing}px`,
          }}
        />

        {/* Card layer always mounts, even on an empty dashboard, so keep-alive browser cards from other dashboards stay alive; the empty-state overlays it below. */}
        {(
          <div
            ref={canvas.contentRef}
            style={{
              transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
              position: 'relative',
            }}
          >
            {/* Tether lines between branched cards */}
            <TetherLayer tethers={tethers} c={c} />
            <DashboardCardLayer
              dashboardId={dashboardId}
              cards={cards}
              viewCards={viewCards}
              browserCards={browserCards}
              keepAliveBrowserCards={keepAliveBrowserCards}
              notes={notes}
              workflowCards={workflowCards}
              workflowsHub={workflowsHub}
              outputs={outputs}
              glowingAgentCards={glowingAgentCards}
              expandedSessionIds={expandedSessionIds}
              zoom={canvas.zoom}
              panX={canvas.panX}
              panY={canvas.panY}
              cmdHeld={canvas.cmdHeld}
              selection={selection}
              highlightedCardId={highlightedCardId}
              autoFocusSessionId={autoFocusSessionId}
              focusedCardId={focusedCardId}
              pendingFocusNoteId={pendingFocusNoteId}
              multiDragDelta={multiDragDelta}
              shakeDirection={shakeDirection}
              spawnOriginsRef={spawnOriginsRef}
              revealSpawnedRef={revealSpawnedRef}
              measuredHeightsRef={measuredHeightsRef}
              getCanvasState={getCanvasState}
              onCardSelect={onCardSelect}
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
              onDoubleClick={onCardDoubleClick}
              onBringToFront={onBringToFront}
              onBranch={onBranch}
              onMeasuredHeight={onMeasuredHeight}
            />
          </div>
        )}
        {sessionList.length === 0 && Object.keys(viewCards).length === 0 && Object.keys(browserCards).length === 0 && Object.keys(workflowCards).length === 0 && !workflowsHub && !fullscreenCardId && (
          <DashboardEmptyState c={c} onLaunch={onToolbarSend} onStarter={onStarter} />
        )}
      </Box>

      {/* display:contents when visible so the overlays' absolute children keep positioning against the canvas root; display:none (not unmount) so the toolbar composer draft survives fullscreen. */}
      <Box sx={{ display: fullscreenCardId ? 'none' : 'contents' }}>
      <DashboardOverlays
        canvas={canvas}
        dashboardId={dashboardId}
        sessions={sessions}
        cards={cards}
        viewCards={viewCards}
        browserCards={browserCards}
        workflowCards={workflowCards}
        workflowsHub={workflowsHub}
        focusedCardId={focusedCardId}
        shakeDirection={shakeDirection}
        neighborDirections={neighborDirections}
        toolbarOpen={toolbarOpen}
        searchPaletteOpen={searchPaletteOpen}
        newAgentBounce={newAgentBounce}
        toolbarRef={toolbarRef}
        onNewAgent={onNewAgent}
        onToolbarCancel={onToolbarCancel}
        onToolbarSend={onToolbarSend}
        onAddView={onAddView}
        onHistoryResume={onHistoryResume}
        onAddBrowser={onAddBrowser}
        onAddNote={onAddNote}
        onNewAgentBounceEnd={onNewAgentBounceEnd}
        onFitToView={onFitToView}
        onTidy={onTidy}
        onSearchPaletteClose={onSearchPaletteClose}
        toolbarPrefill={toolbarPrefill}
        toolbarPrefillMode={toolbarPrefillMode}
      />
      </Box>
    </Box>
    </>
  );
};

export default DashboardCanvas;
