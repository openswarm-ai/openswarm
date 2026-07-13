import React, { useEffect, useMemo, useState } from 'react';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import CloseIcon from '@mui/icons-material/Close';
import IconButton from '@mui/material/IconButton';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearWorkflowsAppTarget, closeWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import {
  fetchWorkflows, fetchAllRuns, fetchPausedState, fetchActiveRuns, fetchDeletedWorkflows,
} from '@/shared/state/workflowsSlice';
import { fetchMissedRuns } from '@/shared/state/missedRunsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ShareButton from '@/app/components/share/ShareButton';
import { FONT_SANS, FONT_SERIF, useWC } from './uiKit';
import type { AppMode, CalView, AppNav, CardHeader } from './types';
import LeftRail from './LeftRail';
import HomeView from './HomeView';
import CalendarView from './CalendarView';
import DetailView from './DetailView';
import ComposeView from './ComposeView';
import TrashView from './TrashView';

// The three-pane Workflows body plus its title bar. The card wraps this with drag/resize geometry and passes the drag handlers in; the title bar lives here because Share needs to know which workflow is open.
const WorkflowsAppContent: React.FC<{ header: CardHeader }> = ({ header }) => {
  const WC = useWC();
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const target = useAppSelector((s) => s.dashboardLayout.workflowsAppTarget);
  const dashboardId = useAppSelector((s) => s.tempState.lastDashboardId) || undefined;

  const [mode, setMode] = useState<AppMode>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [calView, setCalView] = useState<CalView>('month');
  const [refDate, setRefDate] = useState<Date>(() => new Date());

  // goHome leaves selectedId set, so gate on the mode too or Share lingers in the title bar after leaving the workflow.
  const shared = useAppSelector((s) => (selectedId ? s.workflows.items[selectedId] : undefined));
  const selected = mode === 'detail' ? shared : undefined;

  useEffect(() => {
    dispatch(fetchWorkflows(dashboardId));
    dispatch(fetchAllRuns(200));
    dispatch(fetchPausedState());
    dispatch(fetchActiveRuns());
    dispatch(fetchMissedRuns());
    dispatch(fetchDeletedWorkflows(dashboardId));
  }, [dashboardId, dispatch]);

  // A deep-link target (history/notifications/toasts) jumps to that workflow's detail, then clears so a later manual Home nav isn't overridden.
  useEffect(() => {
    if (target) {
      setSelectedId(target);
      setMode('detail');
      dispatch(clearWorkflowsAppTarget());
    }
  }, [target, dispatch]);

  const nav: AppNav = useMemo(() => ({
    mode, selectedId, calView, refDate,
    goHome: () => setMode('home'),
    goCalendar: () => setMode('calendar'),
    goNew: () => { setSelectedId(null); setMode('new'); },
    goTrash: () => { dispatch(fetchDeletedWorkflows(dashboardId)); setMode('trash'); },
    selectWorkflow: (id: string) => { setSelectedId(id); setMode('detail'); },
    setCalView: (v: CalView) => setCalView(v),
    setRefDate: (d: Date) => setRefDate(d),
  }), [mode, selectedId, calView, refDate, dashboardId, dispatch]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: FONT_SANS, color: WC.ink, background: WC.page }}>
      {/* TITLE BAR (drag handle) */}
      <div
        onPointerDown={header.onPointerDown}
        onPointerMove={header.onPointerMove}
        onPointerUp={header.onPointerUp}
        style={{ height: 42, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: `1px solid ${WC.line}`, background: WC.panel, gap: 14, cursor: header.dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EventRepeatIcon sx={{ fontSize: 18, color: WC.accent, display: 'block' }} />
          <span style={{ fontFamily: FONT_SERIF, fontSize: 14.5, fontWeight: 500, color: WC.ink, letterSpacing: '-0.01em', lineHeight: 1, transform: 'translateY(2.5px)' }}>Workflows</span>
        </div>
        <div style={{ flex: 1 }} />
        {selected && (
          // The share dialog portals to the body but its events still bubble the React tree, so stop them here or dragging the card follows a click inside the modal.
          <span
            data-no-drag
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex' }}
          >
            <ShareButton
              target={{ kind: 'workflow', id: selected.id, name: selected.title || 'Untitled workflow' }}
              iconFontSize={17}
            />
          </span>
        )}
        <IconButton
          aria-label="Close"
          data-no-drag
          size="small"
          onClick={(e) => { e.stopPropagation(); dispatch(closeWorkflowsApp()); }}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ color: c.text.tertiary, '&:hover': { color: c.status.error, bgcolor: `${c.status.error}14` } }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <LeftRail nav={nav} />
        {mode === 'home' && <HomeView nav={nav} />}
        {mode === 'calendar' && <CalendarView nav={nav} />}
        {mode === 'detail' && selectedId && <DetailView workflowId={selectedId} nav={nav} />}
        {mode === 'new' && <ComposeView nav={nav} />}
        {mode === 'trash' && <TrashView />}
      </div>
    </div>
  );
};

export default WorkflowsAppContent;
