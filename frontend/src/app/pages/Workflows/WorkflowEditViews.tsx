import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { updateWorkflow, type Workflow, type ScheduleConfig, type PermissionTier } from '@/shared/state/workflowsSlice';
import { WEEKDAY_LABEL, formatTime } from './scheduleUtils';

// JS-style weekday from a Date (Sun=0..Sat=6), matching ScheduleConfig.on_days.
function jsWeekday(d: Date): number { return d.getDay(); }

// Compute the next fire time from a ScheduleConfig — mirrors the backend
// math in scheduler.py:_next_fire_after so the preview matches what
// actually fires. Local-clock, like the backend.
function previewNextRun(sched: ScheduleConfig): Date | null {
  if (!sched.enabled) return null;
  const now = new Date();
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
    let c = new Date(now.getFullYear(), now.getMonth(), Math.min(28, now.getDate()), sched.hour, sched.minute);
    let guard = 0;
    while (c <= now && guard < 60) {
      c = new Date(c.getFullYear(), c.getMonth() + step, c.getDate(), sched.hour, sched.minute);
      guard += 1;
    }
    return c;
  }
  return null;
}

function formatNextRun(d: Date): string {
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${wd} ${mo} ${d.getDate()} at ${formatTime(d.getHours(), d.getMinutes())}`;
}

interface Props {
  workflow: Workflow;
  facet: 'General' | 'Actions' | 'Schedule';
  onChangeFacet: (facet: 'General' | 'Actions' | 'Schedule') => void;
}

const BODY_FS = '0.88rem';
const LABEL_FS = '0.82rem';
const HINT_FS = '0.78rem';
const INPUT_FS = '0.88rem';

// Pre-save validation. Returns the first user-visible reason save should
// be blocked, or null when the draft is good to ship. Keeps the schedule
// from silently saving a "call tier" with no phone number — the previous
// failure mode where the schedule would fire and the call attempt would
// just no-op against an empty string.
function validateDraft(draft: Workflow): string | null {
  for (const tier of (draft.permissions || [])) {
    if (tier.kind === 'notify') continue;
    const cleaned = (tier.phone || '').replace(/[^\d+]/g, '');
    if (!cleaned) {
      return tier.kind === 'text'
        ? 'Add a phone number for the text-me tier.'
        : 'Add a phone number for the call-me tier.';
    }
    if (cleaned.replace(/^\+/, '').length < 7) {
      return `Phone number looks too short (${tier.kind} tier).`;
    }
  }
  return null;
}

export default function WorkflowEditViews({ workflow, facet, onChangeFacet }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [draft, setDraft] = useState<Workflow>(workflow);
  const [busy, setBusy] = useState(false);
  // Save-feedback state: 'idle' | 'saved' | 'error'. `saved` flashes a
  // checkmark + label on the Save button for 1.4s then auto-clears.
  // `error` carries a string the user can read.
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(workflow), [draft, workflow]);

  const onSave = useCallback(async () => {
    if (busy || !dirty) return;
    const reason = validateDraft(draft);
    if (reason) {
      setSaveError(reason);
      return;
    }
    setSaveError(null);
    setBusy(true);
    try {
      const result = await dispatch(updateWorkflow({ id: workflow.id, patch: draft }));
      if (updateWorkflow.fulfilled.match(result)) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1400);
      } else {
        setSaveError('Save failed. Please try again.');
      }
    } catch (e) {
      setSaveError((e as Error)?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  }, [busy, dirty, dispatch, workflow.id, draft]);

  const onDiscard = useCallback(() => {
    setDraft(workflow);
    setSaveError(null);
  }, [workflow]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, fontWeight: 500 }}>Currently Editing</Typography>
        <Select
          size="small"
          value={facet}
          onChange={(e) => onChangeFacet(e.target.value as Props['facet'])}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          <MenuItem value="General">General</MenuItem>
          <MenuItem value="Actions">Actions</MenuItem>
          <MenuItem value="Schedule">Schedule</MenuItem>
        </Select>
        <Box sx={{ flex: 1 }} />
        <ActionBtn label="Discard" tone="muted" disabled={!dirty || busy} onClick={onDiscard} />
        <ActionBtn
          label={savedFlash ? '✓ Saved' : busy ? 'Saving…' : 'Save'}
          tone="success"
          disabled={!dirty || busy || savedFlash}
          onClick={onSave}
        />
      </Box>

      {saveError && (
        <Typography sx={{ fontSize: HINT_FS, color: c.status.error, bgcolor: c.status.errorBg, px: 1, py: 0.5, borderRadius: `${c.radius.md}px` }}>
          {saveError}
        </Typography>
      )}

      {facet === 'General' && <GeneralFacet draft={draft} setDraft={setDraft} />}
      {facet === 'Actions' && <ActionsFacet draft={draft} setDraft={setDraft} />}
      {facet === 'Schedule' && <ScheduleFacet draft={draft} setDraft={setDraft} />}
    </Box>
  );
}

function GeneralFacet({ draft, setDraft }: { draft: Workflow; setDraft: (w: Workflow) => void }) {
  const c = useClaudeTokens();
  const [editingPrompt, setEditingPrompt] = useState(false);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <FieldRow label="Title">
        <InputBase
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          sx={{ flex: 1, fontSize: INPUT_FS, color: c.text.primary, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 1, py: 0.5 }}
        />
      </FieldRow>
      <FieldRow label="Description" align="top">
        <InputBase
          multiline
          minRows={2}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          sx={{ flex: 1, fontSize: INPUT_FS, color: c.text.secondary, lineHeight: 1.5, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 1, py: 0.5 }}
        />
      </FieldRow>
      <FieldRow label="System prompt">
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ fontSize: LABEL_FS, color: c.accent.primary, cursor: 'pointer', fontWeight: 500 }} onClick={() => setEditingPrompt((v) => !v)}>
            {editingPrompt ? 'Editing…' : 'Edit'}
          </Box>
          <Select
            size="small"
            value={draft.use_synced_prompt ? 'synced' : 'custom'}
            onChange={(e) => setDraft({ ...draft, use_synced_prompt: e.target.value === 'synced' })}
            sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
            <MenuItem value="synced">Synced to settings</MenuItem>
            <MenuItem value="custom">Custom</MenuItem>
          </Select>
        </Box>
      </FieldRow>
      {editingPrompt && !draft.use_synced_prompt && (
        <InputBase
          multiline
          minRows={4}
          placeholder="Custom system prompt..."
          value={draft.system_prompt || ''}
          onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
          sx={{ fontSize: INPUT_FS, color: c.text.primary, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, p: 1, lineHeight: 1.5 }}
        />
      )}
      <Typography sx={{ fontSize: BODY_FS, fontWeight: 700, color: c.text.primary, mt: 0.5 }}>Workflow</Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {draft.steps.map((s, idx) => (
          <Box key={s.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
            <Box sx={{ width: 24, height: 24, borderRadius: '50%', border: `1px solid ${c.border.medium}`, fontSize: HINT_FS, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.secondary, flexShrink: 0, mt: 0.4 }}>{idx + 1}</Box>
            <InputBase
              multiline
              value={s.text}
              onChange={(e) => {
                const next = [...draft.steps];
                next[idx] = { ...s, text: e.target.value };
                setDraft({ ...draft, steps: next });
              }}
              sx={{ flex: 1, fontSize: INPUT_FS, color: c.text.primary, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 1.25, py: 0.6, lineHeight: 1.4 }}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ActionsFacet({ draft, setDraft }: { draft: Workflow; setDraft: (w: Workflow) => void }) {
  const c = useClaudeTokens();
  // Configure must ONLY appear when freeze is on (image #40 annotation).
  // When "Don't freeze" is selected the entry vanishes entirely.
  const [configuring, setConfiguring] = useState(false);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, color: c.text.secondary }}>
      <Typography sx={{ fontSize: BODY_FS, color: c.text.secondary, lineHeight: 1.5 }}>
        Do you want to prevent the agent from taking actions that weren&apos;t used in the original workflow?
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Select
          size="small"
          value={draft.actions.prevent_unused ? 'prevent' : 'allow'}
          onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, prevent_unused: e.target.value === 'prevent' } })}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          <MenuItem value="prevent">Prevent all unwanted actions</MenuItem>
          <MenuItem value="allow">Allow all actions</MenuItem>
        </Select>
      </Box>

      <Typography sx={{ fontSize: BODY_FS, color: c.text.secondary, lineHeight: 1.5, mt: 0.5 }}>
        Do you want to freeze the actions available to the Agent so this flow always works even if you change your settings?
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Select
          size="small"
          value={draft.actions.freeze ? 'freeze' : 'dont'}
          onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, freeze: e.target.value === 'freeze' } })}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          <MenuItem value="freeze">Freeze actions</MenuItem>
          <MenuItem value="dont">Don&apos;t freeze</MenuItem>
        </Select>
      </Box>

      {draft.actions.freeze && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
          <Box
            onClick={() => setConfiguring((v) => !v)}
            role="button"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: LABEL_FS, color: configuring ? c.accent.primary : c.text.secondary, cursor: 'pointer', fontWeight: 500, '&:hover': { color: c.accent.primary } }}>
            {configuring ? '⚙ Configuring…' : '⚙ Configure'}
          </Box>
        </Box>
      )}

      {draft.actions.freeze && configuring && (
        <Box sx={{ mt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.6, border: `1px solid ${c.accent.primary}40`, borderRadius: `${c.radius.lg}px`, p: 1.25 }}>
          <Typography sx={{ fontSize: HINT_FS, fontWeight: 700, color: c.text.secondary, letterSpacing: '0.05em', mb: 0.25 }}>BUILT-IN ACTION SETS</Typography>
          {(['Core Actions', 'Extended Actions', 'Apps', 'Browser'] as const).map((set) => {
            const enabled = draft.actions.configured_sets.includes(set);
            return (
              <Box key={set} sx={{ display: 'flex', alignItems: 'center', gap: 1, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 1, py: 0.6 }}>
                <Typography sx={{ flex: 1, fontSize: BODY_FS, color: c.text.primary, fontWeight: 600 }}>{set}</Typography>
                <Switch
                  size="small"
                  checked={enabled}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...draft.actions.configured_sets, set]
                      : draft.actions.configured_sets.filter((s) => s !== set);
                    setDraft({ ...draft, actions: { ...draft.actions, configured_sets: next } });
                  }}
                />
              </Box>
            );
          })}
          <Typography sx={{ fontSize: HINT_FS, fontWeight: 700, color: c.text.secondary, letterSpacing: '0.05em', mt: 0.75, mb: 0.25 }}>CUSTOM ACTION SETS</Typography>
          {(['Notion', 'Google Workspace', 'YouTube', 'Reddit'] as const).map((set) => {
            const enabled = draft.actions.configured_sets.includes(set);
            return (
              <Box key={set} sx={{ display: 'flex', alignItems: 'center', gap: 1, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 1, py: 0.6 }}>
                <Typography sx={{ flex: 1, fontSize: BODY_FS, color: c.text.primary, fontWeight: 600 }}>{set}</Typography>
                <Switch
                  size="small"
                  checked={enabled}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...draft.actions.configured_sets, set]
                      : draft.actions.configured_sets.filter((s) => s !== set);
                    setDraft({ ...draft, actions: { ...draft.actions, configured_sets: next } });
                  }}
                />
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function ScheduleFacet({ draft, setDraft }: { draft: Workflow; setDraft: (w: Workflow) => void }) {
  const c = useClaudeTokens();
  const s = draft.schedule;
  const setSched = useCallback((patch: Partial<ScheduleConfig>) => {
    setDraft({ ...draft, schedule: { ...s, ...patch, enabled: true } });
  }, [draft, s, setDraft]);

  const addBackup = useCallback(() => {
    const tiers = [...(draft.permissions || [])];
    const lastKind = tiers.length ? tiers[tiers.length - 1].kind : 'notify';
    // Tier escalation chain: notify → text → call. Cap at 3 tiers since
    // the chain has no fourth medium and stacking duplicates makes no
    // sense (matches Figma image #44 ceiling).
    if (lastKind === 'notify') tiers.push({ kind: 'text', after_minutes: 5, phone: '' });
    else if (lastKind === 'text') tiers.push({ kind: 'call', after_minutes: 60, phone: '' });
    else return;
    setDraft({ ...draft, permissions: tiers });
  }, [draft, setDraft]);

  const removeTier = useCallback((idx: number) => {
    // Removing tier N drops all tiers after it too, so the chain stays
    // contiguous (no "call" without "text" before it).
    const tiers = (draft.permissions || []).slice(0, idx);
    setDraft({ ...draft, permissions: tiers });
  }, [draft, setDraft]);

  const lastTierKind = (draft.permissions || []).length
    ? draft.permissions[draft.permissions.length - 1].kind
    : 'notify';
  const canAddBackup = lastTierKind !== 'call';

  const setTier = useCallback((idx: number, patch: Partial<PermissionTier>) => {
    const tiers = [...(draft.permissions || [])];
    tiers[idx] = { ...tiers[idx], ...patch };
    setDraft({ ...draft, permissions: tiers });
  }, [draft, setDraft]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Typography sx={{ fontSize: BODY_FS, fontWeight: 700, color: c.text.primary }}>When should this workflow run?</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: BODY_FS, color: c.text.secondary }}>Repeat every</Typography>
        <InputBase
          type="number"
          value={s.repeat_every}
          onChange={(e) => setSched({ repeat_every: Math.max(1, Number(e.target.value) || 1) })}
          sx={{ width: 48, fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4 }}
        />
        <Select
          size="small"
          value={s.repeat_unit}
          onChange={(e) => setSched({ repeat_unit: e.target.value as ScheduleConfig['repeat_unit'] })}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          <MenuItem value="day">day</MenuItem>
          <MenuItem value="week">week</MenuItem>
          <MenuItem value="month">month</MenuItem>
        </Select>
      </Box>
      {s.repeat_unit === 'week' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 2, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>↳ on</Typography>
          {WEEKDAY_LABEL.map((label, idx) => {
            const active = s.on_days.includes(idx);
            return (
              <Box
                key={idx}
                onClick={() => setSched({ on_days: active ? s.on_days.filter((d) => d !== idx) : [...s.on_days, idx] })}
                role="button"
                sx={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: LABEL_FS, fontWeight: 700, cursor: 'pointer', color: active ? '#fff' : c.text.muted, bgcolor: active ? c.accent.primary : 'transparent', border: `1px solid ${active ? c.accent.primary : c.border.subtle}` }}>{label}</Box>
            );
          })}
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 2 }}>
        <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>↳ at</Typography>
        {/* 12-hour picker; we store 0..23 server-side but show 1..12 + AM/PM
            so users can't accidentally schedule "3" thinking it's 3pm and
            get a 3am run (the previous bare-number input made that easy). */}
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
      </Box>

      {(() => {
        // "Next run" preview is the single line that turns "did my schedule
        // actually take?" from a guess into an answer. Re-renders whenever
        // the schedule fields change, so users get instant feedback.
        const next = previewNextRun({ ...s, enabled: true });
        return next ? (
          <Typography sx={{ fontSize: HINT_FS, color: c.accent.primary, pl: 2, fontWeight: 500 }}>
            Next run: {formatNextRun(next)}
          </Typography>
        ) : null;
      })()}

      <Typography sx={{ fontSize: BODY_FS, fontWeight: 700, color: c.text.primary, mt: 0.5 }}>How should the agent ask for your permission?</Typography>
      {(draft.permissions || []).map((tier, idx) => (
        <PermissionRow
          key={idx}
          idx={idx}
          tier={tier}
          prevKind={idx === 0 ? null : (draft.permissions[idx - 1].kind)}
          onChange={(patch) => setTier(idx, patch)}
          onRemove={idx === 0 ? undefined : () => removeTier(idx)}
        />
      ))}
      {canAddBackup && (
        <Box onClick={addBackup} role="button" sx={{ fontSize: LABEL_FS, color: c.text.muted, cursor: 'pointer', mt: 0.5, fontWeight: 500, '&:hover': { color: c.accent.primary } }}>+ add a backup</Box>
      )}
    </Box>
  );
}

function PermissionRow({ idx, tier, onChange, onRemove }: {
  idx: number;
  tier: PermissionTier;
  prevKind: PermissionTier['kind'] | null;
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
  const verb = tier.kind === 'text' ? 'Text me' : 'Call me';
  const unitLabel = tier.kind === 'call' ? 'hour' : 'minutes';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pl: 2, position: 'relative' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>↳ and if I don&apos;t respond after</Typography>
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
        <Typography sx={{ fontSize: HINT_FS, color: c.text.muted }}>at this number</Typography>
        <InputBase
          value={tier.phone || ''}
          placeholder="+1 (000) 123 4567"
          onChange={(e) => onChange({ phone: e.target.value })}
          sx={{ flex: 1, fontSize: INPUT_FS, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.4, color: c.text.primary }}
        />
        {onRemove && (
          <Box
            onClick={onRemove}
            role="button"
            sx={{ fontSize: HINT_FS, color: c.text.ghost, cursor: 'pointer', px: 0.5, '&:hover': { color: c.status.error } }}>
            ×
          </Box>
        )}
      </Box>
    </Box>
  );
}

function FieldRow({ label, children, align }: { label: string; children: React.ReactNode; align?: 'top' | 'center' }) {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'flex', alignItems: align === 'top' ? 'flex-start' : 'center', gap: 1 }}>
      <Typography sx={{ width: 100, flexShrink: 0, fontSize: LABEL_FS, color: c.text.secondary, mt: align === 'top' ? 0.75 : 0, fontWeight: 500 }}>{label}:</Typography>
      {children}
    </Box>
  );
}

function ActionBtn({ label, tone, disabled, onClick }: { label: string; tone: 'muted' | 'success'; disabled?: boolean; onClick: () => void }) {
  const c = useClaudeTokens();
  const isSuccess = tone === 'success';
  return (
    <Box
      onClick={disabled ? undefined : onClick}
      role="button"
      sx={{
        fontSize: LABEL_FS, fontWeight: 600, px: 1.25, py: 0.5,
        borderRadius: `${c.radius.md}px`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: isSuccess ? c.status.success : c.text.secondary,
        bgcolor: isSuccess ? c.status.successBg : c.bg.secondary,
        border: `1px solid ${isSuccess ? c.status.success + '60' : c.border.subtle}`,
        opacity: disabled ? 0.5 : 1,
        '&:hover': { bgcolor: isSuccess ? c.status.success + '30' : c.bg.elevated },
      }}>
      {label}
    </Box>
  );
}
