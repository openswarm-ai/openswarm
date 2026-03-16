import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip, { tooltipClasses } from '@mui/material/Tooltip';
import Icon from '@mui/material/Icon';
import { styled } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import LanguageIcon from '@mui/icons-material/Language';
import SearchIcon from '@mui/icons-material/Search';
import { motion } from 'framer-motion';
import ChatInput from '@/app/pages/AgentChat/ChatInput';
import type { ContextPath } from '@/app/components/DirectoryBrowser';
import { useElementSelection } from '@/app/components/ElementSelectionContext';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { searchHistory, clearHistorySearch } from '@/shared/state/agentsSlice';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { Output } from '@/shared/state/outputsSlice';

interface Props {
  inputOpen: boolean;
  onNewAgent: () => void;
  onCancel: () => void;
  onSend: (
    prompt: string,
    mode: string,
    model: string,
    images?: Array<{ data: string; media_type: string }>,
    contextPaths?: ContextPath[],
    forcedTools?: string[],
    attachedSkills?: Array<{ id: string; name: string; content: string }>,
    selectedBrowserIds?: string[],
  ) => void;
  onAddView: (outputId: string) => void;
  onHistoryResume: (sessionId: string) => void;
  onAddBrowser: () => void;
  dashboardId?: string;
}

const BTN = 40;

const WarmTooltip = styled(
  ({ className, ...props }: React.ComponentProps<typeof Tooltip> & { className?: string }) => (
    <Tooltip {...props} classes={{ popper: className }} />
  )
)<{ tokens: ClaudeTokens }>(({ tokens: c }) => ({
  [`& .${tooltipClasses.tooltip}`]: {
    backgroundColor: c.bg.inverse,
    color: c.text.inverse,
    fontFamily: c.font.sans,
    fontSize: '0.78rem',
    fontWeight: 500,
    padding: '6px 12px',
    borderRadius: c.radius.md,
    boxShadow: c.shadow.md,
    letterSpacing: '0.01em',
  },
  [`& .${tooltipClasses.arrow}`]: {
    color: c.bg.inverse,
  },
}));

const MotionBox = motion.div;

