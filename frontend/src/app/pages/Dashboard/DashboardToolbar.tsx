import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Icon from '@mui/material/Icon';

import DesktopSpawnPill from './desktop/DesktopSpawnPill';
import { coveredByTiledZones } from './canvas/spawnPillCover';
import SearchIcon from '@mui/icons-material/Search';
import { motion } from 'framer-motion';
import ChatInput from '@/app/pages/AgentChat/ChatInput';
import { EmptyState } from '@/app/components/feedback/Loading';
import type { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import SchedulePopover from '@/app/pages/Workflows/SchedulePopover';
import { openWorkflowCard, fetchAllRuns, upsertRun } from '@/shared/state/workflowsSlice';
import { addWorkflowCard, openWorkflowsApp, closeWorkflowsApp, WORKFLOWS_HUB_ID } from '@/shared/state/dashboardLayoutSlice';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { useClaudeTokens, DarkTokensScope } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { searchHistory, clearHistorySearch, deleteSession, renameSession } from '@/shared/state/agentsSlice';
import { openCardContextMenu } from './desktop/openCardContextMenu';
import { displaySessionName } from '@/shared/state/sessionDisplay';
import { updateSettingsPatch, AppSettings } from '@/shared/state/settingsSlice';
import { store } from '@/shared/state/store';
import { API_BASE, getAuthToken } from '@/shared/config';
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
    selectedAppIds?: string[],
  ) => void;
  onAddView: (outputId: string, opts?: { newInstance?: boolean }) => void;
  onOpenApplications: () => void;
  onHistoryResume: (sessionId: string) => void;
  onAddBrowser: () => void;
  dashboardId?: string;
  newAgentBounce?: boolean;
  canvasEmpty?: boolean;
  onNewAgentBounceEnd?: () => void;
  // Text to seed the composer with when it opens (starter-prompt click).
  prefillPrompt?: string;
  // Mode to open the composer in (e.g. 'view-builder' for a Build starter).
  prefillMode?: string;
}

