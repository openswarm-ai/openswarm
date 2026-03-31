import type { ReactNode } from 'react';
import type { Toolkit } from '@assistant-ui/react';
import { MessageDraft } from '@/components/tool-ui/message-draft';
import { DataTable } from '@/components/tool-ui/data-table';
import {
  parseMcpToolName, getGmailHeader, formatTimestamp, stripHtml,
} from '../toolCallUtils';

export { BrowserFeedTracker } from './mcp-browser-feed';

// -- Helpers ----------------------------------------------------------------

/** Unwrap MCP result (string / content-block array / object) into data. */
export function extractMcpData(result: unknown): Record<string, any> {
  if (result == null) return {};

  let text: string | undefined;

  if (typeof result === 'string') {
    text = result;
  } else if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const k of ['text', 'output', 'content', 'result']) {
      if (typeof r[k] === 'string') { text = r[k] as string; break; }
    }
    if (text === undefined) return result as Record<string, any>;
  } else {
    return {};
  }

  if (!text) return {};

  try {
    let parsed = JSON.parse(text);
    if (
      Array.isArray(parsed) &&
      parsed.some((b: any) => b?.type === 'text' && typeof b?.text === 'string')
    ) {
      const joined = parsed
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      try { parsed = JSON.parse(joined); } catch { return {}; }
    }
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* not JSON */ }

  return {};
}

export function extractEmailFields(msg: any) {
  const subject = msg.subject || getGmailHeader(msg, 'Subject') || '(no subject)';
  const from = msg.from || msg.sender || getGmailHeader(msg, 'From') || '';
  const to = msg.to || msg.recipient || getGmailHeader(msg, 'To') || '';
  const rawDate = msg.date || msg.internalDate || msg.receivedAt || getGmailHeader(msg, 'Date') || '';
  const date = formatTimestamp(rawDate);
  const snippet = msg.snippet || '';
  const body = msg.body || msg.text || msg.textBody || '';
  const htmlBody = msg.htmlBody || msg.html || '';
  const bodyPreview = body || (htmlBody ? stripHtml(htmlBody) : '');
  return { subject, from, to, date, snippet, bodyPreview };
}

// -- Gmail → MessageDraft / DataTable ---------------------------------------

function renderGmailSingle(data: Record<string, any>, toolCallId: string): ReactNode {
  const email = extractEmailFields(data);
  const raw = email.to || '';
  const toArray = typeof raw === 'string'
    ? raw.split(',').map((s: string) => s.trim()).filter(Boolean)
    : Array.isArray(raw) ? raw : [];

  return (
    <MessageDraft
      id={`gmail-${toolCallId}`}
      channel="email"
      subject={email.subject || '(no subject)'}
      from={email.from || undefined}
      to={toArray.length > 0 ? toArray : ['(unknown)']}
      body={email.bodyPreview || email.snippet || '(empty)'}
      outcome="sent"
    />
  );
}

function renderGmailList(messages: any[], toolCallId: string): ReactNode {
  return (
    <DataTable
      id={`gmail-list-${toolCallId}`}
      rowIdKey="id"
      columns={[
        { key: 'from', label: 'From', priority: 'primary' as const },
        { key: 'subject', label: 'Subject' },
        { key: 'date', label: 'Date', format: { kind: 'date' as const, dateFormat: 'relative' as const } },
        { key: 'snippet', label: 'Preview', truncate: true },
      ]}
      data={messages.map((msg, i) => {
        const f = extractEmailFields(msg);
        return {
          id: String(i),
          from: f.from,
          subject: f.subject,
          date: f.date,
          snippet: (f.snippet || f.bodyPreview || '').slice(0, 120),
        };
      })}
    />
  );
}

function renderGmailResult(data: Record<string, any>, action: string, toolCallId: string): ReactNode {
  const isSearch = action.includes('search') || action.includes('list');
  const messages: any[] = data.messages || (isSearch && data.results ? data.results : []);
  if (messages.length > 0) return renderGmailList(messages, toolCallId);
  return renderGmailSingle(data, toolCallId);
}

