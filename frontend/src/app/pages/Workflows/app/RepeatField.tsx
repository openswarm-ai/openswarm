import React, { useEffect, useRef, useState } from 'react';
import { useWC } from './uiKit';

// Combobox for the run limit: pick a preset OR type any count. Self-rendered
// (no native <select>, no portal) because a native popup over the canvas card
// is a separate compositor layer and gets dismissed before you can click it.
const OPTIONS: Array<{ label: string; val: number | null }> = [
  { label: 'Forever', val: null },
  { label: 'Once', val: 1 },
  { label: '3 times', val: 3 },
  { label: '10 times', val: 10 },
];

const RepeatField: React.FC<{ value: number | null; onChange: (n: number | null) => void }> = ({ value, onChange }) => {
  const WC = useWC();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setEditing(false); }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const display = value == null ? '' : `${value} time${value === 1 ? '' : 's'}`;

  const commit = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 4);
    setDraft(digits);
    onChange(digits === '' ? null : Math.max(1, parseInt(digits, 10)));
  };

  const pick = (val: number | null) => {
    onChange(val);
    setDraft(val == null ? '' : String(val));
    setEditing(false);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative', width: 134 }}>
      <div style={{ display: 'flex', alignItems: 'center', background: WC.raised, border: `1px solid ${open ? WC.accent : `rgba(${WC.inkRGB},0.12)`}`, borderRadius: 8, height: 32, padding: '0 2px 0 9px' }}>
        <input
          value={editing ? draft : display}
          placeholder="Forever"
          inputMode="numeric"
          onFocus={() => { setEditing(true); setDraft(value == null ? '' : String(value)); setOpen(true); }}
          onChange={(e) => commit(e.target.value)}
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: value == null && !editing ? WC.muted : WC.ink, fontFamily: "'JetBrains Mono',monospace" }}
        />
        <button
          onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 5, color: WC.muted }}
          aria-label="Repeat options"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease-in-out' }}><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 37, left: 0, right: 0, background: WC.raised, border: `1px solid ${WC.line}`, borderRadius: WC.radius.md, boxShadow: WC.shadow.md, padding: 4, zIndex: 40 }}>
          {OPTIONS.map((o) => {
            const active = (o.val == null && value == null) || o.val === value;
            return (
              <div
                key={o.label}
                onMouseDown={(e) => { e.preventDefault(); pick(o.val); }}
                style={{ padding: '7px 9px', borderRadius: 6, fontSize: 13, cursor: 'pointer', color: WC.ink, background: active ? WC.selBg : 'transparent', fontWeight: active ? 600 : 400 }}
              >
                {o.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RepeatField;
