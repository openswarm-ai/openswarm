import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { STARTER_CATEGORIES } from '@/shared/starterCategories';

// Reads like a real chat welcome: a heading that types in, then a warm intro that leans on what
// only OpenSwarm can do (act right on your laptop), then the quick-reply chips. No em-dashes.
const HEADING = "Hi, I'm OpenSwarm, your personal AI team.";
const BODY =
  "I can do just about anything right on your laptop, so bring me anything: a tough problem, " +
  "a half-formed idea, something you need to write. We'll figure it out together. " +
  'Where do you want to start?';

// One-shot typewriter for a fixed string (no infinite loop; stops at the end). startDelayMs
// holds the start so the header title can stream first (sequential reveal).
function useTypewriter(text: string, speedMs = 38, startDelayMs = 0): { shown: string; done: boolean } {
  const [shown, setShown] = React.useState('');
  React.useEffect(() => {
    setShown('');
    let interval: number | undefined;
    const startTimer = window.setTimeout(() => {
      let i = 0;
      interval = window.setInterval(() => {
        i += 1;
        setShown(text.slice(0, i));
        if (i >= text.length) window.clearInterval(interval);
      }, speedMs);
    }, startDelayMs);
    return () => { window.clearTimeout(startTimer); if (interval) window.clearInterval(interval); };
  }, [text, speedMs, startDelayMs]);
  return { shown, done: shown.length >= text.length };
}

// First-run welcome. Two-level chips: category -> concrete prompts. Research/Write/Learn ->
// onPick (real run); Build -> onPickBuilder (App Builder). Pure UI; no run until the parent fires.
const WelcomeQuickReplies: React.FC<{
  c: ClaudeTokens;
  onPick: (prompt: string) => void;
  onPickBuilder: (prompt: string) => void;
}> = ({ c, onPick, onPickBuilder }) => {
  // Sequence: card pops, header title streams, heading types, THEN body + chips slide in.
  const { shown: heading, done: headingDone } = useTypewriter(HEADING, 38, 450);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const currentCategory = STARTER_CATEGORIES.find((cat) => cat.id === expanded);
  const isAppBuilder = currentCategory?.target === 'app-builder';
  const currentPrompts = currentCategory?.prompts ?? [];

  const pick = (prompt: string) => {
    if (isAppBuilder) onPickBuilder(prompt);
    else onPick(prompt);
  };

  return (
    <Box sx={{ px: 2.2, pt: 2.2, pb: 1.2, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
      <Typography sx={{ fontSize: '1.18rem', fontWeight: 600, color: c.text.primary, mb: 1, minHeight: '1.7rem', lineHeight: 1.4 }}>
        {heading}
      </Typography>

      {/* Body + chips slide up + fade in once the heading finishes. */}
      {headingDone && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <Typography sx={{ fontSize: '0.96rem', color: c.text.secondary, lineHeight: 1.6, mb: 2.4 }}>
            {BODY}
          </Typography>

          <AnimatePresence mode="wait" initial={false}>
            {expanded === null ? (
              <motion.div key="categories" initial={false} style={{ display: 'flex', flexDirection: 'column' }}>
                <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem', mb: 1.1 }}>
                  pick one, or just type below
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                  {STARTER_CATEGORIES.map((cat, i) => (
                    <motion.button
                      key={cat.id}
                      onClick={() => setExpanded(cat.id)}
                      initial={{ opacity: 0, scale: 0.86, y: 6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ type: 'spring', stiffness: 360, damping: 24, delay: 0.25 + i * 0.13 }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '10px 14px',
                        borderRadius: 13,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.secondary,
                        fontSize: '0.9rem', fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <cat.Icon size={16} />
                      {cat.label}
                    </motion.button>
                  ))}
                </Box>
              </motion.div>
            ) : (
              <motion.div
                key="specifics"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                style={{ display: 'flex', flexDirection: 'column' }}
              >
                <Box
                  component="button"
                  onClick={() => setExpanded(null)}
                  sx={{
                    display: 'inline-flex', alignItems: 'center', gap: 0.5,
                    alignSelf: 'flex-start', mb: 0.9, px: 0.6, py: 0.3,
                    border: 'none', background: 'transparent',
                    color: c.text.ghost, fontSize: '0.85rem',
                    cursor: 'pointer', fontFamily: 'inherit',
                    '&:hover': { color: c.text.secondary },
                  }}
                >
                  <ArrowLeft size={14} /> back
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.7 }}>
                  {currentPrompts.map((prompt, i) => (
                    <motion.button
                      key={prompt}
                      onClick={() => pick(prompt)}
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 420, damping: 26, delay: i * 0.06 }}
                      style={{
                        textAlign: 'left',
                        padding: '9px 14px',
                        borderRadius: 11,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.secondary,
                        fontSize: '0.88rem',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {prompt}
                    </motion.button>
                  ))}
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </Box>
  );
};

export default WelcomeQuickReplies;
