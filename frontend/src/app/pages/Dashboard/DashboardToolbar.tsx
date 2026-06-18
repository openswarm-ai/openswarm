import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip, { tooltipClasses } from '@mui/material/Tooltip';
import Snackbar from '@mui/material/Snackbar';
import Icon from '@mui/material/Icon';
import { styled } from '@mui/material/styles';
import AddRounded from '@mui/icons-material/AddRounded';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';

import ChatBubbleTeardrop from './ChatBubbleTeardrop';

// Collapsed-row buttons hop up one after another when the toolbar appears.
const popIn = (i: number) => ({
  animation: `toolbar-pop 0.4s cubic-bezier(0.2, 1.4, 0.4, 1) ${i * 55}ms both`,
  '@keyframes toolbar-pop': {
    from: { opacity: 0, transform: 'translateY(14px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
});
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import LanguageIcon from '@mui/icons-material/Language';
import SearchIcon from '@mui/icons-material/Search';
import { motion } from 'framer-motion';
import ChatInput from '@/app/pages/AgentChat/ChatInput';
import type { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import SchedulePopover from '@/app/pages/Workflows/SchedulePopover';
import { openWorkflowCard, fetchAllRuns, upsertRun } from '@/shared/state/workflowsSlice';
import { addWorkflowCard, openWorkflowsHub } from '@/shared/state/dashboardLayoutSlice';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { searchHistory, clearHistorySearch } from '@/shared/state/agentsSlice';
import { updateSettings, AppSettings } from '@/shared/state/settingsSlice';
import { store } from '@/shared/state/store';
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
  onAddNote: () => void;
  dashboardId?: string;
  newAgentBounce?: boolean;
  onNewAgentBounceEnd?: () => void;
  // Text to seed the composer with when it opens (starter-prompt click).
  prefillPrompt?: string;
  // Mode to open the composer in (e.g. 'view-builder' for a Build starter).
  prefillMode?: string;
}

const TOOLBAR_OWNER_ID = '__toolbar__';
const BTN = 44;

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
  ({ inputOpen, onNewAgent, onCancel, onSend, onAddView, onHistoryResume, onAddBrowser, onAddNote, dashboardId, newAgentBounce, onNewAgentBounceEnd, prefillPrompt, prefillMode }, ref) => {
    const c = useClaudeTokens();
    const dispatch = useAppDispatch();
    const elementSelection = useElementSelection();
    const containerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const historyInputRef = useRef<HTMLInputElement>(null);
    const historyListRef = useRef<HTMLDivElement>(null);
    const defaultMode = useAppSelector((s) => s.settings.data.default_mode);
    const defaultModel = useAppSelector((s) => s.settings.data.default_model);
    const defaultThinkingLevel = useAppSelector((s) => s.settings.data.default_thinking_level);
    const settingsLoaded = useAppSelector((s) => s.settings.loaded);
    const [mode, setMode] = useState(defaultMode || 'agent');
    const [model, setModel] = useState(defaultModel || 'sonnet');
    const [thinkingLevel, setThinkingLevel] = useState<'off' | 'low' | 'medium' | 'high' | 'auto'>(defaultThinkingLevel || 'auto');
    // Snap to the persisted Settings defaults as soon as they arrive from the
    // backend. Without the settingsLoaded guard, the effect fires against the
    // Redux initialState ('sonnet') before the real default has loaded, and
    // the settingsApplied flag then locks out the real default for the rest
    // of the session , so new chats spawn under the stale value.
    const settingsApplied = useRef(false);
    useEffect(() => {
      if (settingsLoaded && !settingsApplied.current) {
        setMode(defaultMode || 'agent');
        setModel(defaultModel || 'sonnet');
        setThinkingLevel(defaultThinkingLevel || 'auto');
        settingsApplied.current = true;
      }
    }, [settingsLoaded, defaultMode, defaultModel, defaultThinkingLevel]);
    // Reset defaults on each new compose session so in-session picks don't leak into the next new-chat draft.
    const prevInputOpen = useRef(false);
    useEffect(() => {
      if (settingsLoaded && inputOpen && !prevInputOpen.current) {
        setMode(defaultMode || 'agent');
        setModel(defaultModel || 'sonnet');
        setThinkingLevel(defaultThinkingLevel || 'auto');
      }
      prevInputOpen.current = inputOpen;
    }, [inputOpen, settingsLoaded, defaultMode, defaultModel, defaultThinkingLevel]);
    // Prefill-driven mode: a Build starter opens the composer in App Builder mode
    // ('view-builder'); a non-Build starter (no prefillMode) falls back to the
    // default. Gated on inputOpen + declared last so it wins the reset effects
    // above regardless of settings-load timing. A later manual pick survives
    // because none of these deps change on a pick.
    useEffect(() => {
      if (!inputOpen || !settingsLoaded) return;
      setMode(prefillMode || defaultMode || 'agent');
    }, [prefillMode, inputOpen, settingsLoaded, defaultMode]);

    // Writes toolbar picks through to global default; otherwise the reopen-reset effect would snap back next open.
    const promoteToDefault = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      const current = store.getState().settings;
      if (!current.loaded) return;
      if (current.data[key] === value) return;
      dispatch(updateSettings({ ...current.data, [key]: value }));
    }, [dispatch]);

    const handleModeChange = useCallback((newMode: string) => {
      setMode(newMode);
      promoteToDefault('default_mode', newMode);
    }, [promoteToDefault]);

    const handleModelChange = useCallback((newModel: string) => {
      setModel(newModel);
      promoteToDefault('default_model', newModel);
    }, [promoteToDefault]);

    const handleThinkingLevelChange = useCallback((level: 'off' | 'low' | 'medium' | 'high' | 'auto') => {
      setThinkingLevel(level);
      promoteToDefault('default_thinking_level', level);
    }, [promoteToDefault]);
    const [viewPickerOpen, setViewPickerOpen] = useState(false);
    const [viewSearch, setViewSearch] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyQuery, setHistoryQuery] = useState('');
    const [popoverMode, setPopoverMode] = useState<'search' | 'runs' | 'schedule'>('search');
    const [expandToast, setExpandToast] = useState<string | null>(null);
    const shortcut = useAppSelector((s) => s.settings.data.new_agent_shortcut);
    const outputs = useAppSelector((s) => s.outputs.items);
    const historySearch = useAppSelector((s) => s.agents.historySearch);
    const allRuns = useAppSelector((s) => s.workflows.allRuns);
    const allRunsLoading = useAppSelector((s) => s.workflows.allRunsLoading);
    const workflowItems = useAppSelector((s) => s.workflows.items);

    const outputList = useMemo(() => Object.values(outputs), [outputs]);
    const filteredOutputs = useMemo(() => {
      if (!viewSearch.trim()) return outputList;
      const q = viewSearch.toLowerCase();
      return outputList.filter(
        (o) => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q),
      );
    }, [outputList, viewSearch]);

    const shortcutLabel = (shortcut || '')
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

    // Opens the History popover on Chat history, with a tab to the Scheduled
    // tasks run log. The calendar is a separate destination reached via the
    // Schedule pill, never from here.
    const handleOpenHistory = useCallback(() => {
      if (historyOpen) {
        setHistoryOpen(false);
        return;
      }
      setViewPickerOpen(false);
      setViewSearch('');
      setPopoverMode('search');
      setHistoryOpen(true);
    }, [historyOpen]);

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

    const autoSelectOnNew = useAppSelector((s) => s.settings.data.auto_select_mode_on_new_agent);
    const prevInputOpenRef = useRef(inputOpen);
    useEffect(() => {
      if (prevInputOpenRef.current && !inputOpen && elementSelection) {
        elementSelection.clearOwnerElements(TOOLBAR_OWNER_ID);
        if (elementSelection.selectMode && elementSelection.activeOwnerId === TOOLBAR_OWNER_ID) {
          elementSelection.setSelectMode(false);
        }
      }
      if (!prevInputOpenRef.current && inputOpen && autoSelectOnNew && elementSelection) {
        elementSelection.clearOwnerElements(TOOLBAR_OWNER_ID);
        elementSelection.setActiveOwnerId(TOOLBAR_OWNER_ID);
        elementSelection.setExcludeSelectId(null);
        elementSelection.setSelectMode(true);
      }
      prevInputOpenRef.current = inputOpen;
    }, [inputOpen, elementSelection, autoSelectOnNew]);

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
      let downPos: { x: number; y: number; target: Node } | null = null;
      const DRAG_THRESHOLD = 5;

      const handleDown = (e: MouseEvent) => {
        const target = e.target as Node;
        if (containerRef.current && !containerRef.current.contains(target)) {
          downPos = { x: e.clientX, y: e.clientY, target };
        } else {
          downPos = null;
        }
      };

      const handleUp = (e: MouseEvent) => {
        if (!downPos) return;
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        const target = downPos.target;
        downPos = null;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) return;

        const el = target instanceof Element ? target : (target as Node).parentElement;

        if (el?.closest('[role="dialog"], [role="presentation"], .MuiModal-root, .MuiPopover-root, [data-toolbar-pills]')) {
          return;
        }
        if (elementSelection?.selectMode && el?.closest('[data-select-type]')) {
          return;
        }
        handleDismiss();
      };

      const t = setTimeout(() => {
        document.addEventListener('mousedown', handleDown, true);
        document.addEventListener('mouseup', handleUp, true);
      }, 50);
      return () => {
        clearTimeout(t);
        document.removeEventListener('mousedown', handleDown, true);
        document.removeEventListener('mouseup', handleUp, true);
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
        if (e.metaKey && e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          onAddBrowser();
        }
      };
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }, [handleOpenViewPicker, handleOpenHistory, onAddBrowser]);

    useEffect(() => {
      if (!historyOpen) return;
      const timer = setTimeout(() => {
        dispatch(searchHistory({ q: historyQuery, limit: HISTORY_PAGE_SIZE, offset: 0, dashboardId }));
      }, 300);
      return () => clearTimeout(timer);
    }, [historyQuery, historyOpen, dispatch, dashboardId]);

    useEffect(() => {
      if (historyOpen && popoverMode === 'runs') {
        dispatch(fetchAllRuns(200));
      }
    }, [historyOpen, popoverMode, dispatch]);

    const handleHistoryScroll = useCallback(() => {
      const el = historyListRef.current;
      if (!el) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
        handleHistoryLoadMore();
      }
    }, [handleHistoryLoadMore]);

    const placeholderItems: Array<{ icon: typeof StickyNote2OutlinedIcon; label: string; sub: string }> = [];

    return (
      <>
      {(inputOpen || historyOpen) && (
        <Box data-toolbar-pills sx={{ display: 'flex', gap: 0.5, mb: 0.75, pl: 0.25 }}>
          <Box
            onClick={() => {
              if (historyOpen) {
                handleCloseHistory();
                onNewAgent();
              }
              // If already in inputOpen, this is a no-op (we're already
              // in new chat). The visible active styling tells the user
              // that. Clicking again does nothing intentionally.
            }}
            role="button"
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.3,
              fontSize: '0.74rem', fontWeight: 600,
              color: inputOpen && !historyOpen ? c.text.primary : c.text.secondary,
              bgcolor: c.bg.surface,
              border: `1px solid ${inputOpen && !historyOpen ? c.border.medium : c.border.subtle}`,
              boxShadow: inputOpen && !historyOpen ? c.shadow.sm : 'none',
              px: 0.85, py: 0.3, borderRadius: 999,
              cursor: historyOpen ? 'pointer' : 'default',
              '&:hover': historyOpen ? { bgcolor: c.bg.elevated } : {},
            }}>
            <AddRounded sx={{ fontSize: 12 }} />
            New Chat
          </Box>
          <Box
            onClick={() => {
              // Schedule is a destination, not a toggle: clicking it always
              // lands on (and stays on) the calendar. It used to call
              // handleCloseHistory when already open, which read as "Schedule
              // does nothing" because it closed the calendar you were viewing.
              // Close the composer first; inputOpen takes precedence in the
              // render branch below so the popover would hide behind it.
              if (inputOpen) onCancel();
              setPopoverMode('schedule');
              if (!historyOpen) setHistoryOpen(true);
            }}
            role="button"
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.3,
              fontSize: '0.74rem', fontWeight: 600,
              color: historyOpen ? c.text.primary : c.text.secondary,
              bgcolor: c.bg.surface,
              border: `1px solid ${historyOpen ? c.border.medium : c.border.subtle}`,
              boxShadow: historyOpen ? c.shadow.sm : 'none',
              px: 0.85, py: 0.3, borderRadius: 999,
              cursor: 'pointer',
              '&:hover': { bgcolor: c.bg.elevated },
            }}>
            <CalendarMonthRounded sx={{ fontSize: 12 }} />
            Schedule
          </Box>
        </Box>
      )}
      <MotionBox
        ref={containerRef}
        layout
        transition={{ layout: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] } }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          // Drop toolbar card chrome when popover is open so we don't double-card; popover supplies its own surface.
          background: historyOpen ? 'transparent' : c.bg.surface,
          border: historyOpen ? '1px solid transparent' : `1px solid ${c.border.subtle}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: historyOpen ? 'none' : c.shadow.lg,
          padding: isExpanded ? '6px' : '5px',
          userSelect: 'none' as const,
          overflow: inputOpen || newAgentBounce || historyOpen ? 'visible' : 'hidden',
          // historyOpen: width owned by SchedulePopover; leave undefined so framer-motion measures intrinsic size.
          width: viewPickerOpen ? 580 : historyOpen ? undefined : isExpanded ? 540 : undefined,
        }}
      >
        {inputOpen && !historyOpen ? (
          // historyOpen wins over the composer: clicking Schedule closes the
          // composer via onCancel(), but that's a parent-state update that
          // lands a render late, so without this guard the composer kept
          // covering the calendar (the "Schedule does nothing" bug).
          // data-onboarding-scope="dock" makes AC's per-agent resolver prefer this dock chat input over existing agent cards.
          <div
            data-onboarding-scope="dock"
            style={{ width: '100%', minHeight: 56, paddingBottom: 0, marginBottom: -4 }}
          >
            <ChatInput
              onSend={handleSend}
              mode={mode}
              onModeChange={handleModeChange}
              model={model}
              onModelChange={handleModelChange}
              embedded
              autoFocus
              sessionId={TOOLBAR_OWNER_ID}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={handleThinkingLevelChange}
              prefillPrompt={prefillPrompt}
            />
          </div>
        ) : historyOpen ? (
          <div style={{ width: '100%' }}>
            <SchedulePopover
              mode={popoverMode}
              onModeChange={setPopoverMode}
              hideTopChrome
              historyResults={historySearch.results.map((e) => ({ id: e.id, name: e.name, closed_at: e.closed_at }))}
              historyLoading={historySearch.loading}
              historyQuery={historyQuery}
              onHistoryQueryChange={setHistoryQuery}
              onHistorySelect={handleHistorySelect}
              onNewChat={() => { handleCloseHistory(); onNewAgent(); }}
              onWorkflowSelect={(wid) => {
                dispatch(addWorkflowCard({ workflowId: wid }));
                dispatch(openWorkflowCard({
                  workflowId: wid,
                  view: 'saved',
                }));
                handleCloseHistory();
              }}
              onExpand={() => {
                // Singleton per dashboard, second Expand brings the existing card forward.
                const alreadyOpen = Boolean(store.getState().dashboardLayout.workflowsHub);
                dispatch(openWorkflowsHub({ expandedSessionIds: [] }));
                if (alreadyOpen) setExpandToast('Calendar view is already open');
                handleCloseHistory();
              }}
              allRuns={allRuns}
              allRunsLoading={allRunsLoading}
              workflowTitleFor={(wid) => workflowItems[wid]?.title || 'Workflow'}
              onRunOpen={(run) => {
                // Splice the clicked run in first so HistoryDetail finds it
                // before fetchRuns resolves; avoids a "Run not found" flash.
                dispatch(upsertRun(run));
                dispatch(addWorkflowCard({ workflowId: run.workflow_id }));
                dispatch(openWorkflowCard({
                  workflowId: run.workflow_id,
                  view: 'history_detail',
                  historyRunId: run.id,
                }));
                handleCloseHistory();
              }}
              historyScrollRef={historyListRef as React.RefObject<HTMLDivElement>}
              onHistoryScroll={handleHistoryScroll}
            />
          </div>
        ) : viewPickerOpen ? (
          <div style={{ width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
              <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
              <InputBase
                inputRef={searchInputRef}
                value={viewSearch}
                onChange={(e) => setViewSearch(e.target.value)}
                placeholder="Search apps..."
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
                    {outputList.length === 0 ? 'No apps created yet' : 'No matching apps'}
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
                data-onboarding="new-agent-button"
                tabIndex={0}
                onClick={() => {
                  if (newAgentBounce) onNewAgentBounceEnd?.();
                  onNewAgent();
                }}
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
                  // Pop in first; the empty-canvas bounce takes over once the row has settled.
                  animation: `toolbar-pop 0.4s cubic-bezier(0.2, 1.4, 0.4, 1) both${newAgentBounce ? ', new-agent-bounce 1.6s ease-out 0.6s infinite' : ''}`,
                  '@keyframes toolbar-pop': {
                    from: { opacity: 0, transform: 'translateY(14px)' },
                    to: { opacity: 1, transform: 'translateY(0)' },
                  },
                  '@keyframes new-agent-bounce': {
                    '0%':   { transform: 'translateY(0)' },
                    '15%':  { transform: 'translateY(-10px)' },
                    '30%':  { transform: 'translateY(0)' },
                    '42%':  { transform: 'translateY(-4px)' },
                    '55%':  { transform: 'translateY(0)' },
                    '100%': { transform: 'translateY(0)' },
                  },
                }}
              >
                <ChatBubbleTeardrop sx={{ fontSize: 18 }} />
              </Box>
            </WarmTooltip>

            <WarmTooltip
              tokens={c}
              placement="top"
              arrow
              enterDelay={200}
              title={
                <Box sx={{ textAlign: 'center' }}>
                  <Box sx={{ fontWeight: 600 }}>Add App  ⌘M</Box>
                </Box>
              }
            >
              <Box
                role="button"
                aria-label="Add App"
                tabIndex={0}
                onClick={handleOpenViewPicker}
                data-onboarding="dashboard-toolbar-apps"
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
                  ...popIn(1),
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
                  <Box sx={{ fontWeight: 600 }}>Browser  ⌘N</Box>
                </Box>
              }
            >
              <Box
                role="button"
                aria-label="Browser"
                data-onboarding="browser-button"
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
                  ...popIn(2),
                }}
              >
                <LanguageIcon sx={{ fontSize: 22 }} />
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
                  ...popIn(3),
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
                  <Box sx={{ fontWeight: 600 }}>Add note</Box>
                  <Box sx={{ opacity: 0.6, fontSize: '0.7rem', mt: '1px' }}>Sticky note on the canvas</Box>
                </Box>
              }
            >
              <Box
                role="button"
                aria-label="Add note"
                tabIndex={0}
                onClick={onAddNote}
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
                  ...popIn(4),
                }}
              >
                <StickyNote2OutlinedIcon sx={{ fontSize: 22 }} />
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
      <Snackbar
        open={Boolean(expandToast)}
        autoHideDuration={3000}
        onClose={() => setExpandToast(null)}
        message={expandToast || ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      </>
    );
  },
);

DashboardToolbar.displayName = 'DashboardToolbar';

export default DashboardToolbar;
