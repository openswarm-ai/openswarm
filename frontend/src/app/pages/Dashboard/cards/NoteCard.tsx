import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import {
  setNotePosition,
  setNoteSize,
  removeNote,
  updateNoteContent,
  setNoteColor,
  recordClosedCard,
  toggleMinimizeCard,
  setTiledCard,
  clearTiledCard,
  clearCardWindowState,
  NoteColor,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import WindowControls from './WindowControls';
import { useTiledStyle } from './tileZones';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;
const MIN_W = 160;
const MIN_H = 120;
const HEADER_H = 18;

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

// Hand-tuned palette: distinct enough to skim, gentle in both themes.
const NOTE_PALETTE: Record<NoteColor, { bg: string; border: string; text: string }> = {
  yellow: { bg: '#FBE89C', border: '#E0C95A', text: '#3a2e0a' },
  pink:   { bg: '#F8C3D0', border: '#DB94A6', text: '#3a131e' },
  blue:   { bg: '#B6D7F0', border: '#86B5D8', text: '#0e2a3d' },
  green:  { bg: '#C7E5B5', border: '#94C376', text: '#1c3210' },
  purple: { bg: '#D8C5EE', border: '#A98BCB', text: '#23123e' },
  gray:   { bg: '#DEDDD6', border: '#A8A6A0', text: '#262522' },
};

interface Props {
  noteId: string;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  cmdHeld?: boolean;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  content: string;
  color: NoteColor;
  cardZOrder?: number;
  autoFocus?: boolean;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser' | 'note', shiftKey: boolean, originTarget?: EventTarget | null) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser' | 'note') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser' | 'note') => void;
}

