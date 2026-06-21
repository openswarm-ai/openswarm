// Shared visual helpers for the workflow card UI tier: schedule/permission
// pill chips, status dot, run-status sparkline, step connector, step icon
// auto-classifier. Kept as plain functions/components so individual views
// can compose without owning the styling.

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { useAppDispatch } from '@/shared/hooks';
import { updateWorkflow } from '@/shared/state/workflowsSlice';
import ScheduleIcon from '@mui/icons-material/ScheduleRounded';
import NotificationsIcon from '@mui/icons-material/NotificationsRounded';
import SmsIcon from '@mui/icons-material/SmsRounded';
import PhoneInTalkIcon from '@mui/icons-material/PhoneInTalkRounded';
import EmailIcon from '@mui/icons-material/MailOutlineRounded';
import EventNoteIcon from '@mui/icons-material/EventNoteRounded';
import ChromeReaderModeIcon from '@mui/icons-material/ChromeReaderModeRounded';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import CalendarTodayIcon from '@mui/icons-material/CalendarTodayRounded';
import ArticleIcon from '@mui/icons-material/ArticleRounded';
import LanguageIcon from '@mui/icons-material/LanguageRounded';
import AttachMoneyIcon from '@mui/icons-material/AttachMoneyRounded';
import AllInclusiveIcon from '@mui/icons-material/AllInclusiveRounded';
import CodeIcon from '@mui/icons-material/CodeRounded';
import SearchIcon from '@mui/icons-material/SearchRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { Workflow, WorkflowRun, ScheduleConfig, PermissionTier } from '@/shared/state/workflowsSlice';
import { formatTime, WEEKDAY_LABEL, isScheduleConfigured } from './scheduleUtils';

// ---------- Title placeholders ----------

// Placeholder titles the backend uses before auto-naming kicks in. The title
// Typewriter only animates once the title is a real (generated/user) name, so
// the UI doesn't animate on mount or while still showing a placeholder.
const PLACEHOLDER_TITLES = new Set(['', 'New workflow', 'Untitled workflow', 'Scheduled workflow']);
export function isRealTitle(title?: string | null): boolean {
  return !!title && !PLACEHOLDER_TITLES.has(title.trim());
}

// ---------- Status colors ----------

export type LastRunStatus = NonNullable<Workflow['last_run_status']>;

export function statusDotColor(status: LastRunStatus | null | undefined, c: ReturnType<typeof useClaudeTokens>) {
  switch (status) {
    case 'success': return c.status.success;
    case 'ran_late': return c.status.warning;
    case 'failure': return c.status.error;
    case 'running': return c.accent.primary;
    case 'skipped': return c.text.muted;
    default: return c.text.ghost;
  }
}

// Human-readable status word. We surface "ran late" instead of the
// underscore-y "ran_late" everywhere it'd be visible to a user.
export function statusWord(status: LastRunStatus | null | undefined): string {
  if (!status) return 'Never run';
  if (status === 'ran_late') return 'Ran late';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// Status pill rendered next to the title. Bigger than the previous 9px
// dot and pairs the color with a short word so a non-dev knows what
// they're looking at instead of squinting at a single grey pixel.
export function StatusDot({ status }: { status: LastRunStatus | null | undefined }) {
  const c = useClaudeTokens();
  const word = statusWord(status);
  const dotColor = statusDotColor(status, c);
  return (
    <Tooltip title={status ? `Last run: ${word.toLowerCase()}` : 'This workflow has never run.'}>
      <Box sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.4,
        height: 18, px: 0.75, borderRadius: c.radius.full,
        bgcolor: status === 'failure' ? c.status.errorBg : status === 'ran_late' ? c.status.warningBg : status === 'success' ? c.status.successBg : c.bg.elevated,
        border: `1px solid ${dotColor}55`,
        flexShrink: 0,
      }}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: dotColor, boxShadow: status === 'failure' ? `0 0 4px ${c.status.error}` : 'none' }} />
        <Typography sx={{ fontSize: '0.66rem', fontWeight: 700, color: dotColor, letterSpacing: '0.02em' }}>
          {word}
        </Typography>
      </Box>
    </Tooltip>
  );
}

// ---------- Pill chips ----------

