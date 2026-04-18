import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { setBrowserCardPosition, setBrowserCardSize, updateBrowserTabUrl, type BrowserTab } from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useBrowserActivity } from '@/shared/useBrowserActivity';
import { resolveInput, isGoogleSearch } from '@/shared/resolveUrl';
import BrowserAgentOverlay from './components/BrowserAgentOverlay/BrowserAgentOverlay';
import { useOverlayScrollPassthrough } from '../shared/useOverlayScrollPassthrough';
import { useElementSelection } from '@/app/pages/Dashboard/_shared/element_selection/useElementSelection';
import { type ResizeDir, CURSOR_MAP, HANDLE_DEFS, DRAG_THRESHOLD } from '../shared/cardLayoutConstants';
import { useWebviewLifecycle, isElectron, chromeUserAgent, webviewPreloadPath, type WebviewElement } from './hooks/useWebviewLifecycle';
import type { TabLocalState } from './TabLocalState';
import BrowserTabBar from './components/BrowserTabBar';
import BrowserNavBar from './components/BrowserNavBar';
import BrowserActionOverlay from './components/BrowserActionOverlay';

const MIN_W = 400, MIN_H = 300;

interface Props {
  browserId: string; tabs: BrowserTab[]; activeTabId: string;
  cardX: number; cardY: number; cardWidth: number; cardHeight: number;
  zoom?: number; cmdHeld?: boolean; isSelected?: boolean; isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onDragMove?: (dx: number, dy: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  cardZOrder?: number; onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
}

const BrowserCard: React.FC<Props> = ({
  browserId, tabs, activeTabId, cardX, cardY, cardWidth, cardHeight, zoom = 1, cmdHeld = false,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  cardZOrder = 0, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;
  const browserAgentSession = useAppSelector((state) => {
    const matches = Object.values(state.agents.sessions).filter(
      (s) => s.browser_id === browserId && s.mode === 'browser-agent'
        && ['running', 'completed', 'error', 'stopped'].includes(s.status));
    return matches.find((s) => s.status === 'running') ?? matches[matches.length - 1] ?? null;
  });
  const activity = useBrowserActivity(browserId);
  const agentActive = activity.active || browserAgentSession?.status === 'running';
  const { action: agentAction, lastAction } = activity;
  const [tabLocalStates, setTabLocalStates] = useState<Record<string, TabLocalState>>({});
  const updateTabLocal = useCallback((tabId: string, update: Partial<TabLocalState>) => {
    setTabLocalStates((prev) => ({ ...prev, [tabId]: { loading: false, canGoBack: false, canGoForward: false, ...prev[tabId], ...update } }));
  }, []);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeUrl = activeTab?.url || '', activeTitle = activeTab?.title || '';
  const activeLocal = tabLocalStates[activeTabId] || { loading: false, canGoBack: false, canGoForward: false };
  const [urlBarValue, setUrlBarValue] = useState(activeUrl);
  useEffect(() => { setUrlBarValue(activeUrl); }, [activeUrl, activeTabId]);
  const webviewMap = useWebviewLifecycle(browserId, tabs, activeTabId, updateTabLocal);
  const navigate = useCallback((targetUrl: string) => {
    const finalUrl = resolveInput(targetUrl);
    setUrlBarValue(finalUrl);
    const wv = webviewMap.current.get(activeTabId);
    if (isElectron && wv) wv.loadURL(finalUrl).catch((err: Error) => { if (!err.message?.includes('ERR_ABORTED')) console.error('Navigation failed:', err); });
    dispatch(updateBrowserTabUrl({ browserId, tabId: activeTabId, url: finalUrl }));
  }, [browserId, activeTabId, dispatch]);
  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); navigate(urlBarValue); } }, [navigate, urlBarValue]);
  const handleBack = useCallback((e: React.MouseEvent) => { e.stopPropagation(); webviewMap.current.get(activeTabId)?.goBack(); }, [activeTabId]);
  const handleForward = useCallback((e: React.MouseEvent) => { e.stopPropagation(); webviewMap.current.get(activeTabId)?.goForward(); }, [activeTabId]);
  const handleRefresh = useCallback((e: React.MouseEvent) => { e.stopPropagation(); webviewMap.current.get(activeTabId)?.reload(); }, [activeTabId]);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false), justDraggedRef = useRef(false);
  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
    didDrag.current = false; setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onDragStart?.(browserId, 'browser');
  }, [cardX, cardY, onDragStart, browserId]);
  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX, rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const dx = rawDx / zoom, dy = rawDy / zoom;
    setLocalDragPos({ x: dragState.current.origX + dx, y: dragState.current.origY + dy }); onDragMove?.(dx, dy);
  }, [zoom, onDragMove]);
  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = (e.clientX - dragState.current.startX) / zoom, dy = (e.clientY - dragState.current.startY) / zoom;
    if (didDrag.current) {
      dispatch(setBrowserCardPosition({ browserId, x: dragState.current.origX + dx, y: dragState.current.origY + dy }));
      justDraggedRef.current = true; requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null; didDrag.current = false; setLocalDragPos(null); setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [zoom, dispatch, browserId, onDragEnd]);
  const resizeRef = useRef<{ dir: ResizeDir; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const handleResizeDown = useCallback((dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY, origW: cardWidth, origH: cardHeight };
    setIsResizing(true); (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, cardWidth, cardHeight]);
  const computeResize = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return null;
    const { dir, startX, startY, origX, origY, origW, origH } = resizeRef.current;
    const dx = (e.clientX - startX) / zoom, dy = (e.clientY - startY) / zoom;
    let newX = origX, newY = origY, newW = origW, newH = origH;
    if (dir.includes('e')) newW = origW + dx;
    if (dir.includes('w')) { newW = origW - dx; newX = origX + dx; }
    if (dir.includes('s')) newH = origH + dy;
    if (dir.includes('n')) { newH = origH - dy; newY = origY + dy; }
    if (newW < MIN_W) { if (dir.includes('w')) newX = origX + origW - MIN_W; newW = MIN_W; }
    if (newH < MIN_H) { if (dir.includes('n')) newY = origY + origH - MIN_H; newH = MIN_H; }
    return { x: newX, y: newY, w: newW, h: newH };
  }, [zoom]);
  const handleResizeMove = useCallback((e: React.PointerEvent) => { const r = computeResize(e); if (r) setLocalResize(r); }, [computeResize]);
  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = computeResize(e);
    if (r) { dispatch(setBrowserCardPosition({ browserId, x: r.x, y: r.y })); dispatch(setBrowserCardSize({ browserId, width: r.w, height: r.h })); }
    resizeRef.current = null; setLocalResize(null); setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, browserId]);
  const md = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta : null;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + (md?.dx ?? 0));
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + (md?.dy ?? 0));
  const displayW = localResize?.w ?? cardWidth, displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);
  const isSecure = activeUrl.startsWith('https://'), isSearch = isGoogleSearch(activeUrl);
  const accentColor = c.accent.primary, accentHover = c.accent.hover;
  const accentRgb = accentColor.replace('#', '').match(/.{2}/g)?.map(h => parseInt(h, 16)).join(',') || '189,100,57';
  const glowingBrowserCards = useAppSelector((s) => s.dashboardLayout.glowingBrowserCards);
  const showGlow = !!glowingBrowserCards[browserId];
  const agentBorder = isHighlighted ? `2px solid ${c.accent.primary}` : agentActive ? `2px solid ${accentColor}` : showGlow ? `2px solid ${accentColor}` : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`;
  const innerGlow = showGlow && !agentActive ? `, inset 0 0 30px ${accentColor}25, inset 0 0 60px ${accentColor}10` : '';
  const agentShadow = isHighlighted ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
    : agentActive ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15`
    : showGlow ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15${innerGlow}`
    : (isDragging || isResizing) ? c.shadow.lg : isSelected ? `0 0 0 1px #3b82f6, ${c.shadow.md}` : c.shadow.md;

  return (
    <Box data-select-type="browser-card" data-select-id={browserId}
      data-select-meta={JSON.stringify({ name: activeTitle || 'Browser', url: activeUrl })}
      onPointerDownCapture={() => onBringToFront?.(browserId, 'browser')}
      onClick={(e: React.MouseEvent) => { if (justDraggedRef.current) return; onCardSelect?.(browserId, 'browser', e.shiftKey); }}
      sx={{
        position: 'absolute', left: displayX, top: displayY, width: displayW, height: displayH,
        borderRadius: `${c.radius.lg}px`, border: agentBorder, bgcolor: c.bg.surface, boxShadow: agentShadow,
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.4s ease, border 0.3s ease',
        '&:hover .resize-handle': { opacity: 1 },
        ...(isHighlighted && {
          animation: 'card-highlight-pulse 2s ease-out forwards',
          '@keyframes card-highlight-pulse': {
            '0%': { boxShadow: `0 0 0 3px ${c.accent.primary}70, 0 0 24px ${c.accent.primary}50, 0 0 48px ${c.accent.primary}25` },
            '25%': { boxShadow: `0 0 0 4px ${c.accent.primary}55, 0 0 30px ${c.accent.primary}40, 0 0 56px ${c.accent.primary}20` },
            '50%': { boxShadow: `0 0 0 3px ${c.accent.primary}45, 0 0 22px ${c.accent.primary}30, 0 0 44px ${c.accent.primary}15` },
            '75%': { boxShadow: `0 0 0 2px ${c.accent.primary}25, 0 0 14px ${c.accent.primary}18, 0 0 28px ${c.accent.primary}08` },
            '100%': { boxShadow: c.shadow.md },
          },
        }),
        ...(!isHighlighted && (agentActive || showGlow) && {
          animation: `agent-glow-${browserId} 2s ease-in-out infinite`,
          [`@keyframes agent-glow-${browserId}`]: {
            '0%, 100%': { boxShadow: `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15${innerGlow}` },
            '50%': { boxShadow: `0 0 0 3px ${accentColor}60, 0 0 28px ${accentColor}45, 0 0 56px ${accentColor}25${innerGlow}` },
          },
        }),
      }}
    >
      {isSelected && (
        <Box ref={scrollOverlayRef} onPointerDown={handleDragPointerDown} onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onClick={(e: React.MouseEvent) => { if (justDraggedRef.current) return; onCardSelect?.(browserId, 'browser', e.shiftKey); }}
          sx={{ position: 'absolute', inset: 0, zIndex: 15, cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        />
      )}
      {showGlow && !agentActive && (
        <Box sx={{ position: 'absolute', inset: 0, borderRadius: 'inherit', zIndex: 20, pointerEvents: 'none', overflow: 'hidden', padding: '3px',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'exclude', WebkitMaskComposite: 'xor',
          '&::before': { content: '""', position: 'absolute', inset: '-50%', background: `conic-gradient(from 0deg, transparent 0%, ${accentColor} 25%, transparent 50%, ${accentColor} 75%, transparent 100%)`, animation: 'rotate-glow 3s linear infinite' },
          '@keyframes rotate-glow': { '100%': { transform: 'rotate(360deg)' } },
        }} />
      )}
      {agentActive && <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', zIndex: 20,
        background: `linear-gradient(90deg, transparent, ${accentColor}, ${accentHover}, ${accentColor}, transparent)`,
        backgroundSize: '200% 100%', animation: 'border-shimmer 2s linear infinite',
        '@keyframes border-shimmer': { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
      }} />}
      <BrowserTabBar tabs={tabs} activeTabId={activeTabId} browserId={browserId} tabLocalStates={tabLocalStates}
        accentColor={accentColor} agentActive={agentActive} isDragging={isDragging}
        onDragPointerDown={handleDragPointerDown} onDragPointerMove={handleDragPointerMove} onDragPointerUp={handleDragPointerUp} />
      <BrowserNavBar canGoBack={activeLocal.canGoBack} canGoForward={activeLocal.canGoForward}
        urlBarValue={urlBarValue} isSecure={isSecure} isSearch={isSearch} loading={activeLocal.loading}
        agentActive={agentActive} agentAction={agentAction} accentColor={accentColor}
        onUrlChange={setUrlBarValue} onUrlKeyDown={handleUrlKeyDown}
        onBack={handleBack} onForward={handleForward} onRefresh={handleRefresh} />
      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {isElementSelectMode && <Box sx={{ position: 'absolute', inset: 0, zIndex: 10 }} />}
        {cmdHeld && !isSelected && <Box sx={{ position: 'absolute', inset: 0, zIndex: 12 }} />}
        {isElectron ? tabs.map((tab) => (
          <webview key={tab.id}
            ref={(el: any) => { if (el) webviewMap.current.set(tab.id, el as unknown as WebviewElement); else webviewMap.current.delete(tab.id); }}
            data-tab-id={tab.id} src="about:blank" allowpopups="true" useragent={chromeUserAgent}
            {...(webviewPreloadPath ? { preload: webviewPreloadPath } : {})}
            webpreferences="plugins=yes, autoplayPolicy=no-user-gesture-required"
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none',
              visibility: tab.id === activeTabId ? 'visible' : 'hidden', zIndex: tab.id === activeTabId ? 1 : 0 }}
          />
        )) : (
          <Box sx={{ width: '100%', height: '100%', position: 'relative' }}>
            <iframe src={activeUrl} sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              style={{ width: '100%', height: '100%', border: 'none' }} title="Browser" />
            <Box sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, bgcolor: c.status.warningBg,
              borderTop: `1px solid ${c.status.warning}`, px: 1.5, py: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography sx={{ fontSize: '0.68rem', color: c.status.warning }}>
                iframe mode — some sites may not load. Use the Electron build for full browser support.
              </Typography>
            </Box>
          </Box>
        )}
        <BrowserActionOverlay agentAction={agentAction} lastAction={lastAction} actionSeq={activity.actionSeq}
          coords={activity.coords ?? undefined} accentColor={accentColor} accentRgb={accentRgb}
          showGlow={showGlow} agentActive={agentActive} browserId={browserId}
          showFrostedOverlay={agentActive && !browserAgentSession} />
        {browserAgentSession && <BrowserAgentOverlay session={browserAgentSession} browserWidth={displayW} browserHeight={displayH} />}
      </Box>
      {HANDLE_DEFS.map(({ dir, sx }) => (
        <Box key={dir} className="resize-handle" onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove} onPointerUp={handleResizeUp}
          sx={{ position: 'absolute', cursor: CURSOR_MAP[dir], opacity: 0, zIndex: 10, ...sx }} />
      ))}
    </Box>
  );
};

export default React.memo(BrowserCard);
