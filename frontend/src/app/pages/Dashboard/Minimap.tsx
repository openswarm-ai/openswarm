import React, { useRef, useCallback, useMemo } from 'react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { CardPosition, ViewCardPosition, BrowserCardPosition } from '@/shared/state/dashboardLayoutSlice';

const MINIMAP_W = 200;
const MINIMAP_H = 140;
const PADDING = 20;

export interface MinimapProps {
  panX: number;
  panY: number;
  zoom: number;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  onPan: (panX: number, panY: number) => void;
}

interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'agent' | 'view' | 'browser';
}

const Minimap: React.FC<MinimapProps> = ({
  panX, panY, zoom, viewportRef,
  cards, viewCards, browserCards,
  onPan,
}) => {
  const c = useClaudeTokens();
  const svgRef = useRef<SVGSVGElement>(null);
  const isDraggingRef = useRef(false);

  const allCards = useMemo((): CardRect[] => {
    const result: CardRect[] = [];
    for (const card of Object.values(cards)) {
      result.push({ x: card.x, y: card.y, width: card.width, height: card.height, type: 'agent' });
    }
    for (const vc of Object.values(viewCards)) {
      result.push({ x: vc.x, y: vc.y, width: vc.width, height: vc.height, type: 'view' });
    }
    for (const bc of Object.values(browserCards)) {
      result.push({ x: bc.x, y: bc.y, width: bc.width, height: bc.height, type: 'browser' });
    }
    return result;
  }, [cards, viewCards, browserCards]);

  const layout = useMemo(() => {
    const vp = viewportRef.current;
    const vpW = vp ? vp.clientWidth : 1200;
    const vpH = vp ? vp.clientHeight : 800;

    const vpRect = {
      x: -panX / zoom,
      y: -panY / zoom,
      width: vpW / zoom,
      height: vpH / zoom,
    };

    if (allCards.length === 0) {
      const scale = Math.min(
        (MINIMAP_W - PADDING * 2) / vpRect.width,
        (MINIMAP_H - PADDING * 2) / vpRect.height,
      );
      return {
        scale,
        offsetX: MINIMAP_W / 2 - (vpRect.x + vpRect.width / 2) * scale,
        offsetY: MINIMAP_H / 2 - (vpRect.y + vpRect.height / 2) * scale,
        vpRect,
      };
    }

    let minX = vpRect.x, minY = vpRect.y;
    let maxX = vpRect.x + vpRect.width, maxY = vpRect.y + vpRect.height;
    for (const card of allCards) {
      minX = Math.min(minX, card.x);
      minY = Math.min(minY, card.y);
      maxX = Math.max(maxX, card.x + card.width);
      maxY = Math.max(maxY, card.y + card.height);
    }

    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const scale = Math.min(
      (MINIMAP_W - PADDING * 2) / contentW,
      (MINIMAP_H - PADDING * 2) / contentH,
    );
    return {
      scale,
      offsetX: (MINIMAP_W - contentW * scale) / 2 - minX * scale,
      offsetY: (MINIMAP_H - contentH * scale) / 2 - minY * scale,
      vpRect,
    };
  }, [allCards, panX, panY, zoom, viewportRef]);

  const minimapToCanvas = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const canvasX = (mx - layout.offsetX) / layout.scale;
    const canvasY = (my - layout.offsetY) / layout.scale;
    onPan(
      -(canvasX - layout.vpRect.width / 2) * zoom,
      -(canvasY - layout.vpRect.height / 2) * zoom,
    );
  }, [layout, zoom, onPan]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    minimapToCanvas(e.clientX, e.clientY);

    const onMove = (ev: MouseEvent) => {
      if (isDraggingRef.current) minimapToCanvas(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [minimapToCanvas]);

  const typeColor = (type: 'agent' | 'view' | 'browser') => {
    switch (type) {
      case 'agent': return c.accent.primary;
      case 'view': return c.status.info;
      case 'browser': return c.status.success;
    }
  };

  return (
    <svg
      ref={svgRef}
      width={MINIMAP_W}
      height={MINIMAP_H}
      onMouseDown={handleMouseDown}
      style={{ cursor: 'pointer', display: 'block' }}
    >
      {allCards.map((card, i) => (
        <rect
          key={i}
          x={card.x * layout.scale + layout.offsetX}
          y={card.y * layout.scale + layout.offsetY}
          width={card.width * layout.scale}
          height={card.height * layout.scale}
          fill={typeColor(card.type)}
          opacity={0.6}
          rx={1}
        />
      ))}
      <rect
        x={layout.vpRect.x * layout.scale + layout.offsetX}
        y={layout.vpRect.y * layout.scale + layout.offsetY}
        width={layout.vpRect.width * layout.scale}
        height={layout.vpRect.height * layout.scale}
        fill="none"
        stroke={c.accent.primary}
        strokeWidth={1.5}
        opacity={0.8}
        rx={1}
      />
    </svg>
  );
};

export default Minimap;
