import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import SearchIcon from '@mui/icons-material/Search';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonthRounded';
import OpenInFullIcon from '@mui/icons-material/OpenInFullRounded';
import AddIcon from '@mui/icons-material/Add';
import { AnimatePresence, motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppSelector } from '@/shared/hooks';
import ScheduleCalendar from './ScheduleCalendar';

type Mode = 'search' | 'schedule';

interface Props {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  historyResults: { id: string; name: string; closed_at: string | null }[];
  historyLoading: boolean;
  historyQuery: string;
  onHistoryQueryChange: (q: string) => void;
  onHistorySelect: (id: string) => void;
  onNewChat: () => void;
  onWorkflowSelect: (id: string) => void;
  onExpand: () => void;
  historyScrollRef?: React.RefObject<HTMLDivElement>;
  onHistoryScroll?: () => void;
}

export default function SchedulePopover({
  mode, onModeChange, historyResults, historyLoading, historyQuery, onHistoryQueryChange,
  onHistorySelect, onNewChat, onWorkflowSelect, onExpand, historyScrollRef, onHistoryScroll,
}: Props) {
  const c = useClaudeTokens();
  const [calendarView, setCalendarView] = useState<'Week' | 'Month' | 'List'>('Week');
  const workflows = useAppSelector((s) => s.workflows.items);

  const workflowIconMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const wf of Object.values(workflows)) {
      if (wf.source_session_id) m[wf.source_session_id] = wf.icon || wf.title.slice(0, 1).toUpperCase();
    }
    return m;
  }, [workflows]);

  // Both Search and Schedule modes render at the same fixed dimensions so
  // toggling chips doesn't resize the popover. Schedule sets the floor:
  // its 7-day calendar needs ~620w x ~420h, search inherits the same.
  const POPOVER_W = 620;
  const CONTENT_H = 420;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', width: POPOVER_W, maxWidth: POPOVER_W, gap: 0.75, flexShrink: 0 }}>
      {/* Floating mode chips OUTSIDE the content card (Figma image #30) */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 0.5 }}>
        <ModeChip label="Search" icon={<SearchIcon sx={{ fontSize: 14 }} />} active={mode === 'search'} onClick={() => onModeChange('search')} />
        <ModeChip label="Schedule" icon={<CalendarMonthIcon sx={{ fontSize: 14 }} />} active={mode === 'schedule'} onClick={() => onModeChange('schedule')} />
      </Box>

      {/* Content card — separately bordered/rounded, like image #30.
          Inner content crossfades on tab switch so search↔schedule isn't
          a jarring jump. Outer card stays fixed-size (W×H) so the toolbar
          doesn't reflow. */}
      <Box sx={{
        width: '100%',
        height: CONTENT_H,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: `${c.radius.lg}px`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        {mode === 'search' && (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, flexShrink: 0 }}>
              <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
              <InputBase
                value={historyQuery}
                onChange={(e) => onHistoryQueryChange(e.target.value)}
                placeholder="Search past chats..."
                sx={{ flex: 1, fontSize: '0.85rem', color: c.text.primary, '& input::placeholder': { color: c.text.ghost, opacity: 1 } }}
              />
              <Box onClick={onNewChat} role="button" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: '0.78rem', fontWeight: 500, color: c.text.secondary, px: 1, py: 0.45, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { color: c.accent.primary, bgcolor: c.bg.elevated } }}>
                <AddIcon sx={{ fontSize: 12 }} />
                New
              </Box>
            </Box>
            <Box ref={historyScrollRef} onScroll={onHistoryScroll} sx={{ flex: 1, overflowY: 'auto', borderTop: `1px solid ${c.border.subtle}` }}>
              {historyResults.length === 0 && !historyLoading && (
                <Typography sx={{ px: 1.5, py: 2.5, fontSize: '0.82rem', color: c.text.muted, textAlign: 'center' }}>{historyQuery ? 'No matching chats' : 'No chat history yet'}</Typography>
              )}
              {historyResults.map((entry) => {
                const icon = workflowIconMap[entry.id];
                return (
                  <Box key={entry.id} onClick={() => onHistorySelect(entry.id)} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.9, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
                    <Typography sx={{ flex: 1, fontSize: '0.82rem', color: c.text.primary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</Typography>
                    {icon && (
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '4px', bgcolor: c.accent.primary + '22', color: c.accent.primary, fontSize: '0.7rem', fontWeight: 700 }}>{icon}</Box>
                    )}
                    <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, flexShrink: 0, whiteSpace: 'nowrap' }}>{relTime(entry.closed_at)}</Typography>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {mode === 'schedule' && (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}>
              {(['Week', 'Month', 'List'] as const).map((v) => (
                <Box key={v} onClick={() => setCalendarView(v)} role="button" sx={{ fontSize: '0.85rem', fontWeight: calendarView === v ? 700 : 500, px: 0.75, pt: 0.4, pb: 0.55, color: calendarView === v ? c.text.primary : c.text.muted, borderBottom: `2px solid ${calendarView === v ? c.accent.primary : 'transparent'}`, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>{v}</Box>
              ))}
              <Box sx={{ flex: 1 }} />
              <Box onClick={onExpand} role="button" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: '0.78rem', fontWeight: 500, color: c.text.secondary, px: 1, py: 0.35, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { color: c.accent.primary, bgcolor: c.bg.elevated } }}>
                <OpenInFullIcon sx={{ fontSize: 12 }} />
                Expand
              </Box>
            </Box>
            <Box sx={{ flex: 1, overflowY: 'auto', px: 1.5, py: 1, borderTop: `1px solid ${c.border.subtle}`, minHeight: 0 }}>
              <ScheduleCalendar view={calendarView} density="roomy" onSelectWorkflow={onWorkflowSelect} />
            </Box>
          </Box>
        )}
          </motion.div>
        </AnimatePresence>
      </Box>
    </Box>
  );
}

// Floating chip rendered ABOVE the popover card (image #30). Active gets a
// subtle filled-elevated bg + 1px border; inactive is borderless ghost.
function ModeChip({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  const c = useClaudeTokens();
  return (
    <Box
      onClick={onClick}
      role="button"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.5,
        fontSize: '0.82rem', fontWeight: active ? 700 : 500,
        px: 1.1, py: 0.45,
        cursor: 'pointer',
        color: active ? c.text.primary : c.text.muted,
        bgcolor: active ? c.bg.surface : 'transparent',
        border: `1px solid ${active ? c.border.subtle : 'transparent'}`,
        borderRadius: `${c.radius.md}px`,
        boxShadow: active ? c.shadow.sm : 'none',
        '&:hover': { color: c.text.primary, bgcolor: active ? c.bg.surface : c.bg.elevated },
      }}>
      {icon}
      {label}
    </Box>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const m = Math.floor(sec / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
