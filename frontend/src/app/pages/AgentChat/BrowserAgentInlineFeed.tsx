import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import PanToolOutlinedIcon from '@mui/icons-material/PanToolOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import LanguageIcon from '@mui/icons-material/Language';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import TouchAppOutlinedIcon from '@mui/icons-material/TouchAppOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import CameraAltOutlinedIcon from '@mui/icons-material/CameraAltOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import { createSelector } from '@reduxjs/toolkit';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { AgentMessage, AgentSession, fetchBrowserAgentChildren, handleApproval } from '@/shared/state/agentsSlice';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';
import type { RootState } from '@/shared/state/store';

interface Props {
  parentSessionId: string;
  browserId?: string;
}

interface FeedEntry {
  type: 'thought' | 'action' | 'result' | 'system';
  text: string;
  actionTool?: string;
  sessionLabel?: string;
}

function formatMessage(msg: AgentMessage): FeedEntry | null {
  if (msg.role === 'user') return null;

  if (msg.role === 'assistant' && typeof msg.content === 'string') {
    const trimmed = msg.content.trim();
    if (!trimmed) return null;
    return { type: 'thought', text: trimmed };
  }

  if (msg.role === 'tool_call') {
    const content =
      typeof msg.content === 'string'
        ? (() => { try { return JSON.parse(msg.content); } catch { return {}; } })()
        : msg.content;
    const tool = content?.tool || content?.name || '?';
    const input = content?.input || {};
    let brief = '';
    switch (tool) {
      case 'BrowserNavigate':
        brief = `Navigate → ${input.url || '...'}`;
        break;
      case 'BrowserClick':
        brief = `Click ${input.selector || '...'}`;
        break;
      case 'BrowserType': {
        const txt = (input.text || '').slice(0, 40);
        const ellipsis = (input.text || '').length > 40 ? '…' : '';
        brief = `Type "${txt}${ellipsis}" into ${input.selector || '...'}`;
        break;
      }
      case 'BrowserScreenshot':
        brief = 'Screenshot';
        break;
      case 'BrowserGetText':
        brief = 'Read page text';
        break;
      case 'BrowserGetElements':
        brief = `Inspect elements${input.selector ? ` (${input.selector})` : ''}`;
        break;
      case 'BrowserEvaluate':
        brief = `Evaluate JS`;
        break;
      default:
        brief = `${tool}(${JSON.stringify(input).slice(0, 60)})`;
    }
    return { type: 'action', text: brief, actionTool: tool };
  }

  if (msg.role === 'tool_result') {
    const content =
      typeof msg.content === 'string'
        ? (() => { try { return JSON.parse(msg.content); } catch { return { text: msg.content }; } })()
        : msg.content;
    const toolName = content?.tool_name || '';
    const elapsed = content?.elapsed_ms;
    const text = content?.text || '';

    if (toolName === 'BrowserScreenshot') {
      return { type: 'result', text: `Screenshot captured${elapsed ? ` (${elapsed}ms)` : ''}` };
    }
    const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
    return { type: 'result', text: `${preview}${elapsed ? ` (${elapsed}ms)` : ''}` };
  }

  if (msg.role === 'system') {
    return { type: 'system', text: typeof msg.content === 'string' ? msg.content : '' };
  }

  return null;
}

type SvgIconComponent = typeof OpenInNewIcon;

function getActionIcon(tool?: string): SvgIconComponent {
  switch (tool) {
    case 'BrowserNavigate': return OpenInNewIcon;
    case 'BrowserClick': return TouchAppOutlinedIcon;
    case 'BrowserType': return KeyboardOutlinedIcon;
    case 'BrowserScreenshot': return CameraAltOutlinedIcon;
    case 'BrowserGetText': return ArticleOutlinedIcon;
    case 'BrowserGetElements': return AccountTreeOutlinedIcon;
    case 'BrowserEvaluate': return CodeOutlinedIcon;
    default: return BuildOutlinedIcon;
  }
}

interface FeedColors {
  thought: string;
  thoughtIcon: string;
  result: string;
  error: string;
  errorIcon: string;
  scrollThumb: string;
}

const darkFeedColors: FeedColors = {
  thought: '#a0aab8',
  thoughtIcon: '#555b6e',
  result: '#555b6e',
  error: '#ff8787',
  errorIcon: '#ff8787',
  scrollThumb: '#2a2d3e',
};

const lightFeedColors: FeedColors = {
  thought: '#555550',
  thoughtIcon: '#9e9c95',
  result: '#9e9c95',
  error: '#c03030',
  errorIcon: '#c03030',
  scrollThumb: '#ccc9c0',
};

