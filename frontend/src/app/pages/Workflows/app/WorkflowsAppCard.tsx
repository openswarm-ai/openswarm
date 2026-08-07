import React, { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { setWorkflowsHubPosition, setWorkflowsHubSize, toggleMinimizeCard, closeWorkflowsHub, WORKFLOWS_HUB_ID } from '@/shared/state/dashboardLayoutSlice';
import CanvasWindowCard from '@/app/pages/Dashboard/cards/CanvasWindowCard';
import type { CardType } from '@/shared/state/dashboardLayoutSlice';
import { useWC } from './uiKit';
import WorkflowsAppContent from './WorkflowsAppContent';

const MIN_W = 900;
const MIN_H = 520;

interface Props {
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  cardZOrder?: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragActive?: boolean;
  onCardSelect?: (id: string, type: CardType, shiftKey: boolean) => void;
  onDragStart?: (id: string, type: CardType) => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBringToFront?: (id: string, type: CardType) => void;
}

const WorkflowsAppCard: React.FC<Props> = ({
  cardX, cardY, cardWidth, cardHeight, cardZOrder = 0,
  getCanvasState,
  isSelected = false, isHighlighted = false, multiDragActive = false,
  onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
}) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const isMinimized = useAppSelector((s) => !!s.dashboardLayout.minimizedCards[WORKFLOWS_HUB_ID]);

  // Keep fonts/keyframes available while the card is mounted.
  useEffect(() => { ensureAssets(); }, []);

  const commitPosition = useCallback((x: number, y: number) => {
    dispatch(setWorkflowsHubPosition({ x, y }));
  }, [dispatch]);
  const commitSize = useCallback((width: number, height: number) => {
    dispatch(setWorkflowsHubSize({ width, height }));
  }, [dispatch]);
  const minimize = useCallback(() => { dispatch(toggleMinimizeCard({ cardId: WORKFLOWS_HUB_ID })); }, [dispatch]);
  const close = useCallback(() => { dispatch(closeWorkflowsHub()); }, [dispatch]);

  return (
    <CanvasWindowCard
      cardId={WORKFLOWS_HUB_ID}
      cardType="workflows-hub"
      selectType="workflows-hub-card"
      selectName="Workflows"
      cardX={cardX}
      cardY={cardY}
      cardWidth={cardWidth}
      cardHeight={cardHeight}
      cardZOrder={cardZOrder}
      minimized={isMinimized}
      minWidth={MIN_W}
      minHeight={MIN_H}
      background={WC.page}
      highlightColor={WC.accent}
      getCanvasState={getCanvasState}
      isSelected={isSelected}
      isHighlighted={isHighlighted}
      multiDragActive={multiDragActive}
      onCardSelect={onCardSelect}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onBringToFront={onBringToFront}
      onCommitPosition={commitPosition}
      onCommitSize={commitSize}
      onMinimize={minimize}
      onClose={close}
    >
      {({ header, tileZone, onTileZone }) => (
        <WorkflowsAppContent header={header} tileZone={tileZone} onTileZone={onTileZone} />
      )}
    </CanvasWindowCard>
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
