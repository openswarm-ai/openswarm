import { useCallback, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  editMessage,
  switchBranch,
  duplicateSession,
  setActiveSession,
  type AgentMessage,
  type AgentSession,
} from '@/shared/state/agentsSlice';

// Message edit / regenerate / branch actions (AGENTCHAT_SPLIT_PLAN follow-up): the editing-message
// state and every handler the transcript action bar fires. Lifted verbatim from AgentChat.
export function useBranchActions({
  id,
  session,
  activeBranchMessages,
  onBranch,
}: {
  id: string | undefined;
  session: AgentSession | undefined;
  activeBranchMessages: AgentMessage[];
  onBranch?: (newSessionId: string) => void;
}) {
  const dispatch = useAppDispatch();
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const handleSaveEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!id) return;
      dispatch(editMessage({ sessionId: id, messageId, content: newContent }));
      setEditingMessageId(null);
    },
    [id, dispatch]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleRegenerate = useCallback(
    (assistantMsg: AgentMessage) => {
      if (!id) return;
      const idx = activeBranchMessages.findIndex((m) => m.id === assistantMsg.id);
      for (let i = idx - 1; i >= 0; i--) {
        if (activeBranchMessages[i].role === 'user') {
          const userMsg = activeBranchMessages[i];
          const content = typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content);
          dispatch(editMessage({ sessionId: id, messageId: userMsg.id, content }));
          break;
        }
      }
    },
    [id, activeBranchMessages, dispatch]
  );

  const handleBranchChat = useCallback(async (upToMessageId: string) => {
    if (!id) return;
    const dashId = session?.dashboard_id;
    const action = await dispatch(duplicateSession({ sessionId: id, dashboardId: dashId, upToMessageId }));
    if (duplicateSession.fulfilled.match(action)) {
      if (onBranch) {
        onBranch(action.payload.id);
      } else {
        dispatch(setActiveSession(action.payload.id));
      }
    }
  }, [id, dispatch, onBranch, session?.dashboard_id]);

  const handleSwitchBranch = useCallback((branchId: string) => {
    if (id) dispatch(switchBranch({ sessionId: id, branchId }));
  }, [id, dispatch]);

  return {
    editingMessageId,
    setEditingMessageId,
    handleSaveEdit,
    handleCancelEdit,
    handleRegenerate,
    handleBranchChat,
    handleSwitchBranch,
  };
}
