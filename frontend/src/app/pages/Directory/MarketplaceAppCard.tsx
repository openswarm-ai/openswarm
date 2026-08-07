import React, { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  closeMarketplaceCard,
  setMarketplaceCardPosition,
  setMarketplaceCardSize,
  toggleMinimizeCard,
  MARKETPLACE_CARD_ID,
} from '@/shared/state/dashboardLayoutSlice';
import type { CardType } from '@/shared/state/dashboardLayoutSlice';
import CanvasWindowCard from '@/app/pages/Dashboard/cards/CanvasWindowCard';
import WindowControls from '@/app/pages/Dashboard/cards/WindowControls';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import MarketplaceBody from './MarketplaceBody';

const MIN_W = 760;
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

// Marketplace as a real dashboard window: same chrome as the Settings app, claude Directory inside.
const MarketplaceAppCard: React.FC<Props> = ({
  cardX, cardY, cardWidth, cardHeight, cardZOrder = 0,
  getCanvasState,
  isSelected = false, isHighlighted = false, multiDragActive = false,
  onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const isMinimized = useAppSelector((s) => !!s.dashboardLayout.minimizedCards[MARKETPLACE_CARD_ID]);

  const commitPosition = useCallback((x: number, y: number) => {
    dispatch(setMarketplaceCardPosition({ x, y }));
  }, [dispatch]);
  const commitSize = useCallback((width: number, height: number) => {
    dispatch(setMarketplaceCardSize({ width, height }));
  }, [dispatch]);
  const close = useCallback(() => { dispatch(closeMarketplaceCard()); }, [dispatch]);
  const minimize = useCallback(() => { dispatch(toggleMinimizeCard({ cardId: MARKETPLACE_CARD_ID })); }, [dispatch]);

  return (
    <CanvasWindowCard
      cardId={MARKETPLACE_CARD_ID}
      cardType="marketplace"
      selectType="marketplace-card"
      selectName="Marketplace"
      cardX={cardX}
      cardY={cardY}
      cardWidth={cardWidth}
      cardHeight={cardHeight}
      cardZOrder={cardZOrder}
      minimized={isMinimized}
      minWidth={MIN_W}
      minHeight={MIN_H}
      background={c.bg.surface}
      highlightColor={c.accent.primary}
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
        <>
          <div
            onPointerDown={header.onPointerDown}
            onPointerMove={header.onPointerMove}
            onPointerUp={header.onPointerUp}
            onPointerCancel={header.onPointerCancel}
            onLostPointerCapture={header.onLostPointerCapture}
            style={{
              height: 42, flex: 'none', display: 'flex', alignItems: 'center', gap: 14,
              padding: '0 16px', background: c.bg.surface,
              cursor: header.dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none',
            }}
          >
            <span
              className="osw-card"
              data-no-drag
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'flex', alignItems: 'center' }}
            >
              <WindowControls onClose={close} onMinimize={minimize} onTile={onTileZone} tiled={!!tileZone} />
            </span>
          </div>
          <MarketplaceBody />
        </>
      )}
    </CanvasWindowCard>
  );
};

export default MarketplaceAppCard;
