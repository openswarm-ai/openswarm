import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { fetchSession, resumeSession } from '@/shared/state/agentsSlice';
import {
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  placeCard,
} from '@/shared/state/dashboardLayoutSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { store } from '@/shared/state/store';
import type { Workflow } from '@/shared/state/workflowsSlice';
import { FieldRow, BODY_FS, LABEL_FS, HINT_FS, INPUT_FS } from './workflowEditCommon';

export default function GeneralFacet({ draft, setDraft }: { draft: Workflow; setDraft: (w: Workflow) => void }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const sourceSessionId = draft.source_session_id || null;
  // Open the source chat: fetch if missing, fall through to resume if
  // it was closed, place a card if there isn't one. That's it. No pan
  // animation, no focus pin, no dashboard_id patching, no auto-clear
  // timers. Match the way any other chat opens on the canvas; let the
  // user scroll to it.
  const openSourceChat = React.useCallback(async () => {
    if (!sourceSessionId) return;
    const sid = sourceSessionId;
    if (!store.getState().agents.sessions[sid]) {
      try {
        await dispatch(fetchSession(sid)).unwrap();
      } catch {
        try {
          await dispatch(resumeSession({ sessionId: sid })).unwrap();
        } catch {
          return;
        }
      }
    }
    if (!store.getState().dashboardLayout.cards[sid]) {
      dispatch(placeCard({
        sessionId: sid,
        x: 400, y: 200,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
      }));
    }
    // Pan the canvas to the chat card so the user can see it. Safe to
    // do here because the active element is the Edit button, not a
    // textarea: handleCardSelect's input-aware blur guard prevents the
    // focus animation from killing typing focus in a separate flow.
    dispatch(setPendingFocusAgentId(sid));
  }, [sourceSessionId, dispatch]);
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
        <Select
          size="small"
          value={draft.use_synced_prompt ? 'synced' : 'custom'}
          onChange={(e) => setDraft({ ...draft, use_synced_prompt: e.target.value === 'synced' })}
          sx={{ fontSize: LABEL_FS, '& .MuiSelect-select': { py: 0.5 } }}>
          <MenuItem value="synced">Synced to settings</MenuItem>
          <MenuItem value="custom">Custom</MenuItem>
        </Select>
      </FieldRow>
      {!draft.use_synced_prompt && (
        <InputBase
          multiline
          minRows={4}
          placeholder="Custom system prompt..."
          value={draft.system_prompt || ''}
          onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
          sx={{ fontSize: INPUT_FS, color: c.text.primary, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, p: 1, lineHeight: 1.5 }}
        />
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
        <Typography sx={{ fontSize: BODY_FS, fontWeight: 700, color: c.text.primary, flex: 1 }}>Workflow</Typography>
        {sourceSessionId && (
          <Box
            role="button"
            onClick={openSourceChat}
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.4,
              fontSize: LABEL_FS, fontWeight: 600,
              color: c.text.muted, cursor: 'pointer',
              '&:hover': { color: c.accent.primary },
            }}>
            <EditOutlinedIcon sx={{ fontSize: 14 }} />
            Edit
          </Box>
        )}
      </Box>
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
