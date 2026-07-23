import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion } from 'framer-motion';
import { Search, Hammer, Globe, CalendarClock, FolderGit2, Sparkles, ArrowUp, Image as ImageIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useAppSelector } from '@/shared/hooks';
import {
  hasModelConnected,
  hasFreeTrialActive,
} from '@/app/components/Onboarding/steps/skipPredicates';

// Empty canvas, styled after ChatGPT / Claude / Manus: a short question, a centered composer as the HERO, then a few TAILORED, icon-led suggestions (the onboarding scan wrote them), never abstract category buttons. Font sizes come from the shared type scale so it reads clean.
type Suggestion = { title: string; prompt: string };

const FALLBACK_SUGGESTIONS: Suggestion[] = [
  { title: 'Research something and give me a clear comparison', prompt: 'Research a topic I care about and give me a tight, current comparison with dated sources. Ask me the topic first if you need to.' },
  { title: 'Build me a small app I can use right now', prompt: 'Build me a simple, useful app I can use right now, and drop it on my canvas.' },
  { title: 'Send an agent to find something on the web', prompt: 'Open a real website and do a multi-step task for me, then report what you found.' },
];

// Give each suggestion a leading icon inferred from what it does, so the list reads like real actions (the way ChatGPT tags suggestions with app icons) instead of a wall of identical rows.
function iconForStarter(text: string): LucideIcon {
  const t = text.toLowerCase();
  if (/screenshot|image|photo|gallery|frame/.test(t)) return ImageIcon;
  if (/schedule|daily|brief|weekly|morning|every day/.test(t)) return CalendarClock;
  if (/build|app|tool|make me|dashboard/.test(t)) return Hammer;
  if (/web|browse|site|online|flight|price|open a/.test(t)) return Globe;
  if (/project|repo|readme|codebase/.test(t)) return FolderGit2;
  if (/research|compare|find|look up|best|search/.test(t)) return Search;
  return Sparkles;
}

const DashboardEmptyState: React.FC<{
  c: ClaudeTokens;
  onLaunch?: (prompt: string, mode: string, model: string) => void;
  onStarter?: (prompt: string, mode?: string) => void;
}> = ({ c, onLaunch, onStarter }) => {
  const model = useAppSelector((s) => s.settings.data.default_model);
  const mode = useAppSelector((s) => s.settings.data.default_mode);
  const canRun = useAppSelector((s) => hasFreeTrialActive(s) || hasModelConnected(s));
  const personalized = useAppSelector((s) => s.settings.data.personalized_starters ?? []);
  const [text, setText] = React.useState('');
  const [launching, setLaunching] = React.useState(false);

  const launch = (prompt: string) => {
    const p = prompt.trim();
    if (launching || !p) return;
    if (onLaunch) { setLaunching(true); onLaunch(p, mode, model); return; }
    if (onStarter) onStarter(p);
  };

  const suggestions: Suggestion[] = personalized.length > 0
    ? personalized.slice(0, 4).map((s) => ({ title: s.title, prompt: s.prompt }))
    : FALLBACK_SUGGESTIONS;

  return (
    <Box
      sx={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none', px: 3,
      }}
    >
      {/* Swallow pointerdown so the canvas's pan/marquee handler doesn't preventDefault the press and
          steal focus from the composer, that's why clicking the input did nothing. Clicks/typing still work. */}
      <Box
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        sx={{ width: '100%', maxWidth: 620, pointerEvents: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        <Typography sx={{ color: c.text.primary, fontSize: c.font.size.display, fontWeight: 600, textAlign: 'center', letterSpacing: '-0.01em', mb: 3 }}>
          What do you want done?
        </Typography>

        {canRun && !!onLaunch ? (
          <>
            {/* The hero: a real composer you can just start typing into. Fixed-dark to match the app's
                floating chrome (sidebar, pills, chat cards), not a stark white box that fights the canvas. */}
            <Box
              sx={{
                display: 'flex', alignItems: 'center', gap: 1,
                background: 'rgba(22,12,34,0.72)',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: '16px',
                px: 2, py: 1.25, boxShadow: '0 12px 34px rgba(0,0,0,0.32)', mb: 2.5,
                transition: 'border-color 150ms, box-shadow 150ms',
                '&:focus-within': { borderColor: 'rgba(255,255,255,0.28)' },
              }}
            >
              <Box
                component="input"
                value={text}
                autoFocus
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); launch(text); setText(''); }
                }}
                placeholder="Ask me anything..."
                disabled={launching}
                sx={{
                  flex: 1, border: 'none', outline: 'none', bgcolor: 'transparent',
                  color: 'rgba(255,255,255,0.92)', fontFamily: 'inherit', fontSize: c.font.size.md,
                  '&::placeholder': { color: 'rgba(255,255,255,0.45)' },
                }}
              />
              <Box
                component="button"
                aria-label="Send"
                onClick={() => { launch(text); setText(''); }}
                disabled={launching || !text.trim()}
                sx={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  width: 32, height: 32, borderRadius: '50%', border: 'none',
                  bgcolor: text.trim() ? c.accent.primary : 'rgba(255,255,255,0.12)',
                  color: text.trim() ? '#fff' : 'rgba(255,255,255,0.5)',
                  cursor: text.trim() ? 'pointer' : 'default',
                  transition: 'background 150ms, color 150ms',
                }}
              >
                <ArrowUp size={17} />
              </Box>
            </Box>

            {/* Tailored, icon-led suggestions. */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {suggestions.map((s, i) => {
                const Ic = iconForStarter(`${s.title} ${s.prompt}`);
                return (
                  <Box
                    key={s.title}
                    component={motion.button}
                    onClick={() => launch(s.prompt)}
                    disabled={launching}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, delay: 0.05 + i * 0.05 }}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 1.5, textAlign: 'left', width: '100%',
                      px: 1.75, py: 1.25, borderRadius: '12px',
                      border: `1px solid transparent`, background: 'transparent',
                      color: c.text.secondary, fontFamily: 'inherit', fontSize: c.font.size.base,
                      cursor: launching ? 'default' : 'pointer',
                      transition: 'background 150ms, border-color 150ms',
                      '&:hover': launching ? {} : { background: c.bg.surface, borderColor: c.border.subtle },
                    }}
                  >
                    <Ic size={17} style={{ color: c.text.muted, flexShrink: 0 }} />
                    {s.title}
                  </Box>
                );
              })}
            </Box>
          </>
        ) : (
          <Typography sx={{ color: c.text.ghost, fontSize: c.font.size.base, textAlign: 'center' }}>
            Connect a model in Settings to get started.
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export default DashboardEmptyState;