const NoteCard: React.FC<Props> = ({
  noteId, cardX, cardY, cardWidth, cardHeight, getCanvasState,
  isSelected = false, isHighlighted = false, multiDragDelta, content, color,
  cardZOrder = 0, autoFocus, onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const palette = NOTE_PALETTE[color] || NOTE_PALETTE.yellow;
  const isMinimized = useAppSelector((s) => !!s.dashboardLayout.minimizedCards[noteId]);
  const tileZone = useAppSelector((s) => s.dashboardLayout.tiledCards[noteId]);

  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });

  const [showColorPicker, setShowColorPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      // Defer so the card has mounted in its final position.
      const t = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getCanvasState();
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: cardX, origY: cardY,
      startPanX: cs.panX, startPanY: cs.panY,
    };
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(noteId, 'note');
  }, [cardX, cardY, noteId, onDragStart, getCanvasState]);

  const recomputeDragPos = useCallback(() => {
    const ds = dragState.current;
    if (!ds || !didDrag.current) return;
    const { clientX, clientY } = lastPointerRef.current;
    const rawDx = clientX - ds.startX;
    const rawDy = clientY - ds.startY;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - ds.startPanX) / z;
    const panDy = (cs.panY - ds.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({ x: ds.origX + dx, y: ds.origY + dy });
    onDragMove?.(dx, dy, clientX, clientY);
  }, [onDragMove, getCanvasState]);

  // Edge-pan/wheel-zoom moves the camera without a React commit; the pan-changed event is the live signal to re-pin the card to the cursor.
  useEffect(() => {
    if (!isDragging) return;
    const onPanChange = () => {
      if (didDrag.current) recomputeDragPos();
    };
    window.addEventListener('openswarm:canvas-pan-changed', onPanChange);
    return () => window.removeEventListener('openswarm:canvas-pan-changed', onPanChange);
  }, [isDragging, recomputeDragPos]);

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
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = (e.clientX - dragState.current.startX) / z - panDx;
    const dy = (e.clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      if (!e.shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }
      dispatch(setNotePosition({ noteId, x: finalX, y: finalY }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, noteId, onDragEnd, getCanvasState]);

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
      const zoom = getCanvasState().zoom;
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
    [getCanvasState],
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
      dispatch(setNotePosition({ noteId, x: result.x, y: result.y }));
      dispatch(setNoteSize({ noteId, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, noteId]);

  const handleRemove = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    dispatch(clearCardWindowState(noteId));
    dispatch(recordClosedCard({ kind: 'note', id: noteId }));
    dispatch(removeNote(noteId));
  };
  const onMinimize = () => dispatch(toggleMinimizeCard({ cardId: noteId }));
  const onTile = (zone: string) => {
    if (zone === 'restore') dispatch(clearTiledCard(noteId));
    else dispatch(setTiledCard({ cardId: noteId, zone }));
  };
  // Tiled geometry must track pan/zoom, but the camera lives outside React now; subscribe to the pan event ONLY while tiled and read the live getter.
  const [tileTick, setTileTick] = useState(0);
  useEffect(() => {
    if (!tileZone) return undefined;
    const onPan = (): void => setTileTick((t) => t + 1);
    window.addEventListener('openswarm:canvas-pan-changed', onPan);
    return () => window.removeEventListener('openswarm:canvas-pan-changed', onPan);
  }, [tileZone]);
  void tileTick;
  const cam = getCanvasState();
  const tiledStyle = useTiledStyle(tileZone, cam.panX, cam.panY, cam.zoom);
  const isFullscreen = tileZone === 'fullscreen';

  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;

  return (
    <Box
      className="osw-card"
      data-select-type="note-card"
      data-select-id={noteId}
      data-select-meta={JSON.stringify({ name: 'Note', content: content.slice(0, 60) })}
      onPointerDownCapture={(e: React.PointerEvent) => {
        onBringToFront?.(noteId, 'note');
        // Capture-phase so a click the textarea swallows still selects the note; shift keeps the bubbled toggle path. Pass the target so a textarea press selects without yanking the camera.
        if (e.button === 0 && !e.shiftKey) onCardSelect?.(noteId, 'note', false, e.target);
      }}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(noteId, 'note', e.shiftKey);
      }}
      sx={{
        position: 'absolute',
        left: tiledStyle ? tiledStyle.left : displayX,
        top: tiledStyle ? tiledStyle.top : displayY,
        width: tiledStyle ? tiledStyle.width : (isMinimized ? 190 : displayW),
        height: tiledStyle ? tiledStyle.height : (isMinimized ? 32 : displayH),
        transform: tiledStyle ? tiledStyle.transform : undefined,
        transformOrigin: tiledStyle ? tiledStyle.transformOrigin : undefined,
        // contain + willChange: own compositor layer so paint stays scoped (see AgentCard for full rationale).
        contain: 'layout style',
        willChange: 'transform',
        borderRadius: isFullscreen ? '12px' : `${c.radius.md}px`,
        bgcolor: palette.bg,
        border: isHighlighted
          ? `2px solid ${c.accent.primary}`
          : isSelected ? '2px solid #3b82f6' : `1px solid ${palette.border}`,
        boxShadow: isHighlighted
          ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35`
          : isDragging || isResizing
            ? c.shadow.lg
            : isSelected
              ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
              : c.shadow.sm,
        zIndex: tiledStyle ? 999990 : (isDragging || isResizing) ? 999999 : cardZOrder,
        display: 'flex',
        flexDirection: 'column',
        '&:hover .note-controls': { opacity: 1 },
      }}
    >
      {/* Drag header */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
        sx={{
          height: isMinimized ? '100%' : HEADER_H,
          flexShrink: 0,
          cursor: isDragging ? 'grabbing' : 'grab',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 0.75,
          touchAction: 'none',
        }}
      >
        <Box onPointerDown={(e) => e.stopPropagation()} sx={{ display: 'flex', alignItems: 'center' }}>
          <WindowControls onClose={() => handleRemove()} onMinimize={onMinimize} onTile={onTile} tiled={!!tileZone} />
        </Box>
        {isMinimized && (
          <Box sx={{ flex: 1, minWidth: 0, fontSize: '0.8rem', color: palette.text, opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {content.trim() || 'Note'}
          </Box>
        )}
        <Box
          className="note-controls"
          sx={{ ml: 'auto', opacity: 0, transition: 'opacity 0.15s', display: isMinimized ? 'none' : 'flex' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); setShowColorPicker((v) => !v); }}
            sx={{ p: 0.25, color: palette.text, opacity: 0.55, '&:hover': { opacity: 1, bgcolor: 'rgba(0,0,0,0.06)' } }}
          >
            <PaletteOutlinedIcon sx={{ fontSize: 13 }} />
          </IconButton>
        </Box>
      </Box>

      {showColorPicker && (
        <Box
          onPointerDown={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            top: HEADER_H + 2,
            left: 8,
            display: 'flex',
            gap: 0.5,
            p: 0.75,
            bgcolor: 'rgba(255,255,255,0.95)',
            border: `1px solid ${c.border.medium}`,
            borderRadius: `${c.radius.sm}px`,
            boxShadow: c.shadow.md,
            zIndex: 10,
          }}
        >
          {(Object.keys(NOTE_PALETTE) as NoteColor[]).map((key) => {
            const p = NOTE_PALETTE[key];
            const active = key === color;
            return (
              <Box
                key={key}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(setNoteColor({ noteId, color: key }));
                  setShowColorPicker(false);
                }}
                sx={{
                  width: 16, height: 16, borderRadius: '50%',
                  bgcolor: p.bg,
                  border: active ? `2px solid #3b82f6` : `1px solid ${p.border}`,
                  cursor: 'pointer',
                  transition: 'transform 0.1s',
                  '&:hover': { transform: 'scale(1.15)' },
                }}
              />
            );
          })}
        </Box>
      )}

      {/* Editable content. Fullscreen = focus-writing mode: reading-size type in a centered column, like Bear/Arc, not 12px lost in a 2800px card. */}
      {!isMinimized && (
      <Box sx={{ flex: 1, p: 1, pt: 0.25, display: 'flex', justifyContent: 'center', minHeight: 0 }}>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => dispatch(updateNoteContent({ noteId, content: e.target.value }))}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="Type a note…"
          spellCheck
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            resize: 'none',
            background: 'transparent',
            color: palette.text,
            fontFamily: c.font.sans,
            fontSize: isFullscreen ? 'clamp(1.1rem, 1.3vw, 1.5rem)' : '0.85rem',
            lineHeight: isFullscreen ? 1.6 : 1.45,
            padding: isFullscreen ? '4vh 0 0' : 0,
            maxWidth: isFullscreen ? 'min(72ch, 82%)' : undefined,
          }}
        />
      </Box>
      )}

      {/* Resize handles */}
      {!isMinimized && HANDLE_DEFS.map(({ dir, sx }) => (
        <Box
          key={dir}
          onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          onPointerCancel={handleResizeUp}
          sx={{
            position: 'absolute',
            cursor: CURSOR_MAP[dir],
            zIndex: 5,
            touchAction: 'none',
            ...sx,
          }}
        />
      ))}
    </Box>
  );
};

export default React.memo(NoteCard);
