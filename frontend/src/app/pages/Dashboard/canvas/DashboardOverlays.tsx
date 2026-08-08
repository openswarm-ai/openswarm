import React, { type RefObject } from 'react';
import Box from '@mui/material/Box';
import DashboardToolbar from '../DashboardToolbar';
import CanvasControls from '../controls/CanvasControls';
import HelpPill from '../desktop/HelpPill';
import CardSearchPalette from '../controls/CardSearchPalette';
import WorkflowRunningToast from '@/app/pages/Workflows/WorkflowRunningToast';
import WorkflowNoticeToast from '@/app/pages/Workflows/WorkflowNoticeToast';
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

interface DashboardOverlaysProps {
  anyFullscreen: boolean;
  canvas: Canvas;
  dashboardId: string;
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  focusedCardId: string | null;
  toolbarOpen: boolean;
  searchPaletteOpen: boolean;
  newAgentBounce: boolean;
  canvasEmpty: boolean;
  toolbarRef: RefObject<HTMLDivElement>;
  onNewAgent: () => void;
  onToolbarCancel: () => void;
  onToolbarSend: (...args: any[]) => void;
  onAddView: (outputId: string, opts?: { newInstance?: boolean }) => void;
  onOpenApplications: () => void;
  onHistoryResume: (sessionId: string) => void;
  onAddBrowser: () => void;
  onNewAgentBounceEnd: () => void;
  onFitToView: () => void;
  onTidy: () => void;
  onDeleteSelected: () => void;
  deleteMode: 'selection' | 'newest' | 'none';
  onSearchPaletteClose: () => void;
  toolbarPrefill?: string;
  toolbarPrefillMode?: string;
}

const DashboardOverlays: React.FC<DashboardOverlaysProps> = ({
  anyFullscreen,
  canvas,
  dashboardId,
  sessions,
  cards,
  viewCards,
  browserCards,
  workflowCards,
  workflowsHub,
  focusedCardId,
  toolbarOpen,
  searchPaletteOpen,
  newAgentBounce,
  canvasEmpty,
  toolbarRef,
  onNewAgent,
  onToolbarCancel,
  onToolbarSend,
  onAddView,
  onOpenApplications,
  onHistoryResume,
  onAddBrowser,
  onNewAgentBounceEnd,
  onFitToView,
  onTidy,
  onDeleteSelected,
  deleteMode,
  onSearchPaletteClose,
  toolbarPrefill,
  toolbarPrefillMode,
}) => {
  return (
    <>
      {/* Floating bottom toolbar (all floating chrome steps aside while anything is fullscreen). Sits at 30 not 16 so the spawn pill's 26px shadow reach clears the canvas root's clip. */}
      {!anyFullscreen && (
      <Box sx={{ position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <DashboardToolbar
          ref={toolbarRef}
          inputOpen={toolbarOpen}
          onNewAgent={onNewAgent}
          onCancel={onToolbarCancel}
          onSend={onToolbarSend}
          onAddView={onAddView}
          onOpenApplications={onOpenApplications}
          onHistoryResume={onHistoryResume}
          onAddBrowser={onAddBrowser}
          dashboardId={dashboardId}
          newAgentBounce={newAgentBounce}
          canvasEmpty={canvasEmpty}
          onNewAgentBounceEnd={onNewAgentBounceEnd}
          prefillPrompt={toolbarPrefill}
          prefillMode={toolbarPrefillMode}
        />
      </Box>
      )}

      {/* Desktop help pill */}
      {!anyFullscreen && (
      <Box sx={{ position: 'absolute', top: 14, right: 16, zIndex: 10 }}>
        <HelpPill />
      </Box>
      )}

      {/* Arrow-key nav still works; its translucent chevron hints are gone by Eric's call (2026-08-06). */}

      {/* Floating zoom controls + minimap */}
      {!anyFullscreen && (
      <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
        <CanvasControls
          zoom={canvas.zoom}
          actions={canvas.actions}
          onFitToView={onFitToView}
          onTidy={onTidy}
          onDeleteSelected={onDeleteSelected}
          deleteMode={deleteMode}
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
      )}

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
      <WorkflowNoticeToast />

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

export default React.memo(DashboardOverlays);
