import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Hammer, Globe, CalendarClock, FolderGit2, Sparkles, ArrowUp, ArrowLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useAppSelector } from '@/shared/hooks';
import {
  hasModelConnected,
  hasFreeTrialActive,
} from '@/app/components/Onboarding/steps/skipPredicates';
import { HERO_CATEGORIES, heroMenuFor, type HeroCategoryId } from './heroMenu';
import type { PersonalizedStarter } from '@/shared/state/settingsSlice';

// Identity-stable fallback so an absent settings field can't re-render this per store tick.
const EMPTY_STARTERS: PersonalizedStarter[] = [];

// Empty canvas, styled after ChatGPT / Claude / Manus: a short question, a centered composer as the
// HERO, then a two-level menu: 4 GENERAL things OpenSwarm can do, each drilling into 4 SPECIFIC
// starters tailored to this user (onboarding prep wrote them). Font sizes ride the shared type scale.

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

// The placeholder cycles agentic invitations with a typewriter feel (only while the field is empty),
// so the hero reads like an agent offering to go DO things, not a search box waiting for keywords.
// Seven lines of prompt, then it scrolls: enough to see a whole paragraph without the hero eating the starters below it.
const COMPOSER_MAX_H = 176;

const GHOST_DEFAULTS = [
  'Send an agent to find me something great...',
  'Build me a tool I can use right now...',
  'Research something and report back...',
  'Watch a site and tell me when it changes...',
];

function useTypedGhost(lines: string[], active: boolean): string {
  const [out, setOut] = React.useState('');
  React.useEffect(() => {
    if (!active || lines.length === 0) return undefined;
    let li = 0; let ci = 0; let deleting = false;
    const id = window.setInterval(() => {
      const line = lines[li % lines.length];
      if (!deleting) {
        ci += 1;
        if (ci >= line.length + 24) deleting = true; // linger fully typed ~1s
      } else {
        ci -= 3;
        if (ci <= 0) { deleting = false; ci = 0; li += 1; }
      }
      setOut(line.slice(0, Math.min(ci, line.length)));
    }, 45);
    return () => window.clearInterval(id);
  }, [lines, active]);
  return out;
}

const DashboardEmptyState: React.FC<{
  c: ClaudeTokens;
  onLaunch?: (prompt: string, mode: string, model: string) => void;
  onStarter?: (prompt: string, mode?: string) => void;
}> = ({ c, onLaunch, onStarter }) => {
  const model = useAppSelector((s) => s.settings.data.default_model);
  const mode = useAppSelector((s) => s.settings.data.default_mode);
  const canRun = useAppSelector((s) => hasFreeTrialActive(s) || hasModelConnected(s));
  const settingsKnown = useAppSelector((s) => s.settings.loaded);
  const personalized = useAppSelector((s) => s.settings.data.personalized_starters) ?? EMPTY_STARTERS;
  const personalizedMenu = useAppSelector((s) => s.settings.data.personalized_menu ?? null);
  const userName = useAppSelector((s) => s.settings.data.user_name ?? null);
  const [text, setText] = React.useState('');
  const [launching, setLaunching] = React.useState(false);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const [openCat, setOpenCat] = React.useState<HeroCategoryId | null>(null);
  const menu = React.useMemo(() => heroMenuFor(personalizedMenu, personalized), [personalizedMenu, personalized]);
  const firstName = (userName ?? '').trim().split(/\s+/)[0] || null;
  const headline = firstName ? `What should we get done, ${firstName}?` : 'What do you want done?';
  const ghostLines = React.useMemo(
    () => (personalized.length > 0 ? [...personalized.slice(0, 3).map((s) => `${s.title}...`), ...GHOST_DEFAULTS.slice(0, 2)] : GHOST_DEFAULTS),
    [personalized],
  );
  const ghost = useTypedGhost(ghostLines, text.length === 0 && canRun);
  // Height follows the value, so a long prompt wraps into view instead of scrolling sideways, and
  // clearing on send snaps it back to one line. Past the cap it scrolls, like every other composer.
  React.useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`;
  }, [text]);

  const launch = (prompt: string) => {
    const p = prompt.trim();
    if (launching || !p) return;
    if (onLaunch) { setLaunching(true); onLaunch(p, mode, model); return; }
    if (onStarter) onStarter(p);
  };

  const openCategory = openCat ? HERO_CATEGORIES.find((cat) => cat.id === openCat) ?? null : null;

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
          {headline}
        </Typography>

        {canRun && !!onLaunch ? (
          <>
            {/* The hero: a real composer you can just start typing into. Fixed-dark to match the app's
                floating chrome (sidebar, pills, chat cards), not a stark white box that fights the canvas. */}
            <Box
              sx={{
                display: 'flex', alignItems: 'flex-end', gap: 1,
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
                component="textarea"
                ref={fieldRef}
                rows={1}
                value={text}
                autoFocus
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); launch(text); setText(''); }
                }}
                placeholder={ghost || "Ask me anything..."}
                disabled={launching}
                sx={{
                  flex: 1, border: 'none', outline: 'none', bgcolor: 'transparent', resize: 'none',
                  color: 'rgba(255,255,255,0.92)', fontFamily: 'inherit', fontSize: c.font.size.md,
                  lineHeight: '24px', py: '4px', maxHeight: `${COMPOSER_MAX_H}px`, overflowY: 'auto',
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

            {/* Two levels: 4 general things it can do, each opening 4 starters tailored to this user. */}
            <AnimatePresence mode="wait" initial={false}>
              {openCategory === null ? (
                <motion.div
                  key="categories"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.16 }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  {HERO_CATEGORIES.map((cat, i) => (
                    <Box
                      key={cat.id}
                      component={motion.button}
                      onClick={() => setOpenCat(cat.id)}
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
                        '&:hover': launching ? {} : { background: c.bg.surface, borderColor: c.border.subtle, '& .osw-hero-chev': { opacity: 1, transform: 'none' } },
                      }}
                    >
                      <cat.Icon size={17} style={{ color: c.text.muted, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{cat.label}</span>
                      <ChevronRight className="osw-hero-chev" size={15} style={{ color: c.text.ghost, flexShrink: 0, opacity: 0, transform: 'translateX(-4px)', transition: 'opacity 150ms, transform 150ms' }} />
                    </Box>
                  ))}
                </motion.div>
              ) : (
                <motion.div
                  key={openCategory.id}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.16 }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <Box
                    component="button"
                    onClick={() => setOpenCat(null)}
                    sx={{
                      display: 'inline-flex', alignItems: 'center', gap: 0.75, alignSelf: 'flex-start',
                      px: 1.75, py: 0.5, border: 'none', background: 'transparent',
                      color: c.text.ghost, fontFamily: 'inherit', fontSize: c.font.size.sm,
                      cursor: 'pointer', '&:hover': { color: c.text.secondary },
                    }}
                  >
                    <ArrowLeft size={14} /> {openCategory.label}
                  </Box>
                  {menu[openCategory.id].map((s, i) => {
                    const Ic = iconForStarter(`${s.title} ${s.prompt}`);
                    return (
                      <Box
                        key={s.title}
                        component={motion.button}
                        onClick={() => launch(s.prompt)}
                        disabled={launching}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, delay: 0.03 + i * 0.045 }}
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
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : (
          <Typography sx={{ color: c.text.ghost, fontSize: c.font.size.base, textAlign: 'center' }}>
            {/* With the backend down we don't know what the user has connected, so don't tell them they have nothing. */}
            {settingsKnown ? 'Connect a model in Settings to get started.' : 'Waiting for the OpenSwarm backend...'}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export default DashboardEmptyState;
