import type { ParsedResult } from './toolResultParsing';

export interface RichRender {
  name: 'terminal' | 'code-block' | 'code-diff';
  props: Record<string, unknown>;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', html: 'html',
  css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', txt: 'text',
};

export function languageForPath(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return EXT_LANGUAGE[ext] ?? 'text';
}

// Keep highlighting off giant bodies: shiki on a 1MB Read janks the canvas; plain <pre> handles those.
const MAX_RICH_CHARS = 60_000;
const COLLAPSED_LINES = 12;

// The `cat -n` line prefix Read results carry ("   12\tcode"); stripped so the code block shows code.
const READ_LINE_PREFIX_RE = /^\s{0,8}\d+\t/;

function stripReadLinePrefixes(text: string): string {
  const lines = text.split('\n');
  const prefixed = lines.filter((l) => l.length === 0 || READ_LINE_PREFIX_RE.test(l)).length;
  if (prefixed < lines.length * 0.9) return text;
  return lines.map((l) => l.replace(READ_LINE_PREFIX_RE, '')).join('\n');
}

/** Map a finished builtin tool call onto a vendored display component, or null for the classic
 * bubble. Display-only components ONLY: tool output is untrusted text, so it must never pick an
 * interactive component (approval-card, question-flow), and the component choice comes from OUR
 * tool-name rules, never from anything inside the output itself. */
export function resolveRichRender(
  toolName: string,
  input: Record<string, unknown>,
  parsed: ParsedResult | null,
  resultElapsedMs: number | null,
  callId: string,
): RichRender | null {
  try {
    const n = toolName.toLowerCase();

    if ((n === 'bash') && parsed?.type === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (!command || (parsed.stdout.length + parsed.stderr.length) > MAX_RICH_CHARS) return null;
      return {
        name: 'terminal',
        props: {
          id: `auto-${callId}`,
          command,
          stdout: parsed.stdout || undefined,
          stderr: parsed.stderr || undefined,
          exitCode: parsed.exitCode ?? 0,
          durationMs: resultElapsedMs ?? undefined,
          maxCollapsedLines: COLLAPSED_LINES,
        },
      };
    }

    if ((n === 'edit' || n === 'strreplace') && typeof input.file_path === 'string') {
      const oldCode = typeof input.old_string === 'string' ? input.old_string : '';
      const newCode = typeof input.new_string === 'string' ? input.new_string : '';
      if ((!oldCode && !newCode) || oldCode.length + newCode.length > MAX_RICH_CHARS) return null;
      return {
        name: 'code-diff',
        props: {
          id: `auto-${callId}`,
          oldCode,
          newCode,
          filename: input.file_path,
          language: languageForPath(input.file_path),
          maxCollapsedLines: COLLAPSED_LINES,
        },
      };
    }

    if (n === 'write' && typeof input.file_path === 'string' && typeof input.content === 'string') {
      if (!input.content || input.content.length > MAX_RICH_CHARS) return null;
      return {
        name: 'code-block',
        props: {
          id: `auto-${callId}`,
          code: input.content,
          filename: input.file_path,
          language: languageForPath(input.file_path),
          maxCollapsedLines: COLLAPSED_LINES,
        },
      };
    }

    if (n === 'read' && parsed?.type === 'text' && typeof input.file_path === 'string') {
      const body = stripReadLinePrefixes(parsed.content);
      if (!body.trim() || body.length > MAX_RICH_CHARS) return null;
      return {
        name: 'code-block',
        props: {
          id: `auto-${callId}`,
          code: body,
          filename: input.file_path,
          language: languageForPath(input.file_path),
          maxCollapsedLines: COLLAPSED_LINES,
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}
