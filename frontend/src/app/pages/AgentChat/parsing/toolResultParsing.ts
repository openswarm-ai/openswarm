import { AgentMessage } from '@/shared/state/agentsSlice';
import { prettyPath, prettyUrl, quoteQuery, bashCommandDetail } from './toolLabels';
import { parseMcpToolName, getMcpInputSummary, getGmailHeader, getWorkflowToolInputDisplay } from '@/shared/mcpToolMeta';
import { isSettingsWriteTool, isSettingsReadTool, settingsWriteSummary, settingsWriteDisplay } from './settingsToolMeta';

export function getToolData(call: AgentMessage) {
  const content = typeof call.content === 'object' ? call.content : {};
  return {
    toolName: content.tool || 'Unknown',
    input: content.input || {},
    isDenied: content.approved === false,
    toolId: content.id,
  };
}

export function isBashTool(name: string) {
  return name === 'Bash' || name === 'bash';
}

export function getInputSummary(toolName: string, input: any): string {
  try {
    // Settings tool first: legible change list, secrets masked. Must precede the generic MCP path (it is an MCP tool) or it renders raw changes JSON.
    if (isSettingsWriteTool(toolName)) return settingsWriteSummary(input);
    if (isSettingsReadTool(toolName)) return '';

    const mcp = parseMcpToolName(toolName);
    if (mcp.isMcp) return getMcpInputSummary(input, mcp.action, mcp.serverSlug);

    const n = toolName.toLowerCase();
    if (isBashTool(toolName)) {
      return bashCommandDetail(input.command || '');
    }
    if (n === 'read' || n === 'write' || n === 'edit' || n === 'multiedit' || n === 'strreplace')
      return prettyPath(input.file_path || input.path || '');
    if (n === 'glob') return input.pattern || input.glob || input.glob_pattern || '';
    if (n === 'grep' || n === 'ripgrep') {
      const pat = input.pattern || input.regex || '';
      const path = input.path || input.directory || '';
      const q = quoteQuery(pat);
      return path ? `${q} in ${prettyPath(path)}` : q;
    }
    if (n === 'websearch') return quoteQuery(input.query || input.search_term || '');
    if (n === 'webfetch') return prettyUrl(input.url || '');
    if (n === 'todoread' || n === 'todowrite') return '';
    if (n === 'ls') return prettyPath(input.path || '.');
    if (n === 'mcpactivate') return '';
    if (n === 'mcpsearch' || n === 'outputsearch') return quoteQuery(input.query || '');
    if (n === 'outputactivate') return input.output_id || '';
    if (n === 'renderoutput') return input.output_id || '';
    return '';
  } catch {
    return '';
  }
}

function formatMcpInputDisplay(input: any): string {
  if (!input || typeof input !== 'object') return String(input ?? '');
  return Object.entries(input)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      return `${k}: ${s}`;
    })
    .join('\n');
}

