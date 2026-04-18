import { AgentSession } from '@/shared/state/agentsSlice';
import { parseMcpToolName } from '@/app/pages/AgentChat/toolkit/approvalToolkit/utils';

export function formatDuration(createdAt: string, closedAt?: string | null, status?: string): string {
  const start = new Date(createdAt).getTime();
  const end = (closedAt ? new Date(closedAt).getTime() : null)
    || (status === 'running' || status === 'waiting_approval' ? Date.now() : Date.now());
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function summarizeToolInput(toolName: string, toolInput: Record<string, any>): string {
  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) {
    const keys = Object.keys(toolInput || {});
    if (keys.length === 0) return '';
    if (keys.length === 1) {
      const v = toolInput[keys[0]];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 60) + '…' : s;
    }
    return keys.slice(0, 3).map((k) => {
      const v = toolInput[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${s.length > 30 ? s.slice(0, 30) + '…' : s}`;
    }).join('  ');
  }
  switch (toolName) {
    case 'Bash':
      return toolInput.command || '(command)';
    case 'Read':
      return toolInput.file_path || toolInput.path || '(file)';
    case 'Write':
    case 'Edit':
      return toolInput.file_path || toolInput.path || '(file)';
    case 'Grep':
      return `/${toolInput.pattern || ''}/${toolInput.path ? ` in ${toolInput.path}` : ''}`;
    case 'Glob':
      return toolInput.glob_pattern || toolInput.pattern || '(pattern)';
    case 'AskUserQuestion': {
      const questions = toolInput.questions;
      if (Array.isArray(questions) && questions.length > 0) {
        return questions[0].question || questions[0].prompt || questions[0].text || 'Question pending';
      }
      return 'Question pending';
    }
    default: {
      return toolInput.command || toolInput.file_path || toolInput.path || toolInput.query
        || JSON.stringify(toolInput).slice(0, 60);
    }
  }
}

export function getToolDisplayName(toolName: string): string {
  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) return mcp.displayName;
  return toolName;
}

export function getStatusColors(c: Record<string, any>): Record<string, { color: string; bg: string }> {
  return {
    running: { color: c.status.success, bg: c.status.successBg },
    waiting_approval: { color: c.status.warning, bg: c.status.warningBg },
    completed: { color: c.text.tertiary, bg: c.bg.secondary },
    error: { color: c.status.error, bg: c.status.errorBg },
    stopped: { color: c.text.tertiary, bg: c.bg.secondary },
    draft: { color: c.accent.primary, bg: c.bg.secondary },
  };
}

export function getPreviewContent(session: AgentSession): { content: string; isStreaming: boolean } {
  const isStreaming = !!session.streamingMessage;
  if (isStreaming) {
    const msg = session.streamingMessage!;
    const text = msg.role === 'tool_call'
      ? `[${getToolDisplayName(msg.tool_name || '')}] ${msg.content}`
      : msg.content;
    return { content: String(text || '').slice(0, 120), isStreaming: true };
  }
  const last = session.messages[session.messages.length - 1];
  return { content: last && typeof last.content === 'string' ? last.content.slice(0, 120) : '', isStreaming: false };
}
