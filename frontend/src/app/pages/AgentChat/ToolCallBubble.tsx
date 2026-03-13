import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import TerminalIcon from '@mui/icons-material/Terminal';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import EmailIcon from '@mui/icons-material/Email';
import EventIcon from '@mui/icons-material/Event';
import FolderIcon from '@mui/icons-material/Folder';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import SearchIcon from '@mui/icons-material/Search';
import SendIcon from '@mui/icons-material/Send';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';

const GoogleServiceIcon: React.FC<{ service: string; size?: number }> = ({ service, size = 14 }) => {
  if (service === 'gmail') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 10" fill="none" style={{ flexShrink: 0 , marginBottom: '6px'}}>
        {/* Left blue bar */}
        <path d="M2 6.5V18a2 2 0 002 2h1V8l-3-1.5z" fill="#4285F4"/>
        {/* Right green bar */}
        <path d="M22 6.5V18a2 2 0 01-2 2h-1V8l3-1.5z" fill="#34A853"/>
        {/* Red M chevron */}
        <path d="M5 8v12h2V10.2L12 14l5-3.8V20h2V8l-7 5.25L5 8z" fill="#EA4335"/>
        {/* Top-left blue triangle */}
        <path d="M4 4a2 2 0 00-2 2.5L5 8V4H4z" fill="#4285F4"/>
        {/* Top-right yellow triangle */}
        <path d="M20 4a2 2 0 012 2.5L19 8V4h1z" fill="#FBBC04"/>
        {/* Top red V */}
        <path d="M19 4H5v4l7 5.25L19 8V4z" fill="#EA4335"/>
      </svg>
    );
  }
  if (service === 'calendar') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="2" fill="#fff" stroke="#4285F4" strokeWidth="1.5"/>
        <rect x="3" y="3" width="18" height="6" rx="2" fill="#4285F4"/>
        <text x="12" y="17.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#4285F4" fontFamily="sans-serif">31</text>
      </svg>
    );
  }
  if (service === 'drive' || service === 'sheets') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <path d="M8 2l7 12H1L8 2z" fill="#FBBC04"/>
        <path d="M15 2l7 12h-7L8 2h7z" fill="#34A853"/>
        <path d="M1 14h14l-3.5 6H4.5L1 14z" fill="#4285F4"/>
        <path d="M15 14h7l-3.5 6h-7L15 14z" fill="#EA4335"/>
      </svg>
    );
  }
  return null;
};

export interface ToolPair {
  type: 'tool_pair';
  id: string;
  call: AgentMessage;
  result: AgentMessage | null;
}

const pulsingKeyframes = `
@keyframes tool-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes border-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--glow-rgb), 0); }
  50% { box-shadow: 0 0 10px 2px rgba(var(--glow-rgb), 0.12); }
}
`;

const streamingCursorKeyframes = `
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`;

const ElapsedTimer: React.FC<{ startTime: string }> = ({ startTime }) => {
  const c = useClaudeTokens();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startTime).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const display = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: c.accent.primary,
          animation: 'tool-pulse 1.5s ease-in-out infinite',
        }}
      />
      <Typography
        sx={{
          fontSize: '0.7rem',
          fontFamily: c.font.mono,
          color: c.text.tertiary,
          minWidth: 28,
          textAlign: 'right',
        }}
      >
        {display}
      </Typography>
    </Box>
  );
};