// -- Calendar → DataTable ---------------------------------------------------

function renderCalendarResult(data: Record<string, any>, toolCallId: string): ReactNode {
  const items: any[] = data.items || (Array.isArray(data) ? data : []);
  const single = !items.length && (data.summary || data.start) ? data : null;
  const rows = single ? [single] : items;
  if (rows.length === 0) return null;

  return (
    <DataTable
      id={`calendar-${toolCallId}`}
      rowIdKey="id"
      columns={[
        { key: 'summary', label: 'Event', priority: 'primary' as const },
        { key: 'start', label: 'Start', format: { kind: 'date' as const, dateFormat: 'short' as const } },
        { key: 'end', label: 'End', format: { kind: 'date' as const, dateFormat: 'short' as const } },
        { key: 'location', label: 'Location' },
      ]}
      data={rows.map((item, i) => ({
        id: String(i),
        summary: item.summary || '(no title)',
        start: item.start?.dateTime || item.start?.date || item.start || '',
        end: item.end?.dateTime || item.end?.date || item.end || '',
        location: item.location || '',
      }))}
    />
  );
}

// -- Drive → DataTable ------------------------------------------------------

function renderDriveResult(data: Record<string, any>, toolCallId: string): ReactNode {
  const files: any[] = data.files || (Array.isArray(data) ? data : []);
  const single = !files.length && data.name ? data : null;
  const rows = single ? [single] : files;
  if (rows.length === 0) return null;

  return (
    <DataTable
      id={`drive-${toolCallId}`}
      rowIdKey="id"
      columns={[
        { key: 'name', label: 'File', priority: 'primary' as const },
        { key: 'mimeType', label: 'Type' },
      ]}
      data={rows.map((f, i) => ({
        id: String(i),
        name: f.name || f.id || '',
        mimeType: f.mimeType?.split('/').pop() || '',
      }))}
    />
  );
}

// -- Generic MCP fallback → DataTable (key / value) -------------------------

function renderGenericMcp(data: Record<string, any>, toolCallId: string): ReactNode {
  const entries = Object.entries(data).filter(([, v]) => v != null);
  if (entries.length === 0) return null;

  return (
    <DataTable
      id={`mcp-generic-${toolCallId}`}
      rowIdKey="id"
      columns={[
        { key: 'field', label: 'Field', priority: 'primary' as const },
        { key: 'value', label: 'Value' },
      ]}
      data={entries.slice(0, 20).map(([key, val], i) => ({
        id: String(i),
        field: key,
        value: typeof val === 'object'
          ? JSON.stringify(val, null, 2).slice(0, 500)
          : String(val).slice(0, 500),
      }))}
    />
  );
}

// -- MCP result dispatch ----------------------------------------------------

/** Render already-parsed MCP data (used by ToolCallBubble). */
export function renderParsedMcpData(
  service: string, action: string, data: Record<string, any>, toolCallId: string,
): ReactNode | null {
  if (data.error || data.is_error) return null;
  switch (service) {
    case 'gmail': return renderGmailResult(data, action, toolCallId);
    case 'calendar': return renderCalendarResult(data, toolCallId);
    case 'drive': case 'sheets': return renderDriveResult(data, toolCallId);
    default:
      return Object.keys(data).length > 0 ? renderGenericMcp(data, toolCallId) : null;
  }
}

/** Full MCP dispatch — parses raw tool name + result, routes to renderer. */
export function renderMcpResult(
  toolName: string, result: unknown, toolCallId: string,
): ReactNode | null {
  const mcpInfo = parseMcpToolName(toolName);
  const data = extractMcpData(result);
  return renderParsedMcpData(mcpInfo.service, mcpInfo.action, data, toolCallId);
}

// -- Exported toolkit (empty — MCP tool names are dynamic; Agent 7 wires) ---

export const mcpToolkit: Partial<Toolkit> = {};
