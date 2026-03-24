import React, { useCallback, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import SendIcon from '@mui/icons-material/Send';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import TerminalIcon from '@mui/icons-material/Terminal';
import DescriptionIcon from '@mui/icons-material/Description';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import BuildIcon from '@mui/icons-material/Build';
import ExtensionIcon from '@mui/icons-material/Extension';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { ApprovalRequest } from '@/shared/state/agentsSlice';
import { useAppSelector } from '@/shared/hooks';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// ---------------------------------------------------------------------------
// Integration metadata (icons, colors) for known MCP servers
// ---------------------------------------------------------------------------

interface IntegrationMeta {
  label: string;
  color: string;
  icon: React.ReactNode;
}

const GoogleIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const RedditIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <circle cx="12" cy="12" r="12" fill="#FF4500"/>
    <path d="M19.5 12c0-.6-.5-1.1-1.1-1.1-.3 0-.6.1-.8.3-1-.7-2.3-1.1-3.7-1.1l.6-3 2.1.5c0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.6-.5-1.1-1.1-1.1-.4 0-.8.3-1 .6l-2.3-.5c-.1 0-.2 0-.2.1l-.7 3.3c-1.4 0-2.7.4-3.7 1.1-.2-.2-.5-.3-.8-.3-.6 0-1.1.5-1.1 1.1 0 .4.2.8.6 1-.1.3-.1.6-.1.9 0 2.3 2.6 4.1 5.8 4.1s5.8-1.8 5.8-4.1c0-.3 0-.6-.1-.9.4-.2.6-.6.6-1zm-9.8 1.1c0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1-.6 0-1.1-.5-1.1-1.1zm6.2 2.9c-.8.8-2 .9-2.9.9s-2.1-.1-2.9-.9c-.1-.1-.1-.3 0-.4.1-.1.3-.1.4 0 .6.6 1.6.8 2.5.8s1.9-.2 2.5-.8c.1-.1.3-.1.4 0 .1.1.1.3 0 .4zm-.2-1.8c-.6 0-1.1-.5-1.1-1.1 0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1z" fill="#fff"/>
  </svg>
);

const INTEGRATION_META: Record<string, IntegrationMeta> = {
  'Google Workspace': { label: 'Google Workspace', color: '#4285F4', icon: GoogleIcon },
  'xbird': { label: 'X / Twitter', color: '#1DA1F2', icon: <span style={{ fontSize: 14, fontWeight: 700 }}>𝕏</span> },
  'Reddit': { label: 'Reddit', color: '#FF4500', icon: RedditIcon },
};

// ---------------------------------------------------------------------------
// MCP tool name parser
// ---------------------------------------------------------------------------

export interface ParsedTool {
  isMcp: boolean;
  serverSlug: string;
  actionName: string;
  displayName: string;
}

export function parseMcpToolName(rawName: string): ParsedTool {
  const m = rawName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (!m) {
    return { isMcp: false, serverSlug: '', actionName: rawName, displayName: rawName };
  }
  const serverSlug = m[1];
  const actionName = m[2];
  const displayName = actionName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return { isMcp: true, serverSlug, actionName, displayName };
}

function sanitizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Look up MCP tool metadata from the Redux tools store
// ---------------------------------------------------------------------------

interface McpToolMeta {
  integration: IntegrationMeta | null;
  description: string;
  serverLabel: string;
}