const HISTORY_PAGE_SIZE = 20;

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const DashboardToolbar = React.forwardRef<HTMLDivElement, Props>(
  ({ inputOpen, onNewAgent, onCancel, onSend, onAddView, onHistoryResume, onAddBrowser, dashboardId }, ref) => {
    const c = useClaudeTokens();
    const dispatch = useAppDispatch();
    const elementSelection = useElementSelection();
    const containerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const historyInputRef = useRef<HTMLInputElement>(null);
    const historyListRef = useRef<HTMLDivElement>(null);
    const [mode, setMode] = useState('agent');
    const [model, setModel] = useState('sonnet');
    const [viewPickerOpen, setViewPickerOpen] = useState(false);
    const [viewSearch, setViewSearch] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyQuery, setHistoryQuery] = useState('');
    const shortcut = useAppSelector((s) => s.settings.data.new_agent_shortcut);
    const outputs = useAppSelector((s) => s.outputs.items);
    const historySearch = useAppSelector((s) => s.agents.historySearch);

    const outputList = useMemo(() => Object.values(outputs), [outputs]);
    const filteredOutputs = useMemo(() => {
      if (!viewSearch.trim()) return outputList;
      const q = viewSearch.toLowerCase();
      return outputList.filter(
        (o) => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q),
      );
    }, [outputList, viewSearch]);

    const shortcutLabel = shortcut
      .split('+')
      .map((p) => {
        if (p === 'Meta') return '⌘';
        if (p === 'Ctrl') return 'Ctrl';
        if (p === 'Alt') return '⌥';
        if (p === 'Shift') return '⇧';
        return p.toUpperCase();
      })
      .join('');

    React.useImperativeHandle(ref, () => containerRef.current!, []);

    const handleSend = useCallback(
      (
        message: string,
        images?: Array<{ data: string; media_type: string }>,
        contextPaths?: ContextPath[],
        forcedTools?: string[],
        attachedSkills?: Array<{ id: string; name: string; content: string }>,
        selectedBrowserIds?: string[],
      ) => {
        onSend(message, mode, model, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds);
      },
      [onSend, mode, model],
    );

    const handleCloseHistory = useCallback(() => {
      setHistoryOpen(false);
      setHistoryQuery('');
      dispatch(clearHistorySearch());
    }, [dispatch]);

    const handleDismiss = useCallback(() => {
      if (historyOpen) {
        handleCloseHistory();
      } else if (viewPickerOpen) {
        setViewPickerOpen(false);
        setViewSearch('');
      } else {
        onCancel();
      }
    }, [historyOpen, viewPickerOpen, onCancel, handleCloseHistory]);

    const handleSelectView = useCallback((output: Output) => {
      onAddView(output.id);
      setViewPickerOpen(false);
      setViewSearch('');
    }, [onAddView]);

    const handleOpenViewPicker = useCallback(() => {
      if (viewPickerOpen) {
        setViewPickerOpen(false);
        setViewSearch('');
        return;
      }
      setHistoryOpen(false);
      setHistoryQuery('');
      dispatch(clearHistorySearch());
      setViewPickerOpen(true);
      setViewSearch('');
    }, [viewPickerOpen, dispatch]);

    const handleOpenHistory = useCallback(() => {
      if (historyOpen) {
        setHistoryOpen(false);
        setHistoryQuery('');
        dispatch(clearHistorySearch());
        return;
      }
      setViewPickerOpen(false);
      setViewSearch('');
      setHistoryOpen(true);
      setHistoryQuery('');
      dispatch(clearHistorySearch());
      dispatch(searchHistory({ q: '', limit: HISTORY_PAGE_SIZE, offset: 0, dashboardId }));
    }, [historyOpen, dispatch, dashboardId]);

    const handleHistorySelect = useCallback((sessionId: string) => {
      onHistoryResume(sessionId);
      handleCloseHistory();
    }, [onHistoryResume, handleCloseHistory]);

    const handleHistoryLoadMore = useCallback(() => {
      if (historySearch.loading || !historySearch.hasMore) return;
      dispatch(searchHistory({
        q: historyQuery,
        limit: HISTORY_PAGE_SIZE,
        offset: historySearch.results.length,
        dashboardId,
      }));
    }, [dispatch, historyQuery, historySearch.loading, historySearch.hasMore, historySearch.results.length, dashboardId]);

    const isExpanded = inputOpen || viewPickerOpen || historyOpen;

    const prevInputOpenRef = useRef(inputOpen);
    useEffect(() => {
      if (prevInputOpenRef.current && !inputOpen && elementSelection?.selectMode) {
        elementSelection.setSelectMode(false);
      }
      prevInputOpenRef.current = inputOpen;
    }, [inputOpen, elementSelection]);

    useEffect(() => {
      if (!isExpanded) return;
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleDismiss();
        }
      };
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }, [isExpanded, handleDismiss]);

    useEffect(() => {
      if (!isExpanded) return;
      const handleClick = (e: MouseEvent) => {
        if (elementSelection?.selectMode) return;
        const target = e.target as Node;
        if (containerRef.current && !containerRef.current.contains(target)) {
          const el = target instanceof Element ? target : target.parentElement;
          if (el?.closest('[role="dialog"], [role="presentation"], .MuiModal-root, .MuiPopover-root')) {
            return;
          }
          handleDismiss();
        }
      };
      const t = setTimeout(() => document.addEventListener('mousedown', handleClick), 50);
      return () => {
        clearTimeout(t);
        document.removeEventListener('mousedown', handleClick);
      };
    }, [isExpanded, handleDismiss, elementSelection?.selectMode]);

    useEffect(() => {
      if (viewPickerOpen) {
        setTimeout(() => searchInputRef.current?.focus(), 60);
      }
    }, [viewPickerOpen]);

    useEffect(() => {
      if (historyOpen) {
        setTimeout(() => historyInputRef.current?.focus(), 60);
      }
    }, [historyOpen]);

    useEffect(() => {
      const handleKey = (e: KeyboardEvent) => {
        if (e.metaKey && e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          handleOpenViewPicker();
        }
        if (e.metaKey && e.key.toLowerCase() === 'o' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          handleOpenHistory();
        }
      };
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }, [handleOpenViewPicker, handleOpenHistory]);

    useEffect(() => {
      if (!historyOpen) return;
      const timer = setTimeout(() => {
        dispatch(searchHistory({ q: historyQuery, limit: HISTORY_PAGE_SIZE, offset: 0, dashboardId }));
      }, 300);
      return () => clearTimeout(timer);
    }, [historyQuery, historyOpen, dispatch, dashboardId]);

    const handleHistoryScroll = useCallback(() => {
      const el = historyListRef.current;
      if (!el) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
        handleHistoryLoadMore();
      }
    }, [handleHistoryLoadMore]);

    const placeholderItems = [
      { icon: StickyNote2OutlinedIcon, label: 'Add Notes', sub: 'Coming soon' },
    ];

    return (
      <MotionBox
        ref={containerRef}
        layout
        transition={{ layout: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] } }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: c.bg.surface,
          border: `1px solid ${c.border.subtle}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: c.shadow.lg,
          padding: isExpanded ? '4px' : '6px',
          userSelect: 'none' as const,
          overflow: inputOpen ? 'visible' : 'hidden',
          width: viewPickerOpen ? 480 : isExpanded ? 360 : undefined,
        }}
      >
        {inputOpen ? (
          <div style={{ width: '100%', minHeight: 44, paddingBottom: 0, marginBottom: -4 }}>
            <ChatInput
              onSend={handleSend}
              mode={mode}
              onModeChange={setMode}
              model={model}
              onModelChange={setModel}
              embedded
              autoFocus
            />
          </div>
        ) : historyOpen ? (
          <div style={{ width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
              <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
              <InputBase
                inputRef={historyInputRef}
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Search past chats..."
                sx={{
                  flex: 1,
                  fontSize: '0.85rem',
                  color: c.text.primary,
                  fontFamily: c.font.sans,
                  '& input::placeholder': { color: c.text.ghost, opacity: 1 },
                }}
              />
              {historySearch.loading && historySearch.results.length === 0 && (
                <CircularProgress size={16} sx={{ color: c.text.muted }} />
              )}
            </Box>
            <Box
              ref={historyListRef}
              onScroll={handleHistoryScroll}
              sx={{
                maxHeight: 320,
                overflow: 'auto',
                borderTop: `1px solid ${c.border.subtle}`,
                '&::-webkit-scrollbar': { width: 4 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
                scrollbarWidth: 'thin',
                scrollbarColor: `${c.border.medium} transparent`,
              }}
            >
              {historySearch.results.length === 0 && !historySearch.loading ? (
                <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
                  <Typography sx={{ fontSize: '0.82rem', color: c.text.muted }}>
                    {historyQuery ? 'No matching chats' : 'No chat history yet'}
                  </Typography>
                </Box>
              ) : (
                <>
                  {historySearch.results.map((entry) => (
                    <Box
                      key={entry.id}
                      onClick={() => handleHistorySelect(entry.id)}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1.5,
                        px: 1.5,
                        py: 0.9,
                        cursor: 'pointer',
                        transition: 'background-color 0.1s',
                        '&:hover': { bgcolor: c.bg.elevated },
                      }}
                    >
                      <Typography
                        sx={{
                          fontSize: '0.82rem',
                          fontWeight: 500,
                          color: c.text.primary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {entry.name}
                      </Typography>
                      <Typography
                        sx={{
                          fontSize: '0.7rem',
                          color: c.text.ghost,
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatRelativeTime(entry.closed_at)}
                      </Typography>
                    </Box>
                  ))}
                  {historySearch.loading && historySearch.results.length > 0 && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}>
                      <CircularProgress size={16} sx={{ color: c.text.muted }} />
                    </Box>
                  )}
                </>
              )}
            </Box>
          </div>
        ) : viewPickerOpen ? (
          <div style={{ width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
              <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
              <InputBase
                inputRef={searchInputRef}
                value={viewSearch}
                onChange={(e) => setViewSearch(e.target.value)}
                placeholder="Search views..."
                sx={{
                  flex: 1,
                  fontSize: '0.85rem',
                  color: c.text.primary,
                  fontFamily: c.font.sans,
                  '& input::placeholder': { color: c.text.ghost, opacity: 1 },
                }}
              />
            </Box>
            <Box
              sx={{
                maxHeight: 400,
                overflow: 'auto',
                borderTop: `1px solid ${c.border.subtle}`,
                '&::-webkit-scrollbar': { width: 4 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': {
                  background: c.border.medium,
                  borderRadius: 2,
                },
                scrollbarWidth: 'thin',
                scrollbarColor: `${c.border.medium} transparent`,
              }}
            >
              {filteredOutputs.length === 0 ? (
                <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
                  <Typography sx={{ fontSize: '0.82rem', color: c.text.muted }}>
                    {outputList.length === 0 ? 'No views created yet' : 'No matching views'}
                  </Typography>
                </Box>
              ) : (
                filteredOutputs.map((output) => (
                  <Box
                    key={output.id}
                    onClick={() => handleSelectView(output)}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      px: 1.5,
                      py: 1,
                      cursor: 'pointer',
                      transition: 'background-color 0.1s',
                      '&:hover': { bgcolor: c.bg.elevated },
                    }}
                  >
                    {output.thumbnail ? (
                      <Box
                        component="img"
                        src={output.thumbnail}
                        alt={output.name}
                        sx={{
                          width: 144,
                          height: 96,
                          borderRadius: '6px',
                          objectFit: 'cover',
                          objectPosition: 'top left',
                          flexShrink: 0,
                          border: `1px solid ${c.border.subtle}`,
                        }}
                      />
                    ) : (
                      <Box
                        sx={{
                          width: 144,
                          height: 96,
                          borderRadius: '6px',
                          flexShrink: 0,
                          border: `1px solid ${c.border.subtle}`,
                          bgcolor: c.accent.primary + '12',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Icon sx={{ fontSize: 32, color: c.accent.primary, opacity: 0.7 }}>
                          {output.icon || 'view_quilt'}
                        </Icon>
                      </Box>
                    )}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        sx={{
                          fontSize: '0.82rem',
                          fontWeight: 500,
                          color: c.text.primary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {output.name}
                      </Typography>
                      {output.description && (
                        <Typography
                          sx={{
                            fontSize: '0.72rem',
                            color: c.text.muted,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {output.description}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                ))
              )}
            </Box>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            <WarmTooltip tokens={c} title={`New Agent  ${shortcutLabel}`} placement="top" arrow enterDelay={400}>
              <Box
                role="button"
                aria-label="New Agent"
                tabIndex={0}
                onClick={onNewAgent}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: BTN,
                  height: BTN,
                  borderRadius: `${c.radius.lg}px`,
                  bgcolor: c.accent.primary,
                  color: '#fff',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                  '&:hover': { bgcolor: c.accent.hover },
                  '&:active': { bgcolor: c.accent.pressed },
                }}
              >
                <AddIcon sx={{ fontSize: 20 }} />
              </Box>
            </WarmTooltip>

            <WarmTooltip
              tokens={c}
              placement="top"
              arrow
              enterDelay={200}
              title={
                <Box sx={{ textAlign: 'center' }}>
                  <Box sx={{ fontWeight: 600 }}>Add View  ⌘M</Box>
                </Box>
              }
            >
              <Box
                role="button"
                aria-label="Add View"
                tabIndex={0}
                onClick={handleOpenViewPicker}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: BTN,
                  height: BTN,
                  borderRadius: `${c.radius.md}px`,
                  color: c.text.tertiary,
                  cursor: 'pointer',
                  transition: 'opacity 0.15s, background-color 0.15s',
                  '&:hover': { opacity: 1, bgcolor: c.bg.secondary, color: c.accent.primary },
                }}
              >
                <GridViewRoundedIcon sx={{ fontSize: 22 }} />
              </Box>
            </WarmTooltip>

            <WarmTooltip
              tokens={c}
              placement="top"
              arrow
              enterDelay={200}
              title={
                <Box sx={{ textAlign: 'center' }}>
                  <Box sx={{ fontWeight: 600 }}>History  ⌘O</Box>
                </Box>
              }
            >
              <Box
                role="button"
                aria-label="History"
                tabIndex={0}
                onClick={handleOpenHistory}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: BTN,
                  height: BTN,
                  borderRadius: `${c.radius.md}px`,
                  color: c.text.tertiary,
                  cursor: 'pointer',
                  transition: 'opacity 0.15s, background-color 0.15s',
                  '&:hover': { opacity: 1, bgcolor: c.bg.secondary, color: c.accent.primary },
                }}
              >
                <HistoryRoundedIcon sx={{ fontSize: 22 }} />
              </Box>
            </WarmTooltip>

            <WarmTooltip
              tokens={c}
              placement="top"
              arrow
              enterDelay={200}
              title={
                <Box sx={{ textAlign: 'center' }}>
                  <Box sx={{ fontWeight: 600 }}>Browser</Box>
                </Box>
              }
            >
              <Box
                role="button"
                aria-label="Browser"
                tabIndex={0}
                onClick={onAddBrowser}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: BTN,
                  height: BTN,
                  borderRadius: `${c.radius.md}px`,
                  color: c.text.tertiary,
                  cursor: 'pointer',
                  transition: 'opacity 0.15s, background-color 0.15s',
                  '&:hover': { opacity: 1, bgcolor: c.bg.secondary, color: c.accent.primary },
                }}
              >
                <LanguageIcon sx={{ fontSize: 22 }} />
              </Box>
            </WarmTooltip>

            {placeholderItems.map(({ icon: PlaceholderIcon, label, sub }) => (
              <WarmTooltip
                key={label}
                tokens={c}
                placement="top"
                arrow
                enterDelay={200}
                title={
                  <Box sx={{ textAlign: 'center' }}>
                    <Box sx={{ fontWeight: 600 }}>{label}</Box>
                    <Box sx={{ opacity: 0.6, fontSize: '0.7rem', mt: '1px' }}>{sub}</Box>
                  </Box>
                }
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: BTN,
                    height: BTN,
                    borderRadius: `${c.radius.md}px`,
                    color: c.text.tertiary,
                    opacity: 0.45,
                    cursor: 'default',
                    transition: 'opacity 0.15s, background-color 0.15s',
                    '&:hover': { opacity: 0.65, bgcolor: c.bg.secondary },
                  }}
                >
                  <PlaceholderIcon sx={{ fontSize: 22 }} />
                </Box>
              </WarmTooltip>
            ))}
          </div>
        )}
      </MotionBox>
    );
  },
);

DashboardToolbar.displayName = 'DashboardToolbar';

export default DashboardToolbar;
