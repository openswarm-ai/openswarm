import React, { useEffect, type RefObject } from 'react';
import Box from '@mui/material/Box';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { addViewCard, addBrowserTab, clearTiledCard, toggleMinimizeCard, selectFullscreenCardId, selectViewportCoveringCardId } from '@/shared/state/dashboardLayoutSlice';
import { store } from '@/shared/state/store';
import { buildDockEntries } from '../desktop/dockEntries';
import DashboardHeader from './DashboardHeader';
import TetherLayerHost from './TetherLayerHost';
import { useLiveMultiDrag } from '../hooks/interaction/useLiveMultiDrag';
import DashboardCardLayer from './DashboardCardLayer';
import DashboardOverlays from './DashboardOverlays';
import { useCanvasContextMenu } from './useCanvasContextMenu';
import DashboardEmptyState from './DashboardEmptyState';
import '../desktop/desktop.css';
import DesktopDock from '../desktop/DesktopDock';
import MinimizedStack from '../desktop/MinimizedStack';
import ApplicationsWindow from '../desktop/ApplicationsWindow';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useThemeAccent, useThemeWash } from '@/shared/styles/ThemeContext';
import { useGrainTile } from '@/shared/styles/useGrainTileUrl';
import { washBackgroundLayers, canvasUnderlayColor, effectiveWashStops } from '@/shared/styles/washBackground';

// How far the dot grid bleeds past the viewport. The phase translate is `pan % dotSpacing`, so it
// can never exceed one tile period; deriving the bleed from that bound keeps the layer as small as
// it can be (a hardcoded 256 made it 3.5x bigger than needed, all of it evictable texture) and a
// future max-zoom bump can't silently uncover an edge.
const GRID_BLEED_PX = 24 * MAX_ZOOM;
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
  WorkflowCardPosition,
  WorkflowsHubPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';
