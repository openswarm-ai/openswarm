import React from 'react';
import type { ApprovalRequest } from '@/shared/state/agentsSlice';
import { ToolQuestion } from './components/ToolQuestion/ToolQuestion';
import { ToolApproval } from './components/ToolApproval';

interface ApprovalRouterProps {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
}

export const ApprovalRouter: React.FC<ApprovalRouterProps> = (props) => {
  if (props.request.tool_name === 'AskUserQuestion') {
    return <ToolQuestion {...props} />;
  }
  return <ToolApproval {...props} />;
};
