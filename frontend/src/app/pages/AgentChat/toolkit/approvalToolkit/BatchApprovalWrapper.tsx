import React, { useMemo, useCallback } from 'react';
import type { ApprovalRequest } from '@/shared/state/agentsSlice';
import { ToolQuestion } from './components/ToolQuestion/ToolQuestion';
import { ToolApproval } from './components/ToolApproval';
import { ApprovalRouter } from './ApprovalRouter';

interface BatchApprovalWrapperProps {
  requests: ApprovalRequest[];
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
}

export const BatchApprovalWrapper: React.FC<BatchApprovalWrapperProps> = ({
  requests, onApprove, onDeny,
}) => {
  const questionReqs = useMemo(
    () => requests.filter((r) => r.tool_name === 'AskUserQuestion'),
    [requests],
  );
  const approvalReqs = useMemo(
    () => requests.filter((r) => r.tool_name !== 'AskUserQuestion'),
    [requests],
  );

  const handleApproveAll = useCallback(() => {
    for (const req of approvalReqs) onApprove(req.id);
  }, [approvalReqs, onApprove]);

  const handleDenyAll = useCallback(() => {
    for (const req of approvalReqs) onDeny(req.id);
  }, [approvalReqs, onDeny]);

  return (
    <div className="flex flex-col gap-2 px-2 pb-1">
      {questionReqs.map((req) => (
        <ToolQuestion key={req.id} request={req} onApprove={onApprove} onDeny={onDeny} />
      ))}

      {approvalReqs.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-xl bg-muted/50 px-4 py-2">
            <span className="text-sm font-semibold text-muted-foreground">
              {approvalReqs.length} pending approvals
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="inline-flex items-center rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                onClick={handleApproveAll}
              >
                Approve All
              </button>
              <button
                type="button"
                className="inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors"
                onClick={handleDenyAll}
              >
                Deny All
              </button>
            </div>
          </div>
          {approvalReqs.map((req) => (
            <ToolApproval key={req.id} request={req} onApprove={onApprove} onDeny={onDeny} />
          ))}
        </div>
      )}

      {approvalReqs.length === 1 && (
        <ApprovalRouter request={approvalReqs[0]} onApprove={onApprove} onDeny={onDeny} />
      )}
    </div>
  );
};