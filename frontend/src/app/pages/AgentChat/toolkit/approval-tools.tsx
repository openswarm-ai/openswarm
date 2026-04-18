import React, { useMemo, useCallback } from 'react';
import type { Toolkit } from '@assistant-ui/react';
import { ApprovalCard } from '@/components/tool-ui/ApprovalCard/ApprovalCard';
import type { ApprovalRequest } from '@/shared/state/agentsSlice';
import { useAppSelector } from '@/shared/hooks';
import type { ToolDefinition } from '@/shared/state/toolsSlice';
import {
  parseMcpToolName, sanitizeServerName, getMcpInputSummary,
  getToolIconName, buildMetadata, isDangerous,
  INTEGRATION_META,
  type ParsedTool, type McpToolMeta,
} from './approval-utils';
import { ToolQuestion } from './approval-question';

// ---------------------------------------------------------------------------
// useMcpToolMeta (React hook — lives here alongside other component code)
// ---------------------------------------------------------------------------

export function useMcpToolMeta(parsed: ParsedTool): McpToolMeta {
  const toolItems = useAppSelector((s) => s.tools.items);

  return useMemo(() => {
    if (!parsed.isMcp) {
      return { integration: null, description: '', serverLabel: '' };
    }

    const toolDef: ToolDefinition | undefined = Object.values(toolItems).find(
      (t) => t.mcp_config && Object.keys(t.mcp_config).length > 0
        && sanitizeServerName(t.name) === parsed.serverSlug,
    );

    if (!toolDef) {
      return { integration: null, description: '', serverLabel: parsed.serverSlug };
    }

    const description = toolDef.tool_permissions?._tool_descriptions?.[parsed.actionName] || '';
    const integration = INTEGRATION_META[toolDef.name] || null;
    const serverLabel = toolDef.name;

    return { integration, description, serverLabel };
  }, [parsed, toolItems]);
}

// ---------------------------------------------------------------------------
// ToolApproval
// ---------------------------------------------------------------------------

interface ToolApprovalProps {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
}

const ToolApproval: React.FC<ToolApprovalProps> = ({ request, onApprove, onDeny }) => {
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

// ---------------------------------------------------------------------------
// BatchApprovalWrapper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ApprovalRouter (replaces old ApprovalBar default export)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Toolkit export (empty — approvals are standalone, not thread tool renderers)
// ---------------------------------------------------------------------------

export const approvalToolkit: Partial<Toolkit> = {};
