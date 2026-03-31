import React, { useMemo, useEffect, useRef } from 'react';
import { createSelector } from '@reduxjs/toolkit';
import { ProgressTracker } from '@/components/tool-ui/progress-tracker';
import type { ProgressStep } from '@/components/tool-ui/progress-tracker';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import type { AgentSession, AgentMessage } from '@/shared/state/agentsSlice';
import { fetchBrowserAgentChildren } from '@/shared/state/agentsSlice';
import type { RootState } from '@/shared/state/store';

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const selectBrowserSessions = createSelector(
  [
    (state: RootState) => state.agents.sessions,
    (_: RootState, parentSessionId: string) => parentSessionId,
    (_: RootState, __: string, browserId?: string) => browserId,
  ],
  (sessions, parentSessionId, browserId) =>
    Object.values(sessions).filter(
      (s): s is AgentSession =>
        s.mode === 'browser-agent' &&
        s.parent_session_id === parentSessionId &&
        (!browserId || s.browser_id === browserId),
    ),
);

// ---------------------------------------------------------------------------
// Message → step conversion
// ---------------------------------------------------------------------------

function formatBrowserAction(content: any): { label: string; description: string } {
  const tool = content?.tool || content?.name || '?';
  const input = content?.input || {};

  switch (tool) {
    case 'BrowserNavigate':
      return { label: 'Navigate', description: input.url || '...' };
    case 'BrowserClick':
      return { label: 'Click', description: input.selector || '...' };
    case 'BrowserType': {
      const txt = (input.text || '').slice(0, 40);
      const ellipsis = (input.text || '').length > 40 ? '…' : '';
      return { label: 'Type', description: `"${txt}${ellipsis}" → ${input.selector || '...'}` };
    }
    case 'BrowserScreenshot':
      return { label: 'Screenshot', description: 'Capture page' };
    case 'BrowserGetText':
      return { label: 'Read text', description: 'Get page content' };
    case 'BrowserGetElements':
      return { label: 'Inspect', description: input.selector ? `Elements (${input.selector})` : 'Elements' };
    case 'BrowserEvaluate':
      return { label: 'Execute JS', description: 'Run script' };
    default:
      return { label: tool, description: JSON.stringify(input).slice(0, 60) };
  }
}

function messagesToSteps(messages: AgentMessage[]): ProgressStep[] {
  const steps: ProgressStep[] = [];
  const pendingCalls = new Map<string, number>();

  for (const msg of messages) {
    if (msg.role === 'tool_call') {
      const content =
        typeof msg.content === 'string'
          ? (() => { try { return JSON.parse(msg.content); } catch { return {}; } })()
          : msg.content;

      const { label, description } = formatBrowserAction(content);
      const stepId = content?.id || `step-${steps.length}`;

      steps.push({ id: stepId, label, description, status: 'in-progress' });
      if (content?.id) pendingCalls.set(content.id, steps.length - 1);
    } else if (msg.role === 'tool_result') {
      const content =
        typeof msg.content === 'string'
          ? (() => { try { return JSON.parse(msg.content); } catch { return { text: msg.content }; } })()
          : msg.content;

      const callId = content?.tool_call_id || content?.id;
      if (callId && pendingCalls.has(callId)) {
        const idx = pendingCalls.get(callId)!;
        steps[idx] = {
          ...steps[idx],
          status: content?.is_error || content?.error ? 'failed' : 'completed',
        };
        pendingCalls.delete(callId);
      } else {
        const lastIdx = [...pendingCalls.values()].pop();
        if (lastIdx !== undefined) {
          steps[lastIdx] = {
            ...steps[lastIdx],
            status: content?.is_error || content?.error ? 'failed' : 'completed',
          };
          for (const [k, v] of pendingCalls) {
            if (v === lastIdx) { pendingCalls.delete(k); break; }
          }
        }
      }
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BrowserFeedTrackerProps {
  parentSessionId: string;
  browserId?: string;
}

export const BrowserFeedTracker: React.FC<BrowserFeedTrackerProps> = ({
  parentSessionId,
  browserId,
}) => {
  const dispatch = useAppDispatch();
  const fetchedRef = useRef<string | null>(null);

  const browserSessions = useAppSelector((state) =>
    selectBrowserSessions(state, parentSessionId, browserId),
  );

  useEffect(() => {
    if (browserSessions.length === 0 && fetchedRef.current !== parentSessionId) {
      fetchedRef.current = parentSessionId;
      dispatch(fetchBrowserAgentChildren(parentSessionId))
        .unwrap()
        .catch(() => { fetchedRef.current = null; });
    }
  }, [browserSessions.length, parentSessionId, dispatch]);

  const allSteps = useMemo(() => {
    const raw: ProgressStep[] = [];
    for (const session of browserSessions) {
      raw.push(...messagesToSteps(session.messages));
    }
    if (raw.length === 0) return raw;

    const seen = new Set<string>();
    return raw.map((step, i) => {
      let id = step.id;
      if (seen.has(id)) id = `${id}-${i}`;
      seen.add(id);
      return { ...step, id };
    });
  }, [browserSessions]);

  if (browserSessions.length === 0 || allSteps.length === 0) return null;

  const allDone = allSteps.every((s) => s.status === 'completed' || s.status === 'failed');
  const hasFailed = allSteps.some((s) => s.status === 'failed');

  return (
    <ProgressTracker
      id={`browser-feed-${parentSessionId}`}
      steps={allSteps}
      choice={
        allDone
          ? {
              outcome: hasFailed ? 'partial' as const : 'success' as const,
              summary: hasFailed ? 'Completed with errors' : 'All steps completed',
              at: new Date().toISOString(),
            }
          : undefined
      }
    />
  );
};
