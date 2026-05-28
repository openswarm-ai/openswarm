import { parseMcpToolName } from '@/shared/mcpToolMeta';

export function isBrowserAgentTool(name: string): boolean {
  if (name === 'CreateBrowserAgent' || name === 'BrowserAgent' || name === 'BrowserAgents') return true;
  const mcp = parseMcpToolName(name);
  return mcp.isMcp && mcp.serverSlug === 'openswarm-browser-agent';
}

export function isInvokeAgentTool(name: string): boolean {
  if (name === 'InvokeAgent') return true;
  const mcp = parseMcpToolName(name);
  return mcp.isMcp && mcp.serverSlug === 'openswarm-invoke-agent';
}

export function isCreateAgentTool(name: string): boolean {
  return name === 'Agent';
}

export function parseInvokedSessionId(rawText: string): string | null {
  const match = rawText.match(/\(forked session:\s*([a-f0-9]+)\)/);
  return match ? match[1] : null;
}

export interface InvokeAgentParsed {
  agentName: string;
  sessionId: string | null;
  cost: string | null;
  response: string;
}

export function parseCreateAgentResult(rawText: string): string {
  if (!rawText) return '';
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.text) return parsed.text;
      if (parsed.content) return typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
      if (parsed.result) return typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
    }
  } catch {}
  return rawText;
}

export function parseInvokeAgentResult(rawText: string): InvokeAgentParsed | null {
  const headerMatch = rawText.match(
    /\*\*Invoked Agent Result\*\*(?:\s*;\s*(.+?))?\s*\(forked session:\s*([a-f0-9]+)\)/,
  );
  if (!headerMatch) return null;

  const agentName = headerMatch[1]?.trim() || 'Agent';
  const sessionId = headerMatch[2];

  const costMatch = rawText.match(/\*Cost:\s*\$([0-9.]+)\*/);
  const cost = costMatch ? costMatch[1] : null;

  const bodyStart = rawText.indexOf('\n\n');
  let response = bodyStart >= 0 ? rawText.slice(bodyStart + 2).trim() : '';
  if (response.startsWith('*Cost:')) {
    const afterCost = response.indexOf('\n');
    response = afterCost >= 0 ? response.slice(afterCost + 1).trim() : '';
  }

  return { agentName, sessionId, cost, response };
}
