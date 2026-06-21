import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import BookmarkIcon from '@mui/icons-material/BookmarkBorderRounded';
import SearchIcon from '@mui/icons-material/Search';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonthRounded';
import OpenInFullIcon from '@mui/icons-material/OpenInFullRounded';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import AddIcon from '@mui/icons-material/Add';
import { AnimatePresence, motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppSelector } from '@/shared/hooks';
import type { WorkflowRun } from '@/shared/state/workflowsSlice';
import ScheduleCalendar from './ScheduleCalendar';
import { HistoryList } from './WorkflowCardSubviews';
import { addDays, startOfWeek } from './scheduleUtils';

type Mode = 'search' | 'runs' | 'schedule';

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
  allRuns: WorkflowRun[];
  allRunsLoading: boolean;
  onRunOpen: (run: WorkflowRun) => void;
  workflowTitleFor: (workflowId: string) => string;
  historyScrollRef?: React.RefObject<HTMLDivElement>;
  onHistoryScroll?: () => void;
  /** When true, hides the internal Search/Schedule chips + redundant "+ New"
   *  pill. The new DashboardToolbar pills above the popover replace them. */
  hideTopChrome?: boolean;
  /** When true, the dock History is purely chat history: the Scheduled-tasks /
   *  Schedule tabs and views are dropped (workflows live in the Workflows app). */
  chatHistoryOnly?: boolean;
}

