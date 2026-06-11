import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Hammer, PenLine, GraduationCap, ArrowLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useDashboardActive } from '@/shared/hooks/useDashboardActive';
import { useAppSelector } from '@/shared/hooks';
import {
  hasModelConnected,
  hasFreeTrialActive,
} from '@/app/components/Onboarding/steps/skipPredicates';
import ChatBubbleTeardrop from '../ChatBubbleTeardrop';

// Two-level starters: pick a category, then its concrete prompts spawn. Every
// prompt is one-click-runnable (no [placeholders]) and free-trial-safe, it
// touches the web or the App Builder sandbox, never the user's files.
// target 'app-builder' opens the App Builder (live preview) with the prompt
// auto-sent; the rest run as a normal agent on the dashboard.
type StarterCategory = { id: string; label: string; Icon: LucideIcon; prompts: string[]; target?: 'app-builder' };
const STARTER_CATEGORIES: StarterCategory[] = [
  {
    id: 'research', label: 'Research', Icon: Search,
    prompts: [
      'Find today\'s top news and summarize it for me',
      'Compare the 3 best standing desks and recommend one',
      'Plan a weekend trip to Tokyo with a day-by-day itinerary',
      'Find the highest-rated wireless earbuds under $100',
    ],
  },
  {
    id: 'build', label: 'Build', Icon: Hammer, target: 'app-builder',
    prompts: [
      'Build a focus timer that dings when the break starts',
      'Make a tip calculator that splits the bill',
      'Create a Snake game I can play right now',
      'Build a daily habit tracker with a streak counter',
    ],
  },
  {
    id: 'write', label: 'Write', Icon: PenLine,
    prompts: [
      'Write a friendly email introducing myself to a new client',
      'Turn my rough notes into a polished update',
      'Write a product description for a coffee mug',
      'Write a short poem about the sea',
    ],
  },
  {
    id: 'learn', label: 'Learn', Icon: GraduationCap,
    prompts: [
      'Explain how AI chatbots actually work, in plain English',
      'Teach me the basics of investing in 5 minutes',
      'Explain the stock market like I\'m five',
      'Give me a 5-minute crash course on climate change',
    ],
  },
];

const DashboardEmptyState: React.FC<{
  c: ClaudeTokens;
  onLaunch?: (prompt: string, mode: string, model: string) => void;
}> = ({ c, onLaunch }) => {
  // The host hides Dashboard with visibility:hidden (not display:none), which keeps
  // CSS animations ticking; gate on active so the shimmer only burns while watched.
  const active = useDashboardActive();
  const model = useAppSelector((s) => s.settings.data.default_model);
  const mode = useAppSelector((s) => s.settings.data.default_mode);
  const canRun = useAppSelector((s) => hasFreeTrialActive(s) || hasModelConnected(s));
  const navigate = useNavigate();
  const [launching, setLaunching] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [hoveredPrompt, setHoveredPrompt] = React.useState<string | null>(null);
  const currentCategory = STARTER_CATEGORIES.find((cat) => cat.id === expanded);
  const currentPrompts = currentCategory?.prompts ?? [];

  // Only offer chips once a run can actually succeed (free trial armed or a real
  // model connected); otherwise fall back to the plain hint.
  const showChips = !!onLaunch && canRun;

  const launch = (prompt: string) => {
    if (launching) return;
    // Build prompts open the App Builder (live preview) with the prompt auto-sent.
    if (currentCategory?.target === 'app-builder') {
      navigate(`/apps/new?prompt=${encodeURIComponent(prompt)}`);
      return;
    }
    if (!onLaunch) return;
    setLaunching(true); // empty state unmounts on first session, but guard a fast double-click
    onLaunch(prompt, mode, model);
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
      <style>{`@keyframes empty-state-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <Typography sx={{ color: c.text.tertiary, fontSize: '1.25rem', mb: 1 }}>
        No agents running
      </Typography>
      <Typography
        sx={{
          fontSize: '1rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.7,
          background: `linear-gradient(90deg, ${c.text.ghost} 0%, ${c.text.ghost} 40%, ${c.text.primary} 50%, ${c.text.ghost} 60%, ${c.text.ghost} 100%)`,
          backgroundSize: '200% 100%',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          color: 'transparent',
          animation: active ? 'empty-state-shimmer 6s linear infinite' : 'none',
        }}
      >
        Click the
        {/* Literal toolbar glyph; the shimmer's transparent color would hide it, so reset color here. */}
        <Box component="span" sx={{ display: 'inline-flex', color: c.text.tertiary }}>
          <ChatBubbleTeardrop sx={{ fontSize: 15 }} />
        </Box>
        below to launch your first agent
      </Typography>

      {showChips && (
        <Box sx={{ mt: 3, width: '100%', maxWidth: 560, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <AnimatePresence mode="wait" initial={false}>
            {expanded === null ? (
              <motion.div
                key="categories"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
              >
                <Typography sx={{ color: c.text.ghost, fontSize: '0.9rem', mb: 1.4 }}>
                  or try one of these
                </Typography>
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
                        color: c.text.secondary,
                        fontSize: '0.98rem', fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit',
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
                <Box
                  onMouseLeave={() => setHoveredPrompt(null)}
                  sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0.9, width: '100%', maxWidth: 480 }}
                >
                  {currentPrompts.map((prompt) => (
                    <Box
                      component="button"
                      key={prompt}
                      onClick={() => launch(prompt)}
                      onMouseEnter={() => setHoveredPrompt(prompt)}
                      disabled={launching}
                      sx={{
                        textAlign: 'left',
                        px: 1.8, py: 1.1,
                        borderRadius: 2,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.secondary,
                        fontSize: '0.95rem',
                        cursor: launching ? 'default' : 'pointer',
                        opacity: launching ? 0.5 : 1,
                        fontFamily: 'inherit',
                        transition: 'background 150ms, border-color 150ms',
                        '&:hover': launching ? {} : { background: c.bg.elevated, borderColor: c.border.strong },
                      }}
                    >
                      {prompt}
                    </Box>
                  ))}

                  {/* Hover preview: a translucent ghost of the chat that would open,
                      so the user sees their message land before committing. Pure
                      divs (not the heavy AgentChat), so it costs nothing to render. */}
                  <AnimatePresence>
                    {hoveredPrompt && (
                      <Box
                        component={motion.div}
                        key="ghost"
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 0.72, x: 0 }}
                        exit={{ opacity: 0, x: -8 }}
                        transition={{ duration: 0.16 }}
                        sx={{
                          position: 'absolute',
                          left: '100%', top: '50%', ml: 3,
                          transform: 'translateY(-50%)',
                          width: 300,
                          pointerEvents: 'none',
                          bgcolor: c.bg.surface,
                          border: `1px solid ${c.border.medium}`,
                          borderRadius: 3,
                          boxShadow: c.shadow.md,
                          p: 1.5,
                        }}
                      >
                        <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.tertiary, mb: 1.2 }}>
                          New chat
                        </Typography>
                        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <Box sx={{ maxWidth: '88%', bgcolor: c.bg.elevated, borderRadius: 2.5, px: 1.4, py: 0.9 }}>
                            <Typography sx={{ fontSize: '0.85rem', color: c.text.primary, lineHeight: 1.4 }}>
                              {hoveredPrompt}
                            </Typography>
                          </Box>
                        </Box>
                      </Box>
                    )}
                  </AnimatePresence>
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
        </Box>
      )}
    </Box>
  );
};

export default DashboardEmptyState;
