import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import LanguageIcon from '@mui/icons-material/Language';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import LockIcon from '@mui/icons-material/Lock';
import {
  setBrowserCardPosition,
  setBrowserCardSize,
  removeBrowserCard,
  updateBrowserCardUrl,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

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

interface WebviewElement extends HTMLElement {
  src: string;
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  addEventListener: (event: string, listener: (...args: any[]) => void) => void;
  removeEventListener: (event: string, listener: (...args: any[]) => void) => void;
}

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

function ensureProtocol(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

const BrowserCard: React.FC<Props> = ({
  browserId, url, cardX, cardY, cardWidth, cardHeight, zoom = 1,
  isSelected = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const webviewRef = useRef<WebviewElement | null>(null);

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

  const navigate = useCallback((targetUrl: string) => {
    const finalUrl = ensureProtocol(targetUrl);
    setUrlBarValue(finalUrl);
    if (isElectron && webviewRef.current) {
      webviewRef.current.loadURL(finalUrl);
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

  return (
    <Box
      data-select-type="browser-card"
      data-select-id={browserId}
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
        border: isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`,
        bgcolor: c.bg.surface,
        boxShadow: isDragging || isResizing
          ? c.shadow.lg
          : isSelected
            ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
            : c.shadow.md,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 100 : 1,
        transition: noTransition ? 'none' : 'box-shadow 0.2s',
        '&:hover .resize-handle': { opacity: 1 },
      }}
    >
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
          bgcolor: c.bg.secondary,
          borderBottom: `1px solid ${c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          flexShrink: 0,
          minHeight: 36,
          userSelect: 'none',
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
        {isSecure && (
          <LockIcon sx={{ fontSize: 13, color: c.status.success, flexShrink: 0 }} />
        )}
        <InputBase
          value={urlBarValue}
          onChange={(e) => setUrlBarValue(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
          placeholder="Enter URL..."
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

      {/* Loading indicator */}
      {loading && (
        <LinearProgress
          sx={{
            height: 2,
            flexShrink: 0,
            bgcolor: 'transparent',
            '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary },
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