export function useMcpToolMeta(parsed: ParsedTool): McpToolMeta {
  const toolItems = useAppSelector((s) => s.tools.items);

  return useMemo(() => {
    if (!parsed.isMcp) {
      return { integration: null, description: '', serverLabel: '' };
    }

    const toolDef: ToolDefinition | undefined = Object.values(toolItems).find(
      (t) => t.mcp_config && Object.keys(t.mcp_config).length > 0 && sanitizeServerName(t.name) === parsed.serverSlug
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
// Smart input summary for MCP tools
// ---------------------------------------------------------------------------

function getMcpInputSummary(actionName: string, toolInput: Record<string, any>): string {
  const lower = actionName.toLowerCase();

  if (lower.includes('gmail') || lower.includes('email') || lower.includes('mail')) {
    const query = toolInput.query || toolInput.search_query || toolInput.q || '';
    const to = toolInput.to || toolInput.recipient || '';
    const subject = toolInput.subject || '';
    if (query) return `Search: "${query}"`;
    if (to && subject) return `To ${to} — ${subject}`;
    if (to) return `To ${to}`;
    if (subject) return `Subject: ${subject}`;
  }

  if (lower.includes('calendar') || lower.includes('event') || lower.includes('freebusy')) {
    const summary = toolInput.summary || toolInput.title || toolInput.event_name || '';
    const start = toolInput.start || toolInput.start_time || toolInput.date || '';
    if (summary && start) return `${summary} — ${start}`;
    if (summary) return summary;
    if (start) return `Date: ${start}`;
  }

  if (lower.includes('drive') || lower.includes('doc') || lower.includes('sheet') || lower.includes('slide')) {
    const name = toolInput.name || toolInput.title || toolInput.filename || toolInput.file_name || '';
    const query = toolInput.query || toolInput.q || '';
    if (name) return name;
    if (query) return `Search: "${query}"`;
  }

  if (lower.includes('tweet') || lower.includes('post') || lower.includes('send') || lower.includes('reply')) {
    const text = toolInput.text || toolInput.content || toolInput.body || toolInput.message || '';
    if (text) return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }

  if (lower.includes('search') || lower.includes('find') || lower.includes('query') || lower.includes('list')) {
    const query = toolInput.query || toolInput.q || toolInput.search_query || toolInput.keyword || toolInput.term || '';
    if (query) return `"${query}"`;
  }

  const stringVals: string[] = [];
  for (const [key, val] of Object.entries(toolInput)) {
    if (key.startsWith('_')) continue;
    if (typeof val === 'string' && val.trim()) {
      stringVals.push(val.trim());
    }
    if (stringVals.length >= 2) break;
  }
  if (stringVals.length > 0) {
    const joined = stringVals.join(' -- ');
    return joined.length > 100 ? joined.slice(0, 97) + '...' : joined;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

interface Props {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
}

export function getToolIcon(toolName: string) {
  switch (toolName) {
    case 'Bash': return <TerminalIcon sx={{ fontSize: '1rem' }} />;
    case 'Read': return <DescriptionIcon sx={{ fontSize: '1rem' }} />;
    case 'Write': case 'Edit': return <EditIcon sx={{ fontSize: '1rem' }} />;
    case 'Grep': case 'Glob': return <SearchIcon sx={{ fontSize: '1rem' }} />;
    case 'AskUserQuestion': return <QuestionAnswerIcon sx={{ fontSize: '1rem' }} />;
    default: return <BuildIcon sx={{ fontSize: '1rem' }} />;
  }
}

interface ToolPreviewProps {
  request: ApprovalRequest;
  tokens: ReturnType<typeof useClaudeTokens>;
}

const CodeBlock: React.FC<{ tokens: ReturnType<typeof useClaudeTokens>; children: React.ReactNode }> = ({ tokens: c, children }) => (
  <Box
    component="pre"
    sx={{
      bgcolor: c.bg.secondary,
      borderRadius: 1.5,
      p: 1.5,
      m: 0,
      maxHeight: 150,
      overflow: 'auto',
      border: `1px solid ${c.border.subtle}`,
      color: c.text.secondary,
      fontSize: '0.75rem',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: c.font.mono,
      '&::-webkit-scrollbar': { width: 5 },
      '&::-webkit-scrollbar-track': { background: 'transparent' },
      '&::-webkit-scrollbar-thumb': {
        background: c.border.medium,
        borderRadius: 3,
        '&:hover': { background: c.border.strong },
      },
      scrollbarWidth: 'thin',
      scrollbarColor: `${c.border.medium} transparent`,
    }}
  >
    {children}
  </Box>
);

const ToolPreview: React.FC<ToolPreviewProps> = ({ request, tokens: c }) => {
  const { tool_name, tool_input } = request;

  switch (tool_name) {
    case 'Bash': {
      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {tool_input.description && (
            <Typography sx={{ color: c.text.muted, fontSize: '0.78rem' }}>
              {tool_input.description}
            </Typography>
          )}
          <CodeBlock tokens={c}>{tool_input.command || '(empty command)'}</CodeBlock>
        </Box>
      );
    }

    case 'Read':
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <DescriptionIcon sx={{ fontSize: '0.9rem', color: c.text.muted }} />
          <Typography sx={{ color: c.text.secondary, fontSize: '0.8rem', fontFamily: c.font.mono }}>
            {tool_input.file_path || tool_input.path || JSON.stringify(tool_input)}
          </Typography>
        </Box>
      );

    case 'Write':
    case 'Edit': {
      const path = tool_input.file_path || tool_input.path || '';
      const content = tool_input.content || tool_input.new_content || tool_input.old_string;
      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <EditIcon sx={{ fontSize: '0.9rem', color: c.text.muted }} />
            <Typography sx={{ color: c.text.secondary, fontSize: '0.8rem', fontFamily: c.font.mono }}>
              {path}
            </Typography>
          </Box>
          {content && <CodeBlock tokens={c}>{typeof content === 'string' ? content : JSON.stringify(content, null, 2)}</CodeBlock>}
        </Box>
      );
    }

    case 'Grep':
    case 'Glob': {
      const pattern = tool_input.pattern || tool_input.glob_pattern || tool_input.query || '';
      const path = tool_input.path || tool_input.directory || '';
      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Chip
              label={pattern}
              size="small"
              sx={{ fontFamily: c.font.mono, fontSize: '0.75rem', bgcolor: c.bg.secondary, color: c.text.secondary, border: `1px solid ${c.border.subtle}` }}
            />
            {path && (
              <Typography sx={{ color: c.text.muted, fontSize: '0.75rem', fontFamily: c.font.mono }}>
                in {path}
              </Typography>
            )}
          </Box>
        </Box>
      );
    }

    case 'AskUserQuestion':
      return null;

    default: {
      const preview = tool_input.command || tool_input.file_path || tool_input.path || tool_input.query || null;
      if (preview) {
        return <CodeBlock tokens={c}>{preview}</CodeBlock>;
      }
      return <CodeBlock tokens={c}>{JSON.stringify(tool_input, null, 2)}</CodeBlock>;
    }
  }
};

// ---------------------------------------------------------------------------
// QuestionForm (AskUserQuestion — unchanged)
// ---------------------------------------------------------------------------

function getOptionKey(opt: any): string {
  return opt.id || opt.value || opt.label || opt.text || String(opt);
}

function getOptionLabel(opt: any): string {
  return opt.label || opt.value || opt.text || String(opt);
}

type Answers = Record<number, string | string[]>;

export interface QuestionFormProps {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
  compact?: boolean;
}

const OTHER_KEY = '__other__';

export const QuestionForm: React.FC<QuestionFormProps> = ({ request, onApprove, onDeny, compact }) => {
  const c = useClaudeTokens();
  const questions: any[] = request.tool_input.questions || [];
  const [answers, setAnswers] = useState<Answers>(() => {
    const init: Answers = {};
    questions.forEach((q: any, i: number) => {
      init[i] = q.multiSelect ? [] : '';
    });
    return init;
  });
  const [otherActive, setOtherActive] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  const toggleOption = useCallback((qIdx: number, key: string, multi: boolean) => {
    setAnswers((prev) => {
      const copy = { ...prev };
      if (multi) {
        const arr = Array.isArray(copy[qIdx]) ? [...(copy[qIdx] as string[])] : [];
        const idx = arr.indexOf(key);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(key);
        copy[qIdx] = arr;
      } else {
        copy[qIdx] = copy[qIdx] === key ? '' : key;
      }
      return copy;
    });
    if (key !== OTHER_KEY) {
      if (!multi) {
        setOtherActive((prev) => ({ ...prev, [qIdx]: false }));
        setOtherText((prev) => ({ ...prev, [qIdx]: '' }));
      }
    }
  }, []);

  const toggleOther = useCallback((qIdx: number, multi: boolean) => {
    setOtherActive((prev) => {
      const wasActive = !!prev[qIdx];
      if (wasActive) {
        setOtherText((p) => ({ ...p, [qIdx]: '' }));
      }
      if (!multi && !wasActive) {
        setAnswers((p) => ({ ...p, [qIdx]: '' }));
      }
      return { ...prev, [qIdx]: !wasActive };
    });
  }, []);

  const setTextAnswer = useCallback((qIdx: number, text: string) => {
    setAnswers((prev) => ({ ...prev, [qIdx]: text }));
  }, []);

  const handleSubmit = () => {
    const answersDict: Record<string, string> = {};
    questions.forEach((q: any, i: number) => {
      const questionText = q.question || q.prompt || q.text || '';
      const hasOptions = Array.isArray(q.options) && q.options.length > 0;
      let answer = answers[i];
      if (hasOptions && otherActive[i] && otherText[i]) {
        if (q.multiSelect) {
          const arr = Array.isArray(answer) ? [...answer] : [];
          arr.push(otherText[i]);
          answer = arr;
        } else {
          answer = otherText[i];
        }
      }
      if (Array.isArray(answer)) {
        answersDict[questionText] = answer.join(', ');
      } else {
        answersDict[questionText] = answer || '';
      }
    });
    onApprove(request.id, { ...request.tool_input, questions, answers: answersDict });
  };

  const isSelected = (qIdx: number, key: string): boolean => {
    const val = answers[qIdx];
    if (Array.isArray(val)) return val.includes(key);
    return val === key;
  };

  return (
    <Box
      sx={{
        bgcolor: c.bg.secondary,
        border: `1px solid ${c.accent.primary}33`,
        borderRadius: compact ? 2 : 2.5,
        p: compact ? 1.5 : 2,
        mx: compact ? 0 : 2,
        mb: compact ? 0 : 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
        <Box sx={{ color: c.accent.primary, display: 'flex', alignItems: 'center' }}>
          <QuestionAnswerIcon sx={{ fontSize: '1rem' }} />
        </Box>
        <Typography sx={{ color: c.accent.primary, fontWeight: 700, fontSize: '0.85rem' }}>
          Agent has a question
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 2 }}>
        {questions.map((q: any, i: number) => {
          const hasOptions = Array.isArray(q.options) && q.options.length > 0;
          const multi = !!q.multiSelect;
          const isOtherActive = !!otherActive[i];
          return (
            <Box key={i}>
              {q.header && (
                <Typography sx={{ color: c.text.muted, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', mb: 0.25 }}>
                  {q.header}
                </Typography>
              )}
              <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 500, mb: 0.75 }}>
                {q.question || q.prompt || q.text || '(question)'}
              </Typography>
              {hasOptions ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                    {q.options.map((opt: any) => {
                      const key = getOptionKey(opt);
                      const selected = isSelected(i, key);
                      return (
                        <Chip
                          key={key}
                          label={getOptionLabel(opt)}
                          size="small"
                          onClick={() => toggleOption(i, key, multi)}
                          sx={{
                            fontSize: '0.78rem',
                            fontWeight: selected ? 600 : 400,
                            cursor: 'pointer',
                            color: selected ? c.accent.primary : c.text.secondary,
                            bgcolor: selected ? `${c.accent.primary}18` : 'transparent',
                            borderColor: selected ? c.accent.primary : c.border.medium,
                            borderWidth: 1,
                            borderStyle: 'solid',
                            transition: 'all 0.15s ease',
                            '&:hover': {
                              bgcolor: selected ? `${c.accent.primary}24` : `${c.text.secondary}0a`,
                              borderColor: selected ? c.accent.primary : c.text.secondary,
                            },
                          }}
                        />
                      );
                    })}
                    <Chip
                      label="Other…"
                      size="small"
                      onClick={() => toggleOther(i, multi)}
                      sx={{
                        fontSize: '0.78rem',
                        fontWeight: isOtherActive ? 600 : 400,
                        fontStyle: 'italic',
                        cursor: 'pointer',
                        color: isOtherActive ? c.accent.primary : c.text.muted,
                        bgcolor: isOtherActive ? `${c.accent.primary}18` : 'transparent',
                        borderColor: isOtherActive ? c.accent.primary : c.border.subtle,
                        borderWidth: 1,
                        borderStyle: 'dashed',
                        transition: 'all 0.15s ease',
                        '&:hover': {
                          bgcolor: isOtherActive ? `${c.accent.primary}24` : `${c.text.secondary}0a`,
                          borderColor: isOtherActive ? c.accent.primary : c.border.medium,
                        },
                      }}
                    />
                  </Box>
                  {isOtherActive && (
                    <TextField
                      placeholder="Type your own answer..."
                      value={otherText[i] || ''}
                      onChange={(e) => setOtherText((prev) => ({ ...prev, [i]: e.target.value }))}
                      fullWidth
                      size="small"
                      autoFocus
                      sx={{
                        mt: 0.25,
                        '& .MuiOutlinedInput-root': {
                          color: c.text.primary,
                          fontSize: '0.82rem',
                          '& fieldset': { borderColor: c.border.medium },
                          '&:hover fieldset': { borderColor: c.border.strong },
                          '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                        },
                      }}
                    />
                  )}
                </Box>
              ) : (
                <TextField
                  placeholder="Type your answer..."
                  value={answers[i] || ''}
                  onChange={(e) => setTextAnswer(i, e.target.value)}
                  fullWidth
                  size="small"
                  multiline
                  maxRows={4}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      color: c.text.primary,
                      fontSize: '0.82rem',
                      '& fieldset': { borderColor: c.border.medium },
                      '&:hover fieldset': { borderColor: c.border.strong },
                      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                    },
                  }}
                />
              )}
            </Box>
          );
        })}
      </Box>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          variant="contained"
          startIcon={<SendIcon />}
          onClick={handleSubmit}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.hover || c.accent.primary, filter: 'brightness(0.9)' },
            fontWeight: 600,
            fontSize: '0.8rem',
          }}
        >
          Submit
        </Button>
        <Button
          variant="outlined"
          onClick={() => onDeny(request.id)}
          sx={{
            borderColor: c.border.strong,
            color: c.text.secondary,
            '&:hover': { borderColor: c.text.secondary, bgcolor: `${c.text.secondary}08` },
            fontWeight: 600,
            fontSize: '0.8rem',
          }}
        >
          Dismiss
        </Button>
      </Box>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// GenericApprovalBar — redesigned for MCP tools
