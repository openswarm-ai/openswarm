import React from 'react';
import Box from '@mui/material/Box';
import { GLASS_SURFACE, GLASS_SURFACE_BLUR } from '@/shared/styles/glassSurface';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import DashboardGlyph from '../canvas/DashboardGlyph';
import ShowUiWidgetView from '@/app/pages/AgentChat/tool-ui/ShowUiWidgetView';
import AskUiBubble from '@/app/pages/AgentChat/tool-ui/AskUiBubble';
import PillArtifactFrame from './PillArtifactFrame';
import type { ToolPair } from '@/app/pages/AgentChat/tool-bubbles/ToolCallBubble';
import { artifactName, type ShowUiPayload } from '@/app/pages/AgentChat/tool-ui/showUiPayload';
import type { AgentTodoItem } from './agentTodos';
import type { AgentLiveStep } from './agentLiveSteps';
import { shimmerTextSx } from '@/app/pages/AgentChat/tool-bubbles/toolRowMotion';

interface AgentNarratorPillProps {
  label: string;
  running: boolean;
  todos: AgentTodoItem[] | null;
  /** Tool activity of the live turn, the transition phase between "Thinking" and the answer. */
  liveSteps: AgentLiveStep[] | null;
  artifact: ShowUiPayload | null;
  askPair?: ToolPair | null;
  sessionId?: string;
  browserShot: string | null;
  /** A live browser miniature is tucked under this pill; non-actionable artifacts yield to it. */
  browserDocked?: boolean;
  /** App quit mid-turn and this agent still owes a response; click resumes it (ENG-321). */
  interrupted?: boolean;
  onResumeInterrupted?: () => void;
  selected: boolean;
  highlighted: boolean;
}

const GLASS = GLASS_SURFACE;
const GLASS_BLUR = GLASS_SURFACE_BLUR;
const MAX_VISIBLE_TODOS = 4;

