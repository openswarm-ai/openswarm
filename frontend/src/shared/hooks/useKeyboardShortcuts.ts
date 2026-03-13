import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { handleApproval, setActiveSession } from '@/shared/state/agentsSlice';

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const sessions = useAppSelector((state) => state.agents.sessions);

  const handler = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (isInput) return;

      if (e.key === 'd' && !e.metaKey && !e.ctrlKey) {
        navigate('/');
        return;
      }
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) {
        navigate('/templates');
        return;
      }

      if (e.key === 'A' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        for (const session of Object.values(sessions)) {
          for (const req of session.pending_approvals) {
            dispatch(handleApproval({ requestId: req.id, behavior: 'allow' }));
          }
        }
        return;
      }

      if (e.key === 'D' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        for (const session of Object.values(sessions)) {
          for (const req of session.pending_approvals) {
            dispatch(handleApproval({ requestId: req.id, behavior: 'deny' }));
          }
        }
        return;
      }

      if (e.key >= '1' && e.key <= '9' && !e.metaKey && !e.ctrlKey) {
        const idx = parseInt(e.key) - 1;
        const sessionList = Object.values(sessions).sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        if (sessionList[idx]) {
          navigate('/');
          dispatch(setActiveSession(sessionList[idx].id));
        }
        return;
      }
    },
    [navigate, dispatch, sessions]
  );

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
