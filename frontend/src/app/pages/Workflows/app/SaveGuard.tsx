import React from 'react';
import { useWC } from './uiKit';

// Test-first nudge before scheduling: a test run grants the tool access the
// workflow needs, so unattended runs don't stall reaching for them.
const SaveGuard: React.FC<{
  title: string;
  onClose: () => void;
  onSaveAnyway: () => void;
  onRunTest: () => void;
}> = ({ title, onClose, onSaveAnyway, onRunTest }) => {
  const WC = useWC();
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: `rgba(${WC.inkRGB},0.34)`, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 28 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 430, maxWidth: '100%', background: WC.paper, borderRadius: WC.radius.lg, boxShadow: WC.shadow.lg, overflow: 'hidden' }}>
        <div style={{ padding: '24px 24px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, background: 'rgba(185,138,46,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={WC.warn} strokeWidth="2"><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>
            </div>
            <h3 style={{ margin: 0, fontFamily: "'Newsreader',serif", fontSize: 20, fontWeight: 500, color: WC.ink }}>Test run recommended</h3>
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: WC.ink4 }}>
            You haven’t tested “{title}” yet. A quick test run confirms the steps work and grants the tool access it needs before it goes on a schedule.
          </p>
        </div>
        <div style={{ padding: '0 24px 22px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onSaveAnyway} style={{ background: 'transparent', border: `1px solid rgba(${WC.inkRGB},0.16)`, borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, color: WC.ink3, cursor: 'pointer' }}>Save anyway</button>
          <button onClick={onRunTest} style={{ display: 'flex', alignItems: 'center', gap: 7, background: WC.accent, color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <div style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '8px solid #fff', flex: 'none' }} />
            <span>Run test now</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default SaveGuard;
