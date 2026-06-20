import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import RepeatIcon from '@mui/icons-material/RepeatRounded';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmptyRounded';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import BedtimeIcon from '@mui/icons-material/BedtimeOutlined';
import NotificationsIcon from '@mui/icons-material/NotificationsNoneRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchCloudSmsStatus, type Workflow, type ScheduleConfig, type PermissionTier } from '@/shared/state/workflowsSlice';
import { WEEKDAY_LABEL, formatTime, isScheduleActive } from './scheduleUtils';
import { nextTierAfter } from './permissionsUtils';
import { BODY_FS, LABEL_FS, HINT_FS, INPUT_FS } from './workflowEditCommon';

function jsWeekday(d: Date): number { return d.getDay(); }

// Turn an IANA zone string into something a non-dev can parse. "local"
// (legacy) or the host's own zone collapse to "your time"; otherwise
// show "Pacific Time" / "Eastern Time" / etc. when we can resolve a
// short name via Intl, falling back to the raw IANA name if not.
function friendlyTzLabel(tz: string): string {
  if (!tz || tz === 'local') return 'your time';
  try {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === host) {
      const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date());
      const name = parts.find((p) => p.type === 'timeZoneName')?.value || '';
      return name ? `your time (${name.replace(' Standard Time', '').replace(' Daylight Time', '')})` : 'your time';
    }
    const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    return name || tz;
  } catch {
    return tz;
  }
}

function lastDayOfMonthFE(year: number, monthZeroBased: number): number {
  return new Date(year, monthZeroBased + 1, 0).getDate();
}

// Compute the next fire time from a ScheduleConfig. Mirrors the backend
// math in scheduler.py:_next_fire_after using browser-local time so the
// preview lines up with what the user will actually see on their system
// clock. Honors ends_at + max_runs so the "Next run" line doesn't lie
// after the schedule has expired.
function previewNextRun(sched: ScheduleConfig): Date | null {
  if (!isScheduleActive(sched)) return null;
  const now = new Date();
  if (sched.ends_at) {
    const ends = new Date(sched.ends_at);
    if (!Number.isNaN(ends.getTime()) && ends.getTime() <= now.getTime()) return null;
  }
  if (sched.max_runs != null && sched.runs_count >= sched.max_runs) return null;
  if (sched.repeat_unit === 'minute') {
    const step = Math.max(15, sched.repeat_every);
    let c = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
    while (c <= now) c = new Date(c.getTime() + step * 60000);
    return c;
  }
  if (sched.repeat_unit === 'hour') {
    const step = Math.max(1, sched.repeat_every);
    let c = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), sched.minute, 0, 0);
    while (c <= now) c = new Date(c.getTime() + step * 3600000);
    return c;
  }
  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sched.hour, sched.minute, 0, 0);
  if (candidate <= now) candidate = new Date(candidate.getTime() + 86400000);
  if (sched.repeat_unit === 'day') {
    const step = Math.max(1, sched.repeat_every);
    while (candidate <= now) candidate = new Date(candidate.getTime() + step * 86400000);
    return candidate;
  }
  if (sched.repeat_unit === 'week') {
    const allowed = sched.on_days.length ? sched.on_days : [jsWeekday(now)];
    for (let i = 0; i < 14; i += 1) {
      if (allowed.includes(jsWeekday(candidate)) && candidate > now) return candidate;
      candidate = new Date(candidate.getTime() + 86400000);
    }
    return candidate;
  }
  if (sched.repeat_unit === 'month') {
    const step = Math.max(1, sched.repeat_every);
    const startDay = now.getDate();
    let year = now.getFullYear();
    let month = now.getMonth();
    let guard = 0;
    while (guard < 60) {
      const day = Math.min(startDay, lastDayOfMonthFE(year, month));
      const c = new Date(year, month, day, sched.hour, sched.minute, 0, 0);
      if (c > now) return c;
      month += step;
      year += Math.floor(month / 12);
      month = ((month % 12) + 12) % 12;
      guard += 1;
    }
    return null;
  }
  return null;
}

