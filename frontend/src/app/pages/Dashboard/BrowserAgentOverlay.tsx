import React, { useState, useEffect, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import StopIcon from '@mui/icons-material/Stop';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { AgentSession, AgentMessage, stopAgent } from '@/shared/state/agentsSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  session: AgentSession;
  browserWidth: number;
  browserHeight: number;
}

function summarizeMessage(msg: AgentMessage): { type: 'thought' | 'action' | 'result' | 'skip'; text: string } {
  if (msg.role === 'assistant' && typeof msg.content === 'string') {
    const trimmed = msg.content.trim();
    if (!trimmed) return { type: 'skip', text: '' };
    return { type: 'thought', text: trimmed };
  }

  if (msg.role === 'tool_call') {
    const content = typeof msg.content === 'string' ? (() => { try { return JSON.parse(msg.content); } catch { return {}; } })() : msg.content;
    const tool = content?.tool || content?.name || '?';
    const input = content?.input || {};
    let brief = '';
    switch (tool) {
      case 'BrowserNavigate': brief = `Navigate → ${input.url || '...'}`; break;
      case 'BrowserClick': brief = `Click ${input.selector || '...'}`; break;
      case 'BrowserType': brief = `Type "${(input.text || '').slice(0, 30)}${(input.text || '').length > 30 ? '…' : ''}" into ${input.selector || '...'}`; break;
      case 'BrowserScreenshot': brief = 'Screenshot'; break;
      case 'BrowserGetText': brief = 'Read page text'; break;
      case 'BrowserGetElements': brief = `Inspect elements${input.selector ? ` (${input.selector})` : ''}`; break;
      case 'BrowserEvaluate': brief = `Evaluate JS`; break;
      default: brief = tool;
    }
    return { type: 'action', text: brief };
  }

  if (msg.role === 'tool_result') {
    return { type: 'result', text: '' };
  }

  return { type: 'skip', text: '' };
}