const selectBrowserSessions = createSelector(
  [(state: RootState) => state.agents.sessions,
   (_: RootState, parentSessionId: string) => parentSessionId,
   (_: RootState, __: string, browserId?: string) => browserId],
  (sessions, parentSessionId, browserId) =>
    Object.values(sessions).filter(
      (s): s is AgentSession =>
        s.mode === 'browser-agent' &&
        s.parent_session_id === parentSessionId &&
        (!browserId || s.browser_id === browserId),
    ),
);

const BrowserAgentInlineFeed: React.FC<Props> = ({ parentSessionId, browserId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { mode } = useThemeMode();
  const fc = mode === 'dark' ? darkFeedColors : lightFeedColors;
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetchedForSession = useRef<string | null>(null);

  const browserSessions = useAppSelector((state) =>
    selectBrowserSessions(state, parentSessionId, browserId),
  );

  useEffect(() => {
    if (browserSessions.length === 0 && fetchedForSession.current !== parentSessionId) {
      fetchedForSession.current = parentSessionId;
      dispatch(fetchBrowserAgentChildren(parentSessionId))
        .unwrap()
        .catch(() => { fetchedForSession.current = null; });
    }
  }, [browserSessions.length, parentSessionId, dispatch]);

  const sessionsWithEntries = useMemo(() => {
    return browserSessions.map((session) => {
      const entries: FeedEntry[] = [];
      for (const msg of session.messages) {
        const entry = formatMessage(msg);
        if (entry) entries.push(entry);
      }
      if (session.streamingMessage?.role === 'assistant' && session.streamingMessage.content) {
        entries.push({ type: 'thought', text: session.streamingMessage.content });
      }
      return { session, entries };
    });
  }, [browserSessions]);

  const totalMessages = browserSessions.reduce(
    (n, s) => n + s.messages.length + (s.streamingMessage ? 1 : 0),
    0,
  );

  // Sticky-to-bottom: auto-scroll to the latest content unless the user
  // has manually scrolled up. Re-enable auto-scroll when the user scrolls
  // back to the bottom (within a small threshold).
  const isStuckToBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // "At bottom" = within 30px of the bottom edge
    isStuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  useEffect(() => {
    if (isStuckToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [totalMessages]);

  if (browserSessions.length === 0) return null;

  const showLabels = sessionsWithEntries.length > 1;
  const accentColor = c.accent.primary;

  return (
    <Box
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={(e) => {
        // Capture wheel events so the feed scrolls on hover without
        // needing to click/focus first. Without this, the parent chat
        // scroll container eats the wheel events.
        const el = scrollRef.current;
        if (!el) return;
        const atTop = el.scrollTop <= 0 && e.deltaY < 0;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 1 && e.deltaY > 0;
        // Only stop propagation when the feed has room to scroll in this
        // direction. At boundaries, let the parent scroll naturally.
        if (!atTop && !atBottom) e.stopPropagation();
      }}
      sx={{
        maxHeight: 300,
        overflowY: 'auto',
        px: 1.5,
        py: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        scrollbarWidth: 'thin',
        scrollbarColor: `${fc.scrollThumb} transparent`,
        '&::-webkit-scrollbar': { width: 4 },
        '&::-webkit-scrollbar-thumb': {
          background: fc.scrollThumb,
          borderRadius: 2,
        },
      }}
    >
      {sessionsWithEntries.map(({ session, entries }, si) => (
        <Box key={session.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          {showLabels && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: si > 0 ? 1 : 0, mb: 0.25 }}>
              <LanguageIcon sx={{ fontSize: 12, color: accentColor, opacity: 0.7 }} />
              <Typography
                sx={{
                  fontSize: '0.65rem',
                  fontWeight: 600,
                  color: accentColor,
                  opacity: 0.8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {session.browser_id || `Browser ${si + 1}`}
              </Typography>
              <SessionStatusChip status={session.status} />
            </Box>
          )}

          {!showLabels && entries.length === 0 && session.status === 'running' && (
            <Typography
              sx={{
                fontSize: '0.7rem',
                color: c.text.tertiary,
                fontStyle: 'italic',
                fontFamily: c.font.mono,
              }}
            >
              Starting browser agent...
            </Typography>
          )}

          {entries.map((entry, i) => (
            <EntryRow key={i} entry={entry} accentColor={accentColor} fc={fc} />
          ))}

          {/* Inline RequestHumanIntervention — matches the DynamicIsland
              and BrowserAgentOverlay style (amber, hand icon, compact pill).
              Same request_id → whichever surface the user responds from
              first resolves the approval; the others auto-dismiss. */}
          {session.pending_approvals?.filter(
            (a) => a.tool_name === 'RequestHumanIntervention',
          ).map((intervention) => {
            const problem = (intervention.tool_input as any)?.problem || 'Browser agent needs help';
            return (
              <Box
                key={intervention.id}
                sx={{
                  mt: 0.75,
                  mb: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  px: 1,
                  py: 0.5,
                  borderRadius: '8px',
                  bgcolor: 'rgba(245,158,11,0.10)',
                  border: '1px solid rgba(245,158,11,0.25)',
                }}
              >
                <PanToolOutlinedIcon sx={{ fontSize: 12, color: '#f59e0b', flexShrink: 0, mt: '2px' }} />
                <Typography
                  sx={{
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    color: '#f59e0b',
                    flex: 1,
                    minWidth: 0,
                    lineHeight: 1.4,
                  }}
                >
                  {problem}
                </Typography>
                <Tooltip title="Done — continue" arrow>
                  <IconButton
                    size="small"
                    onClick={() => dispatch(handleApproval({ requestId: intervention.id, behavior: 'allow' }))}
                    sx={{
                      p: 0,
                      width: 18,
                      height: 18,
                      color: '#fff',
                      bgcolor: '#f59e0b',
                      '&:hover': { bgcolor: '#d97706' },
                    }}
                  >
                    <CheckIcon sx={{ fontSize: 11 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Skip" arrow>
                  <IconButton
                    size="small"
                    onClick={() => dispatch(handleApproval({ requestId: intervention.id, behavior: 'deny', message: 'User declined to help' }))}
                    sx={{
                      p: 0,
                      width: 18,
                      height: 18,
                      color: '#f59e0b',
                      border: '1px solid rgba(245,158,11,0.4)',
                      '&:hover': { bgcolor: 'rgba(245,158,11,0.1)' },
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 11 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}

          {!showLabels && session.status === 'running' && entries.length > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: accentColor,
                  animation: 'ba-feed-pulse 1.4s ease-in-out infinite',
                  '@keyframes ba-feed-pulse': {
                    '0%, 100%': { opacity: 0.3, transform: 'scale(0.8)' },
                    '50%': { opacity: 1, transform: 'scale(1.2)' },
                  },
                }}
              />
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
};

const EntryRow: React.FC<{ entry: FeedEntry; accentColor: string; fc: FeedColors }> = ({ entry, accentColor, fc }) => {
  const c = useClaudeTokens();

  if (entry.type === 'thought') {
    return (
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start', minWidth: 0 }}>
        <SmartToyOutlinedIcon
          sx={{ fontSize: 10, color: fc.thoughtIcon, mt: '3px', flexShrink: 0 }}
        />
        <Typography
          sx={{
            fontSize: '0.7rem',
            color: fc.thought,
            lineHeight: 1.45,
            wordBreak: 'break-word',
            fontFamily: c.font.mono,
          }}
        >
          {entry.text}
        </Typography>
      </Box>
    );
  }

  if (entry.type === 'action') {
    const ActionIcon = getActionIcon(entry.actionTool);
    return (
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start', minWidth: 0 }}>
        <ActionIcon sx={{ fontSize: 11, color: accentColor, mt: '2px', flexShrink: 0 }} />
        <Typography
          sx={{
            fontSize: '0.7rem',
            fontFamily: c.font.mono,
            color: accentColor,
            lineHeight: 1.45,
            wordBreak: 'break-word',
          }}
        >
          {entry.text}
        </Typography>
      </Box>
    );
  }

  if (entry.type === 'result') {
    return (
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start', minWidth: 0, pl: 1.25 }}>
        <Typography
          sx={{
            fontSize: '0.65rem',
            fontFamily: c.font.mono,
            color: fc.result,
            lineHeight: 1.45,
            wordBreak: 'break-word',
          }}
        >
          ↳ {entry.text}
        </Typography>
      </Box>
    );
  }

  if (entry.type === 'system') {
    return (
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', minWidth: 0 }}>
        <ErrorOutlineIcon sx={{ fontSize: 10, color: fc.errorIcon, flexShrink: 0 }} />
        <Typography
          sx={{
            fontSize: '0.68rem',
            fontFamily: c.font.mono,
            color: fc.error,
            lineHeight: 1.45,
          }}
        >
          {entry.text}
        </Typography>
      </Box>
    );
  }

  return null;
};

const SessionStatusChip: React.FC<{ status: string }> = ({ status }) => {
  const c = useClaudeTokens();
  if (status === 'running') {
    return (
      <Box
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: c.status.success,
          animation: 'ba-feed-pulse 1.4s ease-in-out infinite',
          '@keyframes ba-feed-pulse': {
            '0%, 100%': { opacity: 0.3, transform: 'scale(0.8)' },
            '50%': { opacity: 1, transform: 'scale(1.2)' },
          },
        }}
      />
    );
  }
  if (status === 'completed') {
    return <CheckCircleOutlineIcon sx={{ fontSize: 10, color: c.status.success }} />;
  }
  if (status === 'error') {
    return <ErrorOutlineIcon sx={{ fontSize: 10, color: c.status.error }} />;
  }
  return null;
};

export default React.memo(BrowserAgentInlineFeed);
