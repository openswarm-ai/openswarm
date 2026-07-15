import React from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { INTEGRATIONS } from '@/app/pages/Tools/integrations';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import BeatShell from './BeatShell';

// Order matters: the first row should read as "your work lives here" for the widest audience.
const PICKER_IDS = ['google-workspace', 'notion', 'slack', 'github', 'discord', 'microsoft-365', 'reddit', 'youtube', 'x', 'airtable', 'hubspot', 'tiktok'];

// Picks do double duty: they brief the prep call on what this person's work looks like, and they seed which integrations we suggest connecting later. Nothing installs here; the MCP gate stays untouched. Staged inside a miniature OpenSwarm window (Zen's diegetic picker) so the canvas metaphor lands before the canvas exists.
const BeatApps: React.FC<{
  c: ClaudeTokens;
  picks: string[];
  setPicks: (ids: string[]) => void;
  onNext: () => void;
  onBack: () => void;
}> = ({ c, picks, setPicks, onNext, onBack }) => {
  const entries = PICKER_IDS
    .map((id) => INTEGRATIONS.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i);

  const toggle = (id: string) => {
    setPicks(picks.includes(id) ? picks.filter((p) => p !== id) : [...picks, id]);
  };

  return (
    <BeatShell
      c={c}
      title="Choose the apps you live in."
      body="I'll shape your starting canvas around them, and I can connect to them later so your agents work where you already do."
      nextLabel={picks.length > 0 ? 'Continue' : 'Skip for now'}
      onNext={onNext}
      onBack={onBack}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 24, delay: 0.2 }}
        style={{
          width: 'min(600px, 100%)', borderRadius: 14, background: c.bg.surface,
          border: `1px solid ${c.border.medium}`, boxShadow: '0 18px 50px rgba(0,0,0,0.22)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', borderBottom: `1px solid ${c.border.subtle}`, background: c.bg.elevated }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 10, height: 10, borderRadius: 999, background: c.border.strong }} />
          ))}
          <span style={{ marginLeft: 8, fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, letterSpacing: '0.04em' }}>OpenSwarm</span>
        </div>
        <div style={{ padding: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))', gap: 11 }}>
          {entries.map((entry, i) => {
            const picked = picks.includes(entry.id);
            return (
              <motion.button
                key={entry.id}
                onClick={() => toggle(entry.id)}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 360, damping: 24, delay: 0.28 + i * 0.035 }}
                style={{
                  position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9,
                  padding: '16px 8px 12px', borderRadius: c.radius.md,
                  border: `1.5px solid ${picked ? c.accent.primary : c.border.medium}`,
                  background: c.bg.surface, cursor: 'pointer', fontFamily: 'inherit',
                  boxShadow: picked ? `0 0 0 3px ${c.accent.primary}22` : c.shadow.sm,
                  transition: 'border-color 140ms ease, box-shadow 140ms ease',
                }}
              >
                {picked && (
                  <span style={{ position: 'absolute', top: 6, right: 6, width: 17, height: 17, borderRadius: 999, background: c.accent.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Check size={11} color="#fff" />
                  </span>
                )}
                <span style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{entry.icon}</span>
                <span style={{ fontSize: '0.78rem', fontWeight: 500, color: c.text.secondary, textAlign: 'center' }}>{entry.name}</span>
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </BeatShell>
  );
};

export default BeatApps;
