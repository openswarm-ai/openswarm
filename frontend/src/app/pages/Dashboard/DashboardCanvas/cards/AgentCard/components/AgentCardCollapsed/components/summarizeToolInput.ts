import { parseMcpToolName } from '@/app/pages/AgentChat/toolkit/approvalToolkit/utils';

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