import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { updateWorkflow, updateWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
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
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(workflow), [draft, workflow]);

  // Push the dirty flag up so the parent card can decorate the Edit tab.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // Clear the parent's flag on unmount so a closed editor doesn't leave
  // a stale "you have unsaved changes" dot on the tab.
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  // Save is explicit only. The previous auto-save raced the Save button:
  // the user toggled a field, autosave fired 800ms later, dirty went
  // false, and a manual Save click became a no-op.
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
        // Rebase the draft on the server's echoed copy. Without this,
        // `dirty` would stay true after Save (because updated_at differs)
        // and the user would see a phantom "unsaved" state.
        const saved = result.payload as Workflow;
        if (saved) setDraft(saved);
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
      {/* Match target image #111: left cluster (label + facet picker)
          flush-left, action pills flush-right, generous breathing room
          between. Gap inside each cluster stays tight so the two read
          as two distinct groups, not five evenly-spaced chips. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', minWidth: 0, py: 0.5 }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <Box
            onClick={() => dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }))}
            role="button"
            aria-label="Back"
            sx={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, borderRadius: 999, mr: 0.25,
              color: c.text.secondary, cursor: 'pointer',
              '&:hover': { color: c.text.primary, bgcolor: c.bg.elevated },
            }}>
            <ArrowBackRounded sx={{ fontSize: 17 }} />
          </Box>
          <Typography sx={{ fontSize: LABEL_FS, color: c.text.secondary, fontWeight: 500 }}>Currently Editing</Typography>
          <Select
            size="small"
            value={facet}
            onChange={(e) => onChangeFacet(e.target.value as Props['facet'])}
            sx={{ fontSize: LABEL_FS, minWidth: 110, '& .MuiSelect-select': { py: 0.4 } }}>
            <MenuItem value="General">General</MenuItem>
            <MenuItem value="Actions">Actions</MenuItem>
            <MenuItem value="Schedule">Schedule</MenuItem>
          </Select>
        </Box>
        <Box sx={{ flex: 1, minWidth: 24 }} />
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <ActionBtn
            label="Discard"
            tone="danger"
            icon="trash"
            disabled={!dirty || busy}
            onClick={onDiscard}
          />
          <Box sx={{ display: 'inline-flex', minWidth: 80, justifyContent: 'center' }}>
            <ActionBtn
              label={busy ? 'Saving…' : 'Save'}
              tone="success"
              icon="check"
              disabled={!dirty || busy || saveState === 'saved'}
              onClick={onSave}
            />
          </Box>
        </Box>
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