function formatElapsed(ms: number): string {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function getToolData(call: AgentMessage) {
  const content = typeof call.content === 'object' ? call.content : {};
  return {
    toolName: content.tool || 'Unknown',
    input: content.input || {},
    isDenied: content.approved === false,
    toolId: content.id,
  };
}

function isBashTool(name: string) {
  return name === 'Bash' || name === 'bash';
}

export interface McpToolInfo {
  isMcp: boolean;
  serverSlug: string;
  action: string;
  service: string;
  displayName: string;
}

export function parseMcpToolName(rawName: string): McpToolInfo {
  const m = rawName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (!m) return { isMcp: false, serverSlug: '', action: '', service: '', displayName: rawName };
  const serverSlug = m[1];
  const action = m[2];
  const display = action.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

  const lower = action.toLowerCase();
  let service = '';
  if (lower.includes('gmail') || lower.includes('email') || lower.includes('mail')) service = 'gmail';
  else if (lower.includes('calendar') || lower.includes('event') || lower.includes('freebusy')) service = 'calendar';
  else if (lower.includes('drive') || lower.includes('file')) service = 'drive';
  else if (lower.includes('sheet') || lower.includes('spreadsheet')) service = 'sheets';
  else if (lower.includes('doc') || lower.includes('paragraph')) service = 'docs';
  else if (lower.includes('contact')) service = 'contacts';

  return { isMcp: true, serverSlug, action, service, displayName: display };
}

function getMcpInputSummary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const v = input[keys[0]];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  return keys.slice(0, 3).map((k) => {
    const v = input[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${s.length > 30 ? s.slice(0, 30) + '…' : s}`;
  }).join('  ');
}

function getInputSummary(toolName: string, input: any): string {
  try {
    const mcp = parseMcpToolName(toolName);
    if (mcp.isMcp) return getMcpInputSummary(input);

    const n = toolName.toLowerCase();
    if (isBashTool(toolName)) {
      const cmd = input.command || '';
      return `$ ${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}`;
    }
    if (n === 'read') return input.file_path || input.path || '';
    if (n === 'write') return input.file_path || input.path || '';
    if (n === 'edit' || n === 'multiedit' || n === 'strreplace')
      return input.file_path || input.path || '';
    if (n === 'glob') return input.pattern || input.glob || input.glob_pattern || '';
    if (n === 'grep' || n === 'ripgrep') {
      const pat = input.pattern || input.regex || '';
      const path = input.path || input.directory || '';
      return path ? `/${pat}/ in ${path}` : `/${pat}/`;
    }
    if (n === 'websearch') return input.query || input.search_term || '';
    if (n === 'webfetch') return input.url || '';
    if (n === 'todoread' || n === 'todowrite') return 'todos';
    if (n === 'ls') return input.path || '.';
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

function formatInputDisplay(toolName: string, input: any): string {
  try {
    const mcp = parseMcpToolName(toolName);
    if (mcp.isMcp) return formatMcpInputDisplay(input);

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

interface ParsedBashResult {
  type: 'bash';
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ParsedTextResult {
  type: 'text';
  content: string;
  isError?: boolean;
}

interface ParsedMcpResult {
  type: 'mcp';
  service: string;
  action: string;
  data: Record<string, any>;
  rawText: string;
}

type ParsedResult = ParsedBashResult | ParsedTextResult | ParsedMcpResult;

function parseToolResult(toolName: string, rawText: string): ParsedResult {
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

export function getMcpShortAction(mcpInfo: McpToolInfo): string {
  const { action, service } = mcpInfo;
  let short = action;
  if (service && action.toLowerCase().startsWith(service.toLowerCase() + '_')) {
    short = action.slice(service.length + 1);
  }
  return short.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function getResultSummary(toolName: string, rawText: string): string {
  const parsed = parseToolResult(toolName, rawText);

  if (parsed.type === 'bash') {
    const lines = parsed.stdout.split('\n').filter((l) => l.trim()).length;
    if (parsed.exitCode !== null && parsed.exitCode !== 0) return `✗ exit ${parsed.exitCode}`;
    if (parsed.stderr && !parsed.stdout) return '✗ stderr';
    return `✓ ${lines} line${lines !== 1 ? 's' : ''}`;
  }

  if (parsed.type === 'mcp') {
    const d = parsed.data;
    if (parsed.service === 'gmail') {
      const subj = d.subject || getGmailHeader(d, 'Subject');
      if (subj) return subj;
      if (Array.isArray(d.messages)) return `${d.messages.length} email${d.messages.length !== 1 ? 's' : ''}`;
      if (d.id || d.messageId) return '✓ done';
    }
    if (parsed.service === 'calendar') {
      if (d.summary) return d.summary.slice(0, 40);
      if (Array.isArray(d.items)) return `${d.items.length} event${d.items.length !== 1 ? 's' : ''}`;
    }
    if (parsed.service === 'drive') {
      if (d.name) return d.name;
      if (Array.isArray(d.files)) return `${d.files.length} file${d.files.length !== 1 ? 's' : ''}`;
    }
    if (d.error || d.is_error) return '✗ error';
    return '✓ done';
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
    if (n === 'write') {
      if (text.toLowerCase().includes('success') || text.toLowerCase().includes('written'))
        return '✓ written';
      return '✓ done';
    }
    if (n === 'edit' || n === 'multiedit' || n === 'strreplace') {
      if (text.toLowerCase().includes('success') || text.toLowerCase().includes('applied'))
        return '✓ applied';
      return '✓ done';
    }
    if (n === 'websearch') return 'results';
    if (n === 'webfetch') return `${lineCount} lines`;
    if (parsed.isError) return '✗ error';
  } catch {}

  return `${lineCount} line${lineCount !== 1 ? 's' : ''}`;
}

function getPromptPrefix(toolName: string): string {
  if (isBashTool(toolName)) return '$ ';
  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) return `❯ ${mcp.displayName} `;
  return `❯ ${toolName} `;
}

interface ToolCallBubbleProps {
  call: AgentMessage;
  result?: AgentMessage | null;
  isPending?: boolean;
  isStreaming?: boolean;
  mcpCompact?: boolean;
}

interface TermColors {
  TERM_BG: string;
  TERM_BORDER: string;
  PROMPT_COLOR: string;
  CMD_COLOR: string;
  OUTPUT_COLOR: string;
  PATH_COLOR: string;
  ADD_COLOR: string;
  DEL_COLOR: string;
  STDERR_COLOR: string;
  WARN_COLOR: string;
  NUM_COLOR: string;
  DIM_COLOR: string;
  DIFF_HEADER_COLOR: string;
  SCROLLBAR_THUMB: string;
}

const darkTermColors: TermColors = {
  TERM_BG: '#131520',
  TERM_BORDER: '#1e2030',
  PROMPT_COLOR: '#7ec699',
  CMD_COLOR: '#e8ecf4',
  OUTPUT_COLOR: '#a0aab8',
  PATH_COLOR: '#82aaff',
  ADD_COLOR: '#7ec699',
  DEL_COLOR: '#ff8787',
  STDERR_COLOR: '#ff8787',
  WARN_COLOR: '#ffcb6b',
  NUM_COLOR: '#f78c6c',
  DIM_COLOR: '#555b6e',
  DIFF_HEADER_COLOR: '#c792ea',
  SCROLLBAR_THUMB: '#2a2d3e',
};

const lightTermColors: TermColors = {
  TERM_BG: '#f4f3ee',
  TERM_BORDER: '#e2e0d8',
  PROMPT_COLOR: '#2d7a3e',
  CMD_COLOR: '#2a2a28',
  OUTPUT_COLOR: '#555550',
  PATH_COLOR: '#3060a8',
  ADD_COLOR: '#2d7a3e',
  DEL_COLOR: '#c03030',
  STDERR_COLOR: '#c03030',
  WARN_COLOR: '#8a6518',
  NUM_COLOR: '#c05020',
  DIM_COLOR: '#9e9c95',
  DIFF_HEADER_COLOR: '#7c4daa',
  SCROLLBAR_THUMB: '#ccc9c0',
};

function useTermColors(): TermColors {
  const { mode } = useThemeMode();
  return mode === 'dark' ? darkTermColors : lightTermColors;
}

function colorizeInput(toolName: string, text: string, tc: TermColors): React.ReactNode {
  const n = toolName.toLowerCase();
  const mcp = parseMcpToolName(toolName);

  if (mcp.isMcp) {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0 && colonIdx < 30) {
            return (
              <span key={i}>
                <span style={{ color: tc.DIM_COLOR }}>{line.slice(0, colonIdx + 1)}</span>
                <span style={{ color: tc.CMD_COLOR }}>{line.slice(colonIdx + 1)}</span>
                {nl}
              </span>
            );
          }
          return <span key={i} style={{ color: tc.CMD_COLOR }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  if (isBashTool(toolName)) return <span style={{ color: tc.CMD_COLOR }}>{text}</span>;

  if (n === 'edit' || n === 'strreplace' || n === 'multiedit') {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          if (i === 0 && (line.startsWith('/') || line.includes('.')))
            return <span key={i} style={{ color: tc.PATH_COLOR }}>{line}{nl}</span>;
          if (line.startsWith('+ '))
            return <span key={i} style={{ color: tc.ADD_COLOR }}>{line}{nl}</span>;
          if (line.startsWith('- '))
            return <span key={i} style={{ color: tc.DEL_COLOR }}>{line}{nl}</span>;
          return <span key={i} style={{ color: tc.CMD_COLOR }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  if (n === 'write') {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          if (i === 0 && (line.startsWith('/') || line.includes('.')))
            return <span key={i} style={{ color: tc.PATH_COLOR }}>{line}{nl}</span>;
          return <span key={i} style={{ color: tc.CMD_COLOR, opacity: 0.7 }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  if (n === 'read' || n === 'glob' || n === 'webfetch') {
    if (/^\//.test(text) || text.includes('/'))
      return <span style={{ color: tc.PATH_COLOR }}>{text}</span>;
  }

  if (n === 'grep' || n === 'ripgrep') {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          if (line.startsWith('pattern:'))
            return (
              <span key={i}>
                <span style={{ color: tc.DIM_COLOR }}>pattern: </span>
                <span style={{ color: tc.WARN_COLOR }}>{line.slice(9)}</span>
                {nl}
              </span>
            );
          if (line.startsWith('path:'))
            return (
              <span key={i}>
                <span style={{ color: tc.DIM_COLOR }}>path: </span>
                <span style={{ color: tc.PATH_COLOR }}>{line.slice(6)}</span>
                {nl}
              </span>
            );
          return <span key={i} style={{ color: tc.CMD_COLOR }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  return <span style={{ color: tc.CMD_COLOR }}>{text}</span>;
}

function colorizeOutput(toolName: string, text: string, tc: TermColors): React.ReactNode {
  if (!text) return <span style={{ color: tc.DIM_COLOR, fontStyle: 'italic' }}>(empty)</span>;

  const lines = text.split('\n');
  const n = toolName.toLowerCase();

  return (
    <>
      {lines.map((line, i) => {
        const nl = i < lines.length - 1 ? '\n' : '';
        const trimmed = line.trimStart();

        if (/^\/\S+/.test(trimmed))
          return <span key={i} style={{ color: tc.PATH_COLOR }}>{line}{nl}</span>;

        if (n === 'grep' || n === 'ripgrep') {
          const grepMatch = line.match(/^(\S+?:\d+[:-])/);
          if (grepMatch) {
            return (
              <span key={i}>
                <span style={{ color: tc.PATH_COLOR }}>{grepMatch[1]}</span>
                <span style={{ color: tc.OUTPUT_COLOR }}>{line.slice(grepMatch[1].length)}</span>
                {nl}
              </span>
            );
          }
          const fileHeader = line.match(/^(\S+\.\w+)$/);
          if (fileHeader)
            return <span key={i} style={{ color: tc.PATH_COLOR, fontWeight: 600 }}>{line}{nl}</span>;
        }

        if (line.startsWith('@@') && line.includes('@@'))
          return <span key={i} style={{ color: tc.DIFF_HEADER_COLOR }}>{line}{nl}</span>;
        if (line.startsWith('+'))
          return <span key={i} style={{ color: tc.ADD_COLOR }}>{line}{nl}</span>;
        if (line.startsWith('-'))
          return <span key={i} style={{ color: tc.DEL_COLOR }}>{line}{nl}</span>;

        if (/\b[Ee]rror\b/.test(line))
          return <span key={i} style={{ color: tc.STDERR_COLOR }}>{line}{nl}</span>;
        if (/\b[Ww]arning\b/.test(line))
          return <span key={i} style={{ color: tc.WARN_COLOR }}>{line}{nl}</span>;

        if (n === 'read') {
          const lineNumMatch = line.match(/^(\s*\d+\s*[|:])/);
          if (lineNumMatch) {
            return (
              <span key={i}>
                <span style={{ color: tc.NUM_COLOR, opacity: 0.6 }}>{lineNumMatch[1]}</span>
                <span style={{ color: tc.OUTPUT_COLOR }}>{line.slice(lineNumMatch[1].length)}</span>
                {nl}
              </span>
            );
          }
        }

        return <span key={i} style={{ color: tc.OUTPUT_COLOR }}>{line}{nl}</span>;
      })}
    </>
  );
}


function formatTimestamp(ts: string | number | undefined): string {
  if (!ts) return '';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return String(ts); }
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

interface CardColors {
  TC_BG: string;
  TC_BORDER: string;
  TC_HOVER: string;
  TC_HEADING: string;
  TC_BODY: string;
  TC_MUTED: string;
  TC_DIM: string;
  TC_ACCENT: string;
  TC_SUCCESS: string;
  TC_WARNING: string;
}

const darkCardColors: CardColors = {
  TC_BG: 'rgba(255,255,255,0.03)',
  TC_BORDER: 'rgba(255,255,255,0.06)',
  TC_HOVER: 'rgba(255,255,255,0.05)',
  TC_HEADING: '#C2C0B6',
  TC_BODY: '#9C9A92',
  TC_MUTED: '#85837C',
  TC_DIM: 'rgba(156,154,146,0.5)',
  TC_ACCENT: '#c4633a',
  TC_SUCCESS: '#7AB948',
  TC_WARNING: '#D1A041',
};

const lightCardColors: CardColors = {
  TC_BG: 'rgba(0,0,0,0.03)',
  TC_BORDER: 'rgba(0,0,0,0.08)',
  TC_HOVER: 'rgba(0,0,0,0.05)',
  TC_HEADING: '#3D3D3A',
  TC_BODY: '#555550',
  TC_MUTED: '#73726C',
  TC_DIM: 'rgba(115,114,108,0.5)',
  TC_ACCENT: '#ae5630',
  TC_SUCCESS: '#265B19',
  TC_WARNING: '#805C1F',
};

function useCardColors(): CardColors {
  const { mode } = useThemeMode();
  return mode === 'dark' ? darkCardColors : lightCardColors;
}

function getGmailHeader(msg: any, name: string): string {
  if (msg.payload?.headers && Array.isArray(msg.payload.headers)) {
    const h = msg.payload.headers.find(
      (hdr: any) => (hdr.name || '').toLowerCase() === name.toLowerCase()
    );
    if (h) return h.value || '';
  }
  if (msg.headers && typeof msg.headers === 'object' && !Array.isArray(msg.headers)) {
    return msg.headers[name] || msg.headers[name.toLowerCase()] || '';
  }
  return '';
}

function extractEmailFields(msg: any) {
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

const GmailCard: React.FC<{ data: Record<string, any>; action: string; hideSubjectHeader?: boolean }> = ({ data, action, hideSubjectHeader }) => {
  const c = useClaudeTokens();
  const { TC_BG, TC_BORDER, TC_HOVER, TC_HEADING, TC_BODY, TC_MUTED, TC_DIM, TC_ACCENT, TC_SUCCESS, TC_WARNING } = useCardColors();
  const email = extractEmailFields(data);
  const labels = data.labelIds || data.labels || [];
  const attachments = data.attachments || [];

  const isSend = action.includes('send');
  const isSearch = action.includes('search') || action.includes('list');
  const messages: any[] = data.messages || (isSearch && data.results ? data.results : []);

  if (messages.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.5, pt: 1 }}>
        {messages.slice(0, 5).map((msg: any, i: number) => {
          const m = extractEmailFields(msg);
          return (
            <Box key={i} sx={{
              bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`, borderRadius: 1.5,
              px: 1.25, py: 1, display: 'flex', flexDirection: 'column', gap: 0.4,
              transition: 'background-color 0.15s',
              '&:hover': { bgcolor: TC_HOVER },
            }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
                <span style={{ color: TC_HEADING, fontSize: '0.74rem', fontWeight: 600, fontFamily: c.font.sans }}>
                  {m.subject}
                </span>
                {m.date && (
                  <span style={{ color: TC_DIM, fontSize: '0.6rem', flexShrink: 0, fontFamily: c.font.mono }}>
                    {m.date}
                  </span>
                )}
              </Box>
              {m.from && (
                <span style={{ color: TC_MUTED, fontSize: '0.68rem', fontFamily: c.font.sans }}>
                  {m.from}
                </span>
              )}
              {(m.snippet || m.bodyPreview) && (
                <span style={{ color: TC_BODY, fontSize: '0.68rem', lineHeight: 1.45, fontFamily: c.font.sans }}>
                  {(m.snippet || m.bodyPreview).slice(0, 120)}
                  {(m.snippet || m.bodyPreview).length > 120 ? '…' : ''}
                </span>
              )}
            </Box>
          );
        })}
        {messages.length > 5 && (
          <span style={{ color: TC_DIM, fontSize: '0.66rem', fontStyle: 'italic', textAlign: 'center', display: 'block' }}>
            +{messages.length - 5} more
          </span>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{
      ...(hideSubjectHeader
        ? { overflow: 'hidden' }
        : { bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`, borderRadius: 1.5, mx: 1.5, my: 1, overflow: 'hidden' }),
    }}>
      {!hideSubjectHeader && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75,
          px: 1.5, py: 0.85,
          borderBottom: `1px solid ${TC_BORDER}`,
        }}>
          {isSend ? (
            <SendIcon sx={{ fontSize: 14, color: TC_SUCCESS, opacity: 0.8 }} />
          ) : (
            <EmailIcon sx={{ fontSize: 14, color: TC_ACCENT, opacity: 0.8 }} />
          )}
          <span style={{ color: TC_HEADING, fontSize: '0.78rem', fontWeight: 600, flex: 1, fontFamily: c.font.sans }}>
            {email.subject}
          </span>
        </Box>
      )}

      <Box sx={{ px: 1.5, py: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {(email.from || email.to || email.date) && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3 }}>
            {email.from && (
              <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
                <span style={{ color: TC_DIM, minWidth: 32, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>From</span>
                <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{email.from}</span>
              </Box>
            )}
            {email.to && (
              <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
                <span style={{ color: TC_DIM, minWidth: 32, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>To</span>
                <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{email.to}</span>
              </Box>
            )}
            {email.date && (
              <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
                <span style={{ color: TC_DIM, minWidth: 32, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Date</span>
                <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{email.date}</span>
              </Box>
            )}
          </Box>
        )}

        {labels.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', mt: 0.15 }}>
            {labels.map((l: string, i: number) => (
              <Box key={i} sx={{
                display: 'inline-flex', alignItems: 'center',
                bgcolor: `${TC_ACCENT}18`, borderRadius: 0.75,
                px: 0.6, py: 0.1,
              }}>
                <span style={{ fontSize: '0.56rem', color: TC_ACCENT, fontFamily: c.font.mono, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{l}</span>
              </Box>
            ))}
          </Box>
        )}

        {(email.snippet || email.bodyPreview) && (
          <Box sx={{
            mt: 0.25, pt: 0.5, borderTop: `1px solid ${TC_BORDER}`,
            color: TC_BODY,
            fontFamily: c.font.sans,
            fontSize: '0.7rem',
            lineHeight: 1.6,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            '& p': { m: 0, mb: 0.75, '&:last-child': { mb: 0 } },
            '& h1, & h2, & h3, & h4, & h5, & h6': {
              color: TC_HEADING, fontFamily: c.font.sans,
              mt: 1, mb: 0.5, '&:first-of-type': { mt: 0 },
            },
            '& h1': { fontSize: '0.82rem' }, '& h2': { fontSize: '0.78rem' },
            '& h3': { fontSize: '0.74rem' }, '& h4, & h5, & h6': { fontSize: '0.7rem' },
            '& strong': { color: TC_HEADING, fontWeight: 600 },
            '& em': { fontStyle: 'italic' },
            '& a': { color: TC_ACCENT, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
            '& ul, & ol': { pl: 2, mb: 0.75, mt: 0 },
            '& li': { mb: 0.2 },
            '& blockquote': {
              m: 0, mb: 0.75, pl: 1, ml: 0,
              borderLeft: `2px solid ${TC_BORDER}`,
              color: TC_MUTED, fontStyle: 'italic',
            },
            '& code': {
              bgcolor: `${TC_BORDER}`, px: 0.4, py: 0.15,
              borderRadius: 0.5, fontSize: '0.65rem', fontFamily: c.font.mono,
            },
            '& pre': {
              bgcolor: `${TC_BORDER}`, borderRadius: 1, p: 1,
              overflow: 'auto', fontSize: '0.65rem', fontFamily: c.font.mono,
              m: 0, mb: 0.75,
            },
            '& pre code': { bgcolor: 'transparent', p: 0 },
            '& hr': { border: 'none', borderTop: `1px solid ${TC_BORDER}`, my: 0.75 },
            '& img': { maxWidth: '100%', borderRadius: 1 },
          }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}
            >
              {email.bodyPreview || email.snippet}
            </ReactMarkdown>
          </Box>
        )}

        {attachments.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', mt: 0.2 }}>
            {attachments.map((a: any, i: number) => (
              <Box key={i} sx={{
                display: 'inline-flex', alignItems: 'center', gap: 0.3,
                bgcolor: `${TC_WARNING}15`, borderRadius: 0.75,
                px: 0.6, py: 0.1,
              }}>
                <AttachFileIcon sx={{ fontSize: 9, color: TC_WARNING, opacity: 0.7 }} />
                <span style={{ fontSize: '0.58rem', color: TC_WARNING, fontFamily: c.font.mono }}>
                  {a.filename || a.name || 'attachment'}
                </span>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};

const CalendarCard: React.FC<{ data: Record<string, any>; hideHeader?: boolean }> = ({ data, hideHeader }) => {
  const c = useClaudeTokens();
  const { TC_BG, TC_BORDER, TC_HOVER, TC_HEADING, TC_BODY, TC_DIM, TC_SUCCESS } = useCardColors();
  const items: any[] = data.items || (Array.isArray(data) ? data : []);
  const single = !items.length ? data : null;

  if (single && (single.summary || single.start)) {
    const start = single.start?.dateTime || single.start?.date || single.start || '';
    const end = single.end?.dateTime || single.end?.date || single.end || '';
    return (
      <Box sx={{
        ...(hideHeader
          ? { overflow: 'hidden' }
          : { bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`, borderRadius: 1.5, mx: 1.5, my: 1, overflow: 'hidden' }),
      }}>
        {!hideHeader && (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 0.75,
            px: 1.5, py: 0.85, borderBottom: `1px solid ${TC_BORDER}`,
          }}>
            <EventIcon sx={{ fontSize: 14, color: TC_SUCCESS, opacity: 0.8 }} />
            <span style={{ color: TC_HEADING, fontSize: '0.78rem', fontWeight: 600, fontFamily: c.font.sans }}>
              {single.summary || '(no title)'}
            </span>
          </Box>
        )}
        <Box sx={{ px: 1.5, py: 1, display: 'flex', flexDirection: 'column', gap: 0.3 }}>
          {start && (
            <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
              <span style={{ color: TC_DIM, minWidth: 48, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Start</span>
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{formatTimestamp(start)}</span>
            </Box>
          )}
          {end && (
            <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
              <span style={{ color: TC_DIM, minWidth: 48, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>End</span>
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{formatTimestamp(end)}</span>
            </Box>
          )}
          {single.location && (
            <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
              <span style={{ color: TC_DIM, minWidth: 48, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Where</span>
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{single.location}</span>
            </Box>
          )}
          {single.description && (
            <Box sx={{ mt: 0.3, pt: 0.5, borderTop: `1px solid ${TC_BORDER}` }}>
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: c.font.sans, fontSize: '0.68rem', lineHeight: 1.5,
                color: TC_BODY,
              }}>
                {single.description.slice(0, 300)}
                {single.description.length > 300 ? '…' : ''}
              </pre>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  if (items.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.5, pt: 1 }}>
        {items.slice(0, 6).map((item: any, i: number) => (
          <Box key={i} sx={{
            bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`,
            borderRadius: 1.5, px: 1.25, py: 0.75,
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1,
            transition: 'background-color 0.15s',
            '&:hover': { bgcolor: TC_HOVER },
          }}>
            <span style={{ color: TC_HEADING, fontSize: '0.72rem', fontWeight: 500, fontFamily: c.font.sans }}>
              {item.summary || '(no title)'}
            </span>
            <span style={{ color: TC_DIM, fontSize: '0.6rem', flexShrink: 0, fontFamily: c.font.mono }}>
              {formatTimestamp(item.start?.dateTime || item.start?.date || item.start)}
            </span>
          </Box>
        ))}
        {items.length > 6 && (
          <span style={{ color: TC_DIM, fontSize: '0.64rem', fontStyle: 'italic', textAlign: 'center', display: 'block' }}>
            +{items.length - 6} more
          </span>
        )}
      </Box>
    );
  }

  return null;
};

const DriveCard: React.FC<{ data: Record<string, any> }> = ({ data }) => {
  const c = useClaudeTokens();
  const { TC_BG, TC_BORDER, TC_HOVER, TC_HEADING, TC_DIM, TC_WARNING } = useCardColors();
  const files: any[] = data.files || (Array.isArray(data) ? data : []);
  const single = !files.length && data.name ? data : null;

  if (single) {
    return (
      <Box sx={{
        bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`,
        borderRadius: 1.5, mx: 1.5, my: 1, px: 1.25, py: 0.85, display: 'flex', alignItems: 'center', gap: 0.75,
      }}>
        <FolderIcon sx={{ fontSize: 16, color: TC_WARNING, opacity: 0.7 }} />
        <Box>
          <span style={{ color: TC_HEADING, fontSize: '0.73rem', fontWeight: 500, display: 'block', fontFamily: c.font.sans }}>
            {single.name}
          </span>
          {single.mimeType && (
            <span style={{ color: TC_DIM, fontSize: '0.6rem', fontFamily: c.font.mono }}>{single.mimeType}</span>
          )}
        </Box>
      </Box>
    );
  }

  if (files.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, p: 1.5, pt: 1 }}>
        {files.slice(0, 8).map((f: any, i: number) => (
          <Box key={i} sx={{
            bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`,
            borderRadius: 1.5, px: 1.25, py: 0.6, display: 'flex', alignItems: 'center', gap: 0.75,
            transition: 'background-color 0.15s',
            '&:hover': { bgcolor: TC_HOVER },
          }}>
            <FolderIcon sx={{ fontSize: 13, color: TC_WARNING, opacity: 0.5 }} />
            <span style={{ color: TC_HEADING, fontSize: '0.7rem', fontFamily: c.font.sans }}>{f.name || f.id}</span>
            {f.mimeType && (
              <span style={{ color: TC_DIM, fontSize: '0.58rem', flexShrink: 0, fontFamily: c.font.mono }}>
                {f.mimeType.split('/').pop()}
              </span>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  return null;
};

const GenericMcpCard: React.FC<{ data: Record<string, any> }> = ({ data }) => {
  const c = useClaudeTokens();
  const { TC_DIM, TC_BODY } = useCardColors();
  const entries = Object.entries(data).filter(([, v]) => v != null);

  if (entries.length === 0)
    return <span style={{ color: TC_DIM, fontStyle: 'italic', fontSize: '0.7rem', padding: '8px 12px', display: 'block' }}>(empty response)</span>;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3, px: 1.5, py: 1 }}>
      {entries.slice(0, 20).map(([key, val], i) => {
        const isLong = typeof val === 'string' && val.length > 100;
        const isObj = typeof val === 'object';
        return (
          <Box key={i} sx={{ fontSize: '0.7rem', display: 'flex', gap: 0.75, lineHeight: 1.5 }}>
            <span style={{ color: TC_DIM, minWidth: 72, flexShrink: 0, fontWeight: 500, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.03em', paddingTop: 1 }}>
              {key}
            </span>
            {isObj ? (
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: TC_BODY, fontFamily: c.font.mono, fontSize: '0.68rem',
              }}>
                {JSON.stringify(val, null, 2).slice(0, 500)}
              </pre>
            ) : isLong ? (
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: TC_BODY, fontFamily: c.font.sans, fontSize: '0.68rem',
              }}>
                {String(val).slice(0, 500)}{String(val).length > 500 ? '…' : ''}
              </pre>
            ) : (
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{String(val)}</span>
            )}
          </Box>
        );
      })}
      {entries.length > 20 && (
        <span style={{ color: TC_DIM, fontSize: '0.62rem', fontStyle: 'italic' }}>
          +{entries.length - 20} more fields
        </span>
      )}
    </Box>
  );
};

const McpResultCard: React.FC<{ parsed: ParsedMcpResult; compact?: boolean }> = ({ parsed, compact }) => {
  const tc = useTermColors();
  const { service, action, data } = parsed;

  if (data.error || data.is_error) {
    return (
      <Box sx={{ p: 1 }}>
        <span style={{ color: tc.STDERR_COLOR, fontSize: '0.73rem' }}>
          {data.error || data.message || JSON.stringify(data, null, 2)}
        </span>
      </Box>
    );
  }

  if (service === 'gmail') return <GmailCard data={data} action={action} hideSubjectHeader={compact} />;
  if (service === 'calendar') return <CalendarCard data={data} hideHeader={compact} />;
  if (service === 'drive' || service === 'sheets') return <DriveCard data={data} />;

  return <GenericMcpCard data={data} />;
};

const ToolCallBubble: React.FC<ToolCallBubbleProps> = React.memo(
  ({ call, result = null, isPending = false, isStreaming = false, mcpCompact = false }) => {
    const c = useClaudeTokens();
    const tc = useTermColors();
    const [expanded, setExpanded] = useState(false);

    const { toolName, input, isDenied } = getToolData(call);
    const mcpInfo = useMemo(() => parseMcpToolName(toolName), [toolName]);
    const inputSummary = getInputSummary(toolName, input);
    const formattedInput = useMemo(() => formatInputDisplay(toolName, input), [toolName, input]);
    const showTimer = isPending && !isDenied && !isStreaming;
    const showBody = expanded || isStreaming;

    const resultContent = result?.content;
    const hasStructuredResult =
      resultContent && typeof resultContent === 'object' && 'text' in resultContent;
    const resultRawText: string = hasStructuredResult
      ? resultContent.text
      : typeof resultContent === 'string'
        ? resultContent
        : resultContent
          ? JSON.stringify(resultContent, null, 2)
          : '';
    const resultElapsedMs: number | null = hasStructuredResult
      ? resultContent.elapsed_ms ?? null
      : null;

    const parsedResult = useMemo(
      () => (result ? parseToolResult(toolName, resultRawText) : null),
      [result, toolName, resultRawText],
    );
    const resultSummary = result ? getResultSummary(toolName, resultRawText) : null;
    const isError =
      resultSummary?.startsWith('✗') ||
      (parsedResult?.type === 'bash' && parsedResult.exitCode !== null && parsedResult.exitCode !== 0) ||
      (parsedResult?.type === 'text' && parsedResult.isError);

    const toggle = useCallback(() => {
      if (!isStreaming) setExpanded((v) => !v);
    }, [isStreaming]);

    const accentRgb = c.accent.primary
      .replace('#', '')
      .match(/.{2}/g)
      ?.map((h) => parseInt(h, 16))
      .join(', ') || '189, 100, 57';

    const promptPrefix = getPromptPrefix(toolName);
    const shortAction = mcpInfo.isMcp ? getMcpShortAction(mcpInfo) : toolName;

    const serviceLabel = mcpInfo.isMcp && mcpInfo.service
      ? mcpInfo.service.charAt(0).toUpperCase() + mcpInfo.service.slice(1)
      : shortAction;

    const ServiceIcon = mcpInfo.isMcp && mcpInfo.service
      ? <GoogleServiceIcon service={mcpInfo.service} size={14} />
      : null;

    const selectAttrs = {
      'data-select-type': 'tool-call' as const,
      'data-select-id': call.id,
      'data-select-meta': JSON.stringify({ tool: toolName, inputSummary }),
    };

    if (mcpCompact && mcpInfo.isMcp) {
      return (
        <Box {...selectAttrs} sx={{ my: 0 }}>
          <style>{pulsingKeyframes}</style>
          <Box
            onClick={toggle}
            sx={{
              display: 'flex',
              alignItems: showBody ? 'flex-start' : 'center',
              gap: 0.75,
              px: 1.5,
              py: 0.6,
              cursor: 'pointer',
              borderBottom: showBody ? `1px solid ${c.border.subtle}` : 'none',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' },
            }}
          >
            {ServiceIcon}
            <Typography
              sx={{
                color: c.accent.primary,
                fontSize: '0.78rem',
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {serviceLabel}
            </Typography>
            {resultSummary && !isError && (
              <Typography
                sx={{
                  color: c.text.secondary,
                  fontSize: '0.74rem',
                  flex: 1,
                  minWidth: 0,
                  ...(showBody
                    ? { whiteSpace: 'normal', wordBreak: 'break-word' }
                    : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                }}
              >
                {resultSummary}
              </Typography>
            )}
            {!resultSummary && !showTimer && <Box sx={{ flex: 1 }} />}
            {showTimer && (
              <>
                <Box sx={{ flex: 1 }} />
                <ElapsedTimer startTime={call.timestamp} />
              </>
            )}
            {isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
                <BlockIcon sx={{ fontSize: 12, color: c.status.error }} />
                <Typography sx={{ color: c.status.error, fontSize: '0.68rem', fontWeight: 500 }}>denied</Typography>
              </Box>
            )}
            {result && !isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                {isError ? (
                  <ErrorOutlineIcon sx={{ fontSize: 12, color: c.status.error }} />
                ) : (
                  <CheckCircleOutlineIcon sx={{ fontSize: 12, color: c.status.success }} />
                )}
                {resultElapsedMs != null && (
                  <Typography sx={{ fontSize: '0.63rem', fontFamily: c.font.mono, color: c.text.tertiary }}>
                    {formatElapsed(resultElapsedMs)}
                  </Typography>
                )}
              </Box>
            )}
            <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.15, flexShrink: 0 }}>
              {showBody ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Box>

          <Collapse in={showBody}>
            <Box
              sx={{
                bgcolor: tc.TERM_BG,
                maxHeight: '60vh',
                overflowY: 'auto',
                overflowX: 'hidden',
                '&::-webkit-scrollbar': { width: 5 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': { background: tc.SCROLLBAR_THUMB, borderRadius: 3 },
              }}
            >
              {parsedResult && parsedResult.type === 'mcp' ? (
                <McpResultCard parsed={parsedResult} compact />
              ) : parsedResult ? (
                <pre style={{
                  margin: 0, padding: '8px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontFamily: c.font.mono, fontSize: '0.73rem', lineHeight: 1.5, color: tc.OUTPUT_COLOR,
                }}>
                  {parsedResult.type === 'text' ? parsedResult.content : ''}
                </pre>
              ) : null}
              {!parsedResult && isPending && !isStreaming && (
                <Box sx={{ px: 1.5, py: 1 }}>
                  <Box sx={{ width: 8, height: 2, bgcolor: tc.PROMPT_COLOR, animation: 'tool-pulse 1s ease-in-out infinite', borderRadius: 1 }} />
                </Box>
              )}
            </Box>
          </Collapse>
        </Box>
      );
    }

    return (
      <Box {...selectAttrs} sx={{ maxWidth: mcpCompact ? '100%' : '85%', my: mcpCompact ? 0 : 0.5 }}>
        <style>{pulsingKeyframes}</style>
        {isStreaming && <style>{streamingCursorKeyframes}</style>}
        <Box
          sx={{
            '--glow-rgb': accentRgb,
            bgcolor: mcpCompact ? 'transparent' : c.bg.elevated,
            border: mcpCompact ? 'none' : `1px solid ${
              isPending || isStreaming
                ? c.accent.primary
                : isDenied
                  ? c.status.error + '60'
                  : c.border.subtle
            }`,
            borderRadius: mcpCompact ? 0 : 2,
            overflow: 'hidden',
            animation: (isPending || isStreaming) && !mcpCompact ? 'border-glow 2s ease-in-out infinite' : 'none',
            transition: 'border-color 0.3s, box-shadow 0.3s',
          } as any}
        >
          {/* Header */}
          <Box
            onClick={toggle}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: mcpCompact ? 0.6 : 0.75,
              cursor: isStreaming ? 'default' : 'pointer',
              borderBottom: mcpCompact && showBody ? `1px solid ${c.border.subtle}` : 'none',
              '&:hover': isStreaming ? {} : { bgcolor: 'rgba(0,0,0,0.02)' },
            }}
          >
            {mcpInfo.isMcp && mcpInfo.service
              ? <GoogleServiceIcon service={mcpInfo.service} size={mcpCompact ? 14 : 15} />
              : (() => {
                  const n = toolName.toLowerCase();
                  if (n.includes('search') || n === 'grep' || n === 'glob')
                    return <SearchIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: c.accent.primary, flexShrink: 0 }} />;
                  return <TerminalIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: c.accent.primary, flexShrink: 0 }} />;
                })()
            }
            <Typography
              sx={{
                color: c.accent.primary,
                fontSize: mcpCompact ? '0.78rem' : '0.8rem',
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {mcpInfo.isMcp ? mcpInfo.displayName : toolName}
            </Typography>
            {mcpInfo.isMcp && (
              <Typography
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.65rem',
                  opacity: 0.7,
                  flexShrink: 0,
                }}
              >
                {mcpInfo.serverSlug}
              </Typography>
            )}
            {inputSummary && !isStreaming && (
              <Typography
                noWrap
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.75rem',
                  fontFamily: c.font.mono,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {inputSummary}
              </Typography>
            )}
            {!inputSummary && <Box sx={{ flex: 1 }} />}
            {isStreaming && <Box sx={{ flex: 1 }} />}

            {isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
                <BlockIcon sx={{ fontSize: 13, color: c.status.error }} />
                <Typography sx={{ color: c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>
                  denied
                </Typography>
              </Box>
            )}
            {result && !isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {isError ? (
                  <ErrorOutlineIcon sx={{ fontSize: 13, color: c.status.error }} />
                ) : (
                  <CheckCircleOutlineIcon sx={{ fontSize: 13, color: c.status.success }} />
                )}
                <Typography
                  sx={{
                    color: isError ? c.status.error : c.status.success,
                    fontSize: '0.7rem',
                    fontWeight: 500,
                  }}
                >
                  {resultSummary}
                </Typography>
                {resultElapsedMs != null && (
                  <Typography
                    sx={{
                      fontSize: '0.65rem',
                      fontFamily: c.font.mono,
                      color: c.text.tertiary,
                    }}
                  >
                    {formatElapsed(resultElapsedMs)}
                  </Typography>
                )}
              </Box>
            )}
            {showTimer && <ElapsedTimer startTime={call.timestamp} />}

            {!isStreaming && (
              <IconButton size="small" sx={{ color: c.text.tertiary, p: mcpCompact ? 0.15 : 0.25, flexShrink: 0 }}>
                {showBody ? (
                  <ExpandLessIcon sx={{ fontSize: mcpCompact ? 16 : 18 }} />
                ) : (
                  <ExpandMoreIcon sx={{ fontSize: mcpCompact ? 16 : 18 }} />
                )}
              </IconButton>
            )}
          </Box>

          {/* Unified terminal body */}
          <Collapse in={showBody}>
            <Box
              sx={{
                bgcolor: tc.TERM_BG,
                borderTop: `1px solid ${tc.TERM_BORDER}`,
                maxHeight: 500,
                overflow: 'auto',
                '&::-webkit-scrollbar': { width: 5 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': {
                  background: tc.SCROLLBAR_THUMB,
                  borderRadius: 3,
                },
              }}
            >
              {/* Prompt + command */}
              <pre
                style={{
                  margin: 0,
                  padding: '8px 12px 0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: c.font.mono,
                  fontSize: '0.73rem',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: tc.PROMPT_COLOR, fontWeight: 600, userSelect: 'none' }}>
                  {promptPrefix}
                </span>
                {isStreaming ? (
                  <span style={{ color: tc.CMD_COLOR }}>{call.content?.input ?? ''}</span>
                ) : (
                  colorizeInput(toolName, formattedInput, tc)
                )}
                {isStreaming && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 2,
                      height: '1em',
                      background: c.accent.primary,
                      marginLeft: 2,
                      verticalAlign: 'text-bottom',
                      animation: 'blink-cursor 0.8s step-end infinite',
                    }}
                  />
                )}
              </pre>

              {/* Output */}
              {parsedResult && parsedResult.type === 'mcp' ? (
                <McpResultCard parsed={parsedResult} />
              ) : parsedResult ? (
                <pre
                  style={{
                    margin: 0,
                    padding: '4px 12px 8px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: c.font.mono,
                    fontSize: '0.73rem',
                    lineHeight: 1.5,
                  }}
                >
                  {parsedResult.type === 'bash' ? (
                    <>
                      {parsedResult.stdout.trim() &&
                        colorizeOutput(toolName, parsedResult.stdout, tc)}
                      {parsedResult.stderr.trim() && (
                        <>
                          {parsedResult.stdout.trim() && '\n'}
                          <span style={{ color: tc.STDERR_COLOR }}>{parsedResult.stderr}</span>
                        </>
                      )}
                      {!parsedResult.stdout.trim() && !parsedResult.stderr.trim() && (
                        <span style={{ color: tc.DIM_COLOR, fontStyle: 'italic' }}>(no output)</span>
                      )}
                    </>
                  ) : (
                    <>
                      {parsedResult.isError ? (
                        <span style={{ color: tc.STDERR_COLOR }}>{parsedResult.content || '(empty)'}</span>
                      ) : (
                        colorizeOutput(toolName, parsedResult.content, tc)
                      )}
                    </>
                  )}
                </pre>
              ) : null}

              {/* Pending indicator when waiting for result */}
              {!parsedResult && isPending && !isStreaming && (
                <Box sx={{ px: 1.5, pb: 1, pt: 0.5 }}>
                  <Box
                    sx={{
                      width: 8,
                      height: 2,
                      bgcolor: tc.PROMPT_COLOR,
                      animation: 'tool-pulse 1s ease-in-out infinite',
                      borderRadius: 1,
                    }}
                  />
                </Box>
              )}
            </Box>
          </Collapse>
        </Box>
      </Box>
    );
  }
);

export default ToolCallBubble;
