import { useAppSelector } from '@/shared/hooks';

// All of the dashboard's Redux reads in one place. Keeps Dashboard.tsx a
// thin composition layer instead of a 25-line selector wall.
export function useDashboardSelectors(dashboardId: string) {
  const dashboardName = useAppSelector((state) =>
    dashboardId ? state.dashboards.items[dashboardId]?.name : undefined,
  );
  const sessions = useAppSelector((state) => state.agents.sessions);
  const expandedSessionIds = useAppSelector((state) => state.agents.expandedSessionIds);
  const cards = useAppSelector((state) => state.dashboardLayout.cards);
  const viewCards = useAppSelector((state) => state.dashboardLayout.viewCards);
  const browserCards = useAppSelector((state) => state.dashboardLayout.browserCards);
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
