import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { updateWorkflow, type Workflow } from '@/shared/state/workflowsSlice';
import { validateDraft } from './permissionsUtils';
import { ActionBtn, HINT_FS, LABEL_FS } from './workflowEditCommon';
import GeneralFacet from './GeneralFacet';
import ActionsFacet from './ActionsFacet';
import ScheduleFacet from './ScheduleFacet';

interface Props {
  workflow: Workflow;
  facet: 'General' | 'Actions' | 'Schedule';
  onChangeFacet: (facet: 'General' | 'Actions' | 'Schedule') => void;
  // Lifted dirty state so the parent card can decorate the Edit tab with
  // an unsaved-changes dot. Optional; older callers don't need to wire it.
  onDirtyChange?: (dirty: boolean) => void;
}

export default function WorkflowEditViews({ workflow, facet, onChangeFacet, onDirtyChange }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [draft, setDraft] = useState<Workflow>(workflow);
  const [busy, setBusy] = useState(false);
  // Save-feedback state. `savedFlash` flashes a checkmark for 1.4s then
  // auto-clears; `saveError` carries a string the user can read.
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(workflow), [draft, workflow]);

  // Push the dirty flag up so the parent card can decorate the Edit tab.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // Clear the parent's flag on unmount so a closed editor doesn't leave
  // a stale "you have unsaved changes" dot on the tab.
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  // Auto-save on a quiet idle. We debounce 800ms after the last edit so
  // rapid typing doesn't fire dozens of PATCHes. Validation still gates
  // the network call so bad drafts (empty phone, etc.) don't auto-save
  // a broken state. Explicit Save still works for users who want it.
  useEffect(() => {
    if (!dirty || busy) return;
    if (validateDraft(draft)) return; // skip auto-save while invalid
    const handle = window.setTimeout(() => { onSaveRef.current?.(); }, 800);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, busy]);
  // onSave refs itself so the effect above doesn't depend on it.
  const onSaveRef = React.useRef<(() => Promise<void>) | null>(null);

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
      // If-Match: pass the workflow's current updated_at so the backend
      // can reject a stale write. Without this, two open windows or a
      // mid-edit background fire silently clobber each other.
      const result = await dispatch(updateWorkflow({
        id: workflow.id,
        patch: draft,
        ifMatch: workflow.updated_at || null,
      }));
      if (updateWorkflow.fulfilled.match(result)) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1400);
      } else if (result.payload?.kind === 'stale') {
        setSaveError('This workflow was changed in another window or by a recent run. Discard to reload the latest, then re-apply your edits.');
      } else {
        setSaveError(result.payload?.message || 'Save failed. Please try again.');
      }
    } catch (e) {
      setSaveError((e as Error)?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  }, [busy, dirty, dispatch, workflow.id, workflow.updated_at, draft]);

  // Keep the ref pointing at the latest onSave so the auto-save effect
  // can call it without re-subscribing on every keystroke.
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  const onDiscard = useCallback(() => {
    setDraft(workflow);
    setSaveError(null);
  }, [workflow]);

  // Right-edge save indicator. dirty + busy + savedFlash collapse to a
  // single state so the button doesn't flicker between "Save now" and
  // "Up to date" mid-keystroke. When idle and clean, show a quiet
  // check-mark "Saved" label that's identical to the post-flash state.
  const saveState: 'dirty' | 'busy' | 'saved' = busy ? 'busy' : dirty ? 'dirty' : 'saved';
  const _flash = savedFlash; void _flash;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {/* Top control row, target image #67:
            "Currently Editing  [Select▾]"   spacer   [Discard] [Save]
          Discard + Save are the same pill-style buttons used at the
          bottom of SavedView; placing them here gives the user a single
          place to commit OR throw away whatever they just edited. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, fontWeight: 500 }}>Currently Editing</Typography>
        <Select
          size="small"
          value={facet}
          onChange={(e) => onChangeFacet(e.target.value as Props['facet'])}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.4 } }}>
          <MenuItem value="General">General</MenuItem>
          <MenuItem value="Actions">Actions</MenuItem>
          <MenuItem value="Schedule">Schedule</MenuItem>
        </Select>
        <Box sx={{ flex: 1 }} />
        <ActionBtn
          label="Discard"
          tone="danger"
          icon="trash"
          disabled={!dirty || busy}
          onClick={onDiscard}
        />
        <ActionBtn
          label={busy ? 'Saving…' : 'Save'}
          tone="success"
          icon="check"
          disabled={!dirty || busy || saveState === 'saved'}
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
