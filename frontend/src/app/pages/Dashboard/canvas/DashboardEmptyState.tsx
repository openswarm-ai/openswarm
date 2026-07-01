import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { font } from '@/shared/styles/typography';
import { useAppSelector } from '@/shared/hooks';
import {
  hasModelConnected,
  hasFreeTrialActive,
} from '@/app/components/Onboarding/steps/skipPredicates';
import { STARTER_CATEGORIES } from '@/shared/starterCategories';

// Returning-user empty state (the first-run greeting now lives in the auto-popped welcome chat). Quiet: a one-line prompt + the shared starter chips for users who can run, or a connect-a-model hint for users who can't. Two-level: category -> concrete prompts.
const DashboardEmptyState: React.FC<{
  c: ClaudeTokens;
  onLaunch?: (prompt: string, mode: string, model: string) => void;
  onStarter?: (prompt: string, mode?: string) => void;
}> = ({ c, onLaunch, onStarter }) => {
  const model = useAppSelector((s) => s.settings.data.default_model);
  const mode = useAppSelector((s) => s.settings.data.default_mode);
  const canRun = useAppSelector((s) => hasFreeTrialActive(s) || hasModelConnected(s));
  const [launching, setLaunching] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const currentCategory = STARTER_CATEGORIES.find((cat) => cat.id === expanded);
  const currentPrompts = currentCategory?.prompts ?? [];

  const showChips = !!onLaunch && canRun;
  const isAppBuilder = currentCategory?.target === 'app-builder';

  const launch = (prompt: string) => {
    if (launching) return;
    if (isAppBuilder) {
      if (onStarter) onStarter(prompt, 'view-builder');
      return;
    }
    if (onLaunch) {
      setLaunching(true);
      onLaunch(prompt, mode, model);
      return;
    }
    if (onStarter) onStarter(prompt);
  };

  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <Typography sx={{ color: c.text.primary, fontFamily: font.display, fontSize: '1.5rem', fontWeight: 500, lineHeight: 1.1, letterSpacing: 0, mb: 2.5, textAlign: 'center' }}>
        What do you want done?
      </Typography>

      {showChips ? (
        <Box sx={{ width: '100%', maxWidth: 560, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <AnimatePresence mode="wait" initial={false}>
            {expanded === null ? (
              <motion.div
                key="categories"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
              >
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.2, width: '100%', maxWidth: 460 }}>
                  {STARTER_CATEGORIES.map((cat) => (
                    <Box
                      component="button"
                      key={cat.id}
                      onClick={() => setExpanded(cat.id)}
                      sx={{
                        display: 'flex', alignItems: 'center', gap: 1.1,
                        px: 1.9, py: 1.3,
                        borderRadius: 2.5,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.primary,
                        fontSize: '1.05rem', fontWeight: 400, lineHeight: 1.25,
                        cursor: 'pointer', fontFamily: font.paragraph,
                        transition: 'background 150ms, border-color 150ms',
                        '&:hover': { background: c.bg.elevated, borderColor: c.border.strong },
                      }}
                    >
                      <cat.Icon size={18} />
                      {cat.label}
                    </Box>
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
                style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
              >
                <Box
                  component="button"
                  onClick={() => setExpanded(null)}
                  sx={{
                    display: 'inline-flex', alignItems: 'center', gap: 0.5,
                    mb: 1.2, px: 1, py: 0.4,
                    border: 'none', background: 'transparent',
                    color: c.text.ghost, fontSize: '0.9rem',
                    cursor: 'pointer', fontFamily: 'inherit',
                    '&:hover': { color: c.text.secondary },
                  }}
                >
                  <ArrowLeft size={15} /> back
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.9, width: '100%', maxWidth: 480 }}>
                  {currentPrompts.map((prompt) => (
                    <Box
                      component="button"
                      key={prompt}
                      onClick={() => launch(prompt)}
                      disabled={launching}
                      sx={{
                        textAlign: 'left',
                        px: 1.8, py: 1.1,
                        borderRadius: 2,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.primary,
                        fontSize: '1.02rem',
                        fontWeight: 400,
                        lineHeight: 1.35,
                        cursor: launching ? 'default' : 'pointer',
                        opacity: launching ? 0.5 : 1,
                        fontFamily: font.paragraph,
                        transition: 'background 150ms, border-color 150ms',
                        '&:hover': launching ? {} : { background: c.bg.elevated, borderColor: c.border.strong },
                      }}
                    >
                      {prompt}
                    </Box>
                  ))}
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
        </Box>
      ) : (
        <Typography sx={{ color: c.text.ghost, fontSize: '0.95rem' }}>
          Connect a model in Settings to get started.
        </Typography>
      )}
    </Box>
  );
};

export default DashboardEmptyState;
