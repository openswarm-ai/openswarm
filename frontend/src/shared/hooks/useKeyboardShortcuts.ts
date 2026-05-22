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
      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      // Double-guard: e.target AND document.activeElement. A bare-letter
      // shortcut would otherwise fire if focus is on a wrapper Box and the
      // child input never received it, kicking the user out mid-type.
      const isInputLike = (el: HTMLElement | null) =>
        !!el && (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          !!el.closest('input, textarea, [contenteditable="true"]')
        );
      if (isInputLike(target) || isInputLike(active)) return;

      // Mod-gated shortcuts only. Bare letters were footguns: typing the
      // letter "d" anywhere outside a tagged input field used to navigate
      // home, which surprised users typing workflow titles/descriptions.
      if (e.key.toLowerCase() === 'd' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        navigate('/');
        return;
      }

      if (e.key === 'A' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        for (const session of Object.values(sessions)) {
          for (const req of session.pending_approvals) {
            dispatch(handleApproval({ requestId: req.id, behavior: 'allow' }));
          }
        }
        return;
      }

      if (e.key === 'D' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        for (const session of Object.values(sessions)) {
          for (const req of session.pending_approvals) {
            dispatch(handleApproval({ requestId: req.id, behavior: 'deny' }));
          }
        }
        return;
      }

      if (e.key >= '1' && e.key <= '9' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
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
