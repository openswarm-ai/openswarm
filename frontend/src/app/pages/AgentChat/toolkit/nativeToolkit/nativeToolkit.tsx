import type { ReactNode } from 'react';
import type { Toolkit } from '@assistant-ui/react';
import { Terminal } from './components/Terminal/Terminal';
import { CodeBlock } from './components/CodeBlock/CodeBlock';
import { CodeDiff } from './components/CodeDiff/CodeDiff';

// -- Helpers ----------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
  kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php', r: 'r', lua: 'lua', zig: 'zig',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  prisma: 'prisma', proto: 'protobuf', tf: 'hcl',
};

function guessLanguage(filePath: string): string {
  const base = (filePath.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return base;
  return LANG_MAP[base.split('.').pop() ?? ''] ?? 'text';
}

function extractResult(result: unknown): { text: string; elapsedMs: number | undefined } {
  if (result == null) return { text: '', elapsedMs: undefined };
  if (typeof result === 'string') return { text: result, elapsedMs: undefined };
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const elapsedMs = typeof r.elapsed_ms === 'number' ? r.elapsed_ms : undefined;
    for (const k of ['text', 'output', 'content', 'result'] as const) {
      if (typeof r[k] === 'string') return { text: r[k] as string, elapsedMs };
    }
    const keys = Object.keys(r).filter(k => k !== 'elapsed_ms');
    return keys.length > 0
      ? { text: JSON.stringify(result, null, 2), elapsedMs }
      : { text: '', elapsedMs };
  }
  return { text: String(result), elapsedMs: undefined };
}

function parseBashResult(text: string): { stdout: string; stderr: string; exitCode: number } {
  if (!text) return { stdout: '', stderr: '', exitCode: 0 };
  try {
    const p = JSON.parse(text);
    if (typeof p === 'object' && p !== null && 'stdout' in p) {
      const m = (p.stdout || '').match(/[Ee]xit code:\s*(\d+)/);
      return { stdout: p.stdout ?? '', stderr: p.stderr ?? '', exitCode: m ? parseInt(m[1], 10) : 0 };
    }
  } catch { /* raw stdout */ }
  return { stdout: text, stderr: '', exitCode: 0 };
}

function s(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === 'string') return args[k];
  return '';
}

