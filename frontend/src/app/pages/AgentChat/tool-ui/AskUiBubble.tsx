import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import IconButton from '@mui/material/IconButton';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ToolCallBubble from '../tool-bubbles/ToolCallBubble';
import type { ToolPair } from '../tool-bubbles/ToolCallBubble';
import { parseShowUiPayload } from './showUiPayload';
import VendoredToolUi from '@toolui/VendoredToolUi';
import { API_BASE, getAuthToken } from '@/shared/config';

// The choice components that replaced AskUserQuestion, which always had an "Other" escape hatch.
const FREE_TEXT_COMPONENTS = new Set(['option-list', 'question-flow']);

interface AskUiBubbleProps {
  pair: ToolPair;
  sessionId: string;
  isPending: boolean;
  suppressReveal: boolean;
}

function parseResultResponse(pair: ToolPair): Record<string, unknown> | null {
  const rc = pair.result?.content;
  const text = typeof rc === 'string' ? rc : typeof rc === 'object' && rc?.text ? String(rc.text) : '';
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** An AskUI call: the live interactive component while the agent waits; its answered state after. */
function AskUiBubble({ pair, sessionId, isPending, suppressReveal }: AskUiBubbleProps): React.ReactElement {
  const payload = parseShowUiPayload(pair);
  const [submitted, setSubmitted] = useState(false);
  const [orphaned, setOrphaned] = useState(false);
  const [freeText, setFreeText] = useState('');
  const answered = parseResultResponse(pair);
  const freeTextAnswer =
    answered?.action === 'free_text' && answered.value && typeof answered.value === 'object'
      ? String((answered.value as Record<string, unknown>).text ?? '')
      : null;

  const componentId = payload && payload.component === 'vendored' ? String(payload.props.id || '') : '';

  const respond = useCallback(
    (response: Record<string, unknown>) => {
      if (submitted) return;
      setSubmitted(true);
      void fetch(`${API_BASE}/ui-requests/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({ session_id: sessionId, component_id: componentId, response }),
      })
        .then((r) => {
          if (!r.ok) {
            // Nothing parked server-side (agent gone or this is a replayed transcript): say so instead of silently swallowing the click.
            setSubmitted(false);
            setOrphaned(true);
          }
        })
        .catch(() => setSubmitted(false));
    },
    [submitted, sessionId, componentId],
  );

  const waiting = pair.result === null && !submitted;

  // Their embedded-actions contract: onAction(actionId, state) delivers the component's full state,
  // and the components ship their own footer actions (Clear/Confirm), so we only wire the callback.
  // 'cancel' is a local clear, never an answer; approval-card uses onConfirm/onCancel instead.
  const extraProps = useMemo(() => {
    if (!payload || payload.component !== 'vendored') return {};
    if (payload.name === 'approval-card') {
      return waiting
        ? {
            onConfirm: () => respond({ action: 'confirm', choice: 'approved' }),
            onCancel: () => respond({ action: 'cancel', choice: 'denied' }),
          }
        : { choice: (answered?.choice as string) || undefined };
    }
    if (waiting) {
      return {
        onAction: (actionId: string, state: unknown) => {
          if (actionId === 'cancel') return;
          respond({ action: actionId, value: state ?? null });
        },
      };
    }
    // A free-text answer isn't an option id; passing it as `choice` would fail their contract.
    if (freeTextAnswer !== null) return {};
    return answered && 'value' in answered ? { choice: answered.value } : {};
  }, [payload, waiting, respond, answered, freeTextAnswer]);

  const submitFreeText = useCallback(() => {
    const text = freeText.trim();
    if (!text) return;
    respond({ action: 'free_text', value: { text } });
  }, [freeText, respond]);

  if (!payload || payload.component !== 'vendored' || !componentId) {
    return (
      <ToolCallBubble call={pair.call} result={pair.result} isPending={isPending} sessionId={sessionId} suppressReveal={suppressReveal} />
    );
  }

  return (
    <Box sx={{ my: 1, contain: 'layout style' }} data-select-type="tool-ui-ask" data-select-id={pair.id} data-select-meta={JSON.stringify({ component: payload.name })}>
      <VendoredToolUi name={payload.name} props={payload.props} extraProps={extraProps} />
      {waiting && FREE_TEXT_COMPONENTS.has(payload.name) && (
        <Box
          component="form"
          onSubmit={(e: React.FormEvent) => { e.preventDefault(); submitFreeText(); }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 0.75,
            px: 1.25,
            py: 0.25,
            borderRadius: 999,
            background: 'rgba(127,127,127,0.08)',
            border: '1px solid rgba(127,127,127,0.14)',
            maxWidth: 420,
          }}
        >
          <InputBase
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Or type your own answer..."
            inputProps={{ 'aria-label': 'Type your own answer' }}
            sx={{ flex: 1, fontSize: '0.8125rem' }}
          />
          <IconButton type="submit" size="small" disabled={!freeText.trim()} aria-label="Send answer">
            <ArrowUpwardRoundedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      )}
      {freeTextAnswer !== null && (
        <Box sx={{ fontSize: '0.75rem', opacity: 0.75, pt: 0.75 }}>
          &#10003; Answered: {freeTextAnswer}
        </Box>
      )}
      {submitted && pair.result === null && (
        <Box sx={{ fontSize: '0.75rem', opacity: 0.55, pt: 0.5 }}>Sent to the agent...</Box>
      )}
      {orphaned && (
        <Box sx={{ fontSize: '0.75rem', opacity: 0.55, pt: 0.5 }}>
          No agent is waiting for this answer (the request expired or this is an old transcript).
        </Box>
      )}
    </Box>
  );
}

export default AskUiBubble;
