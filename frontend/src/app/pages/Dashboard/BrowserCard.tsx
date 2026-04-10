import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import Fade from '@mui/material/Fade';
import LanguageIcon from '@mui/icons-material/Language';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import LockIcon from '@mui/icons-material/Lock';
import SearchIcon from '@mui/icons-material/Search';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import {
  setBrowserCardPosition,
  setBrowserCardSize,
  removeBrowserCard,
  addBrowserTab,
  removeBrowserTab,
  setActiveBrowserTab,
  updateBrowserTabUrl,
  updateBrowserTabTitle,
  updateBrowserTabFavicon,
  reorderBrowserTab,
  type BrowserTab,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { handleApproval } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  registerWebview,
  unregisterWebview,
  setActiveTab as setRegistryActiveTab,
  type BrowserWebview,
} from '@/shared/browserRegistry';
import { useBrowserActivity } from '@/shared/useBrowserActivity';
import { getActionLabel } from '@/shared/browserCommandHandler';
import { resolveInput, isGoogleSearch } from '@/shared/resolveUrl';
import BrowserAgentOverlay from './BrowserAgentOverlay';
import { useOverlayScrollPassthrough } from './useOverlayScrollPassthrough';
import { useElementSelection } from '@/app/components/ElementSelectionContext';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;
const MIN_W = 400;
const MIN_H = 300;

const CURSOR_MAP: Record<ResizeDir, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};

