import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { openConfigurePanel, closeConfigurePanel } from '@/shared/state/dashboardLayoutSlice';
import type { Workflow } from '@/shared/state/workflowsSlice';
import { BODY_FS, LABEL_FS } from './workflowEditCommon';

export default function ActionsFacet({ draft, setDraft }: { draft: Workflow; setDraft: (w: Workflow) => void }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Configure pops the Action Library out as a separate dashboard card
  // tethered to this workflow (image #120). Lives in
  // dashboardLayout.configurePanels keyed by workflow id; user can drag,
  // resize, and X-close from there.
  const configuring = useAppSelector((s) => Boolean(s.dashboardLayout.configurePanels[draft.id]));
  const toggleConfigure = () => {
    if (configuring) dispatch(closeConfigurePanel(draft.id));
    else dispatch(openConfigurePanel({ workflowId: draft.id }));
  };
  // If the user flips Freeze off while the popout is open, close it so
  // the orphaned card doesn't keep listening to a workflow that no
  // longer wants a frozen action set.
  React.useEffect(() => {
    if (!draft.actions.freeze && configuring) {
      dispatch(closeConfigurePanel(draft.id));
    }
  }, [draft.actions.freeze, draft.id, configuring, dispatch]);

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

      {/* Configure only makes sense when actions are frozen: the user
          is explicitly picking a curated subset. With "Don't freeze",
          the agent inherits global settings, so there's nothing to
          configure here. Auto-close the panel on un-freeze so a stale
          popout doesn't outlive the toggle. */}
      {draft.actions.freeze && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
          <Box
            onClick={toggleConfigure}
            role="button"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: LABEL_FS, color: configuring ? c.accent.primary : c.text.secondary, cursor: 'pointer', fontWeight: 500, '&:hover': { color: c.accent.primary } }}>
            {configuring ? '⚙ Configuring…' : '⚙ Configure'}
          </Box>
        </Box>
      )}
    </Box>
  );
}
