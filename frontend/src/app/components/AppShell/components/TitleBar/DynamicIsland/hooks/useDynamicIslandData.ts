import { useMemo, useState } from 'react';
import { useAppSelector } from '@/shared/hooks';
import type { HistorySession } from '@/shared/state/agentsSlice';
import type { IslandState, SessionApprovalGroup, TrackedAgent } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export function useDynamicIslandData() {
  const sessions = useAppSelector((state) => state.agents.sessions);
  const history = useAppSelector((state) => state.agents.history);
  const trackedIds = useAppSelector((state) => state.agents.trackedNotificationIds);

  const [userExpanded, setUserExpanded] = useState(false);

  const groups: SessionApprovalGroup[] = useMemo(() => {
    const result: SessionApprovalGroup[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.pending_approvals?.length > 0) {
        result.push({
          sessionId,
          sessionName: session.name || 'Agent',
          approvals: session.pending_approvals,
        });
      }
    }
    return result;
  }, [sessions]);

  const totalApprovals = useMemo(
    () => groups.reduce((sum, g) => sum + g.approvals.length, 0),
    [groups],
  );

  const trackedAgents: TrackedAgent[] = useMemo(() => {
    const agents = trackedIds
      .map((id): TrackedAgent | null => {
        const session = sessions[id];
        if (session && session.status !== 'draft') {
          return { id, name: session.name, status: session.status, dashboardId: session.dashboard_id };
        }
        const hist: HistorySession | undefined = history[id];
        if (hist) {
          return { id, name: hist.name, status: hist.status, dashboardId: hist.dashboard_id };
        }
        return null;
      })
      .filter((a): a is TrackedAgent => a !== null);

    const trackedIdSet = new Set(trackedIds);
    for (const g of groups) {
      if (!trackedIdSet.has(g.sessionId)) {
        const session = sessions[g.sessionId];
        if (session && session.status !== 'draft') {
          agents.push({ id: g.sessionId, name: session.name, status: session.status, dashboardId: session.dashboard_id });
        }
      }
    }

    return agents;
  }, [trackedIds, sessions, history, groups]);

  const activeAgents = useMemo(
    () => trackedAgents.filter((a) => a.status === 'running' || a.status === 'waiting_approval'),
    [trackedAgents],
  );
  const finishedAgents = useMemo(
    () => trackedAgents.filter((a) => a.status !== 'running' && a.status !== 'waiting_approval'),
    [trackedAgents],
  );

  const hasApprovals = totalApprovals > 0;
  const hasAgents = trackedAgents.length > 0;

  const hasOnlyQuestionApprovals = useMemo(() => {
    if (!hasApprovals) return false;
    const allApprovals = groups.flatMap((g) => g.approvals);
    return allApprovals.every((a) => a.tool_name === 'AskUserQuestion');
  }, [hasApprovals, groups]);

  const nonQuestionApprovalCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.approvals.filter((a) => a.tool_name !== 'AskUserQuestion').length, 0),
    [groups],
  );

  const oldestNonQuestionApproval = useMemo(() => {
    const all = groups
      .flatMap((g) => g.approvals)
      .filter((a) => a.tool_name !== 'AskUserQuestion');
    if (all.length === 0) return null;
    return all.reduce((oldest, a) =>
      a.created_at < oldest.created_at ? a : oldest,
    );
  }, [groups]);

  const islandState: IslandState = useMemo(() => {
    if (userExpanded && (hasAgents || hasApprovals)) return 'expanded';
    if (hasApprovals && hasOnlyQuestionApprovals) return 'expanded';
    if (hasApprovals) return 'compact-actionable';
    if (hasAgents) return 'compact';
    return 'idle';
  }, [hasApprovals, hasOnlyQuestionApprovals, userExpanded, hasAgents]);

  return {
    groups,
    totalApprovals,
    activeAgents,
    finishedAgents,
    hasApprovals,
    hasAgents,
    nonQuestionApprovalCount,
    oldestNonQuestionApproval,
    islandState,
    userExpanded,
    setUserExpanded,
  };
}
