import React, { useCallback, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import {
  closeConfigurePanel,
  setConfigurePanelPosition,
  setConfigurePanelSize,
  type ConfigurePanelPosition,
} from '@/shared/state/dashboardLayoutSlice';
import Tools from '@/app/pages/Tools/Tools';

const MIN_W = 420;
const MIN_H = 320;
const EDGE = 6;

export default function ConfigurePanelCard({ panel, zOrder }: { panel: ConfigurePanelPosition; zOrder: number }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const [localPos, setLocalPos] = useState<{ x: number; y: number } | null>(null);
  const [localSize, setLocalSize] = useState<{ w: number; h: number } | null>(null);

  const onDragStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: panel.x, origY: panel.y };
    setLocalPos({ x: panel.x, y: panel.y });
  }, [panel.x, panel.y]);

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const nx = dragRef.current.origX + dx;
    const ny = dragRef.current.origY + dy;
    setLocalPos({ x: nx, y: ny });
    // Push the live position into Redux so the dashboard tether stays
    // glued to the panel during the drag instead of lagging until pointer
    // up. setLocalPos is kept for sub-frame smoothness, but Redux is the
    // tether's source of truth.
    dispatch(setConfigurePanelPosition({ workflowId: panel.workflow_id, x: nx, y: ny }));
  }, [dispatch, panel.workflow_id]);

  const onDragEnd = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setLocalPos(null);
  }, []);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: panel.width, origH: panel.height };
    setLocalSize({ w: panel.width, h: panel.height });
  }, [panel.width, panel.height]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const dw = e.clientX - resizeRef.current.startX;
    const dh = e.clientY - resizeRef.current.startY;
    setLocalSize({
      w: Math.max(MIN_W, resizeRef.current.origW + dw),
      h: Math.max(MIN_H, resizeRef.current.origH + dh),
    });
  }, []);

  const onResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (localSize) {
      dispatch(setConfigurePanelSize({ workflowId: panel.workflow_id, width: localSize.w, height: localSize.h }));
    }
    resizeRef.current = null;
    setLocalSize(null);
  }, [dispatch, localSize, panel.workflow_id]);

  const displayX = localPos?.x ?? panel.x;
  const displayY = localPos?.y ?? panel.y;
  const displayW = localSize?.w ?? panel.width;
  const displayH = localSize?.h ?? panel.height;

  return (
    <Box
      data-select-type="configure-panel"
      data-select-id={panel.workflow_id}
      sx={{
        position: 'absolute',
        left: displayX,
        top: displayY,
        width: displayW,
        height: displayH,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.accent.primary}80`,
        borderRadius: `${c.radius.lg}px`,
        boxShadow: c.shadow.lg,
        zIndex: zOrder,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
      {/* Drag handle + close X strip across the top. Stays slim so the
          full Action Library underneath gets the vertical space. */}
      <Box
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.5,
          px: 1, py: 0.5,
          borderBottom: `1px solid ${c.border.subtle}`,
          bgcolor: c.bg.surface,
          cursor: 'grab',
          '&:active': { cursor: 'grabbing' },
          flexShrink: 0,
          userSelect: 'none',
        }}>
        <DragIndicatorIcon sx={{ fontSize: 14, color: c.text.muted }} />
        <Box sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.text.secondary, flex: 1 }}>Action Library</Box>
        <IconButton
          size="small"
          onClick={() => dispatch(closeConfigurePanel(panel.workflow_id))}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ p: 0.25, color: c.text.muted, '&:hover': { color: c.status.error, bgcolor: c.status.errorBg } }}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
      {/* Body: the real Action Library, exact same component as /actions. */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Tools />
      </Box>
      {/* SE resize handle. */}
      <Box
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        sx={{
          position: 'absolute',
          right: 0, bottom: 0,
          width: 14, height: 14,
          cursor: 'nwse-resize',
          opacity: 0.6,
          '&:hover': { opacity: 1 },
          // Diagonal stripes for the universal "drag-resize" hint.
          background: `linear-gradient(135deg, transparent 50%, ${c.border.medium} 50%, ${c.border.medium} 60%, transparent 60%, transparent 75%, ${c.border.medium} 75%, ${c.border.medium} 85%, transparent 85%)`,
          borderBottomRightRadius: `${EDGE}px`,
        }}
      />
    </Box>
  );
}