// ---------------------------------------------------------------------------

const GenericApprovalBar: React.FC<Props> = ({ request, onApprove, onDeny }) => {
  const c = useClaudeTokens();
  const [denyMessage, setDenyMessage] = useState('');
  const [showDenyInput, setShowDenyInput] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const parsed = useMemo(() => parseMcpToolName(request.tool_name), [request.tool_name]);
  const meta = useMcpToolMeta(parsed);

  const accentColor = meta.integration?.color || c.status.warning;
  const summary = parsed.isMcp ? getMcpInputSummary(parsed.actionName, request.tool_input) : '';

  if (!parsed.isMcp) {
    return (
      <Box
        sx={{
          bgcolor: c.status.warningBg,
          border: '1px solid rgba(128,92,31,0.2)',
          borderRadius: 2.5,
          p: 2,
          mx: 2,
          mb: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.25 }}>
          <Box sx={{ color: c.status.warning, display: 'flex', alignItems: 'center' }}>
            {getToolIcon(request.tool_name)}
          </Box>
          <Typography sx={{ color: c.status.warning, fontWeight: 700, fontSize: '0.85rem' }}>
            Permission Required
          </Typography>
          <Chip
            label={request.tool_name}
            size="small"
            sx={{
              height: 20,
              fontSize: '0.7rem',
              fontWeight: 600,
              fontFamily: c.font.mono,
              bgcolor: 'rgba(128,92,31,0.15)',
              color: c.status.warning,
              border: 'none',
            }}
          />
        </Box>

        <Box sx={{ mb: 1.5 }}>
          <ToolPreview request={request} tokens={c} />
        </Box>

        {showDenyInput && (
          <TextField
            placeholder="Reason for denying (optional)..."
            value={denyMessage}
            onChange={(e) => setDenyMessage(e.target.value)}
            fullWidth
            size="small"
            sx={{
              mb: 1.5,
              '& .MuiOutlinedInput-root': {
                color: c.text.primary,
                fontSize: '0.8rem',
                '& fieldset': { borderColor: c.border.strong },
                '&.Mui-focused fieldset': { borderColor: c.status.error },
              },
            }}
          />
        )}

        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            startIcon={<CheckIcon />}
            onClick={() => onApprove(request.id)}
            sx={{ bgcolor: c.status.success, '&:hover': { bgcolor: '#1e4d15' }, fontWeight: 600, fontSize: '0.8rem' }}
          >
            Approve
          </Button>
          {showDenyInput ? (
            <Button
              variant="contained"
              startIcon={<CloseIcon />}
              onClick={() => { onDeny(request.id, denyMessage || undefined); setShowDenyInput(false); setDenyMessage(''); }}
              sx={{ bgcolor: c.status.error, '&:hover': { bgcolor: '#8f2828' }, fontWeight: 600, fontSize: '0.8rem' }}
            >
              Deny
            </Button>
          ) : (
            <Button
              variant="outlined"
              onClick={() => setShowDenyInput(true)}
              sx={{ borderColor: c.status.error, color: c.status.error, '&:hover': { borderColor: '#8f2828', bgcolor: 'rgba(181,51,51,0.04)' }, fontWeight: 600, fontSize: '0.8rem' }}
            >
              Deny
            </Button>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.subtle}`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 2.5,
        p: 0,
        mx: 2,
        mb: 1,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, pt: 1.75, pb: 0.5 }}>
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: 1.5,
            bgcolor: `${accentColor}14`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {meta.integration?.icon || <ExtensionIcon sx={{ fontSize: 18, color: accentColor }} />}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.9rem' }}>
              {parsed.displayName}
            </Typography>
            <Chip
              label={meta.serverLabel || parsed.serverSlug}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.65rem',
                fontWeight: 500,
                bgcolor: `${accentColor}12`,
                color: accentColor,
                border: 'none',
                '& .MuiChip-label': { px: 0.6 },
              }}
            />
          </Box>
          {meta.description && (
            <Typography
              sx={{
                color: c.text.tertiary,
                fontSize: '0.78rem',
                lineHeight: 1.3,
                mt: 0.15,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {meta.description}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Input summary / details */}
      <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
        {summary && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              cursor: 'pointer',
              '&:hover .expand-icon': { color: c.text.secondary },
            }}
            onClick={() => setDetailsExpanded((v) => !v)}
          >
            <Typography
              sx={{
                color: c.text.secondary,
                fontSize: '0.82rem',
                fontFamily: c.font.mono,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {summary}
            </Typography>
            <IconButton className="expand-icon" size="small" sx={{ color: c.text.ghost, p: 0.25, flexShrink: 0 }}>
              {detailsExpanded ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Box>
        )}
        <Collapse in={detailsExpanded || !summary}>
          <Box sx={{ mt: summary ? 0.75 : 0 }}>
            <CodeBlock tokens={c}>
              {JSON.stringify(request.tool_input, null, 2)}
            </CodeBlock>
          </Box>
        </Collapse>
      </Box>

      {/* Deny reason input */}
      {showDenyInput && (
        <Box sx={{ px: 2, pb: 0.5 }}>
          <TextField
            placeholder="Reason for denying (optional)..."
            value={denyMessage}
            onChange={(e) => setDenyMessage(e.target.value)}
            fullWidth
            size="small"
            autoFocus
            sx={{
              '& .MuiOutlinedInput-root': {
                color: c.text.primary,
                fontSize: '0.8rem',
                '& fieldset': { borderColor: c.border.strong },
                '&.Mui-focused fieldset': { borderColor: c.status.error },
              },
            }}
          />
        </Box>
      )}

      {/* Action buttons */}
      <Box sx={{ display: 'flex', gap: 1, px: 2, pt: 1, pb: 1.75 }}>
        <Button
          variant="contained"
          startIcon={<CheckIcon />}
          onClick={() => onApprove(request.id)}
          sx={{
            bgcolor: c.status.success,
            '&:hover': { bgcolor: '#1e4d15' },
            fontWeight: 600,
            fontSize: '0.8rem',
            textTransform: 'none',
            borderRadius: 1.5,
            px: 2,
          }}
        >
          Approve
        </Button>
        {showDenyInput ? (
          <Button
            variant="contained"
            startIcon={<CloseIcon />}
            onClick={() => { onDeny(request.id, denyMessage || undefined); setShowDenyInput(false); setDenyMessage(''); }}
            sx={{
              bgcolor: c.status.error,
              '&:hover': { bgcolor: '#8f2828' },
              fontWeight: 600,
              fontSize: '0.8rem',
              textTransform: 'none',
              borderRadius: 1.5,
              px: 2,
            }}
          >
            Deny
          </Button>
        ) : (
          <Button
            variant="outlined"
            onClick={() => setShowDenyInput(true)}
            sx={{
              borderColor: c.status.error,
              color: c.status.error,
              '&:hover': { borderColor: '#8f2828', bgcolor: 'rgba(181,51,51,0.04)' },
              fontWeight: 600,
              fontSize: '0.8rem',
              textTransform: 'none',
              borderRadius: 1.5,
              px: 2,
            }}
          >
            Deny
          </Button>
        )}
      </Box>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const ApprovalBar: React.FC<Props> = (props) => {
  if (props.request.tool_name === 'AskUserQuestion') {
    return <QuestionForm request={props.request} onApprove={props.onApprove} onDeny={props.onDeny} />;
  }
  return <GenericApprovalBar {...props} />;
};

// ---------------------------------------------------------------------------
// BatchApprovalBar — grouped mass approve/deny when many approvals pending
// ---------------------------------------------------------------------------

interface ToolGroup {
  toolName: string;
  parsed: ParsedTool;
  requests: ApprovalRequest[];
}

interface BatchApprovalBarProps {
  requests: ApprovalRequest[];
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
}

export const BatchApprovalBar: React.FC<BatchApprovalBarProps> = ({ requests, onApprove, onDeny }) => {
  const c = useClaudeTokens();
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const questions = requests.filter((r) => r.tool_name === 'AskUserQuestion');
  const nonQuestions = requests.filter((r) => r.tool_name !== 'AskUserQuestion');

  const groups = useMemo(() => {
    const map = new Map<string, ToolGroup>();
    for (const req of nonQuestions) {
      const existing = map.get(req.tool_name);
      if (existing) {
        existing.requests.push(req);
      } else {
        map.set(req.tool_name, {
          toolName: req.tool_name,
          parsed: parseMcpToolName(req.tool_name),
          requests: [req],
        });
      }
    }
    return Array.from(map.values());
  }, [nonQuestions]);

  const handleApproveAll = () => {
    for (const req of nonQuestions) onApprove(req.id);
  };

  const handleDenyAll = () => {
    for (const req of nonQuestions) onDeny(req.id);
  };

  const handleApproveGroup = (group: ToolGroup) => {
    for (const req of group.requests) onApprove(req.id);
  };

  const handleDenyGroup = (group: ToolGroup) => {
    for (const req of group.requests) onDeny(req.id);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {questions.map((req) => (
        <QuestionForm key={req.id} request={req} onApprove={onApprove} onDeny={onDeny} />
      ))}

      {nonQuestions.length > 1 && (
        <Box
          sx={{
            mx: 2,
            mb: 0.5,
            borderRadius: 2.5,
            border: `1px solid ${c.border.subtle}`,
            bgcolor: c.bg.surface,
            overflow: 'hidden',
          }}
        >
          {/* Global actions bar */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              px: 2,
              py: 1.25,
              bgcolor: c.status.warningBg,
              borderBottom: `1px solid ${c.border.subtle}`,
            }}
          >
            <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: c.status.warning, flex: 1 }}>
              {nonQuestions.length} pending approvals
            </Typography>
            <Button
              variant="contained"
              size="small"
              startIcon={<CheckIcon />}
              onClick={handleApproveAll}
              sx={{
                bgcolor: c.status.success,
                '&:hover': { bgcolor: '#1e4d15' },
                fontWeight: 600,
                fontSize: '0.78rem',
                textTransform: 'none',
                borderRadius: 1.5,
                px: 1.5,
                minHeight: 30,
              }}
            >
              Approve All
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<CloseIcon />}
              onClick={handleDenyAll}
              sx={{
                borderColor: c.status.error,
                color: c.status.error,
                '&:hover': { borderColor: '#8f2828', bgcolor: 'rgba(181,51,51,0.04)' },
                fontWeight: 600,
                fontSize: '0.78rem',
                textTransform: 'none',
                borderRadius: 1.5,
                px: 1.5,
                minHeight: 30,
              }}
            >
              Deny All
            </Button>
          </Box>

          {/* Per-group rows */}
          {groups.map((group) => (
            <GroupRow
              key={group.toolName}
              group={group}
              expanded={expandedGroup === group.toolName}
              onToggle={() => setExpandedGroup((prev) => prev === group.toolName ? null : group.toolName)}
              onApprove={onApprove}
              onDeny={onDeny}
              onApproveGroup={() => handleApproveGroup(group)}
              onDenyGroup={() => handleDenyGroup(group)}
            />
          ))}
        </Box>
      )}

      {nonQuestions.length === 1 && (
        <ApprovalBar request={nonQuestions[0]} onApprove={onApprove} onDeny={onDeny} />
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// GroupRow — a single tool-name group within the batch bar
// ---------------------------------------------------------------------------

interface GroupRowProps {
  group: ToolGroup;
  expanded: boolean;
  onToggle: () => void;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
  onApproveGroup: () => void;
  onDenyGroup: () => void;
}

const GroupRow: React.FC<GroupRowProps> = ({ group, expanded, onToggle, onApprove, onDeny, onApproveGroup, onDenyGroup }) => {
  const c = useClaudeTokens();
  const meta = useMcpToolMeta(group.parsed);
  const accentColor = meta.integration?.color || c.status.warning;

  return (
    <Box sx={{ borderBottom: `1px solid ${c.border.subtle}`, '&:last-child': { borderBottom: 'none' } }}>
      <Box
        onClick={onToggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          py: 1,
          cursor: 'pointer',
          '&:hover': { bgcolor: c.bg.secondary },
          transition: 'background-color 0.1s',
        }}
      >
        <Box
          sx={{
            width: 26,
            height: 26,
            borderRadius: 1,
            bgcolor: `${accentColor}14`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {group.parsed.isMcp
            ? (meta.integration?.icon || <ExtensionIcon sx={{ fontSize: 15, color: accentColor }} />)
            : getToolIcon(group.toolName)}
        </Box>

        <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: c.text.primary, flex: 1 }}>
          {group.parsed.isMcp ? group.parsed.displayName : group.toolName}
        </Typography>

        <Chip
          label={`${group.requests.length}`}
          size="small"
          sx={{
            height: 20,
            minWidth: 24,
            fontSize: '0.72rem',
            fontWeight: 700,
            bgcolor: `${accentColor}18`,
            color: accentColor,
            border: 'none',
          }}
        />

        {group.requests.length > 1 && (
          <>
            <Button
              variant="text"
              size="small"
              onClick={(e) => { e.stopPropagation(); onApproveGroup(); }}
              sx={{
                color: c.status.success,
                fontWeight: 600,
                fontSize: '0.72rem',
                textTransform: 'none',
                minWidth: 0,
                px: 1,
                minHeight: 24,
              }}
            >
              Approve {group.requests.length}
            </Button>
            <Button
              variant="text"
              size="small"
              onClick={(e) => { e.stopPropagation(); onDenyGroup(); }}
              sx={{
                color: c.status.error,
                fontWeight: 600,
                fontSize: '0.72rem',
                textTransform: 'none',
                minWidth: 0,
                px: 1,
                minHeight: 24,
              }}
            >
              Deny {group.requests.length}
            </Button>
          </>
        )}

        <IconButton size="small" sx={{ color: c.text.ghost, p: 0.25 }}>
          {expanded ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <Box sx={{ px: 1, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {group.requests.map((req) => (
            <ApprovalBar key={req.id} request={req} onApprove={onApprove} onDeny={onDeny} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};

export default ApprovalBar;