/** Collapsed agent as the desktop narrator pill; below it, the best artifact wins: live question > widget > browser shot > plan > live steps > Thinking. */
function AgentNarratorPill({ label, running, todos, liveSteps, artifact, askPair, sessionId, browserShot, browserDocked, interrupted, onResumeInterrupted, selected, highlighted }: AgentNarratorPillProps): React.ReactElement {
  const visibleTodos = (todos || []).slice(0, MAX_VISIBLE_TODOS);
  const hiddenCount = (todos?.length || 0) - visibleTodos.length;
  // Live tool steps window to the most recent, since earlier ones are history, not plan.
  const visibleSteps = running && !visibleTodos.length ? (liveSteps || []).slice(-MAX_VISIBLE_TODOS) : [];
  const earlierSteps = running && !visibleTodos.length ? Math.max(0, (liveSteps?.length || 0) - visibleSteps.length) : 0;
  const shownArtifact = artifact;
  const ring = selected || highlighted ? { outline: '2px solid #3b82f6', outlineOffset: '2px' } : undefined;
  const liveAsk = askPair && sessionId ? askPair : null;
  // One key per ladder state so a state CHANGE remounts the artifact and replays the one-shot entrance; nothing loops.
  // A docked live miniature owns the space below the pill: everything non-actionable yields to it
  // (interrupted and asks still win, and the ask case parks the miniature upstream anyway).
  const quiet = !!browserDocked && !interrupted && !liveAsk;
  const artifactKey = interrupted ? 'interrupted' : liveAsk ? `ask-${liveAsk.id}` : quiet ? 'none' : shownArtifact ? 'widget' : browserShot ? 'shot' : visibleTodos.length > 0 ? 'todos' : visibleSteps.length > 0 ? 'steps' : running ? 'thinking' : 'none';

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        '@keyframes osw-artifact-in': {
          from: { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
        '& .osw-artifact': {
          animation: 'osw-artifact-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        },
        '@media (prefers-reduced-motion: reduce)': {
          '& .osw-artifact': { animation: 'none' },
        },
      }}
    >
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          height: 34,
          pl: 1.25,
          pr: 1.75,
          borderRadius: 999,
          background: GLASS,
          backdropFilter: GLASS_BLUR,
          WebkitBackdropFilter: GLASS_BLUR,
          boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
          whiteSpace: 'nowrap',
          ...ring,
        }}
      >
        <DashboardGlyph name={label} size={15} color="rgba(255,255,255,0.85)" />
        <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500, color: 'rgba(255,255,255,0.92)' }}>
          {label}
        </Typography>
        {/* Is this agent still working? Collapsed is the ONE place you cannot tell, because the
            transcript is not on screen, and "Thinking..." only ever appeared as a last-resort
            fallback: a running agent showing a widget, todos or a browser shot had no status at all.
            This lives on the title row, which every pill always has, so it never moves and never
            competes with the content below it.
            Present = working, absent = done. Only marking the live ones keeps a row of finished
            cards completely quiet, which is the state most cards are in most of the time. */}
        {running && (
          <Box
            aria-label="Working"
            role="status"
            sx={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0, ml: 0.25,
              background: 'rgba(255,255,255,0.9)',
              animation: 'osw-pill-alive 1.6s ease-in-out infinite',
              '@keyframes osw-pill-alive': {
                '0%, 100%': { opacity: 0.35, transform: 'scale(0.85)' },
                '50%': { opacity: 1, transform: 'scale(1)' },
              },
              '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.9 },
            }}
          />
        )}
      </Box>

      {interrupted ? (
        // Interrupted wins the ladder: a chat that owes a response must read that from the BOARD,
        // not only after opening the card (ENG-321). 'stopped' covers user-stop AND app-restart
        // cuts with no persisted discriminator, so the copy stays true for both.
        <Box
          key={artifactKey}
          className="osw-artifact"
          role="button"
          aria-label="Resume this chat"
          onClick={(e) => { e.stopPropagation(); onResumeInterrupted?.(); }}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.25,
            py: 0.5,
            borderRadius: '999px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            background: 'rgba(30,27,24,0.85)',
            border: '1px solid rgba(245,158,11,0.55)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
            transition: 'background 0.15s ease, transform 0.15s ease',
            '&:hover': { background: 'rgba(48,40,28,0.95)', transform: 'translateY(-1px)' },
          }}
        >
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: '#f59e0b', flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: '#fbbf24', lineHeight: 1.6 }}>
            Interrupted
          </Typography>
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: 'rgba(251,191,36,0.75)', lineHeight: 1.6 }}>
            · Resume
          </Typography>
        </Box>
      ) : liveAsk ? (
        <PillArtifactFrame key={artifactKey} name="question">
          {/* One glass surface holds the whole ask (options + Confirm + the type-your-own field); without it the widget's footer floated bare on the canvas. */}
          <Box sx={{ borderRadius: '16px', background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR, boxShadow: '0 8px 24px rgba(0,0,0,0.32)', px: 1.25, py: 1.25 }}>
            <AskUiBubble pair={liveAsk} sessionId={sessionId!} isPending suppressReveal />
          </Box>
        </PillArtifactFrame>
      ) : quiet ? null : shownArtifact ? (
        <PillArtifactFrame key={artifactKey} name={artifactName(shownArtifact)}>
          <ShowUiWidgetView payload={shownArtifact} ambient />
        </PillArtifactFrame>
      ) : browserShot ? (
        <Box
          key={artifactKey}
          className="osw-artifact"
          component="img"
          src={browserShot}
          alt=""
          sx={{ width: 320, display: 'block', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}
        />
      ) : visibleTodos.length > 0 ? (
        <Box
          key={artifactKey}
          className="osw-artifact"
          sx={{
            borderRadius: '16px',
            background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR,
            boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
            px: 1.75,
            py: 1.5,
            minWidth: 200,
          }}
        >
          <Box sx={{ position: 'relative' }}>
            {visibleTodos.length > 1 && (
              <Box sx={{ position: 'absolute', left: 10, top: 12, bottom: 12, width: '2px', background: 'rgba(214,170,203,0.4)' }} />
            )}
            {visibleTodos.map((todo, i) => {
              const done = todo.status === 'completed';
              const active = todo.status === 'in_progress';
              return (
                <Box key={`${i}-${todo.content.slice(0, 24)}`} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.75 }}>
                  <Box
                    sx={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      flexShrink: 0,
                      zIndex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: done ? '#ecd2e4' : active ? '#cf9fc4' : 'rgba(207,159,196,0.35)',
                    }}
                  >
                    {done && <CheckIcon sx={{ fontSize: 14, color: '#3c2035' }} />}
                  </Box>
                  <Typography
                    sx={{
                      fontSize: '0.8125rem',
                      fontWeight: done || active ? 500 : 400,
                      color: done || active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.45)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: 260,
                    }}
                  >
                    {todo.content}
                  </Typography>
                </Box>
              );
            })}
          </Box>
          {hiddenCount > 0 && (
            <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', pl: '2px', pt: 0.5 }}>
              ... {hiddenCount} more
            </Typography>
          )}
        </Box>
      ) : visibleSteps.length > 0 ? (
        // The transition phase: real tool activity as a simple checklist while the turn works.
        <Box
          key={artifactKey}
          className="osw-artifact"
          sx={{
            borderRadius: '16px',
            background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR,
            boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
            px: 1.75,
            py: 1.5,
            minWidth: 200,
          }}
        >
          {earlierSteps > 0 && (
            <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', pl: '2px', pb: 0.5 }}>
              {earlierSteps} earlier step{earlierSteps === 1 ? '' : 's'}
            </Typography>
          )}
          <Box sx={{ position: 'relative' }}>
            {visibleSteps.length > 1 && (
              <Box sx={{ position: 'absolute', left: 10, top: 12, bottom: 12, width: '2px', background: 'rgba(255,255,255,0.18)' }} />
            )}
            {visibleSteps.map((step, i) => (
              <Box key={`${i}-${step.label.slice(0, 24)}`} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.75 }}>
                <Box
                  sx={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    flexShrink: 0,
                    zIndex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: step.done ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.28)',
                  }}
                >
                  {step.done && <CheckIcon sx={{ fontSize: 14, color: '#2a2a2a' }} />}
                </Box>
                <Typography
                  sx={{
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    color: 'rgba(255,255,255,0.92)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 260,
                    ...(step.done ? {} : shimmerTextSx('rgba(255,255,255,0.92)')),
                  }}
                >
                  {step.label}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      ) : running ? (
        <Box
          key={artifactKey}
          className="osw-artifact"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 28,
            px: 1.5,
            borderRadius: 999,
            background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR,
            boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
          }}
        >
          <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)' }}>
            Thinking...
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}

export default AgentNarratorPill;