import type { CardType, useDashboardSelection } from '../hooks/state/useDashboardSelection';
import { MAX_ZOOM, type useCanvasControls } from '../hooks/interaction/useCanvasControls';
import { useWebviewSuspend } from '../hooks/interaction/useWebviewSuspend';
import { deleteSelectedCards } from '../hooks/interaction/deleteSelectedCards';
import { getLastInteractedBrowser } from '@/shared/browserFocus';
import type { TetherInputs } from '../geometry/dashboardTethers';

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
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  keepAliveBrowserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  outputs: Record<string, Output>;
  glowingAgentCards: Record<string, GlowingAgentCard>;
  expandedSessionIds: string[];
  tetherInputs: TetherInputs;
  highlightedCardId: string | null;
  autoFocusSessionId: string | null;
  focusedCardId: string | null;
  multiDragActive: boolean;
  shakeDirection: Direction | null;
  neighborDirections: NeighborDirections;
  toolbarOpen: boolean;
  searchPaletteOpen: boolean;
  newAgentBounce: boolean;
  canvasEmpty: boolean;
  toolbarRef: RefObject<HTMLDivElement>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  revealSpawnedRef: RefObject<Set<string>>;
  measuredHeightsRef: RefObject<Record<string, number>>;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  onViewportMouseDown: (e: React.MouseEvent) => void;
  onViewportMouseMove: (e: React.MouseEvent) => void;
  /** Returns true when the release ended a marquee drag rather than a plain click. */
  onViewportMouseUp: (e: React.MouseEvent) => boolean;
  onViewportDoubleClick: (e: React.MouseEvent) => void;
  onCardSelect: (id: string, type: CardType, shiftKey: boolean, originTarget?: EventTarget | null) => void;
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
  cards,
  viewCards,
  browserCards,
  keepAliveBrowserCards,
  workflowCards,
  workflowsHub,
  outputs,
  glowingAgentCards,
  expandedSessionIds,
  tetherInputs,
  highlightedCardId,
  autoFocusSessionId,
  focusedCardId,
  multiDragActive,
  shakeDirection,
  neighborDirections,
  toolbarOpen,
  searchPaletteOpen,
  newAgentBounce,
  canvasEmpty,
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
  onNewAgentBounceEnd,
  onFitToView,
  onTidy,
  onSearchPaletteClose,
}) => {
  useLiveMultiDrag();
  const { accent, gradient } = useThemeAccent();
  const { washOpacity, grain } = useThemeWash();
  // A single picked color stores gradient=null, so fall back to the accent (mirrors BeatShell).
  const washStops = React.useMemo(() => effectiveWashStops(gradient, accent), [gradient, accent]);
  const dotSize = Math.max(1, 1.5 * canvas.zoom);
  const dotSpacing = 24 * canvas.zoom;
  // Memoized: this component re-renders every card-drag frame, and rebuilding these strings (SVG encode + hex blends) per frame is pure waste.
  // Canvas variant: folds the dot grid's mean tone in, so an evicted tile paints what the dotted
  // canvas averaged instead of a lighter dot-less tint (the ENG-340 white blink).
  const grainTile = useGrainTile(grain);
  const grainTileUrl = grainTile?.url ?? null;
  const washUnderlay = React.useMemo(
    () => canvasUnderlayColor(washStops, washOpacity, c.bg.page, c.border.medium, dotSize, dotSpacing,
      grainTile ? { meanHex: grainTile.meanHex, meanAlpha: grainTile.meanAlpha } : null),
    [washStops, washOpacity, c.bg.page, c.border.medium, dotSize, dotSpacing, grainTile]);
  const washLayers = React.useMemo(() => washBackgroundLayers(washStops, washOpacity, c.bg.page, grainTileUrl), [washStops, washOpacity, c.bg.page, grainTileUrl]);
  const gridTileUrl = React.useMemo(() => `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${dotSpacing}' height='${dotSpacing}'><circle cx='${dotSpacing / 2}' cy='${dotSpacing / 2}' r='${dotSize}' fill='${c.border.medium}'/></svg>`,
  )}")`, [dotSpacing, dotSize, c.border.medium]);

  useWebviewSuspend(browserCards, canvas.panX, canvas.panY, canvas.zoom, canvas.viewportRef);

  // macOS full screen: one card owns the whole window, every piece of chrome steps aside; Esc exits.
  const dispatch = useAppDispatch();
  const fullscreenCardId = useAppSelector(selectFullscreenCardId);
  // Chrome hides because a card OWNS THE SCREEN, which `fill` does just as much as `fullscreen`.
  const coveringCardId = !!useAppSelector(selectViewportCoveringCardId);
  // Exiting holds the chrome down through the card's shrink animation; flipping it back on the
  // state change painted tidy/zoom on top of a still-nearly-fullscreen card for a few hundred ms.
  const [chromeHeld, setChromeHeld] = React.useState(false);
  // Idempotent on purpose: a ref-transition version stranded the hold forever under StrictMode's
  // double-invoke (cleanup cleared the timeout, the second run saw no transition, chrome never
  // came back). Held while covered, release rescheduled on every rerun, so replays are harmless.
  React.useEffect(() => {
    if (coveringCardId) { setChromeHeld(true); return undefined; }
    if (!chromeHeld) return undefined;
    const t = window.setTimeout(() => setChromeHeld(false), 420);
    return () => window.clearTimeout(t);
  }, [coveringCardId, chromeHeld]);
  const screenOwnedByCard = coveringCardId || chromeHeld;
  const minimizedCards = useAppSelector((s) => s.dashboardLayout.minimizedCards);
  const anyFullscreen = !!fullscreenCardId;
  const [headerRevealed, setHeaderRevealed] = React.useState(false);
  const [appsWindowOpen, setAppsWindowOpen] = React.useState(false);
  const openCanvasMenu = useCanvasContextMenu({
    dispatch, dashboardId, expandedSessionIds, selection, canvasEmpty,
    viewportRef: canvas.viewportRef, getCamera: canvas.actions.getLiveState,
    onNewAgent, onAddBrowser, onApplications: () => setAppsWindowOpen(true), onTidy, onFitToView,
  });
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

  // While the sidebar is docked, its top strip (a window drag region) hides the traffic lights AND
  // eats the hover that would reveal them, so keep them visible the whole time the sidebar is open,
  // like every Mac app with a sidebar. Only the immersive collapsed/fullscreen state hover-reveals.
  const [chromeDocked, setChromeDocked] = React.useState(false);
  useEffect(() => {
    const onDocked = (e: Event): void => setChromeDocked(!!(e as CustomEvent).detail?.docked);
    window.addEventListener('openswarm:chrome-docked', onDocked);
    return () => window.removeEventListener('openswarm:chrome-docked', onDocked);
  }, []);

  // Arc-style chrome: the mac traffic lights ride the top-edge hover, in fullscreen too (Arc/Zen both
  // keep the native buttons reachable in compact/fullscreen; Zen even exempts them from hover-leave).
  useEffect(() => {
    // While a card is fullscreen its OWN lights are the window controls; showing the natives too reads as double chrome.
    window.openswarm?.setWindowButtonsVisible?.(!anyFullscreen && (headerRevealed || chromeDocked));
  }, [headerRevealed, chromeDocked, anyFullscreen]);

  // Reveal on any pointer graze of the top edge. The old 22px strip Box was dead in practice: the
  // hidden header overlay's pointer-events:auto children sat above it and ate the mouseenter.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (e.clientY <= 22) setHeaderRevealed(true);
      else if (fullscreenCardId && e.clientY > 80) setHeaderRevealed(false);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [fullscreenCardId]);

  // Stable identities for the memoized shell children: an inline closure or Array.from() here would hand them a fresh prop every render, and a card drag re-renders this component per frame (liveDragInfo), which is exactly when they must bail.
  const selectedIdList = React.useMemo(() => Array.from(selection.selectedIds.keys()) as string[], [selection.selectedIds]);
  // The STORED rect is the collapsed footprint; an expanded chat paints far wider, so fitting the stored rect left half the chat off-screen. Fit what actually rendered, falling back to the stored rect only if the card never mounts.
  const fitRenderedCard = React.useCallback((cardId: string, fallback: { x: number; y: number; width: number; height: number }) => {
    const attemptFit = (attempt: number): void => {
      const el = document.querySelector(`[data-select-id="${cardId}"]`);
      const vp = canvas.viewportRef.current;
      if (el && vp) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          const cam = canvas.actions.getLiveState();
          const vr = vp.getBoundingClientRect();
          canvas.actions.fitToCards([{
            x: (r.left - vr.left - cam.panX) / cam.zoom,
            y: (r.top - vr.top - cam.panY) / cam.zoom,
            width: r.width / cam.zoom,
            height: r.height / cam.zoom,
          }], 1.15, true);
          return;
        }
      }
      if (attempt < 3) { window.setTimeout(() => attemptFit(attempt + 1), 90); return; }
      canvas.actions.fitToCards([fallback], 1.15, true);
    };
    window.setTimeout(() => attemptFit(0), 60);
  }, [canvas.actions, canvas.viewportRef]);
  const handleRestoreCard = React.useCallback((cardId: string, rect: { x: number; y: number; width: number; height: number }) => {
    fitRenderedCard(cardId, rect);
    onHighlightCard?.(cardId);
  }, [fitRenderedCard, onHighlightCard]);
  const handleFocusCard = React.useCallback((cardId: string, rect: { x: number; y: number; width: number; height: number }) => {
    // A parked card sits off-canvas, so flying to its stored rect would land on empty space; unpark it first.
    if (minimizedCards[cardId]) dispatch(toggleMinimizeCard({ cardId }));
    fitRenderedCard(cardId, rect);
    onHighlightCard?.(cardId);
  }, [minimizedCards, dispatch, fitRenderedCard, onHighlightCard]);
  const handleToggleApps = React.useCallback(() => setAppsWindowOpen((v) => !v), []);
  // ENG-154: with nothing selected the trash pops the newest-CREATED card (undo-stack feel); the ledger id must also resolve to a card visible on THIS dashboard, never a keep-alive from another one.
  const creationOrder = useAppSelector((s) => s.dashboardLayout.creationOrder);
  const newestDeletable = React.useMemo((): { id: string; type: CardType } | null => {
    for (let i = creationOrder.length - 1; i >= 0; i--) {
      const id = creationOrder[i];
      if (cards[id]) return { id, type: 'agent' };
      if (viewCards[id]) return { id, type: 'view' };
      const bc = browserCards[id];
      if (bc && (!bc.dashboard_id || bc.dashboard_id === dashboardId)) return { id, type: 'browser' };
      if (workflowCards[id]) return { id, type: 'workflow' };
    }
    return null;
  }, [creationOrder, cards, viewCards, browserCards, workflowCards, dashboardId]);
  const handleDeleteSelected = React.useCallback(() => {
    if (selection.selectedIds.size > 0) {
      deleteSelectedCards(selection.selectedIds, dispatch);
      selection.deselectAll();
      return;
    }
    if (newestDeletable) deleteSelectedCards(new Map([[newestDeletable.id, newestDeletable.type]]), dispatch);
  }, [selection, dispatch, newestDeletable]);

  // Cmd/Ctrl+W and Cmd/Ctrl+T arrive as IPC echoes: main preventDefaults both before any DOM keydown
  // (including from focused guests), so these bridges are the only firing path, no double-handling.
  const browserHomepage = useAppSelector((st) => st.settings.data.browser_homepage ?? 'https://www.google.com');
  React.useEffect(() => {
    const w = window as unknown as { openswarm?: { onCloseShortcut?: (cb: () => void) => () => void; onNewTabShortcut?: (cb: () => void) => () => void; onDockShortcut?: (cb: (index: number) => void) => () => void } };
    const offs: Array<() => void> = [];
    if (w.openswarm?.onCloseShortcut) offs.push(w.openswarm.onCloseShortcut(() => handleDeleteSelected()));
    if (w.openswarm?.onNewTabShortcut) {
      offs.push(w.openswarm.onNewTabShortcut(() => {
        const browserId = getLastInteractedBrowser();
        if (browserId && browserCards[browserId]) dispatch(addBrowserTab({ browserId, url: browserHomepage, makeActive: true }));
        else onAddBrowser();
      }));
    }
    if (w.openswarm?.onDockShortcut) {
      offs.push(w.openswarm.onDockShortcut((index: number) => {
        // Same order the dock draws, so Cmd+N matches what the user sees top-to-bottom.
        const entries = buildDockEntries({ sessions: store.getState().agents.sessions, cards, viewCards, browserCards, workflowCards, outputs });
        const entry = entries[index];
        if (entry) handleFocusCard(entry.id, entry.rect);
      }));
    }
    return () => { offs.forEach((off) => off()); };
  }, [handleDeleteSelected, browserCards, browserHomepage, dispatch, onAddBrowser, cards, viewCards, workflowCards, outputs, handleFocusCard]);

  // Gestures write the transform imperatively (no React commit per frame), so a foreign render mid-gesture would paint the stale committed transform for a frame. Re-applying live after EVERY render seals that; do not remove.
  React.useLayoutEffect(() => {
    canvas.actions.syncTransform();
  });

  return (
    <>
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {/* Floating header overlay */}
      <Box
        onMouseLeave={() => setHeaderRevealed(false)}
        sx={{
          display: fullscreenCardId ? 'none' : undefined,
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          pointerEvents: headerRevealed ? undefined : 'none',
          opacity: headerRevealed ? 1 : 0,
          transform: headerRevealed ? 'translateY(0)' : 'translateY(-6px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
          // p: 3 (24px) was leaving a chunky air gap between the sidebar edge and the dashboard header that read as "two disconnected panels" rather than one continuous surface. 0.75 (6px) tightens the inset so the header floats just inside the content area without losing its breathing room from the top-most pixel.
          pt: 0.75,
          pr: 0.75,
          pb: 0,
          // Clears the macOS traffic lights when the sidebar is docked away (AppShell sets the var); 6px otherwise.
          pl: 'var(--osw-header-inset, 6px)',
          // No scrim: the header carries its own translucent pill (DashboardHeader), so a full-width
          // page->transparent fade here just read as a light-leak band over the themed canvas.
        }}
      >
        {/* Must follow the reveal: an always-auto child overrides the hidden overlay's pointer-events:none and swallowed the whole top strip, so a top/left-tiled window's traffic lights were unclickable. */}
        <Box sx={{ display: 'flex', alignItems: 'center', pointerEvents: headerRevealed ? 'auto' : 'none' }}>
          <DashboardHeader
            dashboardName={dashboardName}
            sessions={sessions}
            cards={cards}
            viewCards={viewCards}
            browserCards={browserCards}
            workflowCards={workflowCards}
            workflowsHub={workflowsHub}
            expandedSessionIds={expandedSessionIds}
            outputs={outputs}
            dashboardId={dashboardId}
            canvasActions={canvas.actions}
            onHighlightCard={onHighlightCard}
            historyAvailable={!anyFullscreen}
          />
        </Box>
      </Box>

      {!anyFullscreen && (
        <MinimizedStack
          browserCards={browserCards}
          viewCards={viewCards}
          outputs={outputs}
          selectedIds={selectedIdList}
          onRestore={handleRestoreCard}
        />
      )}

      {!anyFullscreen && (
        <DesktopDock
          cards={cards}
          viewCards={viewCards}
          browserCards={browserCards}
          workflowCards={workflowCards}
          outputs={outputs}
          selectedIds={selectedIdList}
          onFocusCard={handleFocusCard}
          onApplications={handleToggleApps}
          onAddBrowser={onAddBrowser}
        />
      )}

      {appsWindowOpen && !fullscreenCardId && (
        <ApplicationsWindow
          outputs={outputs}
          onOpenApp={(outputId) => dispatch(addViewCard({ outputId }))}
          onClose={() => setAppsWindowOpen(false)}
        />
      )}

      {/* Canvas viewport */}
      <Box
        ref={canvas.viewportRef}
        data-canvas-viewport
        onMouseDown={onViewportMouseDown}
        onMouseMove={onViewportMouseMove}
        onMouseUp={(e) => {
          const marqueed = onViewportMouseUp(e);
          // The right button belongs to the marquee, so the canvas menu waits for the release and
          // only opens when nothing was rubber-banded. Opening on press stole the drag.
          if (e.button === 2 && !marqueed) openCanvasMenu(e);
        }}
        onDoubleClick={onViewportDoubleClick}
        onContextMenu={(e: React.MouseEvent) => {
          // Bare canvas: kill the native menu (Inspect Element in dev) so the right-drag stays clean.
          const t = e.target as HTMLElement;
          if (!t.closest('[data-select-id]') && !t.closest('input, textarea, [contenteditable]')) e.preventDefault();
        }}
        sx={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          // Last line of the never-white guarantee: if every background layer's raster is gone, the viewport itself still paints tint (solid colors are compositor quads, not evictable textures).
          backgroundColor: washUnderlay,
          // Wash + grain paint HERE rather than on a child: two stacked full-viewport layers meant two
          // rasters the compositor could evict independently, and a dropped one exposed the flat tint
          // as a hard-edged band. One element, one raster, one fewer thing to lose. A uniform wash
          // drops the image entirely, because backgroundColor above already IS that colour.
          ...(washLayers ? {
            backgroundImage: washLayers.image,
            backgroundSize: washLayers.size,
            backgroundRepeat: washLayers.repeat,
          } : {}),
          cursor: (canvas.spaceHeld || canvas.cmdHeld)
            ? 'grab'
            : selection.marquee
              ? 'crosshair'
              : 'default',
        }}
      >

        {/* Dot grid background; gestures move it imperatively via gridRef (phase + scale), commits re-render it here (dot radius included). The tile is an SVG IMAGE, not a procedural gradient: Chromium caches a decoded image as a GPU texture, while a radial-gradient re-rasterizes the whole layer every backgroundSize change, and under GPU memory pressure (many webviews, external monitors) those rasters get dropped and paint as a giant blank rectangle, the 1.5.9 white-patch bug. Same backgroundSize/Position write contract, so the per-frame camera writer is untouched. */}
        <Box
          ref={canvas.gridRef}
          sx={{
            position: 'absolute',
            // Bled past the viewport so the pan phase rides a compositor transform: backgroundPosition writes repainted the WHOLE viewport every pan frame, which both cost the frame budget and fed the GPU pressure that evicts the wash.
            inset: `-${GRID_BLEED_PX}px`,
            pointerEvents: 'none',
            willChange: 'transform',
            transform: `translate3d(${canvas.panX % dotSpacing}px, ${canvas.panY % dotSpacing}px, 0)`,
            // Arc fullscreen: the float sits on a clean themed ground, the dot texture is canvas-only.
            display: screenOwnedByCard ? 'none' : undefined,
            backgroundImage: gridTileUrl,
            backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
          }}
        />

        {/* Card layer always mounts, even on an empty dashboard, so keep-alive browser cards from other dashboards stay alive; the empty-state overlays it below. */}
        {(
          <div
            ref={canvas.contentRef}
            data-canvas-content
            style={{
              transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
              position: 'relative',
            }}
          >
            {/* Tether lines between branched cards; the host alone re-renders on drag frames */}
            <TetherLayerHost inputs={tetherInputs} c={c} />
            <DashboardCardLayer
              dashboardId={dashboardId}
              cards={cards}
              viewCards={viewCards}
              browserCards={browserCards}
              keepAliveBrowserCards={keepAliveBrowserCards}
              workflowCards={workflowCards}
              workflowsHub={workflowsHub}
              outputs={outputs}
              glowingAgentCards={glowingAgentCards}
              expandedSessionIds={expandedSessionIds}
              cmdHeld={canvas.cmdHeld}
              selection={selection}
              highlightedCardId={highlightedCardId}
              autoFocusSessionId={autoFocusSessionId}
              focusedCardId={focusedCardId}
              multiDragActive={multiDragActive}
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
        {canvasEmpty && !fullscreenCardId && (
          <DashboardEmptyState c={c} onLaunch={onToolbarSend} onStarter={onStarter} />
        )}
      </Box>

      {/* display:contents when visible so the overlays' absolute children keep positioning against the canvas root; display:none (not unmount) so the toolbar composer draft survives fullscreen. */}
      <Box sx={{ display: screenOwnedByCard ? 'none' : 'contents' }}>
      <DashboardOverlays
        anyFullscreen={anyFullscreen}
        canvas={canvas}
        dashboardId={dashboardId}
        sessions={sessions}
        cards={cards}
        viewCards={viewCards}
        browserCards={browserCards}
        workflowCards={workflowCards}
        workflowsHub={workflowsHub}
        focusedCardId={focusedCardId}
        toolbarOpen={toolbarOpen}
        searchPaletteOpen={searchPaletteOpen}
        newAgentBounce={newAgentBounce}
        canvasEmpty={canvasEmpty}
        toolbarRef={toolbarRef}
        onNewAgent={onNewAgent}
        onToolbarCancel={onToolbarCancel}
        onToolbarSend={onToolbarSend}
        onAddView={onAddView}
        onOpenApplications={handleToggleApps}
        onHistoryResume={onHistoryResume}
        onAddBrowser={onAddBrowser}
        onNewAgentBounceEnd={onNewAgentBounceEnd}
        onFitToView={onFitToView}
        onTidy={onTidy}
        onDeleteSelected={handleDeleteSelected}
        deleteMode={selection.selectedIds.size > 0 ? 'selection' : newestDeletable ? 'newest' : 'none'}
        onSearchPaletteClose={onSearchPaletteClose}
        toolbarPrefill={toolbarPrefill}
        toolbarPrefillMode={toolbarPrefillMode}
      />
      </Box>

      {/* The one exit that survives everything: mouse events over a fullscreen webview go to the guest, so hover reveals and window-level Escape can both be unreachable; this pill is an embedder element painted above the guest and always clickable. App cards carry their own exit in the fullscreen bar, so they skip the pill (three exits read as clutter, Eric 2026-08-09). */}
      {fullscreenCardId && !viewCards[fullscreenCardId] && (
        <Box
          onClick={() => dispatch(clearTiledCard(fullscreenCardId))}
          sx={{
            position: 'fixed', top: 34, left: '50%', transform: 'translateX(-50%)', zIndex: 1400,
            px: '12px', py: '5px', borderRadius: 999, cursor: 'pointer', userSelect: 'none',
            background: 'rgba(24,14,32,0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: 600, letterSpacing: 0.2,
            opacity: 0.3, transition: 'opacity 140ms ease', '&:hover': { opacity: 1 },
            WebkitAppRegion: 'no-drag',
          }}
        >
          Exit full screen
        </Box>
      )}

    </Box>
    </>
  );
};

export default DashboardCanvas;