export default function SchedulePopover({
  mode, onModeChange, historyResults, historyLoading, historyQuery, onHistoryQueryChange,
  onHistorySelect, onNewChat, onWorkflowSelect, onExpand,
  allRuns, allRunsLoading, onRunOpen, workflowTitleFor,
  historyScrollRef, onHistoryScroll,
  hideTopChrome = false,
  chatHistoryOnly = false,
}: Props) {
  const showSearch = chatHistoryOnly || mode === 'search';
  const c = useClaudeTokens();
  // List leads: it's the at-a-glance "what's coming up" the user wants first,
  // with Week/Month as the calendar grids behind it.
  const [calendarView, setCalendarView] = useState<'Week' | 'Month' | 'List'>('List');
  const [refDate, setRefDate] = useState<Date>(() => new Date());
  const workflows = useAppSelector((s) => s.workflows.items);

  const periodLabel = useMemo(() => {
    if (calendarView === 'Month') {
      return refDate.toLocaleString('en', { month: 'long', year: 'numeric' });
    }
    if (calendarView === 'Week') {
      const start = startOfWeek(refDate);
      const end = addDays(start, 6);
      const sameMonth = start.getMonth() === end.getMonth();
      const startStr = start.toLocaleString('en', { month: 'short', day: 'numeric' });
      const endStr = sameMonth
        ? String(end.getDate())
        : end.toLocaleString('en', { month: 'short', day: 'numeric' });
      return `${startStr} – ${endStr}, ${end.getFullYear()}`;
    }
    return refDate.toLocaleString('en', { month: 'long', day: 'numeric', year: 'numeric' });
  }, [refDate, calendarView]);

  const onPrev = useCallback(() => {
    setRefDate((d) => addDays(d, calendarView === 'Month' ? -28 : calendarView === 'Week' ? -7 : -1));
  }, [calendarView]);
  const onNext = useCallback(() => {
    setRefDate((d) => addDays(d, calendarView === 'Month' ? 28 : calendarView === 'Week' ? 7 : 1));
  }, [calendarView]);

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
      {/* Floating mode chips. Hidden when the parent toolbar supplies its
          own pill row (Image #32 / #54); kept around so the legacy callers
          that surface Schedule mode still have a way in. */}
      {!hideTopChrome && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 0.5 }}>
          <ModeChip label="Search" icon={<SearchIcon sx={{ fontSize: 14 }} />} active={mode === 'search'} onClick={() => onModeChange('search')} />
          <ModeChip label="Schedule" icon={<CalendarMonthIcon sx={{ fontSize: 14 }} />} active={mode === 'schedule'} onClick={() => onModeChange('schedule')} />
        </Box>
      )}

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
        {/* History tabs. Hidden in schedule mode so the Schedule pill's
            calendar stays untouched; toggles only Chat history <-> runs and
            never reaches the calendar from here. */}
        {!chatHistoryOnly && mode !== 'schedule' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}>
            {([['search', 'Chat history'], ['runs', 'Scheduled tasks']] as const).map(([m, label]) => (
              <Box key={m} onClick={() => onModeChange(m)} role="button" sx={{ fontSize: '0.85rem', fontWeight: mode === m ? 700 : 500, px: 0.75, pt: 0.4, pb: 0.55, color: mode === m ? c.text.primary : c.text.muted, borderBottom: `2px solid ${mode === m ? c.accent.primary : 'transparent'}`, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>{label}</Box>
            ))}
          </Box>
        )}
        <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        {showSearch && (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, flexShrink: 0 }}>
              <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
              <InputBase
                value={historyQuery}
                onChange={(e) => onHistoryQueryChange(e.target.value)}
                placeholder="Search past chats..."
                sx={{ flex: 1, fontSize: '0.85rem', color: c.text.primary, '& input::placeholder': { color: c.text.ghost, opacity: 1 } }}
              />
              {!hideTopChrome && (
                <Box onClick={onNewChat} role="button" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: '0.78rem', fontWeight: 500, color: c.text.secondary, px: 1, py: 0.45, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { color: c.accent.primary, bgcolor: c.bg.elevated } }}>
                  <AddIcon sx={{ fontSize: 12 }} />
                  New
                </Box>
              )}
            </Box>
            <Box ref={historyScrollRef} onScroll={onHistoryScroll} sx={{ flex: 1, overflowY: 'auto', borderTop: `1px solid ${c.border.subtle}` }}>
              {historyResults.length === 0 && !historyLoading && (
                <Typography sx={{ px: 1.5, py: 2.5, fontSize: '0.82rem', color: c.text.muted, textAlign: 'center' }}>{historyQuery ? 'No matching chats' : 'No chat history yet'}</Typography>
              )}
              {historyResults.map((entry) => {
                const hasWorkflow = Boolean(workflowIconMap[entry.id]);
                return (
                  <Box key={entry.id} onClick={() => onHistorySelect(entry.id)} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.9, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
                    <Typography sx={{ flex: 1, fontSize: '0.82rem', color: c.text.primary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</Typography>
                    {/* Only annotate chats that became saved workflows.
                        A small workflow glyph reads as a tag, where the
                        old single-letter chip read as a random initial. */}
                    {hasWorkflow && (
                      <Tooltip title="This chat is saved as a workflow">
                        <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '4px', color: c.text.muted }}>
                          <BookmarkIcon sx={{ fontSize: 13 }} />
                        </Box>
                      </Tooltip>
                    )}
                    <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, flexShrink: 0, whiteSpace: 'nowrap' }}>{relTime(entry.closed_at)}</Typography>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {!chatHistoryOnly && mode === 'runs' && (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ flex: 1, overflowY: 'auto', px: 1.5, py: 1, borderTop: `1px solid ${c.border.subtle}`, minHeight: 0 }}>
              {allRunsLoading && allRuns.length === 0 ? (
                <Typography sx={{ px: 0.5, py: 2.5, fontSize: '0.82rem', color: c.text.muted, textAlign: 'center' }}>Loading runs...</Typography>
              ) : (
                <HistoryList runs={allRuns} onOpen={onRunOpen} showWorkflow workflowTitleFor={workflowTitleFor} />
              )}
            </Box>
          </Box>
        )}

        {!chatHistoryOnly && mode === 'schedule' && (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}>
              {(['List', 'Week', 'Month'] as const).map((v) => (
                <Box key={v} onClick={() => setCalendarView(v)} role="button" sx={{ fontSize: '0.85rem', fontWeight: calendarView === v ? 700 : 500, px: 0.75, pt: 0.4, pb: 0.55, color: calendarView === v ? c.text.primary : c.text.muted, borderBottom: `2px solid ${calendarView === v ? c.accent.primary : 'transparent'}`, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>{v}</Box>
              ))}
              <Box sx={{ flex: 1 }} />
              <Box onClick={onExpand} role="button" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: '0.78rem', fontWeight: 500, color: c.text.secondary, px: 1, py: 0.35, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { color: c.accent.primary, bgcolor: c.bg.elevated } }}>
                <OpenInFullIcon sx={{ fontSize: 12 }} />
                Expand
              </Box>
            </Box>
            {/* Period nav: Today pill, prev/next chevrons, range label.
                Apple Calendar pattern. Keeps the popover usable without
                forcing a full Expand for date browsing. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 1.5, pb: 0.75, flexShrink: 0 }}>
              <Box
                onClick={() => setRefDate(new Date())}
                role="button"
                sx={{
                  fontSize: '0.78rem', fontWeight: 600, color: c.text.secondary,
                  border: `1px solid ${c.border.subtle}`, px: 0.95, py: 0.3,
                  borderRadius: `${c.radius.md}px`, cursor: 'pointer',
                  '&:hover': { color: c.text.primary, borderColor: c.border.medium },
                }}>Today</Box>
              <IconButton size="small" onClick={onPrev} sx={{ p: 0.3, color: c.text.muted, '&:hover': { color: c.text.primary } }}><ChevronLeftIcon sx={{ fontSize: 17 }} /></IconButton>
              <IconButton size="small" onClick={onNext} sx={{ p: 0.3, color: c.text.muted, '&:hover': { color: c.text.primary } }}><ChevronRightIcon sx={{ fontSize: 17 }} /></IconButton>
              <Typography sx={{ fontSize: '0.84rem', fontWeight: 600, color: c.text.primary, ml: 0.25 }}>{periodLabel}</Typography>
            </Box>
            <Box sx={{ flex: 1, overflowY: 'auto', px: 1.5, pt: 0, pb: 1, borderTop: `1px solid ${c.border.subtle}`, minHeight: 0 }}>
              <ScheduleCalendar view={calendarView} density="compact" onSelectWorkflow={onWorkflowSelect} refDate={refDate} />
            </Box>
          </Box>
        )}
          </motion.div>
        </AnimatePresence>
        </Box>
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
