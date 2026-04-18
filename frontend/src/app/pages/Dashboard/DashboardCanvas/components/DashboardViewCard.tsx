import React, { useState, useRef } from 'react';
import Box from '@mui/material/Box';
import { EXECUTE_APP, getAppServeUrl } from '@/shared/backend-bridge/apps/app_builder';
import { removeViewCard } from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewPreview, { ViewPreviewHandle } from '@/app/pages/Views/ViewPreview';
import { getDefault } from '@/app/pages/Views/InputSchemaForm';
import { useOverlayScrollPassthrough } from './useOverlayScrollPassthrough';
import { ViewCardProps, HANDLE_DEFS, CURSOR_MAP } from './viewCardConstants';
import { useViewCardDrag } from './useViewCardDrag';
import { useViewCardResize } from './useViewCardResize';
import ViewCardHeader from './ViewCardHeader';

const DashboardViewCard: React.FC<ViewCardProps> = ({
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

  const {
    isDragging, localDragPos, justDraggedRef,
    handleDragPointerDown, handleDragPointerMove, handleDragPointerUp,
  } = useViewCardDrag({ cardX, cardY, zoom, outputId: output.id, onDragStart, onDragMove, onDragEnd });

  const {
    isResizing, localResize,
    handleResizeDown, handleResizeMove, handleResizeUp,
  } = useViewCardResize({ cardX, cardY, cardWidth, cardHeight, zoom, outputId: output.id });

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(removeViewCard(output.id));
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    previewRef.current?.reload();
  };

  const handleExecute = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await dispatch(EXECUTE_APP({ app_id: output.id, input_data: inputData })).unwrap();
      setBackendResult(res.backend_result as Record<string, any> | null);
    } catch {}
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
            '0%': { boxShadow: `0 0 0 3px ${c.accent.primary}70, 0 0 24px ${c.accent.primary}50, 0 0 48px ${c.accent.primary}25` },
            '25%': { boxShadow: `0 0 0 4px ${c.accent.primary}55, 0 0 30px ${c.accent.primary}40, 0 0 56px ${c.accent.primary}20` },
            '50%': { boxShadow: `0 0 0 3px ${c.accent.primary}45, 0 0 22px ${c.accent.primary}30, 0 0 44px ${c.accent.primary}15` },
            '75%': { boxShadow: `0 0 0 2px ${c.accent.primary}25, 0 0 14px ${c.accent.primary}18, 0 0 28px ${c.accent.primary}08` },
            '100%': { boxShadow: c.shadow.md },
          },
        }),
      }}
    >
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

      <ViewCardHeader
        name={output.name}
        hasAutoRun={false}
        autoRunning={false}
        isDragging={isDragging}
        onDragPointerDown={handleDragPointerDown}
        onDragPointerMove={handleDragPointerMove}
        onDragPointerUp={handleDragPointerUp}
        onRefresh={handleRefresh}
        onAutoRun={handleExecute}
        onRemove={handleRemove}
      />

      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {cmdHeld && !isSelected && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 12 }} />
        )}
        <ViewPreview
          ref={previewRef}
          serveUrl={getAppServeUrl(output.id)}
          frontendCode={output.files?.['index.html'] ?? ''}
          inputData={inputData}
          backendResult={backendResult}
        />
      </Box>

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
