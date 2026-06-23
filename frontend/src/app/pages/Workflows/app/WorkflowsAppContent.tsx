import React, { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearWorkflowsAppTarget } from '@/shared/state/dashboardLayoutSlice';
import {
  fetchWorkflows, fetchAllRuns, fetchPausedState, fetchActiveRuns, fetchDeletedWorkflows,
} from '@/shared/state/workflowsSlice';
import { fetchMissedRuns } from '@/shared/state/missedRunsSlice';
import { FONT_SANS, useWC } from './uiKit';
import type { AppMode, CalView, AppNav } from './types';
import LeftRail from './LeftRail';
import HomeView from './HomeView';
import CalendarView from './CalendarView';
import DetailView from './DetailView';
import ComposeView from './ComposeView';
import TrashView from './TrashView';

// The three-pane Workflows body, independent of how it's framed (canvas card).
// Holds nav + data; the card chrome (title bar drag handle, resize) wraps it.
const WorkflowsAppContent: React.FC = () => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const target = useAppSelector((s) => s.dashboardLayout.workflowsAppTarget);
  const dashboardId = useAppSelector((s) => s.tempState.lastDashboardId) || undefined;

  const [mode, setMode] = useState<AppMode>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [calView, setCalView] = useState<CalView>('month');
  const [refDate, setRefDate] = useState<Date>(() => new Date());

  useEffect(() => {
    dispatch(fetchWorkflows(dashboardId));
    dispatch(fetchAllRuns(200));
    dispatch(fetchPausedState());
    dispatch(fetchActiveRuns());
    dispatch(fetchMissedRuns());
    dispatch(fetchDeletedWorkflows(dashboardId));
  }, [dashboardId, dispatch]);

  // A deep-link target (history/notifications/toasts) jumps to that workflow's
  // detail, then clears so a later manual Home nav isn't overridden.
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
    <div style={{ flex: 1, display: 'flex', minHeight: 0, fontFamily: FONT_SANS, color: WC.ink, background: WC.page }}>
      <LeftRail nav={nav} />
      {mode === 'home' && <HomeView nav={nav} />}
      {mode === 'calendar' && <CalendarView nav={nav} />}
      {mode === 'detail' && selectedId && <DetailView workflowId={selectedId} nav={nav} />}
      {mode === 'new' && <ComposeView nav={nav} />}
      {mode === 'trash' && <TrashView />}
    </div>
  );
};

export default WorkflowsAppContent;
