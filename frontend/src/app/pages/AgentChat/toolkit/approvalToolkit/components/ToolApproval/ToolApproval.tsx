import React, { useMemo } from 'react';
import { ApprovalCard } from './ApprovalCard/ApprovalCard';
import type { ApprovalRequest } from '@/shared/state/agentsSlice';
import { useMcpToolMeta } from '../useMcpToolMeta';
import {
  parseMcpToolName,
} from '../../utils';
import { getMcpInputSummary } from '../getMcpInputSummary';
// TODO: what is this even supposed to try and import/use ???
import type { MetadataItem } from '@/components/tool-ui/ApprovalCard/schema';



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


const TOOL_ICON_MAP: Record<string, string> = {
  Bash: 'terminal',
  Read: 'file-text',
  Write: 'file-pen',
  Edit: 'file-pen',
  Grep: 'search',
  Glob: 'search',
  AskUserQuestion: 'message-circle-question',
};

function getToolIconName(toolName: string): string {
  return TOOL_ICON_MAP[toolName] ?? 'wrench';
}

function buildMetadata(toolInput: Record<string, any>): MetadataItem[] {
  return Object.entries(toolInput)
    .filter(([, v]) => v != null)
    .slice(0, 5)
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string'
        ? value.slice(0, 200)
        : JSON.stringify(value).slice(0, 200),
    }));
}

const DANGEROUS_PATTERNS = /\b(rm\s|rmdir|del\s|delete|drop\s|truncate|format)\b/i;

function isDangerous(toolName: string, toolInput: Record<string, any>): boolean {
  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    return DANGEROUS_PATTERNS.test(cmd);
  }
  return false;
}



// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------



interface ToolApprovalProps {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
}

export const ToolApproval: React.FC<ToolApprovalProps> = ({ request, onApprove, onDeny }) => {
  const parsed = useMemo(() => parseMcpToolName(request.tool_name), [request.tool_name]);
  const meta = useMcpToolMeta(parsed);
  const summary = parsed.isMcp
    ? getMcpInputSummary(parsed.actionName, request.tool_input)
    : '';

  return (
    <ApprovalCard
      id={request.id}
      title={parsed.isMcp ? parsed.displayName : `Run ${request.tool_name}`}
      description={meta.description || summary || undefined}
      icon={parsed.isMcp ? 'puzzle' : getToolIconName(request.tool_name)}
      metadata={buildMetadata(request.tool_input)}
      variant={isDangerous(request.tool_name, request.tool_input) ? 'destructive' : 'default'}
      confirmLabel="Approve"
      cancelLabel="Deny"
      onConfirm={() => onApprove(request.id)}
      onCancel={() => onDeny(request.id)}
    />
  );
};