const HANDLE_DEFS: { dir: ResizeDir; sx: Record<string, any> }[] = [
  { dir: 'n',  sx: { top: -EDGE_THICKNESS / 2, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_THICKNESS } },
  { dir: 's',  sx: { bottom: -EDGE_THICKNESS / 2, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_THICKNESS } },
  { dir: 'w',  sx: { left: -EDGE_THICKNESS / 2, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_THICKNESS } },
  { dir: 'e',  sx: { right: -EDGE_THICKNESS / 2, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_THICKNESS } },
  { dir: 'nw', sx: { top: -EDGE_THICKNESS / 2, left: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
  { dir: 'ne', sx: { top: -EDGE_THICKNESS / 2, right: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
  { dir: 'sw', sx: { bottom: -EDGE_THICKNESS / 2, left: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
  { dir: 'se', sx: { bottom: -EDGE_THICKNESS / 2, right: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
];

const isElectron = navigator.userAgent.includes('Electron');

const chromeUserAgent = navigator.userAgent
  .replace(/\s*Electron\/\S+/, '')
  .replace(/\s*OpenSwarm\/\S+/, '');

const webviewPreloadPath: string | undefined = isElectron
  ? (window as any).openswarm?.getWebviewPreloadPath?.()
  : undefined;

type WebviewElement = BrowserWebview;

interface TabLocalState {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface Props {
  browserId: string;
  tabs: BrowserTab[];
  activeTabId: string;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  cmdHeld?: boolean;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  cardZOrder?: number;
  onDoubleClick?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
}


const BrowserCard: React.FC<Props> = ({
  browserId, tabs, activeTabId, cardX, cardY, cardWidth, cardHeight, zoom = 1, panX = 0, panY = 0, cmdHeld = false,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  cardZOrder = 0, onDoubleClick, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;

  const browserAgentSession = useAppSelector((state) => {
    const sessions = state.agents.sessions;
    const matches = Object.values(sessions).filter(
      (s) => s.browser_id === browserId && s.mode === 'browser-agent'
        && (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'completed' || s.status === 'error' || s.status === 'stopped'),
    );
    return matches.find((s) => s.status === 'running' || s.status === 'waiting_approval') ?? matches[matches.length - 1] ?? null;
  });

  const activity = useBrowserActivity(browserId);
  const agentRunning = browserAgentSession?.status === 'running';
  const agentActive = activity.active || agentRunning;
  const agentAction = activity.action;
  const lastAction = activity.lastAction;

  const [tabLocalStates, setTabLocalStates] = useState<Record<string, TabLocalState>>({});
  const updateTabLocal = useCallback((tabId: string, update: Partial<TabLocalState>) => {
    setTabLocalStates((prev) => {
      const existing = prev[tabId] ?? { loading: false, canGoBack: false, canGoForward: false };
      return {
        ...prev,
        [tabId]: { ...existing, ...update },
      };
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeUrl = activeTab?.url || '';
  const activeTitle = activeTab?.title || '';
  const activeLocal = tabLocalStates[activeTabId] || { loading: false, canGoBack: false, canGoForward: false };

  const [urlBarValue, setUrlBarValue] = useState(activeUrl);
  useEffect(() => {
    setUrlBarValue(activeUrl);
  }, [activeUrl, activeTabId]);

  // ---- Webview ref management ----
  const webviewMap = useRef<Map<string, WebviewElement>>(new Map());
  const initializedTabs = useRef(new Set<string>());
  const tabBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRegistryActiveTab(browserId, activeTabId);
  }, [browserId, activeTabId]);

  const tabIdKey = tabs.map((t) => t.id).join(',');
  useEffect(() => {
    if (!isElectron) return;
    const cleanups: (() => void)[] = [];

    for (const tab of tabs) {
      const wv = webviewMap.current.get(tab.id);
      if (!wv) continue;
      const tabId = tab.id;

      registerWebview(browserId, tabId, wv);

      if (!initializedTabs.current.has(tabId)) {
        initializedTabs.current.add(tabId);
        const targetUrl = tab.url;
        const doLoad = () => {
          wv.loadURL(targetUrl).catch(() => {});
        };
        wv.addEventListener('dom-ready', doLoad, { once: true });
        cleanups.push(() => wv.removeEventListener('dom-ready', doLoad));
      }

      const onNavigate = () => {
        const newUrl = wv.getURL();
        dispatch(updateBrowserTabUrl({ browserId, tabId, url: newUrl }));
        updateTabLocal(tabId, {
          canGoBack: wv.canGoBack(),
          canGoForward: wv.canGoForward(),
        });
      };

      const onTitleUpdate = () => {
        dispatch(updateBrowserTabTitle({ browserId, tabId, title: wv.getTitle() }));
      };

      const onLoadStart = () => updateTabLocal(tabId, { loading: true });
      const onLoadStop = () => {
        updateTabLocal(tabId, { loading: false });
        onNavigate();
        onTitleUpdate();
      };

      const onFaviconUpdate = (e: any) => {
        const favicons = e.favicons || (e.detail && e.detail.favicons);
        if (favicons?.[0]) {
          dispatch(updateBrowserTabFavicon({ browserId, tabId, favicon: favicons[0] }));
        }
      };

      wv.addEventListener('did-navigate', onNavigate);
      wv.addEventListener('did-navigate-in-page', onNavigate);
      wv.addEventListener('page-title-updated', onTitleUpdate);
      wv.addEventListener('did-start-loading', onLoadStart);
      wv.addEventListener('did-stop-loading', onLoadStop);
      wv.addEventListener('page-favicon-updated', onFaviconUpdate);

      cleanups.push(() => {
        unregisterWebview(browserId, tabId);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
        wv.removeEventListener('page-title-updated', onTitleUpdate);
        wv.removeEventListener('did-start-loading', onLoadStart);
        wv.removeEventListener('did-stop-loading', onLoadStop);
        wv.removeEventListener('page-favicon-updated', onFaviconUpdate);
      });
    }

    return () => cleanups.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdKey, browserId, dispatch, updateTabLocal]);

  // ---- Navigation (active tab) ----
  const navigate = useCallback((targetUrl: string) => {
    const finalUrl = resolveInput(targetUrl);
    setUrlBarValue(finalUrl);
    const wv = webviewMap.current.get(activeTabId);
    if (isElectron && wv) {
      wv.loadURL(finalUrl).catch((err: Error) => {
        if (!err.message?.includes('ERR_ABORTED')) console.error('Navigation failed:', err);
      });
    }
    dispatch(updateBrowserTabUrl({ browserId, tabId: activeTabId, url: finalUrl }));
  }, [browserId, activeTabId, dispatch]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(urlBarValue);
    }
  }, [navigate, urlBarValue]);

  const handleBack = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewMap.current.get(activeTabId)?.goBack();
  }, [activeTabId]);

  const handleForward = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewMap.current.get(activeTabId)?.goForward();
  }, [activeTabId]);

  const handleRefresh = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewMap.current.get(activeTabId)?.reload();
  }, [activeTabId]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(removeBrowserCard(browserId));
  }, [dispatch, browserId]);

  // ---- Tab management ----
  const handleAddTab = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(addBrowserTab({ browserId, url: browserHomepage }));
  }, [dispatch, browserId, browserHomepage]);

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(removeBrowserTab({ browserId, tabId }));
  }, [dispatch, browserId]);

  const handleSwitchTab = useCallback((tabId: string) => {
    dispatch(setActiveBrowserTab({ browserId, tabId }));
  }, [dispatch, browserId]);

  // ---- Tab drag reorder ----
  const tabDragRef = useRef<{
    tabId: string;
    startX: number;
    isDragging: boolean;
  } | null>(null);
  const swapCooldown = useRef(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragTabOffset, setDragTabOffset] = useState(0);

  const handleTabPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const tabId = (e.currentTarget as HTMLElement).getAttribute('data-tab-id');
    if (!tabId) return;
    tabDragRef.current = { tabId, startX: e.clientX, isDragging: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleTabPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.isDragging && Math.abs(dx) < 5) return;
    drag.isDragging = true;
    setDragTabId(drag.tabId);
    setDragTabOffset(dx);

    if (swapCooldown.current) return;
    const bar = tabBarRef.current;
    if (!bar) return;

    const draggedEl = bar.querySelector(`[data-tab-id="${drag.tabId}"]`) as HTMLElement | null;
    if (!draggedEl) return;
    const rect = draggedEl.getBoundingClientRect();
    const center = rect.left + rect.width / 2 + dx;
    const currentIdx = tabs.findIndex((t) => t.id === drag.tabId);

    if (currentIdx < tabs.length - 1) {
      const nextId = tabs[currentIdx + 1].id;
      const nextEl = bar.querySelector(`[data-tab-id="${nextId}"]`) as HTMLElement | null;
      if (nextEl) {
        const nr = nextEl.getBoundingClientRect();
        if (center > nr.left + nr.width / 2) {
          dispatch(reorderBrowserTab({ browserId, tabId: drag.tabId, toIndex: currentIdx + 1 }));
          drag.startX = e.clientX;
          setDragTabOffset(0);
          swapCooldown.current = true;
          requestAnimationFrame(() => { swapCooldown.current = false; });
        }
      }
    }

    if (currentIdx > 0) {
      const prevId = tabs[currentIdx - 1].id;
      const prevEl = bar.querySelector(`[data-tab-id="${prevId}"]`) as HTMLElement | null;
      if (prevEl) {
        const pr = prevEl.getBoundingClientRect();
        if (center < pr.left + pr.width / 2) {
          dispatch(reorderBrowserTab({ browserId, tabId: drag.tabId, toIndex: currentIdx - 1 }));
          drag.startX = e.clientX;
          setDragTabOffset(0);
          swapCooldown.current = true;
          requestAnimationFrame(() => { swapCooldown.current = false; });
        }
      }
    }
  }, [tabs, browserId, dispatch]);

  const handleTabPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    if (!drag.isDragging) {
      handleSwitchTab(drag.tabId);
    }
    tabDragRef.current = null;
    setDragTabId(null);
    setDragTabOffset(0);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [handleSwitchTab]);

  // ---- Card drag via tab bar background ----
  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });

  const panRef = useRef({ panX, panY });
  panRef.current = { panX, panY };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY, startPanX: panRef.current.panX, startPanY: panRef.current.panY };
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(browserId, 'browser');
  }, [cardX, cardY, onDragStart, browserId]);

  const recomputeDragPos = useCallback(() => {
    const ds = dragState.current;
    if (!ds || !didDrag.current) return;
    const { clientX, clientY } = lastPointerRef.current;
    const rawDx = clientX - ds.startX;
    const rawDy = clientY - ds.startY;
    const z = zoomRef.current;
    const panDx = (panRef.current.panX - ds.startPanX) / z;
    const panDy = (panRef.current.panY - ds.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({ x: ds.origX + dx, y: ds.origY + dy });
    onDragMove?.(dx, dy, clientX, clientY);
  }, [onDragMove]);

  useEffect(() => {
    if (isDragging && didDrag.current) recomputeDragPos();
  }, [panX, panY, isDragging, recomputeDragPos]);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    recomputeDragPos();
  }, [recomputeDragPos]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const z = zoomRef.current;
    const panDx = (panRef.current.panX - dragState.current.startPanX) / z;
    const panDy = (panRef.current.panY - dragState.current.startPanY) / z;
    const dx = (e.clientX - dragState.current.startX) / z - panDx;
    const dy = (e.clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      // Snap to 24px grid (hold Shift to bypass)
      if (!e.shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }
      dispatch(setBrowserCardPosition({
        browserId,
        x: finalX,
        y: finalY,
      }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, browserId, onDragEnd]);

  // ---- Resize ----
  const resizeRef = useRef<{
    dir: ResizeDir; startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        dir, startX: e.clientX, startY: e.clientY,
        origX: cardX, origY: cardY, origW: cardWidth, origH: cardHeight,
      };
      setIsResizing(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [cardX, cardY, cardWidth, cardHeight],
  );

  const computeResize = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return null;
      const { dir, startX, startY, origX, origY, origW, origH } = resizeRef.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      let newX = origX, newY = origY, newW = origW, newH = origH;
      if (dir.includes('e')) newW = origW + dx;
      if (dir.includes('w')) { newW = origW - dx; newX = origX + dx; }
      if (dir.includes('s')) newH = origH + dy;
      if (dir.includes('n')) { newH = origH - dy; newY = origY + dy; }
      if (newW < MIN_W) { if (dir.includes('w')) newX = origX + origW - MIN_W; newW = MIN_W; }
      if (newH < MIN_H) { if (dir.includes('n')) newY = origY + origH - MIN_H; newH = MIN_H; }
      return { x: newX, y: newY, w: newW, h: newH };
    },
    [zoom],
  );

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const result = computeResize(e);
      if (result) setLocalResize(result);
    },
    [computeResize],
  );

  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const result = computeResize(e);
    if (result) {
      dispatch(setBrowserCardPosition({ browserId, x: result.x, y: result.y }));
      dispatch(setBrowserCardSize({ browserId, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, browserId]);

  // ---- Display calculations ----
  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  const isSecure = activeUrl.startsWith('https://');
  const isSearch = isGoogleSearch(activeUrl);

  const accentColor = c.accent.primary;
  const accentHover = c.accent.hover;
  const accentRgb = accentColor.replace('#', '').match(/.{2}/g)?.map(h => parseInt(h, 16)).join(',') || '189,100,57';

  // ---- Glow state ----
  const glowingBrowserCards = useAppSelector((s) => s.dashboardLayout.glowingBrowserCards);
  const isGlowingFromRedux = !!glowingBrowserCards[browserId];

  const showGlow = isGlowingFromRedux;

  const agentBorder = isHighlighted
    ? `2px solid ${c.accent.primary}`
    : agentActive
      ? `2px solid ${accentColor}`
      : showGlow
        ? `2px solid ${accentColor}`
        : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`;

  const innerGlow = showGlow && !agentActive
    ? `, inset 0 0 30px ${accentColor}25, inset 0 0 60px ${accentColor}10`
    : '';

  const agentShadow = isHighlighted
    ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
    : agentActive
      ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15`
      : showGlow
        ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15${innerGlow}`
        : isDragging || isResizing
          ? c.shadow.lg
          : isSelected
            ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
            : c.shadow.md;

  return (
    <Box
      data-select-type="browser-card"
      data-select-id={browserId}
      data-select-meta={JSON.stringify({ name: activeTitle || 'Browser', url: activeUrl })}
      onPointerDownCapture={() => onBringToFront?.(browserId, 'browser')}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(browserId, 'browser', e.shiftKey);
      }}
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onDoubleClick?.(browserId, 'browser');
      }}
      sx={{
        position: 'absolute',
        left: displayX,
        top: displayY,
        width: displayW,
        height: displayH,
        borderRadius: `${c.radius.lg}px`,
        border: agentBorder,
        bgcolor: c.bg.surface,
        boxShadow: agentShadow,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.4s ease, border 0.3s ease',
        '&:hover .resize-handle': { opacity: 1 },
        ...(isHighlighted && {
          animation: 'card-highlight-pulse 2s ease-out forwards',
          '@keyframes card-highlight-pulse': {
            '0%': {
              boxShadow: `0 0 0 3px ${c.accent.primary}70, 0 0 24px ${c.accent.primary}50, 0 0 48px ${c.accent.primary}25`,
            },
            '25%': {
              boxShadow: `0 0 0 4px ${c.accent.primary}55, 0 0 30px ${c.accent.primary}40, 0 0 56px ${c.accent.primary}20`,
            },
            '50%': {
              boxShadow: `0 0 0 3px ${c.accent.primary}45, 0 0 22px ${c.accent.primary}30, 0 0 44px ${c.accent.primary}15`,
            },
            '75%': {
              boxShadow: `0 0 0 2px ${c.accent.primary}25, 0 0 14px ${c.accent.primary}18, 0 0 28px ${c.accent.primary}08`,
            },
            '100%': {
              boxShadow: c.shadow.md,
            },
          },
        }),
        ...(!isHighlighted && (agentActive || showGlow) && {
          animation: `agent-glow-${browserId} 2s ease-in-out infinite`,
          [`@keyframes agent-glow-${browserId}`]: {
            '0%, 100%': {
              boxShadow: `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15${innerGlow}`,
            },
            '50%': {
              boxShadow: `0 0 0 3px ${accentColor}60, 0 0 28px ${accentColor}45, 0 0 56px ${accentColor}25${innerGlow}`,
            },
          },
        }),
      }}
    >
      {/* Selection overlay – only covers header area so webview stays interactive */}

      {/* Rotating gradient border glow for element selection / streaming */}
      {showGlow && !agentActive && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            zIndex: 20,
            pointerEvents: 'none',
            overflow: 'hidden',
            padding: '3px',
            mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
            WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
            maskComposite: 'exclude',
            WebkitMaskComposite: 'xor',
            '&::before': {
              content: '""',
              position: 'absolute',
              inset: '-50%',
              background: `conic-gradient(from 0deg, transparent 0%, ${accentColor} 25%, transparent 50%, ${accentColor} 75%, transparent 100%)`,
              animation: 'rotate-glow 3s linear infinite',
            },
            '@keyframes rotate-glow': {
              '100%': { transform: 'rotate(360deg)' },
            },
          }}
        />
      )}

      {/* Animated border glow (top edge overlay) */}
      {agentActive && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '2px',
            zIndex: 20,
            background: `linear-gradient(90deg, transparent, ${accentColor}, ${accentHover}, ${accentColor}, transparent)`,
            backgroundSize: '200% 100%',
            animation: 'border-shimmer 2s linear infinite',
            '@keyframes border-shimmer': {
              '0%': { backgroundPosition: '200% 0' },
              '100%': { backgroundPosition: '-200% 0' },
            },
          }}
        />
      )}

      {/* ====== Tab bar / drag handle ====== */}
      <Box
        ref={tabBarRef}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        sx={{
          position: 'relative',
          zIndex: 16,
          display: 'flex',
          alignItems: 'stretch',
          bgcolor: agentActive ? `${accentColor}0a` : c.bg.secondary,
          borderBottom: `1px solid ${agentActive ? `${accentColor}30` : c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          flexShrink: 0,
          minHeight: 34,
          userSelect: 'none',
          transition: 'background 0.3s ease',
          overflow: 'hidden',
        }}
      >
        {/* Scrollable tab strip */}
        <Box
          sx={{
            display: 'flex',
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isBeingDragged = tab.id === dragTabId;
            const tls = tabLocalStates[tab.id];

            return (
              <Box
                key={tab.id}
                data-tab-id={tab.id}
                onPointerDown={handleTabPointerDown}
                onPointerMove={handleTabPointerMove}
                onPointerUp={handleTabPointerUp}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1,
                  minWidth: 0,
                  maxWidth: 180,
                  flex: '0 1 180px',
                  position: 'relative',
                  borderRight: `1px solid ${c.border.subtle}`,
                  bgcolor: isActive ? c.bg.surface : 'transparent',
                  cursor: isBeingDragged ? 'grabbing' : 'pointer',
                  transform: isBeingDragged ? `translateX(${dragTabOffset}px)` : 'none',
                  transition: isBeingDragged ? 'none' : 'background 0.15s ease, transform 0.2s ease',
                  zIndex: isBeingDragged ? 10 : 1,
                  '&:hover': { bgcolor: isActive ? c.bg.surface : c.bg.secondary },
                  '&:hover .tab-close': { opacity: 1 },
                  ...(isActive && {
                    '&::after': {
                      content: '""',
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: '2px',
                      bgcolor: accentColor,
                    },
                  }),
                }}
              >
                {/* Favicon / loading spinner */}
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, width: 14, height: 14, justifyContent: 'center' }}>
                  {tls?.loading ? (
                    <CircularProgress size={10} thickness={5} sx={{ color: accentColor }} />
                  ) : tab.favicon ? (
                    <Box
                      component="img"
                      src={tab.favicon}
                      sx={{ width: 14, height: 14, borderRadius: '2px' }}
                      onError={(e: any) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <LanguageIcon sx={{ fontSize: 13, color: isActive ? accentColor : c.text.ghost }} />
                  )}
                </Box>

                {/* Title */}
                <Typography
                  sx={{
                    flex: 1,
                    fontSize: '0.7rem',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? c.text.primary : c.text.muted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    lineHeight: 1.2,
                  }}
                >
                  {tab.title || 'New Tab'}
                </Typography>

                {/* Close tab */}
                <Box
                  className="tab-close"
                  onClick={(e: React.MouseEvent) => handleCloseTab(tab.id, e)}
                  onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: '4px',
                    flexShrink: 0,
                    opacity: isActive ? 0.6 : 0,
                    cursor: 'pointer',
                    transition: 'opacity 0.15s, background 0.15s',
                    '&:hover': { bgcolor: `${c.text.muted}25`, opacity: 1 },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 10, color: c.text.muted }} />
                </Box>
              </Box>
            );
          })}

          {/* Add tab (+) button */}
          <Box
            onClick={handleAddTab}
            onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              flexShrink: 0,
              cursor: 'pointer',
              borderRadius: '4px',
              mx: 0.25,
              my: 0.5,
              transition: 'background 0.15s',
              '&:hover': { bgcolor: `${c.text.muted}15` },
            }}
          >
            <AddIcon sx={{ fontSize: 15, color: c.text.muted }} />
          </Box>
        </Box>

        {/* Right side controls */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 0.5, flexShrink: 0 }}>
          {/* Agent activity badge */}
          {agentActive && (
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.75,
                py: 0.25,
                borderRadius: '6px',
                bgcolor: `${accentColor}18`,
                border: `1px solid ${accentColor}30`,
                animation: 'badge-fade-in 0.25s ease-out',
                '@keyframes badge-fade-in': {
                  '0%': { opacity: 0, transform: 'scale(0.85)' },
                  '100%': { opacity: 1, transform: 'scale(1)' },
                },
              }}
            >
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: accentColor,
                  animation: 'badge-dot-pulse 1.4s ease-in-out infinite',
                  '@keyframes badge-dot-pulse': {
                    '0%, 100%': { opacity: 0.5, transform: 'scale(0.8)' },
                    '50%': { opacity: 1, transform: 'scale(1.3)' },
                  },
                }}
              />
              <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: accentColor, lineHeight: 1 }}>
                AI
              </Typography>
            </Box>
          )}

          <Tooltip title="Close browser" placement="top">
            <IconButton
              size="small"
              onClick={handleRemove}
              onPointerDown={(e) => e.stopPropagation()}
              sx={{ color: c.text.ghost, p: 0.4, '&:hover': { color: c.status.error } }}
            >
              <CloseIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* ====== Navigation bar ====== */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.5,
          py: 0.25,
          bgcolor: c.bg.page,
          borderBottom: `1px solid ${c.border.subtle}`,
          flexShrink: 0,
        }}
      >
        <Tooltip title="Back" placement="top">
          <span>
            <IconButton
              size="small"
              onClick={handleBack}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!activeLocal.canGoBack}
              sx={{ color: c.text.muted, p: 0.4, '&:hover': { color: c.text.primary } }}
            >
              <ArrowBackIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Forward" placement="top">
          <span>
            <IconButton
              size="small"
              onClick={handleForward}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!activeLocal.canGoForward}
              sx={{ color: c.text.muted, p: 0.4, '&:hover': { color: c.text.primary } }}
            >
              <ArrowForwardIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Reload" placement="top">
          <IconButton
            size="small"
            onClick={handleRefresh}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.muted, p: 0.4, '&:hover': { color: c.text.primary } }}
          >
            <RefreshIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>

        {/* URL bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            gap: 0.5,
            ml: 0.5,
            px: 1,
            py: 0.2,
            bgcolor: c.bg.secondary,
            borderRadius: `${c.radius.md}px`,
            border: `1px solid ${c.border.subtle}`,
          }}
        >
          {isSearch ? (
            <SearchIcon sx={{ fontSize: 13, color: c.text.muted, flexShrink: 0 }} />
          ) : isSecure ? (
            <LockIcon sx={{ fontSize: 12, color: c.status.success, flexShrink: 0 }} />
          ) : null}
          <InputBase
            value={urlBarValue}
            onChange={(e) => setUrlBarValue(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            placeholder="Search Google or enter URL..."
            sx={{
              flex: 1,
              fontSize: '0.74rem',
              fontFamily: c.font.mono,
              color: c.text.secondary,
              py: 0,
              '& input': { py: '2px' },
              '& input::placeholder': { color: c.text.ghost, opacity: 1 },
            }}
          />
        </Box>
      </Box>

      {/* Loading indicator */}
      {(activeLocal.loading || (agentActive && agentAction === 'navigate')) && (
        <LinearProgress
          sx={{
            height: 2,
            flexShrink: 0,
            bgcolor: 'transparent',
            '& .MuiLinearProgress-bar': {
              bgcolor: agentActive ? accentColor : c.accent.primary,
            },
          }}
        />
      )}

      {/* ====== Browser body — multiple webviews stacked ====== */}
      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {isElementSelectMode && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }} />
        )}
        {cmdHeld && !isSelected && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 12, pointerEvents: 'none' }} />
        )}
        {isElectron ? (
          tabs.map((tab) => (
            <webview
              key={tab.id}
              ref={(el: any) => {
                if (el) webviewMap.current.set(tab.id, el as unknown as WebviewElement);
                else webviewMap.current.delete(tab.id);
              }}
              data-tab-id={tab.id}
              src="about:blank"
              allowpopups="true"
              useragent={chromeUserAgent}
              {...(webviewPreloadPath ? { preload: webviewPreloadPath } : {})}
              webpreferences="plugins=yes, autoplayPolicy=no-user-gesture-required"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                border: 'none',
                visibility: tab.id === activeTabId ? 'visible' : 'hidden',
                zIndex: tab.id === activeTabId ? 1 : 0,
              }}
            />
          ))
        ) : (
          <Box sx={{ width: '100%', height: '100%', position: 'relative' }}>
            <iframe
              src={activeUrl}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              style={{ width: '100%', height: '100%', border: 'none' }}
              title="Browser"
            />
            <Box
              sx={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                bgcolor: `${c.status.warningBg}`,
                borderTop: `1px solid ${c.status.warning}`,
                px: 1.5,
                py: 0.5,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
              }}
            >
              <Typography sx={{ fontSize: '0.68rem', color: c.status.warning }}>
                iframe mode — some sites may not load. Use the Electron build for full browser support.
              </Typography>
            </Box>
          </Box>
        )}

        {/* ===== Action micro-animations ===== */}

        {/* Camera flash — screenshot */}
        {(agentAction === 'screenshot' || lastAction === 'screenshot') && (
          <Box
            key={`flash-${activity.actionSeq}`}
            sx={{
              position: 'absolute',
              inset: 0,
              bgcolor: '#fff',
              pointerEvents: 'none',
              zIndex: 15,
              animation: 'camera-flash 0.4s ease-out forwards',
              '@keyframes camera-flash': {
                '0%': { opacity: 0.45 },
                '100%': { opacity: 0 },
              },
            }}
          />
        )}

        {/* Scanning line — get_text */}
        {agentAction === 'get_text' && (
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: '3px',
              zIndex: 15,
              pointerEvents: 'none',
              background: `linear-gradient(180deg, transparent, ${accentColor}90, transparent)`,
              boxShadow: `0 0 12px ${accentColor}60`,
              animation: 'scan-sweep 1.5s ease-in-out infinite alternate',
              '@keyframes scan-sweep': {
                '0%': { top: '0%' },
                '100%': { top: 'calc(100% - 3px)' },
              },
            }}
          />
        )}

        {/* Click ripple */}
        {(agentAction === 'click' || lastAction === 'click') && (
          <Box
            key={`ripple-${activity.actionSeq}`}
            sx={{
              position: 'absolute',
              top: `${(activity.coords?.yPercent ?? 0.5) * 100}%`,
              left: `${(activity.coords?.xPercent ?? 0.5) * 100}%`,
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: `2px solid ${accentColor}`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 15,
              animation: 'click-ripple 0.5s ease-out forwards',
              '@keyframes click-ripple': {
                '0%': { opacity: 0.8, width: 10, height: 10, borderWidth: '2px' },
                '100%': { opacity: 0, width: 60, height: 60, borderWidth: '1px' },
              },
            }}
          />
        )}

        {/* Typing indicator */}
        {agentAction === 'type' && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              gap: '4px',
              alignItems: 'center',
              px: 1,
              py: 0.5,
              borderRadius: '8px',
              bgcolor: `${accentColor}20`,
              border: `1px solid ${accentColor}40`,
              zIndex: 15,
              pointerEvents: 'none',
            }}
          >
            {[0, 1, 2].map((i) => (
              <Box
                key={i}
                sx={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  bgcolor: accentColor,
                  animation: `typing-dot 1s ease-in-out ${i * 0.15}s infinite`,
                  '@keyframes typing-dot': {
                    '0%, 60%, 100%': { opacity: 0.3, transform: 'scale(0.8)' },
                    '30%': { opacity: 1, transform: 'scale(1.2)' },
                  },
                }}
              />
            ))}
          </Box>
        )}

        {/* Accent inner shadow overlay for selection / streaming glow */}
        {showGlow && !agentActive && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 14,
              pointerEvents: 'none',
              borderRadius: 'inherit',
              boxShadow: `inset 0 0 40px rgba(${accentRgb},0.35), inset 0 0 80px rgba(${accentRgb},0.15)`,
              animation: `accent-glow-${browserId} 2s ease-in-out infinite`,
              [`@keyframes accent-glow-${browserId}`]: {
                '0%, 100%': {
                  boxShadow: `inset 0 0 40px rgba(${accentRgb},0.35), inset 0 0 80px rgba(${accentRgb},0.15)`,
                },
                '50%': {
                  boxShadow: `inset 0 0 50px rgba(${accentRgb},0.45), inset 0 0 100px rgba(${accentRgb},0.22)`,
                },
              },
            }}
          />
        )}

        {/* ===== Frosted glass overlay ===== */}
        {agentActive && !browserAgentSession && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 16,
              backdropFilter: 'blur(2px)',
              bgcolor: 'rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              animation: 'overlay-fade-in 0.25s ease-out',
              '@keyframes overlay-fade-in': {
                '0%': { opacity: 0 },
                '100%': { opacity: 1 },
              },
            }}
          >
            <CircularProgress
              size={28}
              thickness={3}
              sx={{ color: accentColor }}
            />
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.5,
                py: 0.75,
                borderRadius: '10px',
                bgcolor: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(8px)',
                border: `1px solid ${accentColor}30`,
              }}
            >
              <SmartToyOutlinedIcon sx={{ fontSize: 14, color: accentColor }} />
              <Typography
                sx={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#fff',
                  letterSpacing: '0.02em',
                }}
              >
                {getActionLabel(agentAction ?? '')}
              </Typography>
            </Box>
          </Box>
        )}

        {/* ===== Browser Agent Overlay ===== */}
        {browserAgentSession && (
          <BrowserAgentOverlay
            session={browserAgentSession}
            browserWidth={displayW}
            browserHeight={displayH}
          />
        )}
      </Box>

      {/* Resize handles */}
      {HANDLE_DEFS.map(({ dir, sx }) => (
        <Box
          key={dir}
          className="resize-handle"
          onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          sx={{
            position: 'absolute',
            cursor: CURSOR_MAP[dir],
            opacity: 0,
            zIndex: 10,
            ...sx,
          }}
        />
      ))}
    </Box>
  );
};

export default React.memo(BrowserCard);
