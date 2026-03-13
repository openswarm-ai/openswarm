import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DashboardIcon from '@mui/icons-material/Dashboard';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import {
  fetchSessions,
  fetchHistory,
  collapseAllSessions,
  collapseSession,
  launchAndSendFirstMessage,
  generateTitle,
  resumeSession,
} from '@/shared/state/agentsSlice';
import type { AgentConfig } from '@/shared/state/agentsSlice';
import {
  fetchLayout,
  saveLayout,
  reconcileSessions,
  tidyLayout,
  addViewCard,
  resetLayout,
} from '@/shared/state/dashboardLayoutSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { dashboardWs } from '@/shared/ws/WebSocketManager';
import AgentCard from './AgentCard';
import DashboardViewCard from './DashboardViewCard';
import CanvasControls from './CanvasControls';
import DashboardToolbar from './DashboardToolbar';
import { useCanvasControls } from './useCanvasControls';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ContextPath } from '@/app/components/DirectoryBrowser';
import { ElementSelectionProvider, useElementSelection } from '@/app/components/ElementSelectionContext';
import { useDomElementSelector } from '@/app/components/useDomElementSelector';
import SelectionOverlay from '@/app/components/SelectionOverlay';

const DashboardSelectionOverlay: React.FC = () => {
  const { overlay, dragRect, dragPreview } = useDomElementSelector();
  return <SelectionOverlay overlay={overlay} dragRect={dragRect} dragPreview={dragPreview} />;
};

