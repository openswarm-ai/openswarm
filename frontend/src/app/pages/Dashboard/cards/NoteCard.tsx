import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import {
  setNotePosition,
  setNoteSize,
  removeNote,
  updateNoteContent,
  setNoteColor,
  NoteColor,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

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
  zoom?: number;
  panX?: number;
  panY?: number;
  cmdHeld?: boolean;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  content: string;
  color: NoteColor;
  cardZOrder?: number;
  autoFocus?: boolean;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser' | 'note', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser' | 'note') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser' | 'note') => void;
}

const NoteCard: React.FC<Props> = ({
  noteId, cardX, cardY, cardWidth, cardHeight, zoom = 1, panX = 0, panY = 0,
  isSelected = false, isHighlighted = false, multiDragDelta, content, color,
  cardZOrder = 0, autoFocus, onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const palette = NOTE_PALETTE[color] || NOTE_PALETTE.yellow;

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
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: cardX, origY: cardY,
      startPanX: panRef.current.panX, startPanY: panRef.current.panY,
    };
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(noteId, 'note');
  }, [cardX, cardY, noteId, onDragStart]);

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
  }, [dispatch, noteId, onDragEnd]);

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
      dispatch(setNotePosition({ noteId, x: result.x, y: result.y }));
      dispatch(setNoteSize({ noteId, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, noteId]);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(removeNote(noteId));
  };

  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;

  return (
    <Box
      data-select-type="note-card"
      data-select-id={noteId}
      data-select-meta={JSON.stringify({ name: 'Note', content: content.slice(0, 60) })}
      onPointerDownCapture={() => onBringToFront?.(noteId, 'note')}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(noteId, 'note', e.shiftKey);
      }}
      sx={{
        position: 'absolute',
        left: displayX,
        top: displayY,
        width: displayW,
        height: displayH,
        // contain + willChange: own compositor layer so paint stays scoped (see AgentCard for full rationale).
        contain: 'layout style',
        willChange: 'transform',
        borderRadius: `${c.radius.md}px`,
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
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
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
          height: HEADER_H,
          flexShrink: 0,
          cursor: isDragging ? 'grabbing' : 'grab',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 0.75,
          touchAction: 'none',
        }}
      >
        <Box
          className="note-controls"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.25, opacity: 0, transition: 'opacity 0.15s' }}
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
        <Box
          className="note-controls"
          sx={{ opacity: 0, transition: 'opacity 0.15s' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconButton
            size="small"
            onClick={handleRemove}
            sx={{ p: 0.25, color: palette.text, opacity: 0.55, '&:hover': { opacity: 1, bgcolor: 'rgba(0,0,0,0.06)' } }}
          >
            <CloseIcon sx={{ fontSize: 13 }} />
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

      {/* Editable content */}
      <Box sx={{ flex: 1, p: 1, pt: 0.25, display: 'flex', minHeight: 0 }}>
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
            fontSize: '0.85rem',
            lineHeight: 1.45,
            padding: 0,
          }}
        />
      </Box>

      {/* Resize handles */}
      {HANDLE_DEFS.map(({ dir, sx }) => (
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
