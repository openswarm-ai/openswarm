import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { useAppSelector } from '@/shared/hooks';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { STARTER_CATEGORIES } from '@/shared/starterCategories';
import AutomationChips from '@/app/components/nudges/AutomationChips';

// The always-present 4th option for anyone who doesn't see themselves in the 3 tailored starters: a warm,
// no-personalization-needed "just start talking" that asks OpenSwarm to show what it can do on their machine.
const ANCHOR_PROMPT = "I'm new to OpenSwarm. Show me a few concrete things you could do for me right now on my computer, then pick the single most useful one and actually do it as a quick demo.";

const AnchorButton: React.FC<{ c: ClaudeTokens; onPick: (p: string) => void; delay?: number }> = ({ c, onPick, delay = 0 }) => (
  <motion.button
    onClick={() => onPick(ANCHOR_PROMPT)}
    initial={{ opacity: 0, scale: 0.92 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ type: 'spring', stiffness: 420, damping: 26, delay }}
    style={{
      display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', width: '100%',
      padding: '10px 14px', borderRadius: 11,
      border: `1px solid ${c.border.medium}`, background: c.bg.surface,
      color: c.text.secondary, fontSize: '0.88rem', fontWeight: 500,
      cursor: 'pointer', fontFamily: 'inherit',
    }}
  >
    <Sparkles size={15} color={c.accent.primary} style={{ flexShrink: 0 }} />
    Not sure? Show me what you can do
  </motion.button>
);

// Quick-reply chips that sit UNDER the streamed greeting bubble. Two levels: category -> concrete prompts. Research/Write/Learn -> onPick (real run); Build -> onPickBuilder (prefill). The greeting itself is a real streamed assistant message (see useWelcomeGreeting); this is just the follow-up affordance. Pure UI, no run until the parent fires.
const WelcomeQuickReplies: React.FC<{
  c: ClaudeTokens;
  onPick: (prompt: string) => void;
  onPickBuilder: (prompt: string) => void;
}> = ({ c, onPick, onPickBuilder }) => {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  // Onboarding v3's prep wrote starters about THIS user's machine and apps; they lead, generic categories demote to "More ideas". Show the top 3 tailored + the always-present anchor = 4 options (prep returns 4, so we keep the strongest three and let the anchor be the fourth).
  const personalized = useAppSelector((s) => (s.settings.data.personalized_starters ?? []).slice(0, 3));
  const [showCategories, setShowCategories] = React.useState(personalized.length === 0);
  const currentCategory = STARTER_CATEGORIES.find((cat) => cat.id === expanded);
  const isAppBuilder = currentCategory?.target === 'app-builder';
  const isSchedule = currentCategory?.target === 'schedule';
  const currentPrompts = currentCategory?.prompts ?? [];

  const pick = (prompt: string) => {
    if (isAppBuilder) onPickBuilder(prompt);
    else onPick(prompt);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      style={{ padding: '4px 18px 8px 18px', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {!showCategories && expanded === null ? (
          <motion.div key="personal" initial={false} style={{ display: 'flex', flexDirection: 'column' }}>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem', mb: 1.1 }}>
              made for you, or just type below
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.7 }}>
              {personalized.map((s, i) => (
                <motion.button
                  key={s.title}
                  onClick={() => onPick(s.prompt)}
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 26, delay: 0.08 + i * 0.06 }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                    padding: '10px 14px', borderRadius: 11,
                    border: `1px solid ${c.border.medium}`, background: c.bg.surface,
                    color: c.text.secondary, fontSize: '0.88rem', fontWeight: 500,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {s.title}
                </motion.button>
              ))}
              <AnchorButton c={c} onPick={onPick} delay={0.08 + personalized.length * 0.06} />
            </Box>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.78rem', mt: 1.4, mb: 0.6 }}>
              worth putting on a schedule
            </Typography>
            <AutomationChips c={c} />
            <Box
              component="button"
              onClick={() => setShowCategories(true)}
              sx={{
                alignSelf: 'flex-start', mt: 0.9, px: 0.6, py: 0.3,
                border: 'none', background: 'transparent',
                color: c.text.ghost, fontSize: '0.82rem',
                cursor: 'pointer', fontFamily: 'inherit',
                '&:hover': { color: c.text.secondary },
              }}
            >
              More ideas
            </Box>
          </motion.div>
        ) : expanded === null ? (
          <motion.div key="categories" initial={false} style={{ display: 'flex', flexDirection: 'column' }}>
            {personalized.length > 0 && (
              <Box
                component="button"
                onClick={() => setShowCategories(false)}
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.5,
                  alignSelf: 'flex-start', mb: 0.9, px: 0.6, py: 0.3,
                  border: 'none', background: 'transparent',
                  color: c.text.ghost, fontSize: '0.85rem',
                  cursor: 'pointer', fontFamily: 'inherit',
                  '&:hover': { color: c.text.secondary },
                }}
              >
                <ArrowLeft size={14} /> your starters
              </Box>
            )}
            <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem', mb: 1.1 }}>
              pick one, or just type below
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              {STARTER_CATEGORIES.map((cat, i) => (
                <motion.button
                  key={cat.id}
                  onClick={() => setExpanded(cat.id)}
                  initial={{ opacity: 0, scale: 0.9, y: 5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 24, delay: 0.08 + i * 0.07 }}
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
            {personalized.length === 0 && (
              <Box sx={{ mt: 1 }}>
                <AnchorButton c={c} onPick={onPick} delay={0.08 + STARTER_CATEGORIES.length * 0.07} />
              </Box>
            )}
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
            {isSchedule ? (
              <>
                <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem', mb: 1.1 }}>
                  one click puts it on a schedule
                </Typography>
                <AutomationChips c={c} />
              </>
            ) : (
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
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default WelcomeQuickReplies;
