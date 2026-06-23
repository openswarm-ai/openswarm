import React, { useEffect, useRef, useState } from 'react';
import { useWC, WORKFLOW_PALETTE } from './uiKit';

// Small swatch button that opens a palette popover. Self-rendered (no portal)
// so it survives the canvas compositor, same reasoning as RepeatField.
const ColorSwatch: React.FC<{ value: string; onChange: (hex: string) => void; size?: number }> = ({ value, onChange, size = 14 }) => {
  const WC = useWC();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flex: 'none' }}>
      <div
        onClick={() => setOpen((o) => !o)}
        title="Workflow color"
        style={{ width: size, height: size, borderRadius: 4, cursor: 'pointer', background: value, boxShadow: `0 0 0 1px rgba(${WC.inkRGB},0.14)` }}
      />
      {open && (
        <div style={{ position: 'absolute', top: size + 11, left: 0, zIndex: 45, background: WC.paper, border: `1px solid ${WC.line2}`, borderRadius: WC.radius.lg, boxShadow: WC.shadow.md, padding: 9, display: 'flex', gap: 7 }}>
          {WORKFLOW_PALETTE.map((hex) => {
            const active = hex.toLowerCase() === value.toLowerCase();
            return (
              <div
                key={hex}
                onClick={() => { onChange(hex); setOpen(false); }}
                style={{ width: 18, height: 18, borderRadius: 5, cursor: 'pointer', background: hex, boxShadow: active ? `0 0 0 2px ${WC.paper}, 0 0 0 3.5px ${hex}` : `0 0 0 1px rgba(${WC.inkRGB},0.12)` }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ColorSwatch;