function formatNextRun(d: Date): string {
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${wd} ${mo} ${d.getDate()} at ${formatTime(d.getHours(), d.getMinutes())}`;
}

type EndKind = 'forever' | 'on_date' | 'after_n';

function endKindFromSched(s: ScheduleConfig): EndKind {
  if (s.ends_at) return 'on_date';
  if (s.max_runs != null) return 'after_n';
  return 'forever';
}

interface AppOpenInfo {
  alwaysOn: boolean;       // tray + login both configured
  loginAtLaunch: boolean;
  trayEnabled: boolean;
}

function useAppOpenInfo(): { info: AppOpenInfo; fix: () => Promise<void> } {
  const [info, setInfo] = useState<AppOpenInfo>({ alwaysOn: false, loginAtLaunch: false, trayEnabled: false });
  useEffect(() => {
    let alive = true;
    const w: any = (window as any).openswarm;
    if (!w?.getAppOpenInfo) return;
    w.getAppOpenInfo().then((res: AppOpenInfo) => { if (alive) setInfo(res); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const fix = useCallback(async () => {
    const w: any = (window as any).openswarm;
    if (!w?.setLoginItem || !w?.enableTray) return;
    await w.setLoginItem(true);
    await w.enableTray(true);
    if (w.getAppOpenInfo) {
      const next = await w.getAppOpenInfo();
      setInfo(next);
    }
  }, []);
  return { info, fix };
}

export default function ScheduleFacet({ draft, setDraft }: { draft: Workflow; setDraft: (w: Workflow) => void }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const s = draft.schedule;
  const cloudSms = useAppSelector((st) => (st as any).workflows?.cloudSmsEnabled);

  useEffect(() => { dispatch(fetchCloudSmsStatus()); }, [dispatch]);

  // No silent enable-on-edit. The master Switch is now the single source
  // of truth for whether this schedule is armed.
  const setSched = useCallback((patch: Partial<ScheduleConfig>) => {
    setDraft({ ...draft, schedule: { ...s, ...patch } });
  }, [draft, s, setDraft]);

  const addBackup = useCallback(() => {
    const tiers = [...(draft.permissions || [])];
    const next = nextTierAfter(tiers);
    if (!next) return;
    tiers.push(next);
    setDraft({ ...draft, permissions: tiers });
  }, [draft, setDraft]);

  const removeTier = useCallback((idx: number) => {
    // Drop the removed tier AND all following tiers so the chain stays
    // contiguous (no "call" without "text" before it).
    const tiers = (draft.permissions || []).slice(0, idx);
    setDraft({ ...draft, permissions: tiers });
  }, [draft, setDraft]);

  const setTier = useCallback((idx: number, patch: Partial<PermissionTier>) => {
    const tiers = [...(draft.permissions || [])];
    tiers[idx] = { ...tiers[idx], ...patch };
    setDraft({ ...draft, permissions: tiers });
  }, [draft, setDraft]);

  const canAddBackup = ((draft.permissions || [])[ (draft.permissions || []).length - 1 ]?.kind || 'notify') !== 'call';
  const endKind = endKindFromSched(s);
  const nextPreview = useMemo(() => previewNextRun(s), [s]);
  const { info: appOpen, fix: fixAppOpen } = useAppOpenInfo();

  const setEndKind = (k: EndKind) => {
    if (k === 'forever') setSched({ ends_at: null, max_runs: null });
    else if (k === 'on_date') setSched({ ends_at: new Date(Date.now() + 7 * 86400000).toISOString(), max_runs: null });
    else setSched({ ends_at: null, max_runs: 10 });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Master on/off. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Switch size="small" checked={s.enabled} onChange={(e) => setSched({ enabled: e.target.checked })} />
        <Typography sx={{ fontSize: BODY_FS, fontWeight: 700, color: c.text.primary }}>
          {s.enabled ? 'Schedule is on' : 'Schedule is off'}
        </Typography>
      </Box>

      {s.enabled && (
        <AppOpenStatusBadge info={appOpen} hour={s.hour} minute={s.minute} frequent={s.repeat_unit === 'minute' || s.repeat_unit === 'hour'} onFix={fixAppOpen} />
      )}

      {/* Section: When should this workflow run? */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography sx={{ fontSize: BODY_FS, fontWeight: 600, color: c.text.primary }}>
          When should this workflow run?
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, minWidth: 96 }}>Repeat every</Typography>
          <InputBase
            type="number"
            value={s.repeat_every}
            onChange={(e) => {
              // Per-unit bounds mirror the backend: minute 15..1440 (24h),
              // every other unit 1..365.
              const min = s.repeat_unit === 'minute' ? 15 : 1;
              const max = s.repeat_unit === 'minute' ? 1440 : 365;
              setSched({ repeat_every: Math.min(max, Math.max(min, Number(e.target.value) || min)) });
            }}
            sx={{ width: 56, fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4 }}
          />
          <Select
            size="small"
            value={s.repeat_unit}
            onChange={(e) => {
              const unit = e.target.value as ScheduleConfig['repeat_unit'];
              // 15 is the floor for the minute unit; bump repeat_every up
              // when switching in so the input never shows an invalid value.
              const patch: Partial<ScheduleConfig> = { repeat_unit: unit };
              if (unit === 'minute' && s.repeat_every < 15) patch.repeat_every = 15;
              setSched(patch);
            }}
            sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
            <MenuItem value="minute">minute</MenuItem>
            <MenuItem value="hour">hour</MenuItem>
            <MenuItem value="day">day</MenuItem>
            <MenuItem value="week">week</MenuItem>
            <MenuItem value="month">month</MenuItem>
          </Select>
        </Box>
        {s.repeat_unit === 'week' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pl: 12, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: LABEL_FS, color: c.text.muted }}>↳ on</Typography>
            {WEEKDAY_LABEL.map((label, idx) => {
              const active = s.on_days.includes(idx);
              return (
                <Box
                  key={idx}
                  onClick={() => setSched({ on_days: active ? s.on_days.filter((d) => d !== idx) : [...s.on_days, idx] })}
                  role="button"
                  sx={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: LABEL_FS, fontWeight: 700, cursor: 'pointer', color: active ? '#fff' : c.text.muted, bgcolor: active ? c.accent.primary : 'transparent', border: `1px solid ${active ? c.accent.primary : c.border.subtle}` }}>{label}</Box>
              );
            })}
          </Box>
        )}
        {/* minute-unit schedules have no anchor time; hour-unit schedules
            only need the minute offset; the rest pick a full clock time. */}
        {s.repeat_unit === 'hour' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, minWidth: 96 }}>At</Typography>
            <Typography sx={{ fontSize: INPUT_FS, color: c.text.muted }}>:</Typography>
            <Select
              size="small"
              value={s.minute}
              onChange={(e) => setSched({ minute: Number(e.target.value) })}
              sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.4 } }}>
              {[0, 15, 30, 45].map((m) => (
                <MenuItem key={m} value={m}>{String(m).padStart(2, '0')}</MenuItem>
              ))}
            </Select>
            <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>past the hour</Typography>
          </Box>
        )}
        {(s.repeat_unit === 'day' || s.repeat_unit === 'week' || s.repeat_unit === 'month') && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, minWidth: 96 }}>At</Typography>
          <Select
            size="small"
            value={((s.hour + 11) % 12) + 1}
            onChange={(e) => {
              const h12 = Number(e.target.value);
              const isPm = s.hour >= 12;
              const next = (h12 % 12) + (isPm ? 12 : 0);
              setSched({ hour: next });
            }}
            sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.4 } }}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <MenuItem key={h} value={h}>{h}</MenuItem>
            ))}
          </Select>
          <Typography sx={{ fontSize: INPUT_FS, color: c.text.muted }}>:</Typography>
          <Select
            size="small"
            value={s.minute}
            onChange={(e) => setSched({ minute: Number(e.target.value) })}
            sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.4 } }}>
            {[0, 15, 30, 45].map((m) => (
              <MenuItem key={m} value={m}>{String(m).padStart(2, '0')}</MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={s.hour < 12 ? 'AM' : 'PM'}
            onChange={(e) => {
              const wasPm = s.hour >= 12;
              const willBePm = e.target.value === 'PM';
              if (wasPm === willBePm) return;
              setSched({ hour: willBePm ? s.hour + 12 : s.hour - 12 });
            }}
            sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.4 } }}>
            <MenuItem value="AM">AM</MenuItem>
            <MenuItem value="PM">PM</MenuItem>
          </Select>
          <Typography sx={{ fontSize: HINT_FS, color: c.text.ghost, ml: 0.5 }}>{friendlyTzLabel(s.timezone)}</Typography>
        </Box>
        )}
        {nextPreview && s.enabled && (
          <Typography sx={{ fontSize: HINT_FS, color: c.accent.primary, pl: 12, fontWeight: 500 }}>
            Next run: {formatNextRun(nextPreview)}
          </Typography>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
          <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, minWidth: 96 }}>Runs</Typography>
          <Select
            size="small"
            value={endKind}
            onChange={(e) => setEndKind(e.target.value as EndKind)}
            sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.4 } }}>
            <MenuItem value="forever">Until I turn it off</MenuItem>
            <MenuItem value="on_date">Until a date</MenuItem>
            <MenuItem value="after_n">After a number of runs</MenuItem>
          </Select>
          {endKind === 'on_date' && (
            <InputBase
              type="date"
              value={s.ends_at ? s.ends_at.slice(0, 10) : ''}
              onChange={(e) => {
                const v = e.target.value;
                setSched({ ends_at: v ? new Date(v + 'T23:59:59').toISOString() : null });
              }}
              sx={{ fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4 }}
            />
          )}
          {endKind === 'after_n' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <InputBase
                type="number"
                value={s.max_runs ?? 10}
                onChange={(e) => setSched({ max_runs: Math.max(1, Number(e.target.value) || 1) })}
                sx={{ width: 56, fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4 }}
              />
              <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>runs ({s.runs_count} so far)</Typography>
            </Box>
          )}
        </Box>
        {(() => {
          if (endKind === 'on_date' && s.ends_at) {
            const ends = new Date(s.ends_at).getTime();
            if (!Number.isNaN(ends) && ends <= Date.now()) {
              return (
                <Typography sx={{ fontSize: HINT_FS, color: c.status.warning, pl: 12 }}>
                  This date is in the past. The schedule will turn itself off.
                </Typography>
              );
            }
          }
          if (endKind === 'after_n' && s.max_runs != null && s.runs_count >= s.max_runs) {
            return (
              <Typography sx={{ fontSize: HINT_FS, color: c.status.warning, pl: 12 }}>
                This workflow has already run {s.runs_count}× (limit {s.max_runs}). Raise the number or reset the counter to re-arm.
              </Typography>
            );
          }
          return null;
        })()}
      </Box>

      {/* Section: What can the agent do? */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography sx={{ fontSize: BODY_FS, fontWeight: 600, color: c.text.primary }}>
          What can the agent do?
        </Typography>
        <Select
          size="small"
          value={draft.actions.freeze ? 'scoped' : 'full'}
          onChange={(e) => {
            const scoped = e.target.value === 'scoped';
            if (!scoped) {
              const ok = window.confirm('Full access lets this scheduled run do anything an agent normally can: run commands, edit files, browse the web, send messages. Continue?');
              if (!ok) return;
            }
            setDraft({ ...draft, actions: { ...draft.actions, freeze: scoped } });
          }}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          <MenuItem value="scoped">Only what the original chat used (recommended)</MenuItem>
          <MenuItem value="full">Anything an agent can do (run commands, edit files, browse)</MenuItem>
        </Select>
      </Box>

      {/* Section: How should the agent ask for your permission? */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography sx={{ fontSize: BODY_FS, fontWeight: 600, color: c.text.primary }}>
          How should the agent ask for your permission?
        </Typography>
        {(draft.permissions || []).map((tier, idx) => (
          <PermissionRow
            key={idx}
            idx={idx}
            tier={tier}
            cloudSmsEnabled={Boolean(cloudSms)}
            onChange={(patch) => setTier(idx, patch)}
            onRemove={idx === 0 ? undefined : () => removeTier(idx)}
          />
        ))}
        {canAddBackup && (
          <Box onClick={addBackup} role="button" sx={{ fontSize: LABEL_FS, color: c.text.muted, cursor: 'pointer', mt: 0.5, fontWeight: 500, '&:hover': { color: c.accent.primary } }}>+ Escalate if I don&apos;t respond</Box>
        )}
      </Box>
    </Box>
  );
}

function AppOpenStatusBadge({ info, hour, minute, frequent, onFix }: { info: AppOpenInfo; hour: number; minute: number; frequent: boolean; onFix: () => void }) {
  const c = useClaudeTokens();
  const good = info.alwaysOn;
  const fmt = formatTime(hour, minute);
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1, pl: 0.25,
      bgcolor: good ? c.status.successBg : c.status.warningBg,
      border: `1px solid ${good ? c.status.success + '60' : c.status.warning + '60'}`,
      borderRadius: `${c.radius.md}px`, px: 1, py: 0.5,
    }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: good ? c.status.success : c.status.warning }} />
      <Typography sx={{ flex: 1, fontSize: HINT_FS, color: c.text.primary }}>
        {good ? 'Will run even if you close OpenSwarm.' : (frequent ? 'OpenSwarm must be open for this to run.' : `OpenSwarm must be open at ${fmt} for this to run.`)}
      </Typography>
      {!good && (
        <Tooltip title="One click: start OpenSwarm automatically when you log in, and keep a small icon in your menubar so it stays running when you close the window. You can undo both later in Settings.">
          <Box onClick={onFix} role="button" sx={{ fontSize: HINT_FS, color: c.accent.primary, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}>Always-on</Box>
        </Tooltip>
      )}
    </Box>
  );
}

function PermissionRow({ idx, tier, cloudSmsEnabled, onChange, onRemove }: {
  idx: number;
  tier: PermissionTier;
  cloudSmsEnabled: boolean;
  onChange: (p: Partial<PermissionTier>) => void;
  onRemove?: () => void;
}) {
  const c = useClaudeTokens();
  if (idx === 0) {
    return (
      <Select
        size="small"
        value="notify"
        sx={{ alignSelf: 'flex-start', fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
        <MenuItem value="notify">Notify me in Open Swarm</MenuItem>
      </Select>
    );
  }
  const unitLabel = tier.kind === 'call' ? 'hour' : 'minutes';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pl: 2, position: 'relative' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>after</Typography>
        <InputBase
          type="number"
          value={tier.after_minutes}
          onChange={(e) => onChange({ after_minutes: Math.max(0, Number(e.target.value) || 0) })}
          sx={{ width: 44, fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4 }}
        />
        <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>{unitLabel}</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Select
          size="small"
          value={tier.kind}
          onChange={(e) => onChange({ kind: e.target.value as PermissionTier['kind'] })}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          {tier.kind !== 'call' && <MenuItem value="text">Text me</MenuItem>}
          {tier.kind === 'call' && <MenuItem value="call">Call me</MenuItem>}
        </Select>
        <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>at</Typography>
        <InputBase
          value={tier.phone || ''}
          placeholder="+1 (000) 123 4567"
          onChange={(e) => onChange({ phone: e.target.value })}
          sx={{ flex: 1, fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4, color: c.text.primary }}
        />
        {onRemove && (
          <Box onClick={onRemove} role="button" sx={{ fontSize: HINT_FS, color: c.text.ghost, cursor: 'pointer', px: 0.5, '&:hover': { color: c.status.error } }}>×</Box>
        )}
      </Box>
      {!cloudSmsEnabled && (
        <Typography sx={{ fontSize: HINT_FS, color: c.status.warning, fontStyle: 'italic' }}>
          Coming soon. Until cloud SMS ships, this tier falls back to an in-app notify with a "fallback" badge.
        </Typography>
      )}
    </Box>
  );
}
