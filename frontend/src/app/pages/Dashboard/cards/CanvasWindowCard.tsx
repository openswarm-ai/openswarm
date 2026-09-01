import React, { useCallback, useRef, useState } from 'react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppSelector } from '@/shared/hooks';
import { useTiledCard } from './useTiledCard';
import { useCardTiling } from './useCardTiling';
import { useCanvasWindowResize } from './useCanvasWindowResize';
import { useDragEndBackstops } from '../hooks/interaction/useDragEndBackstops';
import { openCardContextMenu, isNativeMenuTarget, type CardMenuRow } from '../desktop/openCardContextMenu';
import { tileMenuRows } from './tileMenuRows';
import type { CardType } from '@/shared/state/dashboardLayoutSlice';

const DRAG_THRESHOLD = 3;
const SNAP_GRID = 24;

/** Drag handlers the window hands down to whatever renders its title bar. */
export interface CanvasWindowHeader {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
  dragging: boolean;
}

export interface CanvasWindowChrome {
  header: CanvasWindowHeader;
  /** The window's current tile zone, or undefined while it floats free. */
  tileZone: string | undefined;
  /** A TILE_ZONES key, 'fullscreen', or 'restore'. */
  onTileZone: (zone: string) => void;
}

interface CanvasWindowCardProps {
  cardId: string;
  cardType: CardType;
  /** data-select-type / data-select-meta values: the DOM contract paste + onboarding selectors read. */
  selectType: string;
  selectName: string;
  cardX: number; cardY: number; cardWidth: number; cardHeight: number; cardZOrder?: number;
  /** Parked in the minimized rail: stays mounted (and keeps its state) off-canvas instead of unmounting. */
  minimized?: boolean;
  minWidth: number; minHeight: number;
  background: string; highlightColor: string;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  isSelected?: boolean; isHighlighted?: boolean;
  multiDragActive?: boolean;
  onCardSelect?: (id: string, type: CardType, shiftKey: boolean, originTarget?: EventTarget | null) => void;
  onDragStart?: (id: string, type: CardType) => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBringToFront?: (id: string, type: CardType) => void;
  onCommitPosition: (x: number, y: number) => void;
  onCommitSize: (width: number, height: number) => void;
  /** ENG-148: right-click rows the window offers when the host wires them; the menu itself is standard chrome. */
  onMinimize?: () => void;
  onClose?: () => void;
  children: (chrome: CanvasWindowChrome) => React.ReactNode;
}

