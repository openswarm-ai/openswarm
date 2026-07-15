import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Dices } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { ProviderIdentity } from '../onboardingV3Api';
import BeatShell from './BeatShell';

const EPITHETS = [
  'METHODICAL PERFECTIONIST', 'SAVORY ARCHIVIST', 'MIDNIGHT ORCHESTRATOR', 'GENTLE MAXIMALIST',
  'PRACTICAL DREAMER', 'QUIET POWER USER', 'CURIOUS CARTOGRAPHER', 'SWARM WHISPERER',
  'DELIBERATE TINKERER', 'WARM SYSTEMATIZER', 'PATIENT ACCELERATIONIST', 'ANALOG FUTURIST',
];

function nameFromIdentity(identity: ProviderIdentity[]): string {
  const email = identity.find((p) => p.email)?.email ?? '';
  const local = email.split('@')[0] ?? '';
  const letters = local.replace(/[^a-zA-Z]/g, '');
  if (!letters) return '';
  return letters.charAt(0).toUpperCase() + letters.slice(1, 12);
}

// The Arc Card moment: onboarding ends with an identity artifact, not a settings screen. Name is editable in place, the epithet re-rolls, and the leaf wears the accent they just picked.
const BeatCard: React.FC<{
  c: ClaudeTokens;
  identity: ProviderIdentity[];
  onFinish: (name: string | null) => void;
  onBack: () => void;
}> = ({ c, identity, onFinish, onBack }) => {
  const [name, setName] = useState(() => nameFromIdentity(identity));
  const seed = useMemo(() => Math.floor(Math.random() * EPITHETS.length), []);
  const [roll, setRoll] = useState(0);
  const epithet = EPITHETS[(seed + roll) % EPITHETS.length];
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), []);

  return (
    <BeatShell
      c={c}
      title={name ? `Welcome to OpenSwarm, ${name}.` : 'Welcome to OpenSwarm.'}
      body="Here's your Swarm Card. And with that, your canvas is ready."
      nextLabel="Get started"
      onNext={() => onFinish(name.trim() || null)}
      onBack={onBack}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <motion.div
          initial={{ opacity: 0, y: 22, rotate: -3, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 22, delay: 0.25 }}
          style={{
            width: 290, height: 400, borderRadius: 18, background: '#FCFBF5',
            boxShadow: '0 24px 60px rgba(0,0,0,0.28)', padding: '26px 24px', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', position: 'relative',
          }}
        >
          <div style={{
            width: 168, height: 158, alignSelf: 'flex-start',
            borderRadius: '6% 64% 6% 64%',
            background: `linear-gradient(135deg, ${c.accent.hover}, ${c.accent.primary} 70%, ${c.accent.pressed})`,
          }} />
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 18))}
            placeholder="Your name"
            style={{
              marginTop: 26, border: 'none', outline: 'none', background: 'transparent',
              fontSize: '1.7rem', fontWeight: 800, color: c.accent.pressed, fontFamily: 'inherit',
              width: '100%', padding: 0,
            }}
          />
          <div style={{ marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.68rem', letterSpacing: '0.14em', color: c.accent.primary }}>
            {epithet}
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.6rem', letterSpacing: '0.1em',
              color: c.accent.primary, border: `1px solid ${c.accent.primary}55`, borderRadius: 4, padding: '2px 7px',
            }}>
              OPENSWARM · {today.toUpperCase()}
            </span>
            <span style={{ fontSize: '0.6rem', letterSpacing: '0.06em', color: c.accent.pressed, fontWeight: 700, textAlign: 'right', lineHeight: 1.35 }}>
              OPEN<br />SWARM
            </span>
          </div>
        </motion.div>
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7 }}
          onClick={() => setRoll((r) => r + 1)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent',
            color: c.text.tertiary, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit', padding: 4,
          }}
        >
          <Dices size={15} /> Re-roll the title
        </motion.button>
      </div>
    </BeatShell>
  );
};

export default BeatCard;
