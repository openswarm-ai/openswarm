import React, { useEffect, useRef } from 'react';
import { subscribeMarqueeRect, LiveMarqueeRect } from '../hooks/interaction/marqueeLiveChannel';

// The selection rectangle, moved imperatively off the marquee channel: React mounts it once per
// sweep and never re-renders it mid-drag.
const MarqueeRect: React.FC<{ initial: LiveMarqueeRect }> = ({ initial }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => subscribeMarqueeRect((r) => {
    const el = ref.current;
    if (!el || !r) return;
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }), []);
  return (
    <div
      ref={ref}
      data-marquee-rect
      style={{
        position: 'absolute',
        left: initial.x,
        top: initial.y,
        width: initial.width,
        height: initial.height,
        border: '1.5px dashed rgba(59, 130, 246, 0.6)',
        background: 'rgba(59, 130, 246, 0.08)',
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  );
};

export default MarqueeRect;