const BrowserAgentOverlay: React.FC<Props> = ({ session, browserWidth, browserHeight }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const [hidden, setHidden] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isRunning = session.status === 'running';
  const isDone = session.status === 'completed' || session.status === 'error' || session.status === 'stopped';

  const prevSessionId = useRef(session.id);
  useEffect(() => {
    if (session.id !== prevSessionId.current) {
      prevSessionId.current = session.id;
      setFadeOut(false);
      setHidden(false);
      setConfirmStop(false);
    }
  }, [session.id]);

  useEffect(() => {
    if (isDone) {
      fadeTimer.current = setTimeout(() => setFadeOut(true), 2000);
    }
    return () => { if (fadeTimer.current) clearTimeout(fadeTimer.current); };
  }, [isDone]);

  useEffect(() => {
    if (fadeOut) {
      hideTimer.current = setTimeout(() => setHidden(true), 400);
    }
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [fadeOut]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session.messages.length, session.streamingMessage]);

  const handleStop = useCallback(() => {
    if (!confirmStop) {
      setConfirmStop(true);
      confirmTimer.current = setTimeout(() => setConfirmStop(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmStop(false);
    dispatch(stopAgent({ sessionId: session.id }));
  }, [confirmStop, dispatch, session.id]);

  useEffect(() => {
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); };
  }, []);

  const accentColor = c.accent.primary;

  const entries = session.messages
    .map(summarizeMessage)
    .filter((e) => e.type !== 'skip' && e.type !== 'result');

  const streamingMsg = session.streamingMessage;
  if (streamingMsg && streamingMsg.role === 'assistant' && streamingMsg.content) {
    entries.push({ type: 'thought', text: streamingMsg.content });
  }

  const collapsedW = Math.min(300, browserWidth - 24);
  const collapsedH = Math.min(200, browserHeight - 24);
  const expandedW = Math.min(Math.floor(browserWidth * 0.55), browserWidth - 24);
  const expandedH = Math.min(Math.floor(browserHeight * 0.6), browserHeight - 24);

  const panelW = expanded ? expandedW : collapsedW;
  const panelH = expanded ? expandedH : collapsedH;

  if (hidden) return null;

  return (
    <Box
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      sx={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        width: panelW,
        height: panelH,
        zIndex: 18,
        borderRadius: '12px',
        bgcolor: 'rgba(15, 15, 15, 0.88)',
        backdropFilter: 'blur(16px)',
        border: `1px solid ${accentColor}30`,
        boxShadow: `0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.25s ease, height 0.25s ease, opacity 0.4s ease',
        opacity: fadeOut ? 0 : isDone ? 0.7 : 1,
        animation: 'overlay-enter 0.3s ease-out',
        '@keyframes overlay-enter': {
          '0%': { opacity: 0, transform: 'translateY(8px) scale(0.95)' },
          '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.25,
          py: 0.75,
          borderBottom: `1px solid rgba(255,255,255,0.08)`,
          flexShrink: 0,
        }}
      >
        <SmartToyOutlinedIcon sx={{ fontSize: 14, color: accentColor }} />

        {isRunning && (
          <Box
            sx={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              bgcolor: accentColor,
              flexShrink: 0,
              animation: 'overlay-dot-pulse 1.4s ease-in-out infinite',
              '@keyframes overlay-dot-pulse': {
                '0%, 100%': { opacity: 0.4, transform: 'scale(0.8)' },
                '50%': { opacity: 1, transform: 'scale(1.3)' },
              },
            }}
          />
        )}

        {isDone && session.status === 'completed' && (
          <CheckCircleOutlineIcon sx={{ fontSize: 14, color: '#4ade80' }} />
        )}
        {isDone && session.status === 'error' && (
          <ErrorOutlineIcon sx={{ fontSize: 14, color: '#f87171' }} />
        )}

        <Typography
          sx={{
            fontSize: '0.7rem',
            fontWeight: 600,
            color: 'rgba(255,255,255,0.85)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isDone
            ? session.status === 'completed' ? 'Done' : session.status === 'error' ? 'Error' : 'Stopped'
            : 'Browser Agent'}
        </Typography>

        <Tooltip title={expanded ? 'Collapse' : 'Expand'} placement="top">
          <IconButton
            size="small"
            onClick={() => setExpanded((e) => !e)}
            sx={{
              color: 'rgba(255,255,255,0.5)',
              p: 0.3,
              '&:hover': { color: 'rgba(255,255,255,0.8)' },
            }}
          >
            {expanded
              ? <CloseFullscreenIcon sx={{ fontSize: 13 }} />
              : <OpenInFullIcon sx={{ fontSize: 13 }} />
            }
          </IconButton>
        </Tooltip>

        {isRunning && (
          <Tooltip title={confirmStop ? 'Click again to confirm' : 'Stop'} placement="top">
            <IconButton
              size="small"
              onClick={handleStop}
              sx={{
                p: 0.3,
                color: confirmStop ? '#f87171' : 'rgba(255,255,255,0.5)',
                bgcolor: confirmStop ? 'rgba(248,113,113,0.15)' : 'transparent',
                '&:hover': {
                  color: '#f87171',
                  bgcolor: 'rgba(248,113,113,0.12)',
                },
                transition: 'all 0.15s',
              }}
            >
              <StopIcon sx={{ fontSize: 13 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Body — scrollable action log */}
      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: 1.25,
          py: 0.75,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.12) transparent',
          '&::-webkit-scrollbar': { width: 4 },
          '&::-webkit-scrollbar-thumb': {
            background: 'rgba(255,255,255,0.12)',
            borderRadius: 2,
          },
        }}
      >
        {entries.length === 0 && isRunning && (
          <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>
            Starting...
          </Typography>
        )}

        {entries.map((entry, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start', minWidth: 0 }}>
            {entry.type === 'thought' ? (
              <>
                <Box
                  sx={{
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    bgcolor: 'rgba(255,255,255,0.25)',
                    flexShrink: 0,
                    mt: '5px',
                  }}
                />
                <Typography
                  sx={{
                    fontSize: '0.68rem',
                    color: 'rgba(255,255,255,0.6)',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: expanded ? 6 : 2,
                    WebkitBoxOrient: 'vertical',
                    wordBreak: 'break-word',
                  }}
                >
                  {entry.text}
                </Typography>
              </>
            ) : (
              <>
                <Box
                  sx={{
                    width: 4,
                    height: 4,
                    borderRadius: '1px',
                    bgcolor: accentColor,
                    flexShrink: 0,
                    mt: '5px',
                    transform: 'rotate(45deg)',
                  }}
                />
                <Typography
                  sx={{
                    fontSize: '0.68rem',
                    fontFamily: c.font.mono,
                    color: accentColor,
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.text}
                </Typography>
              </>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default React.memo(BrowserAgentOverlay);
