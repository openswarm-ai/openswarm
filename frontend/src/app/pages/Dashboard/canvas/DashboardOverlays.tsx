import React, { type RefObject } from 'react';
import Box from '@mui/material/Box';
import DashboardToolbar from '../DashboardToolbar';
import CanvasControls from '../controls/CanvasControls';
import HelpPill from '../desktop/HelpPill';
import CardSearchPalette from '../controls/CardSearchPalette';
import DirectionHints from '../controls/DirectionHints';
import WorkflowRunningToast from '@/app/pages/Workflows/WorkflowRunningToast';
import MissedRunsToast from '@/app/pages/Workflows/MissedRunsToast';
import ProviderHealthToast from '@/app/components/overlays/ProviderHealthToast';
import ScheduleOfferToast from '@/app/components/nudges/ScheduleOfferToast';
import PrepKeepToast from '@/app/components/nudges/PrepKeepToast';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
  WorkflowCardPosition,
  WorkflowsHubPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { useCanvasControls } from '../hooks/interaction/useCanvasControls';

type Canvas = ReturnType<typeof useCanvasControls>;
type Direction = 'left' | 'right' | 'up' | 'down';
type NeighborDirections = { left: boolean; right: boolean; up: boolean; down: boolean };

interface DashboardOverlaysProps {
  canvas: Canvas;
  dashboardId: string;
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  focusedCardId: string | null;
  shakeDirection: Direction | null;
  neighborDirections: NeighborDirections;
  toolbarOpen: boolean;
  searchPaletteOpen: boolean;
  newAgentBounce: boolean;
  canvasEmpty: boolean;
  toolbarRef: RefObject<HTMLDivElement>;
  onNewAgent: () => void;
  onToolbarCancel: () => void;
  onToolbarSend: (...args: any[]) => void;
  onAddView: (outputId: string, opts?: { newInstance?: boolean }) => void;
  onHistoryResume: (sessionId: string) => void;
  onAddBrowser: () => void;
  onAddNote: () => void;
  onNewAgentBounceEnd: () => void;
  onFitToView: () => void;
  onTidy: () => void;
  onDeleteSelected: () => void;
  hasSelection: boolean;
  onSearchPaletteClose: () => void;
  toolbarPrefill?: string;
  toolbarPrefillMode?: string;
}

const DashboardOverlays: React.FC<DashboardOverlaysProps> = ({
  canvas,
  dashboardId,
  sessions,
  cards,
  viewCards,
  browserCards,
  workflowCards,
  workflowsHub,
  focusedCardId,
  shakeDirection,
  neighborDirections,
  toolbarOpen,
  searchPaletteOpen,
  newAgentBounce,
  canvasEmpty,
  toolbarRef,
  onNewAgent,
  onToolbarCancel,
  onToolbarSend,
  onAddView,
  onHistoryResume,
  onAddBrowser,
  onAddNote,
  onNewAgentBounceEnd,
  onFitToView,
  onTidy,
  onDeleteSelected,
  hasSelection,
  onSearchPaletteClose,
  toolbarPrefill,
  toolbarPrefillMode,
}) => {
  return (
    <>
      {/* Floating bottom toolbar */}
      <Box sx={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <DashboardToolbar
          ref={toolbarRef}
          inputOpen={toolbarOpen}
          onNewAgent={onNewAgent}
          onCancel={onToolbarCancel}
          onSend={onToolbarSend}
          onAddView={onAddView}
          onHistoryResume={onHistoryResume}
          onAddBrowser={onAddBrowser}
          onAddNote={onAddNote}
          dashboardId={dashboardId}
          newAgentBounce={newAgentBounce}
          canvasEmpty={canvasEmpty}
          onNewAgentBounceEnd={onNewAgentBounceEnd}
          prefillPrompt={toolbarPrefill}
          prefillMode={toolbarPrefillMode}
        />
      </Box>

      {/* Desktop help pill */}
      <Box sx={{ position: 'absolute', top: 14, right: 16, zIndex: 10 }}>
        <HelpPill />
      </Box>

      {/* Arrow navigation hints when zoomed in on a card */}
      {focusedCardId && canvas.zoom >= 0.4 && (
        <DirectionHints
          hasLeft={neighborDirections.left}
          hasRight={neighborDirections.right}
          hasUp={neighborDirections.up}
          hasDown={neighborDirections.down}
          shakeDirection={shakeDirection}
        />
      )}

      {/* Floating zoom controls + minimap */}
      <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
        <CanvasControls
          zoom={canvas.zoom}
          actions={canvas.actions}
          onFitToView={onFitToView}
          onTidy={onTidy}
          onDeleteSelected={onDeleteSelected}
          hasSelection={hasSelection}
          minimapProps={{
            panX: canvas.panX,
            panY: canvas.panY,
            zoom: canvas.zoom,
            viewportRef: canvas.viewportRef,
            cards,
            viewCards,
            browserCards,
            workflowCards,
            workflowsHub,
          }}
          onMinimapPan={(px, py) => canvas.actions.setState({ panX: px, panY: py, zoom: canvas.zoom })}
        />
      </Box>

      {/* Card search palette (Cmd+F) */}
      <CardSearchPalette
        open={searchPaletteOpen}
        onClose={onSearchPaletteClose}
        onNavigate={(rect) => canvas.actions.fitToCards([rect], 1.15, true)}
        cards={cards}
        viewCards={viewCards}
        browserCards={browserCards}
        sessions={sessions}
      />

      {/* Scheduled-run nudge: "your {workflow} is running now" + jump-to-canvas */}
      <WorkflowRunningToast />

      {/* Launch nudge when scheduled runs elapsed while the app was closed */}
      <MissedRunsToast />

      {/* Launch nudge when a subscription login died while the app was closed */}
      <ProviderHealthToast />

      {/* One-shot dependency beat: first completed personalized starter offers to become a weekly job */}
      <ScheduleOfferToast dashboardId={dashboardId} />

      {/* The reveal's payoff is the hold-to-enter gradient flood (BeatEnter) landing you on the live work,
          not a summary card, so no modal here. */}

      {/* Accept-or-deny for the audit + app the flow started on the user's behalf */}
      <PrepKeepToast />
    </>
  );
};

export default DashboardOverlays;
