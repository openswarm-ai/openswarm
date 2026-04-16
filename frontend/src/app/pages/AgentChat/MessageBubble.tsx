import React, { useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Modal from '@mui/material/Modal';
import CloseIcon from '@mui/icons-material/Close';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { SKILL_COLOR } from '@/app/components/richEditorUtils';
import ViewBubble from './ViewBubble';

const streamingCursorKeyframes = `
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`;

// Claude.ai-style shimmer that sweeps left → right across text while the
// model is actively thinking. Uses background-clip: text to mask a moving
// linear gradient onto the text glyphs so the effect looks like a light
// wave traveling through the letters.
const thinkingShimmerKeyframes = `
@keyframes thinking-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
`;

const StreamingCursor: React.FC = () => {
  const c = useClaudeTokens();
  return (
    <>
      <style>{streamingCursorKeyframes}</style>
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
    </>
  );
};

const ELEMENT_SEPARATOR = '\n\n---\nSelected UI Elements:\n';

interface OpenSwarmErrorInfo {
  kind: 'cap' | 'capacity' | 'auth' | 'network';
  title: string;
  detail: string;
  ctaLabel?: string;
  ctaAction?: 'upgrade' | 'retry' | 'settings';
}

// Turn a raw Claude-CLI / cloud error string into a user-friendly card.
// Returns null for things that aren't obviously our errors — those fall
// through to normal markdown rendering.
function parseOpenSwarmError(text: string): OpenSwarmErrorInfo | null {
  if (!text) return null;
  // Rate-limit cap from our cloud
  if (/rate_limit_error|reached your OpenSwarm.*plan limit|Usage cap exceeded/i.test(text)) {
    const reset = text.match(/Resets in ([\dhms\s]+)/)?.[1];
    return {
      kind: 'cap',
      title: "You've hit your plan limit",
      detail: reset
        ? `Your usage resets in ${reset}. Upgrade to keep going now, or wait for the window to reset.`
        : 'Upgrade to keep going now, or wait for your usage window to reset.',
      ctaLabel: 'Upgrade plan',
      ctaAction: 'upgrade',
    };
  }
  // Upstream capacity / 503
  if (/at capacity|Try again shortly|503|service unavailable/i.test(text)) {
    return {
      kind: 'capacity',
      title: 'OpenSwarm servers are busy',
      detail: "We're hitting capacity on our end — please retry in a moment. If this keeps happening, contact support.",
      ctaLabel: 'Try again',
      ctaAction: 'retry',
    };
  }
  // Auth / subscription problems
  if (/No active subscription|Subscription canceled|Subscription past_due|Invalid.*token|Missing bearer token/i.test(text)) {
    return {
      kind: 'auth',
      title: 'Subscription issue',
      detail: "We can't find an active OpenSwarm subscription. Check your billing status.",
      ctaLabel: 'Open Settings',
      ctaAction: 'settings',
    };
  }
  // Network issues (keep last so it doesn't swallow the specific cases above)
  if (/ECONNREFUSED|ENETUNREACH|fetch failed|ETIMEDOUT|network|Could not reach/i.test(text)) {
    return {
      kind: 'network',
      title: 'Network issue',
      detail: "Can't reach the OpenSwarm service. Check your internet connection and try again.",
      ctaLabel: 'Try again',
      ctaAction: 'retry',
    };
  }
  return null;
}

interface ParsedElement {
  label: string;
  selector: string;
  isSemantic?: boolean;
}

function parseElementContext(text: string): { userMessage: string; elements: ParsedElement[] } {
  const sepIdx = text.indexOf(ELEMENT_SEPARATOR);
  if (sepIdx === -1) return { userMessage: text, elements: [] };

  const userMessage = text.slice(0, sepIdx);
  const elementSection = text.slice(sepIdx + ELEMENT_SEPARATOR.length);

  const elements: ParsedElement[] = [];
  const blocks = elementSection.split(/\n(?=\d+\.\s)/).filter(Boolean);
  for (const block of blocks) {
    const semanticMatch = block.match(/\d+\.\s+\[([^\]]+)\]\s*(.*)/);
    if (semanticMatch) {
      const typeLabel = semanticMatch[1];
      const rest = semanticMatch[2].trim();
      elements.push({
        label: `${typeLabel}: ${rest.split('\n')[0]}`,
        selector: typeLabel,
        isSemantic: true,
      });
      continue;
    }

    const labelMatch = block.match(/`([^`]+)`\s+\((\w+)\)/);
    const selectorMatch = block.match(/Selector:\s*(.+)/);
    if (labelMatch) {
      elements.push({
        label: labelMatch[1],
        selector: selectorMatch?.[1]?.trim() ?? labelMatch[1],
      });
    }
  }

  return { userMessage, elements };
}

const SKILL_PILL_RE = /\{\{skill:([^}]+)\}\}/g;

function renderUserTextWithPills(text: string, c: ReturnType<typeof useClaudeTokens>): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(SKILL_PILL_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const skillName = match[1];
    parts.push(
      <Chip
        key={`skill-${match.index}`}
        icon={<PsychologyOutlinedIcon sx={{ fontSize: 12 }} />}
        label={skillName}
        size="small"
        sx={{
          bgcolor: `${SKILL_COLOR}18`,
          color: SKILL_COLOR,
          fontSize: '0.72rem',
          fontFamily: c.font.mono,
          height: 20,
          mx: 0.25,
          verticalAlign: 'baseline',
          '& .MuiChip-icon': { color: SKILL_COLOR },
        }}
      />,
    );
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

interface ContextGroup {
  key: string;
  icon: React.ReactNode;
  color: string;
  label: string;
  chips: Array<{ label: string; tooltip?: string; icon: React.ReactNode }>;
}

function buildContextGroups(
  elements: ParsedElement[],
  message: AgentMessage,
): ContextGroup[] {
  const groups: ContextGroup[] = [];

  if (elements.length > 0) {
    groups.push({
      key: 'elements',
      icon: <AdsClickIcon sx={{ fontSize: 13 }} />,
      color: '#3b82f6',
      label: `${elements.length} element${elements.length > 1 ? 's' : ''} selected`,
      chips: elements.map((el) => ({
        label: el.label,
        tooltip: el.selector,
        icon: <AdsClickIcon sx={{ fontSize: 12 }} />,
      })),
    });
  }

  const contextPaths = message.context_paths;
  if (contextPaths && contextPaths.length > 0) {
    const files = contextPaths.filter((cp) => cp.type === 'file');
    const dirs = contextPaths.filter((cp) => cp.type === 'directory');
    const allPaths = [...dirs, ...files];
    const label = [
      dirs.length > 0 ? `${dirs.length} folder${dirs.length > 1 ? 's' : ''}` : '',
      files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(', ') + ' attached';
    groups.push({
      key: 'paths',
      icon: <FolderOutlinedIcon sx={{ fontSize: 13 }} />,
      color: '#10b981',
      label,
      chips: allPaths.map((cp) => {
        const name = cp.path.split('/').filter(Boolean).pop() || cp.path;
        return {
          label: name,
          tooltip: cp.path,
          icon: cp.type === 'directory'
            ? <FolderOutlinedIcon sx={{ fontSize: 12 }} />
            : <InsertDriveFileOutlinedIcon sx={{ fontSize: 12 }} />,
        };
      }),
    });
  }

  const skills = message.attached_skills;
  if (skills && skills.length > 0) {
    groups.push({
      key: 'skills',
      icon: <PsychologyOutlinedIcon sx={{ fontSize: 13 }} />,
      color: SKILL_COLOR,
      label: `${skills.length} skill${skills.length > 1 ? 's' : ''}`,
      chips: skills.map((s) => ({
        label: s.name,
        icon: <PsychologyOutlinedIcon sx={{ fontSize: 12 }} />,
      })),
    });
  }

  const forcedTools = message.forced_tools;
  if (forcedTools && forcedTools.length > 0) {
    groups.push({
      key: 'tools',
      icon: <BuildOutlinedIcon sx={{ fontSize: 13 }} />,
      color: '#f59e0b',
      label: `${forcedTools.length} action${forcedTools.length > 1 ? 's' : ''} requested`,
      chips: forcedTools.map((t) => ({
        label: t,
        icon: <BuildOutlinedIcon sx={{ fontSize: 12 }} />,
      })),
    });
  }

  return groups;
}

const AttachedContextSection: React.FC<{
  elements: ParsedElement[];
  message: AgentMessage;
  c: ReturnType<typeof useClaudeTokens>;
}> = ({ elements, message, c }) => {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => buildContextGroups(elements, message), [elements, message]);

  if (groups.length === 0) return null;

  return (
    <Box sx={{ mt: 1, pt: 0.75, borderTop: `1px solid ${c.border.subtle}` }}>
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          cursor: 'pointer',
          mb: 0.5,
          '&:hover': { opacity: 0.8 },
        }}
      >
        {groups.map((g) => (
          <Box key={g.key} sx={{ color: g.color, display: 'inline-flex', alignItems: 'center' }}>
            {g.icon}
          </Box>
        ))}
        <Typography sx={{ fontSize: '0.7rem', fontWeight: 600, color: c.text.muted }}>
          {groups.map((g) => g.label).join(' · ')}
        </Typography>
        <ExpandMoreIcon
          sx={{
            fontSize: 14,
            color: c.text.tertiary,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: '0.15s',
          }}
        />
      </Box>
      <Collapse in={expanded}>
        {groups.map((g) => (
          <Box key={g.key} sx={{ mt: 0.5 }}>
            <Typography sx={{ fontSize: '0.62rem', fontWeight: 600, color: g.color, textTransform: 'uppercase', letterSpacing: 0.5, mb: 0.25 }}>
              {g.label}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {g.chips.map((chip, i) => (
                <Tooltip key={i} title={chip.tooltip || chip.label} arrow placement="top"
                  slotProps={{ tooltip: { sx: { fontFamily: c.font.mono, fontSize: '0.68rem', maxWidth: 400 } } }}
                >
                  <Chip
                    icon={chip.icon as React.ReactElement}
                    label={chip.label}
                    size="small"
                    sx={{
                      bgcolor: `${g.color}18`,
                      color: g.color,
                      fontSize: '0.68rem',
                      fontFamily: c.font.mono,
                      height: 22,
                      '& .MuiChip-icon': { color: g.color },
                    }}
                  />
                </Tooltip>
              ))}
            </Box>
          </Box>
        ))}
      </Collapse>
    </Box>
  );
};

const ImageLightbox: React.FC<{
  open: boolean;
  src: string;
  onClose: () => void;
  c: ReturnType<typeof useClaudeTokens>;
}> = ({ open, src, onClose, c }) => (
  <Modal open={open} onClose={onClose} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <Box
      onClick={onClose}
      sx={{
        position: 'relative',
        outline: 'none',
        maxWidth: '90vw',
        maxHeight: '90vh',
      }}
    >
      <IconButton
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: -16,
          right: -16,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          color: c.text.secondary,
          width: 32,
          height: 32,
          zIndex: 1,
          '&:hover': { bgcolor: c.bg.secondary },
          boxShadow: c.shadow.md,
        }}
      >
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <img
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          display: 'block',
        }}
      />
    </Box>
  </Modal>
);

const MessageImageThumbnails: React.FC<{
  images: Array<{ data: string; media_type: string }>;
  c: ReturnType<typeof useClaudeTokens>;
}> = ({ images, c }) => {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <Box sx={{ display: 'flex', gap: 0.75, mb: 1, flexWrap: 'wrap' }}>
        {images.map((img, idx) => {
          const src = `data:${img.media_type};base64,${img.data}`;
          return (
            <Box
              key={idx}
              onClick={() => setLightboxSrc(src)}
              sx={{
                width: 64,
                height: 64,
                flexShrink: 0,
                borderRadius: '8px',
                overflow: 'hidden',
                border: `1px solid ${c.border.subtle}`,
                cursor: 'pointer',
                transition: 'opacity 0.15s, transform 0.15s',
                '&:hover': { opacity: 0.85, transform: 'scale(1.04)' },
              }}
            >
              <img
                src={src}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </Box>
          );
        })}
      </Box>
      <ImageLightbox
        open={!!lightboxSrc}
        src={lightboxSrc || ''}
        onClose={() => setLightboxSrc(null)}
        c={c}
      />
    </>
  );
};

// ── ThinkingBubble ──────────────────────────────────────────────────
// Collapsible reasoning section styled after Claude.ai / ChatGPT /
// Gemini. Defaults to expanded so thinking is always visible when
// present. User can click the header to collapse. If we observed the
// stream live we show "Thought for Ns"; otherwise (history replay) we
// just show "Thoughts".
const ThinkingBubble: React.FC<{
  content: string;
  isStreaming?: boolean;
  timestamp?: string;
}> = ({ content, isStreaming }) => {
  const c = useClaudeTokens();

  // Only time a think-session that we actually saw start live. For saved
  // messages loaded from history, we don't have reliable start/end, so
  // we fall back to a generic "Thoughts" label.
  const [startedStreamingAt, setStartedStreamingAt] = useState<number | null>(
    isStreaming ? Date.now() : null
  );
  const [elapsed, setElapsed] = useState<number>(0);
  const [frozenElapsed, setFrozenElapsed] = useState<number | null>(null);

  // Record start time the first time we see streaming
  React.useEffect(() => {
    if (isStreaming && startedStreamingAt === null) {
      setStartedStreamingAt(Date.now());
    }
  }, [isStreaming, startedStreamingAt]);

  // Tick the timer while streaming
  React.useEffect(() => {
    if (!isStreaming || startedStreamingAt === null) return;
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedStreamingAt) / 1000));
    }, 250);
    return () => clearInterval(iv);
  }, [isStreaming, startedStreamingAt]);

  // Freeze elapsed when streaming ends
  React.useEffect(() => {
    if (!isStreaming && startedStreamingAt !== null && frozenElapsed === null) {
      setFrozenElapsed(Math.max(1, Math.floor((Date.now() - startedStreamingAt) / 1000)));
    }
  }, [isStreaming, startedStreamingAt, frozenElapsed]);

  // Always default to expanded — user can click to collapse
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const expanded = userOverride ?? true;
  const toggle = () => setUserOverride(!expanded);

  const displayedSeconds = frozenElapsed ?? elapsed;
  const label = isStreaming
    ? 'Thinking...'
    : startedStreamingAt !== null
      ? `Thought for ${displayedSeconds}s`
      : 'Thoughts';

  const text = typeof content === 'string' ? content : JSON.stringify(content);

  // Shimmer colors — use a bright mid-tone against the muted base to make
  // the sweep visible without being loud. The base color matches the
  // static "Thought for Ns" state so the only visible change is the moving
  // highlight band.
  const shimmerBase = c.text.tertiary;
  const shimmerHighlight = c.text.primary;

  return (
    <Box sx={{ my: 0.5 }}>
      <style>{thinkingShimmerKeyframes}</style>
      <Box
        onClick={toggle}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          cursor: 'pointer',
          color: c.text.tertiary,
          fontSize: '0.78rem',
          py: 0.5,
          px: 1,
          ml: -1,
          borderRadius: `${c.radius.sm}px`,
          transition: 'all 0.15s ease',
          '&:hover': { color: c.text.secondary, bgcolor: c.bg.secondary },
          userSelect: 'none',
        }}
      >
        <PsychologyOutlinedIcon sx={{ fontSize: 14, opacity: 0.75 }} />
        <Typography
          sx={{
            fontSize: '0.78rem',
            fontWeight: 500,
            ...(isStreaming ? {
              // Moving gradient masked onto the text glyphs
              background: `linear-gradient(90deg, ${shimmerBase} 0%, ${shimmerBase} 40%, ${shimmerHighlight} 50%, ${shimmerBase} 60%, ${shimmerBase} 100%)`,
              backgroundSize: '200% 100%',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              color: 'transparent',
              animation: 'thinking-shimmer 2s linear infinite',
            } : { color: 'inherit' }),
          }}
        >
          {label}
        </Typography>
        <ExpandMoreIcon
          sx={{
            fontSize: 16,
            opacity: 0.6,
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s ease',
          }}
        />
      </Box>
      <Collapse in={expanded} timeout={200}>
        <Box
          sx={{
            mt: 0.5,
            ml: 0.5,
            pl: 1.5,
            borderLeft: `2px solid ${c.border.subtle}`,
            color: c.text.tertiary,
            fontSize: '0.85rem',
            lineHeight: 1.55,
            fontStyle: 'normal',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: c.font.sans,
          }}
        >
          {text}
          {isStreaming && <StreamingCursor />}
        </Box>
      </Collapse>
    </Box>
  );
};

interface Props {
  message: AgentMessage;
  editing?: boolean;
  onSaveEdit?: (messageId: string, newContent: string) => void;
  onCancelEdit?: () => void;
  isStreaming?: boolean;
}

const MessageBubble: React.FC<Props> = React.memo(({ message, editing = false, onSaveEdit, onCancelEdit, isStreaming }) => {
  const c = useClaudeTokens();
  const [editText, setEditText] = useState('');
  const { role, content } = message;

  if (role === 'system') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', my: 1 }}>
        <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem', fontStyle: 'italic' }}>
          {typeof content === 'string' ? content : JSON.stringify(content)}
        </Typography>
      </Box>
    );
  }

  if (role === 'thinking') {
    return (
      <ThinkingBubble
        content={typeof content === 'string' ? content : JSON.stringify(content)}
        isStreaming={isStreaming}
        timestamp={message.timestamp}
      />
    );
  }

  if (role === 'tool_call') {
    const toolData = typeof content === 'object' ? content : {};
    const toolInput = toolData.input || {};
    if (toolData.tool === 'RenderOutput') {
      return <ViewBubble toolInput={toolInput} isStreaming={isStreaming} />;
    }
    return null;
  }

  if (role === 'tool_result') {
    let parsedContent: any = null;
    try { parsedContent = typeof content === 'string' ? JSON.parse(content) : content; } catch {}
    if (parsedContent?.output_id && parsedContent?.frontend_code) {
      return (
        <ViewBubble
          toolInput={{ output_id: parsedContent.output_id, input_data: parsedContent.input_data || {} }}
          toolResult={parsedContent}
        />
      );
    }
    return null;
  }

  const isUser = role === 'user';
  const rawText = typeof content === 'string' ? content : JSON.stringify(content);
  const { userMessage: displayText, elements: selectedElements } = isUser
    ? parseElementContext(rawText)
    : { userMessage: rawText, elements: [] };

  // Detect friendly OpenSwarm / upstream errors and render a card instead of
  // raw "API Error: ..." text. Checks both the wrapped format the Claude CLI
  // uses ("API Error: NNN …") and the raw JSON body.
  const openswarmError = !isUser ? parseOpenSwarmError(rawText) : null;

  React.useEffect(() => {
    if (editing) setEditText(rawText);
  }, [editing, rawText]);

  const handleCancelEdit = () => {
    setEditText('');
    onCancelEdit?.();
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== rawText && onSaveEdit) {
      onSaveEdit(message.id, trimmed);
    }
    setEditText('');
    onCancelEdit?.();
  };

  const truncatedContent = typeof content === 'string'
    ? content.slice(0, 200)
    : JSON.stringify(content).slice(0, 200);

  return (
    <Box
      data-select-type="message"
      data-select-id={message.id}
      data-select-meta={JSON.stringify({ role, content: truncatedContent })}
      sx={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        my: 0.75,
      }}
    >
      <Box
        sx={{
          maxWidth: '85%',
          minWidth: 0,
          bgcolor: isUser ? c.user.bubble : c.bg.surface,
          border: isUser ? 'none' : `1px solid ${c.border.subtle}`,
          borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          px: 2,
          py: 1.25,
          boxShadow: isUser ? 'none' : c.shadow.sm,
          overflow: 'hidden',
        }}
      >
        {isUser ? (
          editing ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 240 }}>
              <TextField
                multiline
                fullWidth
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                variant="outlined"
                size="small"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSaveEdit();
                  }
                  if (e.key === 'Escape') handleCancelEdit();
                }}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    color: c.text.primary,
                    fontSize: '0.875rem',
                    '& fieldset': { borderColor: c.border.strong },
                    '&:hover fieldset': { borderColor: c.text.tertiary },
                    '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                  },
                }}
              />
              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                <Button
                  size="small"
                  onClick={handleCancelEdit}
                  sx={{ color: c.text.muted, fontSize: '0.75rem' }}
                >
                  Cancel
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleSaveEdit}
                  disabled={!editText.trim() || editText.trim() === rawText}
                  sx={{
                    bgcolor: c.accent.primary,
                    fontSize: '0.75rem',
                    '&:hover': { bgcolor: c.accent.hover },
                  }}
                >
                  Save & Submit
                </Button>
              </Box>
            </Box>
          ) : (
            <Box>
              {message.images && message.images.length > 0 && (
                <MessageImageThumbnails images={message.images} c={c} />
              )}
              <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', lineHeight: 1.6, overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                {renderUserTextWithPills(displayText, c)}
              </Typography>
              <AttachedContextSection elements={selectedElements} message={message} c={c} />
            </Box>
          )
        ) : (
          <Box
            sx={{
              color: c.text.secondary,
              fontSize: '0.875rem',
              lineHeight: 1.7,
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
              '& p': { m: 0, mb: 1, '&:last-child': { mb: 0 } },
              '& pre': {
                bgcolor: c.bg.secondary,
                borderRadius: 1.5,
                p: 1.5,
                overflow: 'auto',
                fontSize: '0.8rem',
                fontFamily: c.font.mono,
                border: `1px solid ${c.border.subtle}`,
                '&::-webkit-scrollbar': { height: 5, width: 5 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': {
                  background: c.border.medium,
                  borderRadius: 3,
                  '&:hover': { background: c.border.strong },
                },
                scrollbarWidth: 'thin',
                scrollbarColor: `${c.border.medium} transparent`,
              },
              '& code': {
                bgcolor: c.bg.secondary,
                px: 0.5,
                py: 0.25,
                borderRadius: 0.5,
                fontSize: '0.8rem',
                fontFamily: c.font.mono,
              },
              '& pre code': { bgcolor: 'transparent', p: 0 },
              '& table': {
                width: '100%',
                borderCollapse: 'collapse',
                my: 1.5,
                fontSize: '0.82rem',
                border: `1px solid ${c.border.subtle}`,
                borderRadius: 1,
                overflow: 'hidden',
              },
              '& thead': {
                bgcolor: c.bg.secondary,
              },
              '& th': {
                textAlign: 'left',
                fontWeight: 600,
                color: c.text.primary,
                px: 1.5,
                py: 0.75,
                borderBottom: `1.5px solid ${c.border.medium}`,
                whiteSpace: 'nowrap',
              },
              '& td': {
                px: 1.5,
                py: 0.6,
                borderBottom: `0.5px solid ${c.border.subtle}`,
                verticalAlign: 'top',
              },
              '& tr:last-child td': {
                borderBottom: 'none',
              },
              '& tbody tr:hover': {
                bgcolor: `${c.bg.secondary}80`,
              },
              '& ul, & ol': { pl: 2.5, mb: 1 },
              '& li': { mb: 0.25 },
              '& a': { color: c.accent.primary },
            }}
          >
            {openswarmError ? (
              <Box
                sx={{
                  mt: 0.5,
                  p: 1.8,
                  borderRadius: `${c.radius.lg}px`,
                  border: `1px solid ${c.status.warning}40`,
                  bgcolor: `${c.status.warning}10`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.7,
                }}
              >
                <Typography sx={{ fontSize: '0.92rem', fontWeight: 600, color: c.text.primary }}>
                  {openswarmError.title}
                </Typography>
                <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, lineHeight: 1.5 }}>
                  {openswarmError.detail}
                </Typography>
                {openswarmError.ctaLabel && (
                  <Box sx={{ mt: 0.4 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => {
                        const api = (window as any).openswarm;
                        if (openswarmError.ctaAction === 'upgrade') {
                          const url = 'https://api.openswarm.com/api/stripe/checkout';
                          fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ plan: 'pro_plus', billing_interval: 'monthly' }),
                          })
                            .then((r) => r.json())
                            .then(({ url }) => {
                              if (url && api?.openExternal) api.openExternal(url);
                              else if (url) window.open(url, '_blank');
                            })
                            .catch(() => {});
                        } else if (openswarmError.ctaAction === 'settings') {
                          // Best-effort: dispatch a DOM event the Settings modal listens to
                          window.dispatchEvent(new CustomEvent('openswarm:open-settings', { detail: { tab: 'models' } }));
                        }
                      }}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.78rem',
                        borderColor: c.border.medium,
                        color: c.text.primary,
                        borderRadius: `${c.radius.md}px`,
                        '&:hover': { borderColor: c.accent.primary },
                      }}
                    >
                      {openswarmError.ctaLabel}
                    </Button>
                  </Box>
                )}
              </Box>
            ) : (
              <>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ children, ...props }) => (
                      <a {...props} style={{ cursor: 'pointer' }}>{children}</a>
                    ),
                  }}
                >{rawText}</ReactMarkdown>
                {isStreaming && <StreamingCursor />}
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
});

export default MessageBubble;
