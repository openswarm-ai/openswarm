import { useCallback, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch } from '@/shared/hooks';
import {
  dismissAgentNotification,
  dismissAllFinishedNotifications,
} from '@/shared/state/agentsSlice';
import { HANDLE_APPROVAL, STOP_AGENT } from '@/shared/backend-bridge/apps/agents';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import type { IslandState, SessionApprovalGroup } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export function useDynamicIslandActions(
  groups: SessionApprovalGroup[],
  islandState: IslandState,
  hasAgents: boolean,
  hasApprovals: boolean,
  setUserExpanded: (v: boolean) => void,
  islandRef: MutableRefObject<HTMLDivElement | null>,
) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    if (!hasAgents && !hasApprovals) {
      setUserExpanded(false);
    }
  }, [hasAgents, hasApprovals, setUserExpanded]);

  useEffect(() => {
    if (islandState !== 'expanded') return;
    const handler = (e: MouseEvent) => {
      if (islandRef.current && !islandRef.current.contains(e.target as Node)) {
        setUserExpanded(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [islandState, islandRef, setUserExpanded]);

  const onApprove = useCallback(
    (requestId: string, updatedInput?: Record<string, unknown>) => {
      dispatch(HANDLE_APPROVAL({ requestId, behavior: 'allow', updatedInput }));
    },
    [dispatch],
  );

  const onDeny = useCallback(
    (requestId: string, message?: string) => {
      dispatch(HANDLE_APPROVAL({ requestId, behavior: 'deny', message }));
    },
    [dispatch],
  );

  const onStopAgent = useCallback(
    (sessionId: string) => dispatch(STOP_AGENT(sessionId)),
    [dispatch],
  );

  const onDismissAgent = useCallback(
    (sessionId: string) => dispatch(dismissAgentNotification(sessionId)),
    [dispatch],
  );

  const onNavigateToDashboard = useCallback(
    (dashboardId: string, agentId: string) => {
      dispatch(setPendingFocusAgentId(agentId));
      navigate(`/dashboard/${dashboardId}`);
    },
    [navigate, dispatch],
  );

  const onApproveAllNonQuestion = useCallback(() => {
    for (const g of groups) {
      for (const req of g.approvals) {
        if (req.tool_name !== 'AskUserQuestion') {
          dispatch(HANDLE_APPROVAL({ requestId: req.id, behavior: 'allow' }));
        }
      }
    }
  }, [dispatch, groups]);

  const onDenyAllNonQuestion = useCallback(() => {
    for (const g of groups) {
      for (const req of g.approvals) {
        if (req.tool_name !== 'AskUserQuestion') {
          dispatch(HANDLE_APPROVAL({ requestId: req.id, behavior: 'deny' }));
        }
      }
    }
  }, [dispatch, groups]);

  const onClearAllFinished = useCallback(() => {
    dispatch(dismissAllFinishedNotifications());
  }, [dispatch]);

  const handleIslandClick = useCallback(() => {
    if (islandState === 'compact' || islandState === 'compact-actionable') {
      setUserExpanded(true);
    } else if (islandState === 'expanded') {
      setUserExpanded(false);
    }
  }, [islandState, setUserExpanded]);

  return {
    onApprove,
    onDeny,
    onStopAgent,
    onDismissAgent,
    onNavigateToDashboard,
    onApproveAllNonQuestion,
    onDenyAllNonQuestion,
    onClearAllFinished,
    handleIslandClick,
  };
}
