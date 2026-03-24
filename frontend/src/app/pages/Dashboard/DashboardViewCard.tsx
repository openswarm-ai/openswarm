import React, { useState, useRef, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import RefreshIcon from '@mui/icons-material/Refresh';
import BoltIcon from '@mui/icons-material/Bolt';
import CloseIcon from '@mui/icons-material/Close';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import { Output, autoRunOutput, autoRunAgentOutput, executeOutput, OutputExecuteResult, getBackendCode, SERVE_BASE } from '@/shared/state/outputsSlice';
import { setViewCardPosition, setViewCardSize, removeViewCard } from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewPreview, { ViewPreviewHandle } from '@/app/pages/Views/ViewPreview';
import { getDefault } from '@/app/pages/Views/InputSchemaForm';
import { useOverlayScrollPassthrough } from './useOverlayScrollPassthrough';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;
const MIN_W = 320;
const MIN_H = 200;

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

interface Props {
  output: Output;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  zoom?: number;
  cmdHeld?: boolean;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view') => void;
  onDragMove?: (dx: number, dy: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  cardZOrder?: number;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
}

const DashboardViewCard: React.FC<Props> = ({
  output, cardX, cardY, cardWidth, cardHeight, zoom = 1, cmdHeld = false,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  cardZOrder = 0, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);
  const previewRef = useRef<ViewPreviewHandle>(null);

  const [inputData, setInputData] = useState<Record<string, any>>(() => getDefault(output.input_schema));
  const [backendResult, setBackendResult] = useState<Record<string, any> | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);

  const hasAutoRun = !!(output.auto_run_config?.enabled && output.auto_run_config?.prompt);

  // ---- Drag via header ----
  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(output.id, 'view');
  }, [cardX, cardY, onDragStart, output.id]);

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
      dispatch(setViewCardPosition({
        outputId: output.id,
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
  }, [zoom, dispatch, output.id, onDragEnd]);

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
      dispatch(setViewCardPosition({ outputId: output.id, x: result.x, y: result.y }));
      dispatch(setViewCardSize({ outputId: output.id, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, output.id]);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(removeViewCard(output.id));
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    previewRef.current?.reload();
  };

  const handleAutoRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!output.auto_run_config?.prompt) return;
    setAutoRunning(true);

    const config = output.auto_run_config;
    const forcedToolNames = config.forced_tools?.flatMap((ft) => ft.tools) ?? [];

    try {
      if (forcedToolNames.length > 0) {
        const res = await dispatch(autoRunAgentOutput({
          prompt: config.prompt,
          input_schema: output.input_schema,
          output_id: output.id,
          model: config.model,
          forced_tools: forcedToolNames,
          context_paths: config.context_paths,
        })).unwrap();

        // For agent-based auto-run, we execute with default input for now
        // since the agent session result flow is complex for dashboard cards
        const execRes = await dispatch(executeOutput({
          output_id: output.id,
          input_data: inputData,
        })).unwrap();
        setInputData(execRes.input_data);
        setBackendResult(execRes.backend_result);
      } else {
        const res = await dispatch(autoRunOutput({
          prompt: config.prompt,
          input_schema: output.input_schema,
          backend_code: getBackendCode(output) ?? undefined,
          context_paths: config.context_paths,
          forced_tools: forcedToolNames.length > 0 ? forcedToolNames : undefined,
          model: config.model,
        })).unwrap();
        if (res.input_data) {
          setInputData(res.input_data);
          setBackendResult(res.backend_result);
        }
      }
    } catch {
      // Silently handle errors on dashboard
    } finally {
      setAutoRunning(false);
    }
  };

  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  return (
    <Box
      data-select-type="view-card"
      data-select-id={output.id}
      data-select-meta={JSON.stringify({ name: output.name, description: output.description })}
      onPointerDownCapture={() => onBringToFront?.(output.id, 'view')}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(output.id, 'view', e.shiftKey);
      }}
      sx={{
        position: 'absolute',
        left: displayX,
        top: displayY,
        width: displayW,
        height: displayH,
        borderRadius: `${c.radius.lg}px`,
        border: isHighlighted
          ? `2px solid ${c.accent.primary}`
          : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`,
        bgcolor: c.bg.surface,
        boxShadow: isHighlighted
          ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
          : isDragging || isResizing
            ? c.shadow.lg
            : isSelected
              ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
              : c.shadow.md,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.2s',
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
      }}
    >
      {/* Selection overlay – blocks click interaction while selected, enabling drag from anywhere */}
      {isSelected && (
        <Box
          ref={scrollOverlayRef}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onClick={(e: React.MouseEvent) => {
            if (justDraggedRef.current) return;
            onCardSelect?.(output.id, 'view', e.shiftKey);
          }}
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 15,
            cursor: isDragging ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        />
      )}

      {/* Header */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        sx={{
          position: 'relative',
          zIndex: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.5,
          py: 0.75,
          bgcolor: c.bg.secondary,
          borderBottom: `1px solid ${c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          flexShrink: 0,
          minHeight: 36,
          userSelect: 'none',
        }}
      >
        <GridViewRoundedIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
        <Typography
          sx={{
            flex: 1,
            fontSize: '0.8rem',
            fontWeight: 600,
            color: c.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {output.name}
        </Typography>

        <Tooltip title="Reload preview" placement="top">
          <IconButton
            size="small"
            onClick={handleRefresh}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.muted, p: 0.5, '&:hover': { color: c.text.primary } }}
          >
            <RefreshIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>

        {hasAutoRun && (
          <Tooltip title={autoRunning ? 'Running...' : 'Auto Run'} placement="top">
            <span>
              <IconButton
                size="small"
                onClick={handleAutoRun}
                onPointerDown={(e) => e.stopPropagation()}
                disabled={autoRunning}
                sx={{ color: '#f59e0b', p: 0.5, '&:hover': { color: '#d97706' } }}
              >
                {autoRunning ? <CircularProgress size={14} sx={{ color: '#f59e0b' }} /> : <BoltIcon sx={{ fontSize: 16 }} />}
              </IconButton>
            </span>
          </Tooltip>
        )}

        <Tooltip title="Remove from dashboard" placement="top">
          <IconButton
            size="small"
            onClick={handleRemove}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.ghost, p: 0.5, '&:hover': { color: c.status.error } }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Preview body */}
      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {cmdHeld && !isSelected && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 12 }} />
        )}
        <ViewPreview
          ref={previewRef}
          serveUrl={`${SERVE_BASE}/${output.id}/serve/index.html`}
          frontendCode={output.files?.['index.html'] ?? ''}
          inputData={inputData}
          backendResult={backendResult}
        />
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

export default React.memo(DashboardViewCard);
