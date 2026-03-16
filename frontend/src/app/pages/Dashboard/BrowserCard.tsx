import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import LanguageIcon from '@mui/icons-material/Language';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import LockIcon from '@mui/icons-material/Lock';
import SearchIcon from '@mui/icons-material/Search';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import {
  setBrowserCardPosition,
  setBrowserCardSize,
  removeBrowserCard,
  updateBrowserCardUrl,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { registerWebview, unregisterWebview, type BrowserWebview } from '@/shared/browserRegistry';
import { useBrowserActivity } from '@/shared/useBrowserActivity';
import { getActionLabel } from '@/shared/browserCommandHandler';
import { resolveInput, isGoogleSearch } from '@/shared/resolveUrl';

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

type WebviewElement = BrowserWebview;

interface Props {
  browserId: string;
  url: string;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  zoom?: number;
  isSelected?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onDragMove?: (dx: number, dy: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
}


const BrowserCard: React.FC<Props> = ({
  browserId, url, cardX, cardY, cardWidth, cardHeight, zoom = 1,
  isSelected = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const webviewRef = useRef<WebviewElement | null>(null);
  const activity = useBrowserActivity(browserId);
  const agentActive = activity.active;
  const agentAction = activity.action;
  const lastAction = activity.lastAction;

  const [currentUrl, setCurrentUrl] = useState(url);
  const [urlBarValue, setUrlBarValue] = useState(url);
  const [pageTitle, setPageTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  // ---- Webview event wiring ----
  useEffect(() => {
    if (!isElectron) return;
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = () => {
      const newUrl = wv.getURL();
      setCurrentUrl(newUrl);
      setUrlBarValue(newUrl);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
      dispatch(updateBrowserCardUrl({ browserId, url: newUrl }));
    };

    const onTitleUpdate = () => {
      setPageTitle(wv.getTitle());
    };

    const onLoadStart = () => setLoading(true);
    const onLoadStop = () => {
      setLoading(false);
      onNavigate();
      onTitleUpdate();
    };

    const onNewWindow = (e: any) => {
      if (e.url) wv.loadURL(e.url);
    };

    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('page-title-updated', onTitleUpdate);
    wv.addEventListener('did-start-loading', onLoadStart);
    wv.addEventListener('did-stop-loading', onLoadStop);
    wv.addEventListener('new-window', onNewWindow);

    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('page-title-updated', onTitleUpdate);
      wv.removeEventListener('did-start-loading', onLoadStart);
      wv.removeEventListener('did-stop-loading', onLoadStop);
      wv.removeEventListener('new-window', onNewWindow);
    };
  }, [browserId, dispatch]);

  useEffect(() => {
    if (!isElectron) return;
    const wv = webviewRef.current;
    if (!wv) return;
    registerWebview(browserId, wv);
    return () => { unregisterWebview(browserId); };
  }, [browserId]);

  const navigate = useCallback((targetUrl: string) => {
    const finalUrl = resolveInput(targetUrl);
    setUrlBarValue(finalUrl);
    if (isElectron && webviewRef.current) {
      webviewRef.current.loadURL(finalUrl).catch((err: Error) => {
        if (!err.message?.includes('ERR_ABORTED')) console.error('Navigation failed:', err);
      });
    }
    setCurrentUrl(finalUrl);
    dispatch(updateBrowserCardUrl({ browserId, url: finalUrl }));
  }, [browserId, dispatch]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(urlBarValue);
    }
  }, [navigate, urlBarValue]);

  const handleBack = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewRef.current?.goBack();
  }, []);

  const handleForward = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewRef.current?.reload();
  }, []);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(removeBrowserCard(browserId));
  }, [dispatch, browserId]);

  // ---- Drag via header ----
  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(browserId, 'browser');
  }, [cardX, cardY, onDragStart, browserId]);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const dx = rawDx / zoom;
    const dy = rawDy / zoom;
    setLocalDragPos({
      x: dragState.current.origX + dx,
      y: dragState.current.origY + dy,
    });
    onDragMove?.(dx, dy);
  }, [zoom, onDragMove]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = (e.clientX - dragState.current.startX) / zoom;
    const dy = (e.clientY - dragState.current.startY) / zoom;
    if (didDrag.current) {
      dispatch(setBrowserCardPosition({
        browserId,
        x: dragState.current.origX + dx,
        y: dragState.current.origY + dy,
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
  }, [zoom, dispatch, browserId, onDragEnd]);

  // ---- Resize ----
  const resizeRef = useRef<{
    dir: ResizeDir; startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
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

  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  const isSecure = currentUrl.startsWith('https://');
  const isSearch = isGoogleSearch(currentUrl);

  const accentColor = c.accent.primary;
  const accentHover = c.accent.hover;

  const glowingBrowserCards = useAppSelector((s) => s.dashboardLayout.glowingBrowserCards);
  const isGlowingFromRedux = !!glowingBrowserCards[browserId];

  const [hasBeenTouched, setHasBeenTouched] = useState(false);
  useEffect(() => {
    if (isGlowingFromRedux && agentActive) setHasBeenTouched(true);
  }, [isGlowingFromRedux, agentActive]);
  useEffect(() => {
    if (!isGlowingFromRedux) setHasBeenTouched(false);
  }, [isGlowingFromRedux]);

  const showGlow = isGlowingFromRedux && hasBeenTouched;

  const agentBorder = agentActive
    ? `2px solid ${accentColor}`
    : showGlow
      ? `2px solid ${accentColor}`
      : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`;

  const innerGlow = showGlow && !agentActive
    ? `, inset 0 0 30px ${accentColor}25, inset 0 0 60px ${accentColor}10`
    : '';

  const agentShadow = agentActive
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
      data-select-meta={JSON.stringify({ name: pageTitle || 'Browser', url: currentUrl })}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(browserId, 'browser', e.shiftKey);
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
        zIndex: (isDragging || isResizing) ? 100 : (agentActive || showGlow) ? 50 : 1,
        transition: noTransition ? 'none' : 'box-shadow 0.4s ease, border 0.3s ease',
        '&:hover .resize-handle': { opacity: 1 },
        ...((agentActive || showGlow) && {
          animation: 'agent-glow-pulse 2s ease-in-out infinite',
          '@keyframes agent-glow-pulse': {
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

      {/* Header / drag handle */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          bgcolor: agentActive ? `${accentColor}0a` : c.bg.secondary,
          borderBottom: `1px solid ${agentActive ? `${accentColor}30` : c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          flexShrink: 0,
          minHeight: 36,
          userSelect: 'none',
          transition: 'background 0.3s ease',
        }}
      >
        <LanguageIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
        <Typography
          sx={{
            flex: 1,
            fontSize: '0.78rem',
            fontWeight: 600,
            color: c.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {pageTitle || 'Browser'}
        </Typography>

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

        <Tooltip title="Back" placement="top">
          <span>
            <IconButton
              size="small"
              onClick={handleBack}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!canGoBack}
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
              disabled={!canGoForward}
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

      {/* URL bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          py: 0.4,
          bgcolor: c.bg.page,
          borderBottom: `1px solid ${c.border.subtle}`,
          flexShrink: 0,
        }}
      >
        {isSearch ? (
          <SearchIcon sx={{ fontSize: 14, color: c.text.muted, flexShrink: 0 }} />
        ) : isSecure ? (
          <LockIcon sx={{ fontSize: 13, color: c.status.success, flexShrink: 0 }} />
        ) : null}
        <InputBase
          value={urlBarValue}
          onChange={(e) => setUrlBarValue(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
          placeholder="Search Google or enter URL..."
          sx={{
            flex: 1,
            fontSize: '0.76rem',
            fontFamily: c.font.mono,
            color: c.text.secondary,
            py: 0,
            '& input': { py: '3px' },
            '& input::placeholder': { color: c.text.ghost, opacity: 1 },
          }}
        />
      </Box>

      {/* Loading indicator — accent-colored when agent is navigating */}
      {(loading || (agentActive && agentAction === 'navigate')) && (
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

      {/* Browser body */}
      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {isElectron ? (
          <webview
            ref={webviewRef as any}
            src={currentUrl}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        ) : (
          <Box sx={{ width: '100%', height: '100%', position: 'relative' }}>
            <iframe
              src={currentUrl}
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
              animation: 'scan-sweep 1.5s ease-in-out infinite',
              '@keyframes scan-sweep': {
                '0%': { top: '0%' },
                '100%': { top: '100%' },
              },
            }}
          />
        )}

        {/* Click ripple */}
        {(agentAction === 'click' || lastAction === 'click') && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
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

        {/* Orange inner shadow overlay for selection / streaming glow */}
        {showGlow && !agentActive && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 14,
              pointerEvents: 'none',
              borderRadius: 'inherit',
              boxShadow: 'inset 0 0 40px rgba(255,140,0,0.35), inset 0 0 80px rgba(255,100,0,0.15)',
              animation: 'orange-glow-pulse 2s ease-in-out infinite',
              '@keyframes orange-glow-pulse': {
                '0%, 100%': {
                  boxShadow: 'inset 0 0 40px rgba(255,140,0,0.35), inset 0 0 80px rgba(255,100,0,0.15)',
                },
                '50%': {
                  boxShadow: 'inset 0 0 50px rgba(255,140,0,0.45), inset 0 0 100px rgba(255,100,0,0.22)',
                },
              },
            }}
          />
        )}

        {/* ===== Frosted glass overlay ===== */}
        {agentActive && (
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

export default BrowserCard;
