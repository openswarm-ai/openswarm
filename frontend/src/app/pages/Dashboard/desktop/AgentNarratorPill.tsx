import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import DashboardGlyph from '../canvas/DashboardGlyph';
import ShowUiWidgetView from '@/app/pages/AgentChat/tool-ui/ShowUiWidgetView';
import type { ShowUiPayload } from '@/app/pages/AgentChat/tool-ui/showUiPayload';
import type { AgentTodoItem } from './agentTodos';

interface AgentNarratorPillProps {
  label: string;
  running: boolean;
  todos: AgentTodoItem[] | null;
  artifact: ShowUiPayload | null;
  browserShot: string | null;
  selected: boolean;
  highlighted: boolean;
}

const GLASS = 'rgba(24,14,32,0.8)';
const GLASS_BLUR = 'blur(18px) saturate(150%)';
const MAX_VISIBLE_TODOS = 4;

/** Collapsed agent as the desktop narrator pill; below it, the best artifact wins: widget > browser shot > plan > Thinking. */
function AgentNarratorPill({ label, running, todos, artifact, browserShot, selected, highlighted }: AgentNarratorPillProps): React.ReactElement {
  const visibleTodos = (todos || []).slice(0, MAX_VISIBLE_TODOS);
  const hiddenCount = (todos?.length || 0) - visibleTodos.length;
  const ring = selected || highlighted ? { outline: '2px solid #3b82f6', outlineOffset: '2px' } : undefined;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
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
        <Typography sx={{ fontSize: '0.82rem', fontWeight: 500, color: 'rgba(255,255,255,0.92)' }}>
          {label}
        </Typography>
      </Box>

      {artifact ? (
        <ShowUiWidgetView payload={artifact} />
      ) : browserShot ? (
        <Box
          component="img"
          src={browserShot}
          alt=""
          sx={{ width: 300, display: 'block', borderRadius: '10px', boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}
        />
      ) : visibleTodos.length > 0 ? (
        <Box
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
                      fontSize: '0.82rem',
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
      ) : running ? (
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 28,
            px: 1.5,
            borderRadius: 999,
            background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR,
            boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
          }}
        >
          <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)' }}>
            Thinking...
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}

export default AgentNarratorPill;
