import { useMemo } from 'react';
import { useAppSelector } from '@/shared/hooks';
import { isAgentDrivingBrowser } from '@/shared/isAgentDrivingBrowser';

// All of the dashboard's Redux reads in one place. Keeps Dashboard.tsx a thin composition layer instead of a 25-line selector wall.
export function useDashboardSelectors(dashboardId: string) {
  const dashboardName = useAppSelector((state) =>
    dashboardId ? state.dashboards.items[dashboardId]?.name : undefined,
  );
  const sessions = useAppSelector((state) => state.agents.sessions);
  const expandedSessionIds = useAppSelector((state) => state.agents.expandedSessionIds);
  const cards = useAppSelector((state) => state.dashboardLayout.cards);
  const viewCards = useAppSelector((state) => state.dashboardLayout.viewCards);
  const allBrowserCards = useAppSelector((state) => state.dashboardLayout.browserCards);
  // Browser cards live in a single global dict (no per-dashboard nesting) so a card spawned on dashboard A used to leak into dashboard B if the user switched mid-spawn. Filter here so every downstream consumer (render, bounds, layout save, keyboard nav) sees only this dashboard's cards. Legacy cards without dashboard_id fall through, next save tags them.
  const browserCards = useMemo(() => {
    const out: typeof allBrowserCards = {};
    for (const [id, bc] of Object.entries(allBrowserCards)) {
      if (!bc.dashboard_id || bc.dashboard_id === dashboardId) out[id] = bc;
    }
    return out;
  }, [allBrowserCards, dashboardId]);
  // Only an AGENT-driven browser from another dashboard stays mounted-but-hidden here so its run keeps going in the background; a MANUAL browser is deliberately NOT rendered off its own dashboard (it reloads on return) because a kept-alive heavy page bleeds its webview surface onto whatever dashboard you're viewing. Kept OUT of `browserCards` so save/bounds/keyboard-nav only ever see THIS dashboard's cards.
  const keepAliveBrowserCards = useMemo(() => {
    const out: typeof allBrowserCards = {};
    for (const [id, bc] of Object.entries(allBrowserCards)) {
      if (bc.dashboard_id && bc.dashboard_id !== dashboardId && isAgentDrivingBrowser(sessions, id, bc.spawned_by)) out[id] = bc;
    }
    return out;
  }, [allBrowserCards, dashboardId, sessions]);
  const workflowCards = useAppSelector((state) => state.dashboardLayout.workflowCards);
  const workflowsHub = useAppSelector((state) => state.dashboardLayout.workflowsHub);
  const pendingFocusWorkflowId = useAppSelector((state) => state.dashboardLayout.pendingFocusWorkflowId);
  const pendingFocusWorkflowsHub = useAppSelector((state) => state.dashboardLayout.pendingFocusWorkflowsHub);
  const workflowItems = useAppSelector((state) => state.workflows.items);
  const workflowOpenCards = useAppSelector((state) => state.workflows.openCards);
  const notes = useAppSelector((state) => state.dashboardLayout.notes);
  const pendingFocusNoteId = useAppSelector((state) => state.dashboardLayout.pendingFocusNoteId);
  const layoutInitialized = useAppSelector((state) => state.dashboardLayout.initialized);
  const persistedExpandedSessionIds = useAppSelector((state) => state.dashboardLayout.persistedExpandedSessionIds);
  const zoomSensitivity = useAppSelector((state) => state.settings.data.zoom_sensitivity);
  const newAgentShortcut = useAppSelector((state) => state.settings.data.new_agent_shortcut);
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const expandNewChats = useAppSelector((state) => state.settings.data.expand_new_chats_in_dashboard);
  const autoRevealSubAgents = useAppSelector((state) => state.settings.data.auto_reveal_sub_agents);
  const outputs = useAppSelector((state) => state.outputs.items);
  const outputsLoaded = useAppSelector((state) => state.outputs.loaded);
  const glowingAgentCards = useAppSelector((state) => state.dashboardLayout.glowingAgentCards);
  const glowingBrowserCards = useAppSelector((state) => state.dashboardLayout.glowingBrowserCards);

  return {
    dashboardName,
    sessions,
    expandedSessionIds,
    cards,
    viewCards,
    browserCards,
    keepAliveBrowserCards,
    workflowCards,
    workflowItems,
    workflowOpenCards,
    workflowsHub,
    pendingFocusWorkflowId,
    pendingFocusWorkflowsHub,
    notes,
    pendingFocusNoteId,
    layoutInitialized,
    persistedExpandedSessionIds,
    zoomSensitivity,
    newAgentShortcut,
    browserHomepage,
    expandNewChats,
    autoRevealSubAgents,
    outputs,
    outputsLoaded,
    glowingAgentCards,
    glowingBrowserCards,
  };
}
