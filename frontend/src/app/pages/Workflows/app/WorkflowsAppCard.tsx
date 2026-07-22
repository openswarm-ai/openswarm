import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { setWorkflowsHubPosition, setWorkflowsHubSize } from '@/shared/state/dashboardLayoutSlice';
import { useTiledStyle } from '@/app/pages/Dashboard/cards/tileZones';
import { useWC } from './uiKit';
import WorkflowsAppContent from './WorkflowsAppContent';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type CardType = 'workflows-hub';

const EDGE = 6;
const CORNER = 14;
const MIN_W = 900;
const MIN_H = 520;
const DRAG_THRESHOLD = 3;

const CURSOR_MAP: Record<ResizeDir, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};
const HANDLE_DEFS: { dir: ResizeDir; css: React.CSSProperties }[] = [
  { dir: 'n', css: { top: -EDGE / 2, left: CORNER, right: CORNER, height: EDGE } },
  { dir: 's', css: { bottom: -EDGE / 2, left: CORNER, right: CORNER, height: EDGE } },
  { dir: 'w', css: { left: -EDGE / 2, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: 'e', css: { right: -EDGE / 2, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: 'nw', css: { top: -EDGE / 2, left: -EDGE / 2, width: CORNER, height: CORNER } },
  { dir: 'ne', css: { top: -EDGE / 2, right: -EDGE / 2, width: CORNER, height: CORNER } },
  { dir: 'sw', css: { bottom: -EDGE / 2, left: -EDGE / 2, width: CORNER, height: CORNER } },
  { dir: 'se', css: { bottom: -EDGE / 2, right: -EDGE / 2, width: CORNER, height: CORNER } },
];

interface Props {
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  cardZOrder?: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: CardType, shiftKey: boolean) => void;
  onDragStart?: (id: string, type: CardType) => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBringToFront?: (id: string, type: CardType) => void;
}

const WorkflowsAppCard: React.FC<Props> = ({
  cardX, cardY, cardWidth, cardHeight, cardZOrder = 0,
  getCanvasState,
  isSelected = false, isHighlighted = false, multiDragDelta = null,
  onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
}) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const isFullscreen = useAppSelector((s) => !!s.dashboardLayout.workflowsHub?.fullscreen);
  // Fullscreen pins the card to the viewport, so its geometry must track pan/zoom like the tiled
  // agent/browser cards; reuse the exact same helper. Subscribe to pan only while fullscreen.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isFullscreen) return undefined;
    const onPan = (): void => forceTick((t) => t + 1);
    window.addEventListener('openswarm:canvas-pan-changed', onPan);
    return () => window.removeEventListener('openswarm:canvas-pan-changed', onPan);
  }, [isFullscreen]);
  const cam = getCanvasState();
  const fsStyle = useTiledStyle(isFullscreen ? 'fullscreen' : undefined, cam.panX, cam.panY, cam.zoom);


  // ---- Drag (title bar is the handle) ----
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  // Keep fonts/keyframes available while the card is mounted.
  useEffect(() => { ensureAssets(); }, []);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (isFullscreen) return;  // pinned to the viewport, no drag until restored
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag], button, [role="button"], input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getCanvasState();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY, startPanX: cs.panX, startPanY: cs.panY };
    didDrag.current = false;
    setIsDragging(true);
    onDragStart?.('workflows-hub', 'workflows-hub');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, onDragStart, getCanvasState]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({ x: dragState.current.origX + dx, y: dragState.current.origY + dy });
    onDragMove?.(dx, dy, e.clientX, e.clientY);
  }, [onDragMove, getCanvasState]);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = (e.clientX - dragState.current.startX) / z - panDx;
    const dy = (e.clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 0);
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      if (!e.shiftKey) { finalX = Math.round(finalX / 24) * 24; finalY = Math.round(finalY / 24) * 24; }
      dispatch(setWorkflowsHubPosition({ x: finalX, y: finalY }));
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, onDragEnd, getCanvasState]);

  // ---- Resize ----
  const resizeRef = useRef<{ dir: ResizeDir; sx0: number; sy0: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const onResizeDown = useCallback((dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { dir, sx0: e.clientX, sy0: e.clientY, ox: cardX, oy: cardY, ow: cardWidth, oh: cardHeight };
    setIsResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, cardWidth, cardHeight]);

  const compute = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return null;
    const { dir, sx0, sy0, ox, oy, ow, oh } = resizeRef.current;
    const z2 = getCanvasState().zoom;
    const dx = (e.clientX - sx0) / z2;
    const dy = (e.clientY - sy0) / z2;
    let nx = ox, ny = oy, nw = ow, nh = oh;
    if (dir.includes('e')) nw = ow + dx;
    if (dir.includes('w')) { nw = ow - dx; nx = ox + dx; }
    if (dir.includes('s')) nh = oh + dy;
    if (dir.includes('n')) { nh = oh - dy; ny = oy + dy; }
    if (nw < MIN_W) { if (dir.includes('w')) nx = ox + ow - MIN_W; nw = MIN_W; }
    if (nh < MIN_H) { if (dir.includes('n')) ny = oy + oh - MIN_H; nh = MIN_H; }
    return { x: nx, y: ny, w: nw, h: nh };
  }, []);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = compute(e);
    if (r) setLocalResize(r);
  }, [compute]);

  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = compute(e);
    if (r) {
      dispatch(setWorkflowsHubPosition({ x: r.x, y: r.y }));
      dispatch(setWorkflowsHubSize({ width: r.w, height: r.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [compute, dispatch]);

  const mdDx = (!isDragging && !isResizing && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && !isResizing && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const dx = (localResize?.x ?? localDragPos?.x ?? cardX) + mdDx;
  const dy = (localResize?.y ?? localDragPos?.y ?? cardY) + mdDy;
  const dw = localResize?.w ?? cardWidth;
  const dh = localResize?.h ?? cardHeight;

  const border = isHighlighted ? `2px solid ${WC.accent}` : isSelected ? '2px solid #3b82f6' : `1px solid ${WC.border.subtle}`;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  return (
    <div
      data-select-type="workflows-hub-card"
      data-select-id="workflows-hub"
      data-select-meta={JSON.stringify({ name: 'Workflows' })}
      onPointerDownCapture={(e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-no-drag]')) return;
        onBringToFront?.('workflows-hub', 'workflows-hub');
      }}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        const target = e.target as HTMLElement;
        if (target.closest('[data-no-drag]')) return;
        onCardSelect?.('workflows-hub', 'workflows-hub', e.shiftKey);
      }}
      style={{
        position: 'absolute',
        contain: 'layout style',
        willChange: 'transform',
        left: fsStyle ? fsStyle.left : dx,
        top: fsStyle ? fsStyle.top : dy,
        width: fsStyle ? fsStyle.width : dw,
        height: fsStyle ? fsStyle.height : dh,
        transform: fsStyle ? fsStyle.transform : undefined,
        transformOrigin: fsStyle ? fsStyle.transformOrigin : undefined,
        background: WC.page,
        border: fsStyle ? 'none' : border,
        borderRadius: WC.radius.lg,
        boxShadow: (isDragging || isResizing) ? WC.shadow.lg : WC.shadow.md,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: fsStyle ? 999990 : (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.3s ease, border-color 0.2s ease',
      }}
    >
      <WorkflowsAppContent
        header={{
          onPointerDown: onHeaderPointerDown,
          onPointerMove: onHeaderPointerMove,
          onPointerUp: onHeaderPointerUp,
          dragging: isDragging,
        }}
      />

      {!isFullscreen && HANDLE_DEFS.map(({ dir, css }) => (
        <div
          key={dir}
          data-no-drag
          onPointerDown={onResizeDown(dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          style={{ position: 'absolute', cursor: CURSOR_MAP[dir], zIndex: 25, ...css }}
        />
      ))}
    </div>
  );
};

const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';

// Inject the design's webfonts + spinner keyframe once, lazily.
function ensureAssets(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('workflows-app-fonts')) return;
  const link = document.createElement('link');
  link.id = 'workflows-app-fonts';
  link.rel = 'stylesheet';
  link.href = FONTS_HREF;
  document.head.appendChild(link);
  const style = document.createElement('style');
  style.id = 'workflows-app-keyframes';
  style.textContent = [
    '@keyframes os-spin { to { transform: rotate(360deg); } }',
    '@keyframes os-flow { to { stroke-dashoffset: -18; } }',
    '@keyframes os-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.55); opacity: 0.45; } }',
    '@keyframes os-slidein { from { opacity: 0; transform: translateX(-22px) scale(0.97); } to { opacity: 1; transform: none; } }',
  ].join('\n');
  document.head.appendChild(style);
}

export default WorkflowsAppCard;