const DashboardInner: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const elementSelection = useElementSelection();
  const { id: dashboardId } = useParams<{ id: string }>();
  const dashboardName = useAppSelector((state) =>
    dashboardId ? state.dashboards.items[dashboardId]?.name : undefined,
  );
  const sessions = useAppSelector((state) => state.agents.sessions);
  const expandedSessionIds = useAppSelector((state) => state.agents.expandedSessionIds);
  const cards = useAppSelector((state) => state.dashboardLayout.cards);
  const viewCards = useAppSelector((state) => state.dashboardLayout.viewCards);
  const layoutInitialized = useAppSelector((state) => state.dashboardLayout.initialized);
  const zoomSensitivity = useAppSelector((state) => state.settings.data.zoom_sensitivity);
  const newAgentShortcut = useAppSelector((state) => state.settings.data.new_agent_shortcut);
  const outputs = useAppSelector((state) => state.outputs.items);
  const sessionList = Object.values(sessions);

  const selectModeActive = elementSelection?.selectMode ?? false;
  const canvas = useCanvasControls(zoomSensitivity, selectModeActive);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const [toolbarOpen, setToolbarOpen] = useState(false);
  const spawnOriginsRef = useRef<Record<string, { x: number; y: number }>>({});
  const hasFittedRef = useRef(false);

  useEffect(() => {
    if (!dashboardId) return;
    hasFittedRef.current = false;
    dispatch(resetLayout());
    dispatch(fetchSessions({ dashboardId }));
    dispatch(fetchHistory({ dashboardId }));
    dispatch(fetchLayout(dashboardId));
    dispatch(fetchOutputs());
    dashboardWs.connect();
    return () => dashboardWs.disconnect();
  }, [dispatch, dashboardId]);

  useEffect(() => {
    if (!layoutInitialized || hasFittedRef.current) return;
    hasFittedRef.current = true;
    const timer = setTimeout(() => canvas.actions.fitToView(), 150);
    return () => clearTimeout(timer);
  }, [layoutInitialized, canvas.actions]);

  const prevSessionIdsRef = useRef<string>('');

  useEffect(() => {
    if (!layoutInitialized) return;
    const dashboardSessionIds = Object.values(sessions)
      .filter((s) => s.dashboard_id === dashboardId)
      .map((s) => s.id);
    const liveIds = dashboardSessionIds.sort().join(',');
    if (liveIds === prevSessionIdsRef.current) return;
    prevSessionIdsRef.current = liveIds;
    dispatch(reconcileSessions(dashboardSessionIds));
  }, [sessions, layoutInitialized, dispatch, dashboardId]);

  const cardsJson = JSON.stringify(cards);
  const viewCardsJson = JSON.stringify(viewCards);
  const skipInitialSave = useRef(true);
  useEffect(() => {
    if (!layoutInitialized || !dashboardId) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    dispatch(saveLayout({ dashboardId, cards, viewCards }));
  }, [cardsJson, viewCardsJson, layoutInitialized, dashboardId]);

  useEffect(() => {
    const parts = newAgentShortcut.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needsMeta = parts.includes('meta');
    const needsCtrl = parts.includes('ctrl');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');

    const handleShortcut = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return;
      if (needsMeta !== e.metaKey) return;
      if (needsCtrl !== e.ctrlKey) return;
      if (needsShift !== e.shiftKey) return;
      if (needsAlt !== e.altKey) return;
      e.preventDefault();
      setToolbarOpen(true);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [newAgentShortcut]);

  const handleNewAgent = useCallback(() => {
    setToolbarOpen(true);
  }, []);

  const handleToolbarCancel = useCallback(() => {
    setToolbarOpen(false);
  }, []);

  const handleToolbarSend = useCallback(
    (
      prompt: string,
      mode: string,
      model: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: ContextPath[],
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
    ) => {
      setToolbarOpen(false);

      const draftId = `draft-${Date.now().toString(36)}`;

      const toolbarEl = toolbarRef.current;
      const vpEl = canvas.viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const toolbarCenterX = tr.left + tr.width / 2;
        const toolbarTopY = tr.top;
        spawnOriginsRef.current[draftId] = {
          x: (toolbarCenterX - vr.left - canvas.panX) / canvas.zoom,
          y: (toolbarTopY - vr.top - canvas.panY) / canvas.zoom,
        };
      }

      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };

      dispatch(
        launchAndSendFirstMessage({
          draftId,
          config,
          prompt,
          mode,
          model,
          images,
          contextPaths: contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })),
          forcedTools,
          attachedSkills,
          expand: false,
        }),
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          spawnOriginsRef.current[realId] = spawnOriginsRef.current[draftId];
          delete spawnOriginsRef.current[draftId];
        } else {
          delete spawnOriginsRef.current[draftId];
        }
      });
    },
    [canvas.zoom, canvas.panX, canvas.panY, canvas.viewportRef, dispatch, dashboardId],
  );

  const handleAddView = useCallback((outputId: string) => {
    dispatch(addViewCard({ outputId }));
  }, [dispatch]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(resumeSession({ sessionId })).then((action) => {
      if (resumeSession.fulfilled.match(action)) {
        dispatch(collapseSession(sessionId));
      }
    });
  }, [dispatch]);

  const handleTidy = useCallback(() => {
    dispatch(collapseAllSessions());
    dispatch(tidyLayout());

    const { cards: tidied, viewCards: tidiedViews } = store.getState().dashboardLayout;
    const allRects = [
      ...Object.values(tidied).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedViews).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
    ];
    canvas.actions.fitToCards(allRects);
  }, [dispatch, canvas.actions]);

  const nonDraftCount = sessionList.filter((s) => s.status !== 'draft' && s.dashboard_id === dashboardId).length;

  const dotSize = Math.max(1, 1.5 * canvas.zoom);
  const dotSpacing = 24 * canvas.zoom;

  return (
    <>
    <DashboardSelectionOverlay />
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {/* Floating header overlay */}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          pointerEvents: 'none',
          p: 3,
          pb: 0,
          background: `linear-gradient(to bottom, ${c.bg.page} 60%, transparent)`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.medium}`,
              borderRadius: `${c.radius.lg}px`,
              boxShadow: c.shadow.sm,
              py: 0.75,
              px: 1.5,
            }}
          >
            <DashboardIcon sx={{ fontSize: 'small', color: c.accent.primary }} />
            <Typography
              sx={{
                fontSize: '0.9rem',
                fontWeight: 600,
                color: c.text.primary,
                lineHeight: 1,
              }}
            >
              {dashboardName || 'Dashboard'}
              <Box component="span" sx={{ color: c.text.muted, fontWeight: 400, mx: 0.75 }}>·</Box>
              <Box component="span" sx={{ color: c.text.tertiary, fontWeight: 400 }}>
                {nonDraftCount} agent{nonDraftCount !== 1 ? 's' : ''} running
              </Box>
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Canvas viewport */}
      <Box
        ref={canvas.viewportRef}
        onMouseDown={canvas.handlers.onMouseDown}
        onMouseMove={canvas.handlers.onMouseMove}
        onMouseUp={canvas.handlers.onMouseUp}
        sx={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor: canvas.isPanning ? 'grabbing' : canvas.spaceHeld ? 'grab' : selectModeActive ? 'crosshair' : 'default',
        }}
      >
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

        {sessionList.length === 0 && Object.keys(viewCards).length === 0 ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
              No agents running
            </Typography>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.9rem' }}>
              Click &quot;New Agent&quot; to launch your first Claude Code instance
            </Typography>
          </Box>
        ) : (
          <div
            ref={canvas.contentRef}
            style={{
              transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
              position: 'relative',
            }}
          >
            {Object.values(cards).map((card) => {
              const session = sessions[card.session_id];
              if (!session) return null;
              const origin = spawnOriginsRef.current[session.id];
              if (origin) delete spawnOriginsRef.current[session.id];
              return (
                <AgentCard
                  key={session.id}
                  session={session}
                  expanded={expandedSessionIds.includes(session.id)}
                  cardX={card.x}
                  cardY={card.y}
                  cardWidth={card.width}
                  cardHeight={card.height}
                  zoom={canvas.zoom}
                  spawnFrom={origin}
                />
              );
            })}
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
                  zoom={canvas.zoom}
                />
              );
            })}
          </div>
        )}
      </Box>

      {/* Floating bottom toolbar */}
      <Box sx={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <DashboardToolbar
          ref={toolbarRef}
          inputOpen={toolbarOpen}
          onNewAgent={handleNewAgent}
          onCancel={handleToolbarCancel}
          onSend={handleToolbarSend}
          onAddView={handleAddView}
          onHistoryResume={handleHistoryResume}
          dashboardId={dashboardId}
        />
      </Box>

      {/* Floating zoom controls */}
      <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
        <CanvasControls zoom={canvas.zoom} actions={canvas.actions} onTidy={handleTidy} />
      </Box>
    </Box>
    </>
  );
};

const Dashboard: React.FC = () => (
  <ElementSelectionProvider>
    <DashboardInner />
  </ElementSelectionProvider>
);

export default Dashboard;
