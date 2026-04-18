import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ContextPath } from '@/app/components/DirectoryBrowser';
import { useElementSelection } from '@/app/components/ElementSelectionContext';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearHistorySearch } from '@/shared/state/agentsSlice';
import { GET_HISTORY } from '@/shared/backend-bridge/apps/agents';
import type { Output } from '@/shared/state/outputsSlice';
import type { Props } from './toolbarShared';
import { TOOLBAR_OWNER_ID, HISTORY_PAGE_SIZE } from './toolbarShared';

export function useDashboardToolbar({
  inputOpen, onCancel, onSend, onAddView, onHistoryResume, onAddBrowser, dashboardId,
}: Omit<Props, 'onNewAgent'>) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const elementSelection = useElementSelection();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const historyInputRef = useRef<HTMLInputElement>(null);
  const historyListRef = useRef<HTMLDivElement>(null);
  const defaultMode = useAppSelector((s) => s.settings.data.default_mode);
  const defaultModel = useAppSelector((s) => s.settings.data.default_model);
  const [mode, setMode] = useState(defaultMode || 'agent');
  const [model, setModel] = useState(defaultModel || 'sonnet');
  const [viewPickerOpen, setViewPickerOpen] = useState(false);
  const [viewSearch, setViewSearch] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const shortcut = useAppSelector((s) => s.settings.data.new_agent_shortcut);
  const outputs = useAppSelector((s) => s.outputs.items);
  const historySearchState = useAppSelector((s) => s.agents.historySearch);

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
    dispatch(GET_HISTORY({ q: '', limit: HISTORY_PAGE_SIZE, offset: 0 }));
  }, [historyOpen, dispatch]);

  const handleHistorySelect = useCallback((sessionId: string) => {
    onHistoryResume(sessionId);
    handleCloseHistory();
  }, [onHistoryResume, handleCloseHistory]);

  const handleHistoryLoadMore = useCallback(() => {
    if (historySearchState.loading || !historySearchState.hasMore) return;
    dispatch(GET_HISTORY({
      q: historyQuery,
      limit: HISTORY_PAGE_SIZE,
      offset: historySearchState.results.length,
    }));
  }, [dispatch, historyQuery, historySearchState.loading, historySearchState.hasMore, historySearchState.results.length]);

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
      if (e.key === 'Escape') { e.preventDefault(); handleDismiss(); }
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
      } else { downPos = null; }
    };
    const handleUp = (e: MouseEvent) => {
      if (!downPos) return;
      const dx = e.clientX - downPos.x;
      const dy = e.clientY - downPos.y;
      const target = downPos.target;
      downPos = null;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) return;
      const el = target instanceof Element ? target : (target as Node).parentElement;
      if (el?.closest('[role="dialog"], [role="presentation"], .MuiModal-root, .MuiPopover-root')) return;
      if (elementSelection?.selectMode && el?.closest('[data-select-type]')) return;
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
    if (viewPickerOpen) setTimeout(() => searchInputRef.current?.focus(), 60);
  }, [viewPickerOpen]);

  useEffect(() => {
    if (historyOpen) setTimeout(() => historyInputRef.current?.focus(), 60);
  }, [historyOpen]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault(); handleOpenViewPicker();
      }
      if (e.metaKey && e.key.toLowerCase() === 'o' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault(); handleOpenHistory();
      }
      if (e.metaKey && e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault(); onAddBrowser();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleOpenViewPicker, handleOpenHistory, onAddBrowser]);

  useEffect(() => {
    if (!historyOpen) return;
    const timer = setTimeout(() => {
      dispatch(GET_HISTORY({ q: historyQuery, limit: HISTORY_PAGE_SIZE, offset: 0 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [historyQuery, historyOpen, dispatch, dashboardId]);

  const handleHistoryScroll = useCallback(() => {
    const el = historyListRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) handleHistoryLoadMore();
  }, [handleHistoryLoadMore]);

  return {
    c, containerRef, searchInputRef, historyInputRef, historyListRef,
    mode, setMode, model, setModel, viewPickerOpen, viewSearch, setViewSearch,
    historyOpen, historyQuery, setHistoryQuery, historySearch: historySearchState,
    outputList, filteredOutputs, shortcutLabel, isExpanded, handleSend, handleDismiss,
    handleSelectView, handleOpenViewPicker, handleOpenHistory,
    handleHistorySelect, handleHistoryScroll,
  };
}