export const TOOLBAR_OWNER_ID = '__toolbar__';

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
  ({ inputOpen, onNewAgent, onCancel, onSend, onAddView, onOpenApplications, onHistoryResume, onAddBrowser, dashboardId, newAgentBounce, canvasEmpty, onNewAgentBounceEnd, prefillPrompt, prefillMode }, ref) => {
    const c = useClaudeTokens();
    const dispatch = useAppDispatch();
    const elementSelection = useElementSelection();
    const containerRef = useRef<HTMLDivElement>(null);
    // The pill steps aside when a tiled card sits on it; measured from its own rect, re-checked when the tiles or the window change.
    const tiledZonesKey = useAppSelector((s) => Object.values(s.dashboardLayout.tiledCards).sort().join(','));
    const [pillCovered, setPillCovered] = useState(false);
    useEffect(() => {
      const check = (): void => {
        const el = containerRef.current;
        if (!el) { setPillCovered(false); return; }
        const r = el.getBoundingClientRect();
        const zones = tiledZonesKey ? tiledZonesKey.split(',') : [];
        setPillCovered(zones.length > 0 && coveredByTiledZones(zones, { x: r.left, y: r.top, w: r.width, h: r.height }));
      };
      check();
      window.addEventListener('resize', check);
      const t = window.setTimeout(check, 400);
      return () => { window.removeEventListener('resize', check); window.clearTimeout(t); };
    }, [tiledZonesKey]);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const historyInputRef = useRef<HTMLInputElement>(null);
    const historyListRef = useRef<HTMLDivElement>(null);
    const defaultMode = useAppSelector((s) => s.settings.data.default_mode);
    const defaultModel = useAppSelector((s) => s.settings.data.default_model);
    const defaultThinkingLevel = useAppSelector((s) => s.settings.data.default_thinking_level);
    const settingsLoaded = useAppSelector((s) => s.settings.loaded);
    const [mode, setMode] = useState(defaultMode || 'agent');
    const [model, setModel] = useState(defaultModel || 'sonnet-5');
    const [thinkingLevel, setThinkingLevel] = useState<'off' | 'low' | 'medium' | 'high' | 'auto'>(defaultThinkingLevel || 'auto');
    // Snap to the persisted Settings defaults as soon as they arrive from the backend. Without the settingsLoaded guard, the effect fires against the Redux initialState ('sonnet') before the real default has loaded, and the settingsApplied flag then locks out the real default for the rest of the session, so new chats spawn under the stale value.
    const settingsApplied = useRef(false);
    useEffect(() => {
      if (settingsLoaded && !settingsApplied.current) {
        setMode(defaultMode || 'agent');
        setModel(defaultModel || 'sonnet-5');
        setThinkingLevel(defaultThinkingLevel || 'auto');
        settingsApplied.current = true;
      }
    }, [settingsLoaded, defaultMode, defaultModel, defaultThinkingLevel]);
    // Ghost-text predictions: what the user might type next, in their own voice. Fetched once per app
    // load (cached), then one is shown at a time and cycled while the composer sits idle+empty. Empty
    // list (no signal / no provider / error) just leaves the static "Ask me to do anything..." placeholder.
    const [ghostList, setGhostList] = useState<string[]>([]);
    const ghostFetchedRef = useRef(false);
    useEffect(() => {
      if (!inputOpen || ghostFetchedRef.current) return;
      ghostFetchedRef.current = true;
      (async () => {
        try {
          const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
          const headers: Record<string, string> = {};
          if (tok) headers['Authorization'] = `Bearer ${tok}`;
          const resp = await fetch(`${API_BASE}/agents/predict-prompts?count=5`, { headers });
          if (!resp.ok) return;
          const data = await resp.json();
          if (Array.isArray(data.suggestions)) setGhostList(data.suggestions.filter((s: unknown) => typeof s === 'string' && s));
        } catch { /* fail open: keep the static placeholder */ }
      })();
    }, [inputOpen]);
    // ONE stable suggestion, never a rotating carousel: cycling guesses every few seconds reads as
    // "the app is throwing darts." The backend only returns anything when it has real usage history to
    // predict from (see predict_prompts.py), so an empty list just leaves the neutral placeholder.
    const ghostSuggestion = ghostList.length ? ghostList[0] : undefined;

    // Reset defaults on each new compose session so in-session picks don't leak into the next new-chat draft.
    const prevInputOpen = useRef(false);
    useEffect(() => {
      if (settingsLoaded && inputOpen && !prevInputOpen.current) {
        setMode(defaultMode || 'agent');
        setModel(defaultModel || 'sonnet-5');
        setThinkingLevel(defaultThinkingLevel || 'auto');
      }
      prevInputOpen.current = inputOpen;
    }, [inputOpen, settingsLoaded, defaultMode, defaultModel, defaultThinkingLevel]);
    // Prefill-driven mode: a Build starter opens the composer in App Builder mode ('view-builder'); a non-Build starter (no prefillMode) falls back to the default. Gated on inputOpen + declared last so it wins the reset effects above regardless of settings-load timing. A later manual pick survives because none of these deps change on a pick.
    useEffect(() => {
      if (!inputOpen || !settingsLoaded) return;
      setMode(prefillMode || defaultMode || 'agent');
    }, [prefillMode, inputOpen, settingsLoaded, defaultMode]);

    // Writes toolbar picks through to global default; otherwise the reopen-reset effect would snap back next open.
    const promoteToDefault = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      const current = store.getState().settings;
      if (!current.loaded) return;
      if (current.data[key] === value) return;
      dispatch(updateSettingsPatch({ [key]: value }));
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
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyQuery, setHistoryQuery] = useState('');
    const [popoverMode, setPopoverMode] = useState<'search' | 'runs' | 'schedule'>('search');
    const [expandToast, setExpandToast] = useState<string | null>(null);
    const outputs = useAppSelector((s) => s.outputs.items);
    const historySearch = useAppSelector((s) => s.agents.historySearch);
    const allRuns = useAppSelector((s) => s.workflows.allRuns);
    const allRunsLoading = useAppSelector((s) => s.workflows.allRunsLoading);
    const workflowItems = useAppSelector((s) => s.workflows.items);
    // Parked counts as not-showing, so the pill restores the window instead of throwing its state away.
    const workflowsHubOpen = useAppSelector((s) => Boolean(s.dashboardLayout.workflowsHub) && !s.dashboardLayout.minimizedCards[WORKFLOWS_HUB_ID]);

    const outputList = useMemo(() => Object.values(outputs), [outputs]);


    React.useImperativeHandle(ref, () => containerRef.current!, []);

    const handleSend = useCallback(
      (
        message: string,
        images?: Array<{ data: string; media_type: string }>,
        contextPaths?: ContextPath[],
        forcedTools?: string[],
        attachedSkills?: Array<{ id: string; name: string; content: string }>,
        selectedBrowserIds?: string[],
        selectedAppIds?: string[],
      ) => {
        onSend(message, mode, model, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds, selectedAppIds);
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
      } else {
        onCancel();
      }
    }, [historyOpen, onCancel, handleCloseHistory]);

    // Opens the History popover on Chat history, with a tab to the Scheduled tasks run log. The calendar is a separate destination reached via the Schedule pill, never from here.
    const handleOpenHistory = useCallback(() => {
      if (historyOpen) {
        setHistoryOpen(false);
        return;
      }
      setPopoverMode('search');
      setHistoryOpen(true);
    }, [historyOpen]);

    const handleHistorySelect = useCallback((sessionId: string) => {
      onHistoryResume(sessionId);
      handleCloseHistory();
    }, [onHistoryResume, handleCloseHistory]);

    const handleHistoryContextMenu = useCallback((e: React.MouseEvent, entry: { id: string; name: string }) => {
      openCardContextMenu(e, {
        rename: { value: displaySessionName(entry.name), onCommit: (name) => { void dispatch(renameSession({ sessionId: entry.id, name })); } },
        items: [
          { label: 'Resume chat', onClick: () => handleHistorySelect(entry.id) },
          { kind: 'separator' },
          {
            label: 'Delete chat',
            danger: true,
            onClick: () => {
              void dispatch(deleteSession({ sessionId: entry.id })).then(() => {
                dispatch(searchHistory({ q: historyQuery, limit: HISTORY_PAGE_SIZE, offset: 0 }));
              });
            },
          },
        ],
      });
    }, [dispatch, handleHistorySelect, historyQuery]);

    const handleHistoryLoadMore = useCallback(() => {
      if (historySearch.loading || !historySearch.hasMore) return;
      dispatch(searchHistory({
        q: historyQuery,
        limit: HISTORY_PAGE_SIZE,
        offset: historySearch.results.length,
      }));
    }, [dispatch, historyQuery, historySearch.loading, historySearch.hasMore, historySearch.results.length]);

    const isExpanded = inputOpen || historyOpen;

    const autoSelectOnNew = useAppSelector((s) => s.settings.data.auto_select_mode_on_new_agent);
    const prevInputOpenRef = useRef(inputOpen);
    useEffect(() => {
      // Collapsing the composer drops the selecting cursor but KEEPS the selected elements, so they persist across collapse/reopen like the draft text does. The selection is cleared on send via ChatInput's clearOwnerElements(ownerId).
      if (prevInputOpenRef.current && !inputOpen && elementSelection) {
        if (elementSelection.selectMode && elementSelection.activeOwnerId === TOOLBAR_OWNER_ID) {
          elementSelection.setSelectMode(false);
        }
      }
      // Re-arm select mode on reopen without wiping any in-progress selection (mirrors the selector button, which only clears when switching owners).
      if (!prevInputOpenRef.current && inputOpen && autoSelectOnNew && elementSelection) {
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
      if (historyOpen) {
        setTimeout(() => historyInputRef.current?.focus(), 60);
      }
    }, [historyOpen]);

    useEffect(() => {
      const handleKey = (e: KeyboardEvent) => {
        if (e.metaKey && e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          onOpenApplications();
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
      // The desktop dock's History tile opens the same popover as Cmd+O.
      const handleOpenHistoryEvent = () => handleOpenHistory();
      window.addEventListener('keydown', handleKey);
      window.addEventListener('openswarm:open-history', handleOpenHistoryEvent);
      return () => {
        window.removeEventListener('keydown', handleKey);
        window.removeEventListener('openswarm:open-history', handleOpenHistoryEvent);
      };
    }, [onOpenApplications, handleOpenHistory, onAddBrowser]);

    // No dashboardId: chat history is global, so a chat you started on another dashboard is still findable here.
    useEffect(() => {
      if (!historyOpen) return;
      const timer = setTimeout(() => {
        dispatch(searchHistory({ q: historyQuery, limit: HISTORY_PAGE_SIZE, offset: 0 }));
      }, 300);
      return () => clearTimeout(timer);
    }, [historyQuery, historyOpen, dispatch]);

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


    return (
      <>
      <MotionBox
        ref={containerRef}
        layout
        transition={{ layout: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] } }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          // Drop toolbar card chrome when popover is open (popover supplies its own surface) and when
          // collapsed (the spawn pill carries its own dark glass). The open composer wears the same
          // desktop dark glass as the rest of the shell.
          background: historyOpen ? 'transparent' : inputOpen ? 'rgba(22,12,34,0.82)' : 'transparent',
          backdropFilter: inputOpen && !historyOpen ? 'blur(20px) saturate(160%)' : undefined,
          WebkitBackdropFilter: inputOpen && !historyOpen ? 'blur(20px) saturate(160%)' : undefined,
          border: '1px solid transparent',
          borderRadius: `${c.radius.xl}px`,
          boxShadow: historyOpen || !isExpanded ? 'none' : '0 12px 32px rgba(0,0,0,0.4)',
          padding: isExpanded ? '6px' : '0px',
          userSelect: 'none' as const,
          // Only the view picker needs clipping (it scrolls its own list); anything else clipped the collapsed spawn pill's drop shadow flat against its own border box.
          overflow: 'visible',
          // historyOpen: width owned by SchedulePopover; leave undefined so framer-motion measures intrinsic size.
          width: historyOpen ? undefined : isExpanded ? 540 : undefined,
        }}
      >
        {inputOpen && !historyOpen ? (
          // historyOpen wins over the composer: clicking Schedule closes the composer via onCancel(), but that's a parent-state update that lands a render late, so without this guard the composer kept covering the calendar (the "Schedule does nothing" bug). data-onboarding-scope="dock" makes AC's per-agent resolver prefer this dock chat input over existing agent cards.
          <div
            data-onboarding-scope="dock"
            style={{ width: '100%', minHeight: 56, paddingBottom: 0, marginBottom: -4 }}
          >
            <DarkTokensScope>
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
                placeholderOverride="Ask me to do anything..."
                ghostSuggestion={ghostSuggestion}
              />
            </DarkTokensScope>
          </div>
        ) : historyOpen ? (
          <div style={{ width: '100%' }}>
            <SchedulePopover
              mode={popoverMode}
              onModeChange={setPopoverMode}
              hideTopChrome
              chatHistoryOnly
              historyResults={historySearch.results.map((e) => ({ id: e.id, name: e.name, closed_at: e.closed_at }))}
              historyLoading={historySearch.loading}
              historyQuery={historyQuery}
              onHistoryQueryChange={setHistoryQuery}
              onHistorySelect={handleHistorySelect}
              onHistoryContextMenu={handleHistoryContextMenu}
              onNewChat={() => { handleCloseHistory(); onNewAgent(); }}
              onWorkflowSelect={(wid) => {
                dispatch(openWorkflowsApp({ workflowId: wid }));
                handleCloseHistory();
              }}
              onExpand={() => {
                dispatch(openWorkflowsApp());
                handleCloseHistory();
              }}
              allRuns={allRuns}
              allRunsLoading={allRunsLoading}
              workflowTitleFor={(wid) => workflowItems[wid]?.title || 'Workflow'}
              onRunOpen={(run) => {
                dispatch(openWorkflowsApp({ workflowId: run.workflow_id }));
                handleCloseHistory();
              }}
              historyScrollRef={historyListRef as React.RefObject<HTMLDivElement>}
              onHistoryScroll={handleHistoryScroll}
            />
          </div>
        ) : canvasEmpty || pillCovered ? null : (
          <DesktopSpawnPill
            onOpenComposer={() => {
              if (newAgentBounce) onNewAgentBounceEnd?.();
              onNewAgent();
            }}
            onAddBrowser={onAddBrowser}
            onAddApp={onOpenApplications}
            onWorkflows={() => dispatch(workflowsHubOpen ? closeWorkflowsApp() : openWorkflowsApp())}
            onHistory={handleOpenHistory}
          />
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
