import React, { useState, useMemo } from 'react';
import { report } from '@/shared/serviceClient';
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
import { openSettingsModal } from '@/shared/state/settingsSlice';
import { shallowEqual } from 'react-redux';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { SKILL_COLOR } from '@/app/components/editor/richEditorUtils';
import PlanPicker from '@/app/components/overlays/PlanPicker';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';

const streamingCursorKeyframes = `
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`;

const thinkingShimmerKeyframes = `
@keyframes thinking-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
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
  kind: 'cap' | 'auth' | 'network' | 'too_many_tools';
  title: string;
  detail: string;
  ctaLabel?: string;
  ctaAction?: 'upgrade' | 'retry' | 'settings' | 'waitlist';
}

interface OverflowContext {
  model?: string;
  contextWindow?: number;
  inputTokens?: number;
  frameworkOverhead?: number;
  activeMcpCount?: number;
  messagesCount?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Parses raw error text into a friendly card; returns null when the error isn't one we recognize. */
function parseOpenSwarmError(text: string, ctx?: OverflowContext): OpenSwarmErrorInfo | null {
  if (!text) return null;
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
  if (/at capacity|Try again shortly|503|service unavailable/i.test(text)) {
    return {
      kind: 'network',
      title: 'Connection hiccup',
      detail: 'That request timed out after a few retries. Send the message again to continue.',
    };
  }
  if (/Prompt is too long|prompt_too_long|input length and `max_tokens`|context length/i.test(text)) {
    const modelLower = (ctx?.model || '').toLowerCase();
    const isHaiku = modelLower.includes('haiku');
    const win = ctx?.contextWindow || 0;
    const input = ctx?.inputTokens || 0;
    const fw = ctx?.frameworkOverhead || 0;
    const mcps = ctx?.activeMcpCount || 0;
    if (isHaiku && mcps >= 5) {
      return {
        kind: 'too_many_tools',
        title: 'Too many connected apps for Haiku',
        detail:
          `Haiku has the smallest memory of the Claude models${win ? ` (${formatTokens(win)} tokens)` : ''}. ` +
          `Each of the ${mcps} active apps adds instructions Claude has to read before it can answer. ` +
          'Turn off a few apps (Microsoft 365 is the heaviest), or switch to Sonnet or Opus, both have 5x more room.',
        ctaLabel: 'Open Settings',
        ctaAction: 'settings',
      };
    }
    let lead: string;
    if (win && input) {
      // input is the API-reported total which includes our preset, tool
      // defs, MCP descriptions etc. Subtract those for the user-facing
      // "your content" number so we don't blame the user for our overhead.
      const userContent = Math.max(0, input - fw);
      lead = `The request totalled ~${formatTokens(input)} of ${formatTokens(win)} tokens this model can hold (your messages + files: ~${formatTokens(userContent)}).`;
    } else if (win) {
      lead = `This model holds ${formatTokens(win)} tokens and the request exceeded that.`;
    } else {
      lead = 'The request exceeded this model\'s context window.';
    }
    const extras: string[] = [];
    if (fw) extras.push(`built-in tools + system prompt ~${formatTokens(fw)}`);
    if (mcps > 0) extras.push(`${mcps} active app${mcps === 1 ? '' : 's'}`);
    const breakdown = extras.length > 0 ? ` Overhead from OpenSwarm: ${extras.join(', ')}.` : '';
    return {
      kind: 'too_many_tools',
      title: 'This chat exceeded the model\'s context window',
      detail: (
        lead + breakdown +
        ' Try detaching large files, running /compact to summarize older turns, ' +
        'starting a fresh chat, or switching to a model with a larger window.'
      ),
      ctaLabel: 'Open Settings',
      ctaAction: 'settings',
    };
  }
  if (/No active subscription|Subscription canceled|Subscription past_due|Invalid.*token|Missing bearer token/i.test(text)) {
    return {
      kind: 'auth',
      title: 'Subscription issue',
      detail: "We can't find an active OpenSwarm subscription. Check your billing status.",
      ctaLabel: 'Open Settings',
      ctaAction: 'settings',
    };
  }
  // Strict matchers only; bare "network" false-matched Python tracebacks.
  if (/\b(?:ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b|Could\s+not\s+reach\s+OpenSwarm|Unable\s+to\s+connect\s+to\s+OpenSwarm/i.test(text)) {
    return {
      kind: 'network',
      title: 'Connection issue',
      detail: "We couldn't reach the service. Once your connection is back, send a new message to continue.",
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
        const name = cp.path.split(/[\\/]/).filter(Boolean).pop() || cp.path;
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

const THINKING_LABELS: ReadonlyArray<{ live: string; past: string }> = [
  { live: 'Thinking',     past: 'Thought' },
  { live: 'Pondering',    past: 'Pondered' },
  { live: 'Cooking',      past: 'Cooked' },
  { live: 'Marinating',   past: 'Marinated' },
  { live: 'Deliberating', past: 'Deliberated' },
  { live: 'Reasoning',    past: 'Reasoned' },
  { live: 'Reflecting',   past: 'Reflected' },
  { live: 'Untangling',   past: 'Untangled' },
  { live: 'Stewing',      past: 'Stewed' },
  { live: 'Locking-in',   past: 'Locked-in' },
  { live: 'Considering',  past: 'Considered' },
  { live: 'Processing',   past: 'Processed' },
  { live: 'Vibing',       past: 'Vibed' },
  { live: 'Calculating',  past: 'Calculated' },
  { live: 'Chefing',      past: 'Chefed' },
  { live: 'Geeking',      past: 'Geeked' },
  { live: 'Brewing',      past: 'Brewed' },
];

/** Stable hash of message id to label index; reload, scroll-back, and resume keep the same label. */
function labelIndexFromId(id: string | undefined): number {
  if (!id) return 0;
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % THINKING_LABELS.length;
}

const ThinkingBubble: React.FC<{
  content: string;
  isStreaming?: boolean;
  timestamp?: string;
  messageId?: string;
  persistedElapsedMs?: number;
  persistedTokens?: number;
  persistedInputTokens?: number;
  persistedToolCount?: number;
  // Aux-LLM label like "Auditing the pull request"; null falls back to heuristic.
  dynamicLabel?: string | null;
}> = ({ content, isStreaming, messageId, persistedElapsedMs, persistedTokens, persistedInputTokens, persistedToolCount, dynamicLabel }) => {
  const c = useClaudeTokens();

  const turnLabel = useMemo(
    () => THINKING_LABELS[labelIndexFromId(messageId)],
    [messageId],
  );

  const [startedStreamingAt, setStartedStreamingAt] = useState<number | null>(
    isStreaming ? Date.now() : null
  );
  const [elapsed, setElapsed] = useState<number>(0);

  React.useEffect(() => {
    if (isStreaming && startedStreamingAt === null) {
      setStartedStreamingAt(Date.now());
    }
  }, [isStreaming, startedStreamingAt]);

  React.useEffect(() => {
    if (!isStreaming || startedStreamingAt === null) return;
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedStreamingAt) / 1000));
    }, 250);
    return () => clearInterval(iv);
  }, [isStreaming, startedStreamingAt]);

  // userOverride pins explicit clicks; default is expanded while streaming, collapsed after.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const expanded = userOverride ?? !!isStreaming;
  const toggle = () => setUserOverride(!expanded);

  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const liveTokenEstimate = isStreaming ? Math.max(0, Math.round(text.length / 3.6)) : 0;

  const persistedSecs = persistedElapsedMs != null
    ? Math.max(1, Math.round(persistedElapsedMs / 1000))
    : null;
  const finalSeconds = persistedSecs
    ?? (startedStreamingAt != null && !isStreaming
        ? Math.max(1, Math.floor((Date.now() - startedStreamingAt) / 1000))
        : null);
  const finalTokens = persistedTokens
    ?? (text && !isStreaming ? Math.max(1, Math.round(text.length / 3.6)) : null);

  const activeLabel = dynamicLabel
    ? (liveTokenEstimate > 0 ? `${dynamicLabel}… ~${liveTokenEstimate} tokens` : `${dynamicLabel}…`)
    : (liveTokenEstimate > 0 ? `${turnLabel.live}… (~${liveTokenEstimate} tokens)` : `${turnLabel.live}…`);

  const fmtTokens = (n: number) => {
    if (n >= 1000) {
      const k = n / 1000;
      return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
    }
    return String(n);
  };

  const fmtThoughtDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const minutes = Math.floor(sec / 60);
    if (minutes < 60) {
      const remSec = sec % 60;
      return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  };

  // input_tokens is full turn cost (parent + subagents + tool MCPs); legacy messages fall back to output-only.
  const combinedTotalTokens =
    persistedInputTokens != null && persistedInputTokens > 0
      ? persistedInputTokens
      : finalTokens;
  const tokenBreakdown = (() => {
    if (combinedTotalTokens == null || combinedTotalTokens <= 0) return null;
    if (finalTokens == null || finalTokens <= 0) {
      return { total: combinedTotalTokens, output: null as number | null, input: null as number | null };
    }
    const inputSide = Math.max(0, combinedTotalTokens - finalTokens);
    return { total: combinedTotalTokens, output: finalTokens, input: inputSide };
  })();

  const renderPostStreamLabel = () => {
    const segments: React.ReactNode[] = [];
    segments.push(
      <span key="duration">
        {finalSeconds != null
          ? `${turnLabel.past} for ${fmtThoughtDuration(finalSeconds)}`
          : turnLabel.past}
      </span>
    );
    if (tokenBreakdown) {
      const { total, input, output } = tokenBreakdown;
      const tooltipBody = input != null && output != null ? (
        <Box sx={{ p: 0.5, fontFamily: c.font.sans, fontSize: '0.78rem', lineHeight: 1.5 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
            <span>Input</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{input.toLocaleString()}</span>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
            <span>Output</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{output.toLocaleString()}</span>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, mt: 0.25, pt: 0.25, borderTop: `1px solid ${c.border.subtle}`, fontWeight: 600 }}>
            <span>Total</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}</span>
          </Box>
          <Box sx={{ mt: 0.5, color: c.text.ghost, fontSize: '0.7rem', fontStyle: 'italic' }}>
            Input shown is your message, history, and tool outputs. The fixed
            framework preamble (system prompt, tool defs, MCP descriptions) is
            excluded, since it's constant overhead from the agent runtime,
            not anything you can shrink.
          </Box>
        </Box>
      ) : (
        <Box sx={{ p: 0.5, fontFamily: c.font.sans, fontSize: '0.78rem' }}>
          {total.toLocaleString()} tokens (input + output + children)
        </Box>
      );
      segments.push(<span key="sep-1">, </span>);
      segments.push(
        <Tooltip
          key="tokens"
          title={tooltipBody}
          placement="top"
          arrow
          slotProps={{ tooltip: { sx: { bgcolor: c.bg.elevated, color: c.text.primary, border: `1px solid ${c.border.medium}`, maxWidth: 'none' } } }}
        >
          <Box
            component="span"
            onClick={(e) => { e.stopPropagation(); }}
            sx={{
              cursor: 'help',
              borderBottom: `1px dotted ${c.border.medium}`,
              '&:hover': { color: c.text.secondary },
            }}
          >
            {fmtTokens(total)} tokens
          </Box>
        </Tooltip>
      );
    }
    if (persistedToolCount != null && persistedToolCount > 0) {
      segments.push(<span key="sep-2">, </span>);
      segments.push(
        <span key="tools">{persistedToolCount} tool{persistedToolCount === 1 ? '' : 's'} used</span>
      );
    }
    return segments;
  };

  // Shimmer needs a flat string; post-stream label needs nodes for the token tooltip.
  const label: React.ReactNode = isStreaming ? activeLabel : renderPostStreamLabel();

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
          {text ? (
            <>
              {text}
              {isStreaming && <StreamingCursor />}
            </>
          ) : (
            <ProviderReasoningExplanation
              isStreaming={!!isStreaming}
              tokens={persistedTokens ?? null}
              elapsedMs={persistedElapsedMs ?? null}
            />
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

// Shown when the model thought but the provider didn't expose the text.
const ProviderReasoningExplanation: React.FC<{
  isStreaming: boolean;
  tokens: number | null;
  elapsedMs: number | null;
}> = ({ isStreaming, tokens, elapsedMs }) => {
  if (isStreaming) {
    return (
      <Box component="span" sx={{ fontStyle: 'italic', opacity: 0.85 }}>
        Reasoning…
        <StreamingCursor />
      </Box>
    );
  }
  const hasMetrics = (tokens && tokens > 0) || (elapsedMs && elapsedMs > 0);
  const metric = (() => {
    if (!hasMetrics) return null;
    const segs: string[] = [];
    if (elapsedMs && elapsedMs > 0) {
      segs.push(`${Math.max(1, Math.round(elapsedMs / 1000))}s`);
    }
    if (tokens && tokens > 0) {
      segs.push(`${tokens.toLocaleString()} reasoning tokens`);
    }
    return segs.join(', ');
  })();
  const variants = [
    "It's still thinking, we just aren't allowed to peek behind the curtain.",
    "Wheels are turning, but this provider keeps its thoughts private.",
    "Brain's busy back there; the provider just isn't letting us listen in.",
    "Mulling it over quietly. Only Claude shows its work out loud.",
    "Thinking happened, just not in the open. (GPT and Gemini play their cards close.)",
    "Reasoning's underway, but this provider doesn't broadcast it. Trust the process.",
  ];
  const idx = useMemo(() => Math.floor(Math.random() * variants.length), []);
  const line = variants[idx];

  return (
    <Box component="span" sx={{ fontStyle: 'italic', opacity: 0.85 }}>
      {line} {metric ? `Took ${metric}.` : ''}
    </Box>
  );
};

interface Props {
  message: AgentMessage;
  editing?: boolean;
  onSaveEdit?: (messageId: string, newContent: string) => void;
  onCancelEdit?: () => void;
  isStreaming?: boolean;
  dynamicTurnLabel?: string | null;
}

const MessageBubble: React.FC<Props> = React.memo(({ message, editing = false, onSaveEdit, onCancelEdit, isStreaming, dynamicTurnLabel }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [editText, setEditText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
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
        messageId={message.id}
        persistedElapsedMs={(message as any).elapsed_ms}
        persistedTokens={(message as any).tokens}
        persistedInputTokens={(message as any).input_tokens}
        persistedToolCount={(message as any).tool_count}
        dynamicLabel={isStreaming ? dynamicTurnLabel : null}
      />
    );
  }

  if (role === 'tool_call' || role === 'tool_result') {
    return null;
  }

  const isUser = role === 'user';
  const rawText = typeof content === 'string' ? content : JSON.stringify(content);
  const { userMessage: displayText, elements: selectedElements } = isUser
    ? parseElementContext(rawText)
    : { userMessage: rawText, elements: [] };

  const renderedMarkdown = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} style={{ cursor: 'pointer' }}>{children}</a>
        ),
      }}
    >{rawText}</ReactMarkdown>
  ), [rawText]);

  const overflowCtx = useAppSelector((state) => {
    const sid = state.agents.activeSessionId;
    if (!sid) return undefined;
    const s = state.agents.sessions[sid];
    if (!s) return undefined;
    return {
      model: s.model,
      contextWindow: s.context_window,
      inputTokens: s.tokens?.input,
      frameworkOverhead: s.framework_overhead_tokens,
      activeMcpCount: s.active_mcps?.length ?? 0,
      messagesCount: s.messages?.length ?? 0,
    } as OverflowContext;
  }, shallowEqual);
  const openswarmError = !isUser ? parseOpenSwarmError(rawText, overflowCtx) : null;

  // (message.id, kind) keys so cap card analytics fire once, not on edits.
  React.useEffect(() => {
    if (openswarmError?.kind === 'cap') {
      report('subscription', 'rate_limit_hit', { message_id: message.id });
    }
  }, [message.id, openswarmError?.kind]);

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

  const optimisticStatus = (message as any).optimistic_status as 'pending' | 'failed' | undefined;
  const isPending = optimisticStatus === 'pending';
  const isFailed = optimisticStatus === 'failed';

  return (
    <Box
      data-select-type="message"
      data-select-id={message.id}
      data-select-meta={JSON.stringify({ role, content: truncatedContent })}
      sx={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        my: 0.75,
        // Isolates reflow so an expanding bubble doesn't shake the transcript.
        contain: 'layout style',
      }}
    >
      <Box
        sx={{
          maxWidth: '85%',
          minWidth: 0,
          bgcolor: isUser ? c.user.bubble : c.bg.surface,
          border: isUser ? (isFailed ? `1px solid ${c.status.error}` : 'none') : `1px solid ${c.border.subtle}`,
          borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          px: 2,
          py: 1.25,
          boxShadow: isUser ? 'none' : c.shadow.sm,
          overflow: 'hidden',
          opacity: isPending ? 0.7 : 1,
          transition: 'opacity 0.2s, border-color 0.2s',
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
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <ErrorSlime size={22} />
                  <Typography sx={{ fontSize: '0.92rem', fontWeight: 600, color: c.text.primary }}>
                    {openswarmError.title}
                  </Typography>
                </Box>
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
                          setPickerOpen(true);
                        } else if (openswarmError.ctaAction === 'settings') {
                          dispatch(openSettingsModal('models'));
                        } else if (openswarmError.ctaAction === 'waitlist') {
                          const url = 'https://discord.com/channels/1486442924391796896/1486442927554170892';
                          if (api?.openExternal) api.openExternal(url);
                          else window.open(url, '_blank');
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
                {isStreaming ? (
                  <Box
                    component="div"
                    sx={{
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 'inherit',
                      lineHeight: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    {rawText}
                  </Box>
                ) : (
                  renderedMarkdown
                )}
                {isStreaming && <StreamingCursor />}
              </>
            )}
          </Box>
        )}
      </Box>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}
      >
        <Box sx={{
          width: 460, maxWidth: '100%',
          maxHeight: '90vh', overflowY: 'auto',
          bgcolor: c.bg.surface, borderRadius: `${c.radius.xl}px`,
          border: `1px solid ${c.border.subtle}`,
          p: 3, outline: 'none',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1.5 }}>
            <Typography sx={{ fontSize: '1.05rem', fontWeight: 700, color: c.text.primary }}>
              Upgrade your plan
            </Typography>
            <IconButton
              size="small"
              onClick={() => setPickerOpen(false)}
              sx={{ color: c.text.tertiary }}
              aria-label="Close"
            >
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>
          <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mb: 2 }}>
            Pick a plan to keep going. Cancel anytime from Stripe.
          </Typography>
          <PlanPicker
            source="upgrade_cta"
            defaultPlan="pro_plus"
            compact
            onSubscribed={() => setPickerOpen(false)}
          />
        </Box>
      </Modal>
    </Box>
  );
});

export default MessageBubble;
