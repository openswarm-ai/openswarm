import type { ApprovalRequest, AgentSession } from '@/shared/state/agentsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

export type ClaudeTokens = ReturnType<typeof useClaudeTokens>;

export type IslandState = 'idle' | 'compact' | 'compact-actionable' | 'expanded';

export interface SessionApprovalGroup {
  sessionId: string;
  sessionName: string;
  approvals: ApprovalRequest[];
}

export type TrackedAgent = {
  id: string;
  name: string;
  status: AgentSession['status'] | string;
  dashboardId?: string;
};

export const STATUS_CONFIG: Record<string, { label: string; tokenKey?: string }> = {
  running:          { label: 'Running',  tokenKey: 'success' },
  waiting_approval: { label: 'Waiting',  tokenKey: 'warning' },
  completed:        { label: 'Done',     tokenKey: 'success' },
  error:            { label: 'Error',    tokenKey: 'error' },
  stopped:          { label: 'Stopped',  tokenKey: 'info' },
};

export const SPRING_LAYOUT = { type: 'spring' as const, stiffness: 400, damping: 30 };
export const SPRING_BOUNCE = { type: 'spring' as const, stiffness: 500, damping: 25 };