export function formatInputDisplay(toolName: string, input: any): string {
  try {
    // Masked, one-per-line change list instead of raw changes JSON (which would paint a secret value the agent tried to set).
    if (isSettingsWriteTool(toolName)) return settingsWriteDisplay(input);
    if (isSettingsReadTool(toolName)) return '';

    const mcp = parseMcpToolName(toolName);
    if (mcp.isMcp) {
      const workflowDisplay = getWorkflowToolInputDisplay(input, mcp.action, mcp.serverSlug);
      return workflowDisplay || formatMcpInputDisplay(input);
    }

    const n = toolName.toLowerCase();
    if (isBashTool(toolName)) return input.command || '';
    if (n === 'read') {
      const p = input.file_path || input.path || '';
      const parts = [p];
      if (input.offset) parts.push(`offset: ${input.offset}`);
      if (input.limit) parts.push(`limit: ${input.limit}`);
      return parts.join('  ');
    }
    if (n === 'write') {
      const p = input.file_path || input.path || '';
      const content = input.content || '';
      const preview = content.length > 300 ? content.slice(0, 300) + '\n…' : content;
      return `${p}\n\n${preview}`;
    }
    if (n === 'edit' || n === 'strreplace') {
      const p = input.file_path || input.path || '';
      const old = input.old_string || input.old_text || '';
      const nw = input.new_string || input.new_text || '';
      const lines = [p, ''];
      if (old) {
        const oldPreview = old.length > 200 ? old.slice(0, 200) + '…' : old;
        lines.push(`- ${oldPreview.split('\n').join('\n- ')}`);
      }
      if (nw) {
        const nwPreview = nw.length > 200 ? nw.slice(0, 200) + '…' : nw;
        lines.push(`+ ${nwPreview.split('\n').join('\n+ ')}`);
      }
      return lines.join('\n');
    }
    if (n === 'multiedit') {
      const p = input.file_path || input.path || '';
      const edits = input.edits || [];
      const lines = [p];
      for (const e of edits.slice(0, 3)) {
        const old = e.old_string || e.old_text || '';
        lines.push(`  - ${old.split('\n')[0].slice(0, 60)}…`);
      }
      if (edits.length > 3) lines.push(`  … +${edits.length - 3} more edits`);
      return lines.join('\n');
    }
    if (n === 'glob') return input.pattern || input.glob || input.glob_pattern || '';
    if (n === 'grep' || n === 'ripgrep') {
      const pat = input.pattern || input.regex || '';
      const path = input.path || input.directory || '';
      const parts = [`pattern: ${pat}`];
      if (path) parts.push(`path: ${path}`);
      if (input.include) parts.push(`include: ${input.include}`);
      return parts.join('\n');
    }
    if (n === 'websearch') return input.query || input.search_term || '';
    if (n === 'webfetch') return input.url || '';
  } catch {}
  if (typeof input === 'string') return input;
  return JSON.stringify(input, null, 2);
}

export interface ParsedBashResult {
  type: 'bash';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  platformNote?: string;
}

export interface ParsedTextResult {
  type: 'text';
  content: string;
  isError?: boolean;
  platformNote?: string;
}

export interface ParsedMcpResult {
  type: 'mcp';
  service: string;
  action: string;
  data: Record<string, any>;
  rawText: string;
  platformNote?: string;
}

export type ParsedResult = ParsedBashResult | ParsedTextResult | ParsedMcpResult;

const PLATFORM_NOTE_RE = /<openswarm_platform_note>([\s\S]*?)<\/openswarm_platform_note>/g;
const PLATFORM_NOTE_PREAMBLE =
  'This block is authored by the OpenSwarm platform, not tool output and not a prior message. It is trusted context.';

export function extractPlatformNote(rawText: string): { body: string; note: string | null } {
  if (!rawText.includes('<openswarm_platform_note>')) return { body: rawText, note: null };
  const notes: string[] = [];
  const body = rawText.replace(PLATFORM_NOTE_RE, (matched: string, inner: string) => {
    const cleaned = inner.replace(PLATFORM_NOTE_PREAMBLE, '').trim();
    if (cleaned) notes.push(cleaned);
    return '';
  }).trim();
  return { body, note: notes.length ? notes.join('\n\n') : null };
}

export function parseToolResult(toolName: string, rawTextWithNote: string): ParsedResult {
  const { body: rawText, note } = extractPlatformNote(rawTextWithNote);
  const parsed = parseToolBody(toolName, rawText);
  if (note) parsed.platformNote = note;
  return parsed;
}