// Window chrome for the singleton app cards (Workflows, Settings): drag by the title bar, 8 resize
// handles, tile zones, fullscreen. Geometry lives in the slice; the host passes commit callbacks so
// this stays reducer-agnostic, and renders its body through the children render prop.
const CanvasWindowCard: React.FC<CanvasWindowCardProps> = ({
  cardId, cardType, selectType, selectName,
  cardX, cardY, cardWidth, cardHeight, cardZOrder = 0,
  minimized = false, minWidth, minHeight, background, highlightColor,
  getCanvasState,
  isSelected = false, isHighlighted = false, multiDragActive = false,
  onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
  onCommitPosition, onCommitSize,
  onMinimize, onClose,
  children,
}) => {
  const c = useClaudeTokens();
  const zOverride = useAppSelector((state) => state.dashboardLayout.zOrders[cardId]);
  const tiling = useCardTiling({ cardId, getCanvasState, commitPosition: onCommitPosition });

  // ---- Drag (title bar is the handle) ----
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Fullscreen has no drag (macOS rule); same guard as AgentCard/BrowserCard.
    if (tiling.zone === 'fullscreen') return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag], button, [role="button"], input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getCanvasState();
    const popped = tiling.untileForDrag(e.clientX, e.clientY, cardWidth);
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: popped?.x ?? cardX, origY: popped?.y ?? cardY,
      startPanX: cs.panX, startPanY: cs.panY,
    };
    if (popped) setLocalDragPos(popped);
    didDrag.current = false;
    setIsDragging(true);
    onDragStart?.(cardId, cardType);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardId, cardType, cardX, cardY, cardWidth, tiling, onDragStart, getCanvasState]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({ x: dragState.current.origX + dx, y: dragState.current.origY + dy });
    onDragMove?.(dx, dy, e.clientX, e.clientY);
  }, [onDragMove, getCanvasState]);

  const finalizeDrag = useCallback((clientX: number, clientY: number, shiftKey: boolean) => {
    if (!dragState.current) return;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = (clientX - dragState.current.startX) / z - panDx;
    const dy = (clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 0);
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      if (!shiftKey) { finalX = Math.round(finalX / SNAP_GRID) * SNAP_GRID; finalY = Math.round(finalY / SNAP_GRID) * SNAP_GRID; }
      onCommitPosition(finalX, finalY);
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
  }, [onCommitPosition, onDragEnd, getCanvasState]);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    finalizeDrag(e.clientX, e.clientY, e.shiftKey);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* capture already gone */ }
  }, [finalizeDrag]);

  const abortDrag = useCallback(() => {
    if (!dragState.current) return;
    finalizeDrag(lastPointerRef.current.clientX, lastPointerRef.current.clientY, true);
  }, [finalizeDrag]);
  useDragEndBackstops(isDragging, finalizeDrag, abortDrag);

  const { isResizing, live: localResize, handles } = useCanvasWindowResize({
    cardX, cardY, cardWidth, cardHeight, minWidth, minHeight,
    getCanvasState, onCommitPosition, onCommitSize, untileForResize: tiling.untileForResize,
  });

  const dx = localResize?.x ?? localDragPos?.x ?? cardX;
  const dy = localResize?.y ?? localDragPos?.y ?? cardY;
  const dw = localResize?.w ?? cardWidth;
  const dh = localResize?.h ?? cardHeight;
  const tiledSize = useTiledCard({ cardId, zone: tiling.zone, active: !minimized, originX: dx, originY: dy, getCamera: getCanvasState });

  const border = isHighlighted ? `2px solid ${highlightColor}` : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.subtle}`;
  const noTransition = isDragging || isResizing || (isSelected && multiDragActive);

  return (
    <div
      data-select-type={selectType}
      data-select-id={cardId}
      data-select-meta={JSON.stringify({ name: selectName })}
      onPointerDownCapture={(e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-no-drag]')) return;
        onBringToFront?.(cardId, cardType);
      }}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        const target = e.target as HTMLElement;
        if (target.closest('[data-no-drag]')) return;
        onCardSelect?.(cardId, cardType, e.shiftKey, e.target);
      }}
      onContextMenu={(e: React.MouseEvent) => {
        // Same grammar as every other card; typing surfaces keep the OS menu, content with its own menu stopPropagates before this.
        if (isNativeMenuTarget(e)) return;
        const items: CardMenuRow[] = [
          { kind: 'header', label: selectName },
          { label: tiling.isFullscreen ? 'Exit Full Screen' : 'Full Screen', onClick: () => tiling.applyZone(tiling.isFullscreen ? 'restore' : 'fullscreen') },
          { label: 'Tile to zone', submenu: tileMenuRows(tiling.applyZone, tiling.zone) },
        ];
        if (onMinimize) items.push({ label: minimized ? 'Restore' : 'Minimize', onClick: onMinimize });
        if (onBringToFront) items.push({ label: 'Bring to front', onClick: () => onBringToFront(cardId, cardType) });
        if (onClose) {
          items.push({ kind: 'separator' });
          items.push({ label: 'Close', onClick: onClose });
        }
        openCardContextMenu(e, { items });
      }}
      data-keepalive-hidden={minimized ? '1' : undefined}
      style={{
        position: 'absolute',
        contain: 'layout style',
        willChange: 'transform',
        // Parked windows go off-canvas rather than unmounting, so Settings keeps its form and Workflows its view state.
        pointerEvents: minimized ? 'none' : undefined,
        visibility: minimized ? 'hidden' : undefined,
        left: minimized ? -100000 : dx,
        top: minimized ? -100000 : dy,
        width: tiledSize ? tiledSize.width : dw,
        height: tiledSize ? tiledSize.height : dh,
        transformOrigin: tiledSize ? '0 0' : undefined,
        background,
        border: tiling.isFullscreen ? 'none' : border,
        borderRadius: c.radius.lg,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: tiledSize ? 999990 : (isDragging || isResizing) ? 999999 : (zOverride ?? cardZOrder),
        transition: noTransition ? 'none' : 'border-color 0.2s ease',
      }}
    >
      {children({
        header: {
          onPointerDown: onHeaderPointerDown,
          onPointerMove: onHeaderPointerMove,
          onPointerUp: onHeaderPointerUp,
          onPointerCancel: abortDrag,
          onLostPointerCapture: abortDrag,
          dragging: isDragging,
        },
        tileZone: tiling.zone,
        onTileZone: tiling.applyZone,
      })}

      {!minimized && handles.map((h) => (
        <div
          key={h.dir}
          data-no-drag
          onPointerDown={h.onPointerDown}
          onPointerMove={h.onPointerMove}
          onPointerUp={h.onPointerUp}
          style={h.style}
        />
      ))}
    </div>
  );
};

export default CanvasWindowCard;
