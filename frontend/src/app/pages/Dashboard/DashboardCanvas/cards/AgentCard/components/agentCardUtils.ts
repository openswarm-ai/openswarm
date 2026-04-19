import { AgentSession } from '@/shared/state/agentsSlice';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { getToolDisplayName } from './AgentCardCollapsed/components/getToolDisplayName';

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

export function getStatusColors(c: ClaudeTokens): Record<string, { color: string; bg: string }> {
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