function scheduleShort(sched: ScheduleConfig): string {
  if (!sched.enabled || !isScheduleConfigured(sched)) return 'Not scheduled';
  const time = formatTime(sched.hour, sched.minute);
  if (sched.repeat_unit === 'minute') return `Every ${sched.repeat_every}m`;
  if (sched.repeat_unit === 'hour') return sched.repeat_every === 1 ? 'Hourly' : `Every ${sched.repeat_every}h`;
  if (sched.repeat_unit === 'day') {
    return sched.repeat_every === 1 ? `Daily ${time}` : `Every ${sched.repeat_every}d ${time}`;
  }
  if (sched.repeat_unit === 'month') {
    const day = sched.day_of_month ? ` day ${sched.day_of_month}` : '';
    return sched.repeat_every === 1 ? `Monthly${day} ${time}` : `Every ${sched.repeat_every}mo${day} ${time}`;
  }
  if (sched.on_days.length === 5 && [1, 2, 3, 4, 5].every((d) => sched.on_days.includes(d))) return `Weekdays ${time}`;
  if (sched.on_days.length === 2 && [0, 6].every((d) => sched.on_days.includes(d))) return `Weekends ${time}`;
  if (sched.on_days.length === 1) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${labels[sched.on_days[0]]} ${time}`;
  }
  return `${sched.on_days.length}×/wk ${time}`;
}

// Weekday-dot strip "S M T W T F S" with active days filled. Rendered
// inline next to the chip when the schedule is weekly so users can
// pattern-match days without parsing prose. Active = filled accent dot.
export function WeekdayDots({ on_days }: { on_days: number[] }) {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, ml: 0.5 }}>
      {WEEKDAY_LABEL.map((lbl, idx) => {
        const active = on_days.includes(idx);
        return (
          <Box key={`${lbl}-${idx}`} sx={{
            width: 12, height: 12, borderRadius: '50%',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.6rem', fontWeight: 700,
            color: active ? '#fff' : c.text.ghost,
            bgcolor: active ? c.accent.primary : 'transparent',
            border: `1px solid ${active ? c.accent.primary : c.border.subtle}`,
            lineHeight: 1,
          }}>
            {lbl}
          </Box>
        );
      })}
    </Box>
  );
}

function permIcon(kind: PermissionTier['kind'], size = 13) {
  if (kind === 'text') return <SmsIcon sx={{ fontSize: size }} />;
  if (kind === 'call') return <PhoneInTalkIcon sx={{ fontSize: size }} />;
  return <NotificationsIcon sx={{ fontSize: size }} />;
}

// Compact "🔔 → 💬 → 📞" representation of the escalation chain. Hover
// shows the literal prose (notify, text, call, with delays).
export function PermissionChip({ workflow }: { workflow: Workflow }) {
  const c = useClaudeTokens();
  const tiers = workflow.permissions || [];
  if (tiers.length === 0) return null;
  const label = tiers.map((t) => {
    if (t.kind === 'notify') return 'notify in app';
    const unit = t.kind === 'call' ? 'h' : 'm';
    return `${t.kind} after ${t.after_minutes}${unit}`;
  }).join(' → ');
  return (
    <Tooltip title={label}>
      <Box sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.35,
        fontSize: '0.74rem', fontWeight: 500,
        color: c.text.secondary,
        bgcolor: c.bg.elevated,
        border: `1px solid ${c.border.subtle}`,
        px: 0.75, py: 0.3, borderRadius: c.radius.full,
      }}>
        {tiers.map((t, i) => (
          <React.Fragment key={i}>
            {permIcon(t.kind)}
            {i < tiers.length - 1 && <Box sx={{ fontSize: '0.7rem', color: c.text.ghost, mx: 0.1 }}>→</Box>}
          </React.Fragment>
        ))}
      </Box>
    </Tooltip>
  );
}

export function ScheduleChip({ workflow }: { workflow: Workflow }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const enabled = workflow.schedule.enabled && isScheduleConfigured(workflow.schedule);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Inline edit: time + AM/PM only. Anything richer should open the
  // full editor. Saves on change with optimistic updated_at If-Match.
  const sched = workflow.schedule;
  const patchSched = (patch: Partial<typeof sched>) => {
    const next = { ...sched, ...patch };
    dispatch(updateWorkflow({
      id: workflow.id,
      patch: { schedule: next as any },
      ifMatch: workflow.updated_at || null,
    }));
  };
  return (
    <>
      <Tooltip title={enabled ? `Click to tweak time. Full editor lives in the Edit tab.` : 'Not scheduled'}>
        <Box
          onClick={(e) => enabled && setAnchor(e.currentTarget as HTMLElement)}
          role={enabled ? 'button' : undefined}
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.4,
            fontSize: '0.74rem', fontWeight: 600,
            color: enabled ? c.accent.primary : c.text.muted,
            bgcolor: enabled ? c.accent.primary + '14' : c.bg.elevated,
            border: `1px solid ${enabled ? c.accent.primary + '40' : c.border.subtle}`,
            px: 0.75, py: 0.3, borderRadius: c.radius.full,
            cursor: enabled ? 'pointer' : 'default',
            '&:hover': enabled ? { bgcolor: c.accent.primary + '22' } : undefined,
          }}>
          <ScheduleIcon sx={{ fontSize: 13 }} />
          {scheduleShort(workflow.schedule)}
          {enabled && workflow.schedule.repeat_unit === 'week' && (
            <WeekdayDots on_days={workflow.schedule.on_days} />
          )}
        </Box>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}>
        <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 220 }}>
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em' }}>
            QUICK TIME EDIT
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Select
              size="small"
              value={((sched.hour + 11) % 12) + 1}
              onChange={(e) => {
                const h12 = Number(e.target.value);
                const isPm = sched.hour >= 12;
                patchSched({ hour: (h12 % 12) + (isPm ? 12 : 0) });
              }}
              sx={{ fontSize: '0.78rem', '& .MuiSelect-select': { py: 0.4 } }}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <MenuItem key={h} value={h}>{h}</MenuItem>
              ))}
            </Select>
            <Typography sx={{ fontSize: '0.85rem' }}>:</Typography>
            <Select
              size="small"
              value={sched.minute}
              onChange={(e) => patchSched({ minute: Number(e.target.value) })}
              sx={{ fontSize: '0.78rem', '& .MuiSelect-select': { py: 0.4 } }}>
              {[0, 15, 30, 45].map((m) => (
                <MenuItem key={m} value={m}>{String(m).padStart(2, '0')}</MenuItem>
              ))}
            </Select>
            <Select
              size="small"
              value={sched.hour < 12 ? 'AM' : 'PM'}
              onChange={(e) => {
                const wasPm = sched.hour >= 12;
                const willBePm = e.target.value === 'PM';
                if (wasPm === willBePm) return;
                patchSched({ hour: willBePm ? sched.hour + 12 : sched.hour - 12 });
              }}
              sx={{ fontSize: '0.78rem', '& .MuiSelect-select': { py: 0.4 } }}>
              <MenuItem value="AM">AM</MenuItem>
              <MenuItem value="PM">PM</MenuItem>
            </Select>
          </Box>
          <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, mt: 0.25 }}>
            Saved as you change.
          </Typography>
        </Box>
      </Popover>
    </>
  );
}

// Classify a workflow's billing route based on its model id + the user's
// global connection mode. Mirrors the per-session logic in AgentChat so
// the workflow card tells the same story the chat header does. Returns
// 'metered' when the user pays per call (Anthropic/OpenAI/Gemini API
// keys, custom OpenAI-compatible) or 'subscription' when a flat-rate
// account is doing the work (Claude Pro/Max, ChatGPT Plus/Pro, Gemini
// Advanced, OpenSwarm Pro proxy). `subLabel` names the plan for tooltips.
export type RoutingKind = 'metered' | 'subscription';
export interface Routing {
  kind: RoutingKind;
  subLabel?: string;
}

export function routingFor(model: string, connectionMode: string | undefined): Routing {
  const m = (model || '').toLowerCase();
  if (m.endsWith('-api')) return { kind: 'metered' };
  if (m.endsWith('-cc')) return { kind: 'subscription', subLabel: 'Claude Pro/Max' };
  const isPlainAnthropic = m === 'sonnet' || m === 'opus' || m === 'haiku';
  if (isPlainAnthropic && connectionMode === 'openswarm-pro') {
    return { kind: 'subscription', subLabel: 'OpenSwarm Pro' };
  }
  if (isPlainAnthropic) return { kind: 'metered' };
  if (m.startsWith('gpt-5') || m.startsWith('gpt-4') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return { kind: 'subscription', subLabel: 'ChatGPT Plus/Pro' };
  }
  if (m.startsWith('gemini-')) {
    return { kind: 'subscription', subLabel: 'Gemini Advanced' };
  }
  // Unknown model id, default to metered so we don't oversell "free."
  return { kind: 'metered' };
}

export function CostChip({ workflow, connectionMode }: { workflow: Workflow; connectionMode?: string }) {
  const c = useClaudeTokens();
  const est = workflow.cost_estimate;
  const route = routingFor(workflow.model, connectionMode);

  // Subscription-routed workflows have no metered per-call cost. Surface
  // a usage chip instead so the user knows runs are "free" under their
  // existing plan but still sees the projected fire frequency.
  if (route.kind === 'subscription') {
    if (!est || est.fires_per_month === 0) {
      return (
        <Tooltip title={`Runs are covered by your ${route.subLabel} plan. No upcoming runs scheduled.`}>
          <Box sx={chipSx(c)}>
            <AllInclusiveIcon sx={{ fontSize: 12 }} />
            {route.subLabel || 'Subscription'}
          </Box>
        </Tooltip>
      );
    }
    return (
      <Tooltip title={`Routed through your ${route.subLabel} plan; no per-run cost. About ${est.fires_per_month} runs per month at the current schedule.`}>
        <Box sx={chipSx(c)}>
          <AllInclusiveIcon sx={{ fontSize: 12 }} />
          ~{est.fires_per_month} runs/mo
        </Box>
      </Tooltip>
    );
  }

  // Metered route: only render the cost chip once we actually have a
  // last-run figure to project from. Avoids "$0.00/mo" gaslighting.
  if (!est || est.fires_per_month === 0 || est.last_run_usd <= 0) return null;
  const monthly = est.monthly_usd || 0;
  return (
    <Tooltip title={`About $${est.last_run_usd.toFixed(4)} per run, times ${est.fires_per_month} runs per month.`}>
      <Box sx={chipSx(c)}>
        <AttachMoneyIcon sx={{ fontSize: 12, ml: -0.25 }} />
        {monthly < 0.01 ? '<0.01' : monthly.toFixed(2)}/mo
      </Box>
    </Tooltip>
  );
}

function chipSx(c: ReturnType<typeof useClaudeTokens>) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 0.3,
    fontSize: '0.74rem', fontWeight: 600,
    color: c.text.secondary,
    bgcolor: c.bg.elevated,
    border: `1px solid ${c.border.subtle}`,
    px: 0.75, py: 0.3, borderRadius: c.radius.full,
  } as const;
}

// Compact "last fired" mini-label, used inside the Run-tab summary.
export function LastFiredHint({ workflow }: { workflow: Workflow }) {
  const c = useClaudeTokens();
  if (!workflow.last_run_at) return null;
  const ms = Date.now() - new Date(workflow.last_run_at).getTime();
  const ago = relTime(ms);
  return (
    <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost }}>Last ran {ago}</Typography>
  );
}

function relTime(ms: number): string {
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

// ---------- Run history sparkline ----------

// 10-dot horizontal strip of last N runs colored by status. Easy "lately
// healthy?" check without opening the History tab.
export function RunSparkline({ runs, max = 10 }: { runs: WorkflowRun[]; max?: number }) {
  const c = useClaudeTokens();
  if (!runs || runs.length === 0) return null;
  const slice = runs.slice(0, max).reverse();
  const successes = slice.filter((r) => r.status === 'success').length;
  const failures = slice.filter((r) => r.status === 'failure').length;
  const tooltip = `Last ${slice.length} run${slice.length === 1 ? '' : 's'}: ${successes} successful, ${failures} failed`;
  return (
    <Tooltip title={tooltip}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.3, ml: 0.5 }}>
        {slice.map((r) => (
          <Box key={r.id} sx={{
            width: 6, height: 6, borderRadius: '50%',
            bgcolor: statusDotColor(r.status as LastRunStatus, c),
          }} />
        ))}
      </Box>
    </Tooltip>
  );
}

// ---------- Streak badge ----------

// Count consecutive successful runs at the head of the runs list.
// `runs[0]` is the most recent run, so we walk forward until we hit a
// non-success. Returns 0 when no streak is active.
export function successStreak(runs: WorkflowRun[] | undefined): number {
  if (!runs || runs.length === 0) return 0;
  let n = 0;
  for (const r of runs) {
    if (r.status === 'success' || r.status === 'ran_late') n += 1;
    else break;
  }
  return n;
}

export function StreakBadge({ runs }: { runs: WorkflowRun[] | undefined }) {
  const c = useClaudeTokens();
  const n = successStreak(runs);
  if (n < 3) return null;
  return (
    <Tooltip title={`${n} successful runs in a row.`}>
      <Box sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.3,
        fontSize: '0.72rem', fontWeight: 700,
        color: c.status.success,
        bgcolor: c.status.successBg,
        border: `1px solid ${c.status.success + '60'}`,
        px: 0.75, py: 0.3, borderRadius: c.radius.full,
      }}>
        🔥 {n}
      </Box>
    </Tooltip>
  );
}

// ---------- Step icon auto-classifier ----------

// Pick a glyph by keyword scan of the step text. Falls back to the
// step number when nothing matches. Same Roman-numeral simple heuristic
// the user sees: "summarize email" -> mail icon, "make notion page" ->
// article icon, etc.
const ICON_RULES: Array<{ pattern: RegExp; Icon: React.ElementType }> = [
  { pattern: /\b(email|inbox|gmail|outlook|mail)\b/i, Icon: EmailIcon },
  { pattern: /\b(calendar|schedule|event|meeting)\b/i, Icon: CalendarTodayIcon },
  { pattern: /\b(notion|doc|page|page template|document|article)\b/i, Icon: ArticleIcon },
  { pattern: /\b(text|sms|message|whatsapp|imessage)\b/i, Icon: SmsIcon },
  { pattern: /\b(call|phone|dial|ring)\b/i, Icon: PhoneInTalkIcon },
  { pattern: /\b(browser|web|website|url|fetch|visit|navigate)\b/i, Icon: LanguageIcon },
  { pattern: /\b(search|find|look up|google)\b/i, Icon: SearchIcon },
  { pattern: /\b(code|github|repo|script|bash|run)\b/i, Icon: CodeIcon },
  { pattern: /\b(read|review|summarize|summary)\b/i, Icon: ChromeReaderModeIcon },
  { pattern: /\b(chat|reply|respond|dm)\b/i, Icon: ChatBubbleOutlineIcon },
  { pattern: /\b(note|memo|journal|log)\b/i, Icon: EventNoteIcon },
];

export function stepIconFor(text: string): React.ElementType | null {
  for (const rule of ICON_RULES) {
    if (rule.pattern.test(text)) return rule.Icon;
  }
  return null;
}

// ---------- Step duration learner ----------

// Estimates per-step duration by averaging recent runs. Today we only
// have whole-run duration on each WorkflowRun (started_at -> finished_at),
// so the heuristic spreads it evenly across the step count. When per-step
// telemetry lands later, swap this for a per-step lookup.
export function estimateStepDuration(workflow: Workflow, runs: WorkflowRun[] | undefined, stepIdx: number): string | null {
  if (!runs || runs.length === 0) return null;
  const steps = workflow.steps?.length || 1;
  const successful = runs.filter((r) => (r.status === 'success' || r.status === 'ran_late') && r.finished_at);
  if (successful.length === 0) return null;
  const durations = successful.slice(0, 10).map((r) => {
    const start = new Date(r.started_at).getTime();
    const end = new Date(r.finished_at!).getTime();
    return Math.max(0, end - start);
  });
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const perStepMs = avg / steps;
  void stepIdx;
  return humanDuration(perStepMs);
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 && m < 5 ? `${m}m ${rem}s` : `${m}m`;
}

// ---------- Run-button breath logic ----------

// Returns true when the workflow hasn't been run in over 24h. Used by
// the Run tab to add a subtle CSS breathing animation so the button
// invites use without yelling.
export function isStaleSinceLastRun(workflow: Workflow): boolean {
  if (!workflow.last_run_at) return false;
  const age = Date.now() - new Date(workflow.last_run_at).getTime();
  return age > 24 * 3600 * 1000;
}