function toArgs(raw: unknown): Record<string, unknown> {
  return (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
}

// -- Render-props contract --------------------------------------------------

interface RP { args: unknown; result: unknown; status: { type: string }; toolCallId: string }
type BE = { type: 'backend'; render: (p: RP) => ReactNode };
const be = (render: (p: RP) => ReactNode): BE => ({ type: 'backend', render });

// -- Bash → Terminal --------------------------------------------------------

const bashRenderer = be(({ args: raw, result, status, toolCallId }) => {
  const a = toArgs(raw);
  const command = s(a, 'command') || '...';
  const cwd = s(a, 'working_directory', 'cwd') || undefined;
  if (status.type === 'running') {
    return <Terminal id={`bash-${toolCallId}`} command={command} exitCode={0} cwd={cwd} />;
  }
  const { text, elapsedMs } = extractResult(result);
  const p = parseBashResult(text);
  return (
    <Terminal
      id={`bash-${toolCallId}`} command={command}
      stdout={p.stdout || undefined} stderr={p.stderr || undefined}
      exitCode={p.exitCode} durationMs={elapsedMs} cwd={cwd}
    />
  );
});

// -- Read → CodeBlock -------------------------------------------------------

const readRenderer = be(({ args: raw, result, status, toolCallId }) => {
  const a = toArgs(raw);
  const filePath = s(a, 'file_path', 'path');
  const lang = guessLanguage(filePath);
  const { text } = status.type === 'running' ? { text: '' } : extractResult(result);
  return (
    <CodeBlock
      id={`read-${toolCallId}`} code={text} language={lang}
      filename={filePath || undefined} lineNumbers="visible"
    />
  );
});

// -- Write → CodeBlock (shows written content from args) --------------------

const writeRenderer = be(({ args: raw, toolCallId }) => {
  const a = toArgs(raw);
  const filePath = s(a, 'file_path', 'path');
  return (
    <CodeBlock
      id={`write-${toolCallId}`} code={s(a, 'content', 'contents')}
      language={guessLanguage(filePath)} filename={filePath || undefined}
      lineNumbers="visible"
    />
  );
});

// -- Edit / StrReplace → CodeDiff -------------------------------------------

const editRenderer = be(({ args: raw, result, toolCallId }) => {
  const a = toArgs(raw);
  const filePath = s(a, 'file_path', 'path');
  const oldCode = s(a, 'old_string', 'old_text');
  const newCode = s(a, 'new_string', 'new_text');
  if (!oldCode && !newCode) {
    const { text } = extractResult(result);
    return (
      <Terminal id={`edit-${toolCallId}`} command={`Edit ${filePath || 'file'}`}
        stdout={text || undefined} exitCode={0} />
    );
  }
  return (
    <CodeDiff
      id={`edit-${toolCallId}`} oldCode={oldCode} newCode={newCode}
      language={guessLanguage(filePath)} filename={filePath || undefined}
      lineNumbers="visible" diffStyle="unified"
    />
  );
});

// -- MultiEdit → CodeDiff (first edit) --------------------------------------

const multiEditRenderer = be(({ args: raw, result, toolCallId }) => {
  const a = toArgs(raw);
  const filePath = s(a, 'file_path', 'path');
  const edits = Array.isArray(a.edits) ? a.edits : [];
  if (edits.length === 0) {
    const { text } = extractResult(result);
    return (
      <Terminal id={`multiedit-${toolCallId}`} command={`MultiEdit ${filePath || 'file'}`}
        stdout={text || undefined} exitCode={0} />
    );
  }
  const first = (typeof edits[0] === 'object' && edits[0] !== null ? edits[0] : {}) as Record<string, unknown>;
  const oldCode = (typeof first.old_string === 'string' ? first.old_string
    : typeof first.old_text === 'string' ? first.old_text : '');
  const newCode = (typeof first.new_string === 'string' ? first.new_string
    : typeof first.new_text === 'string' ? first.new_text : '');
  const label = edits.length > 1 ? `${filePath} (1/${edits.length})` : filePath;
  return (
    <CodeDiff
      id={`multiedit-${toolCallId}`} oldCode={oldCode} newCode={newCode}
      language={guessLanguage(filePath)} filename={label || undefined}
      lineNumbers="visible" diffStyle="unified"
    />
  );
});

// -- Search / list tools → Terminal -----------------------------------------

function termTool(prefix: string, cmd: (a: Record<string, unknown>) => string): BE {
  return be(({ args: raw, result, status, toolCallId }) => {
    const a = toArgs(raw);
    const command = cmd(a);
    if (status.type === 'running') {
      return <Terminal id={`${prefix}-${toolCallId}`} command={command} exitCode={0} />;
    }
    const { text, elapsedMs } = extractResult(result);
    return (
      <Terminal id={`${prefix}-${toolCallId}`} command={command}
        stdout={text || undefined} exitCode={0} durationMs={elapsedMs} />
    );
  });
}

const grepRenderer = termTool('grep', (a) => {
  const p = s(a, 'pattern', 'regex'), d = s(a, 'path', 'directory');
  return d ? `grep /${p}/ ${d}` : `grep /${p}/`;
});
const globRenderer  = termTool('glob', (a) => `glob ${s(a, 'pattern', 'glob', 'glob_pattern')}`);
const lsRenderer    = termTool('ls', (a) => `ls ${s(a, 'path') || '.'}`);
const searchRenderer = termTool('search', (a) => `search "${s(a, 'query', 'search_term')}"`);
const fetchRenderer  = termTool('fetch', (a) => `fetch ${s(a, 'url')}`);
const todoRenderer   = termTool('todo', () => 'todos');

// -- Exported toolkit -------------------------------------------------------

export const nativeToolkit: Partial<Toolkit> = {
  Bash: bashRenderer, bash: bashRenderer,
  Read: readRenderer,
  Write: writeRenderer,
  Edit: editRenderer, StrReplace: editRenderer,
  MultiEdit: multiEditRenderer,
  Grep: grepRenderer, ripgrep: grepRenderer, RipGrep: grepRenderer,
  Glob: globRenderer,
  Ls: lsRenderer, ls: lsRenderer,
  WebSearch: searchRenderer, WebFetch: fetchRenderer,
  TodoRead: todoRenderer, TodoWrite: todoRenderer,
} as Partial<Toolkit>;