function parseToolBody(toolName: string, rawText: string): ParsedResult {
  if (isBashTool(toolName)) {
    try {
      const parsed = JSON.parse(rawText);
      if (typeof parsed === 'object' && parsed !== null && 'stdout' in parsed) {
        const exitMatch = (parsed.stdout || '').match(/[Ee]xit code:\s*(\d+)/);
        return {
          type: 'bash',
          stdout: parsed.stdout || '',
          stderr: parsed.stderr || '',
          exitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
        };
      }
    } catch {}
  }

  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) {
    try {
      let parsed = JSON.parse(rawText);

      if (Array.isArray(parsed) && parsed.some((b: any) => b?.type === 'text' && typeof b?.text === 'string')) {
        const textContent = parsed
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        try {
          parsed = JSON.parse(textContent);
        } catch {
          return { type: 'mcp', service: mcp.service, action: mcp.action, data: {}, rawText: textContent };
        }
      }

      if (typeof parsed === 'object' && parsed !== null) {
        return { type: 'mcp', service: mcp.service, action: mcp.action, data: parsed, rawText };
      }
    } catch {}
    return { type: 'mcp', service: mcp.service, action: mcp.action, data: {}, rawText };
  }

  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed === 'object' && parsed !== null) {
      if ('stdout' in parsed) {
        return { type: 'text', content: parsed.stdout || '' };
      }
      if ('content' in parsed && typeof parsed.content === 'string') {
        return { type: 'text', content: parsed.content, isError: !!parsed.is_error };
      }
      if ('result' in parsed && typeof parsed.result === 'string') {
        return { type: 'text', content: parsed.result };
      }
      if ('output' in parsed && typeof parsed.output === 'string') {
        return { type: 'text', content: parsed.output };
      }
      const n = toolName.toLowerCase();
      if (n === 'glob' && Array.isArray(parsed)) {
        return { type: 'text', content: parsed.join('\n') };
      }
    }
  } catch {}

  return { type: 'text', content: rawText };
}

export function getResultSummary(toolName: string, rawText: string): string {
  const parsed = parseToolResult(toolName, rawText);

  if (parsed.type === 'bash') {
    const lines = parsed.stdout.split('\n').filter((l) => l.trim()).length;
    if (parsed.exitCode !== null && parsed.exitCode !== 0) return `exit ${parsed.exitCode}`;
    if (parsed.stderr && !parsed.stdout) return 'stderr';
    return `${lines} line${lines !== 1 ? 's' : ''}`;
  }

  if (parsed.type === 'mcp') {
    const d = parsed.data;
    if (parsed.service === 'gmail') {
      const subj = d.subject || getGmailHeader(d, 'Subject');
      if (subj) return subj;
      if (Array.isArray(d.messages)) return `${d.messages.length} email${d.messages.length !== 1 ? 's' : ''}`;
      if (d.id || d.messageId) return 'sent';
    }
    if (parsed.service === 'calendar') {
      if (d.summary) return d.summary.slice(0, 40);
      if (Array.isArray(d.items)) return `${d.items.length} event${d.items.length !== 1 ? 's' : ''}`;
    }
    if (parsed.service === 'drive') {
      if (d.name) return d.name;
      if (Array.isArray(d.files)) return `${d.files.length} file${d.files.length !== 1 ? 's' : ''}`;
    }
    if (d.error || d.is_error) return 'error';
    return '';
  }

  const text = parsed.content;
  const lines = text.split('\n');
  const lineCount = lines.length;
  const n = toolName.toLowerCase();

  try {
    if (n === 'glob') {
      const fileCount = lines.filter((l) => l.trim()).length;
      return `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }
    if (n === 'grep' || n === 'ripgrep') {
      const matchCount = lines.filter((l) => l.trim()).length;
      return `${matchCount} match${matchCount !== 1 ? 'es' : ''}`;
    }
    if (n === 'read') return `${lineCount} lines`;
    if (n === 'write') return '';
    if (n === 'edit' || n === 'multiedit' || n === 'strreplace') return '';
    if (n === 'websearch') return 'results';
    if (n === 'webfetch') return `${lineCount} lines`;
    if (parsed.isError) return 'error';
  } catch {}

  return `${lineCount} line${lineCount !== 1 ? 's' : ''}`;
}

export function getPromptPrefix(toolName: string): string {
  if (isBashTool(toolName)) return '$ ';
  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) return `❯ ${mcp.displayName} `;
  return `❯ ${toolName} `;
}
