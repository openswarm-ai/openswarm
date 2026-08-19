import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import IconButton from '@mui/material/IconButton';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ToolCallBubble from '../tool-bubbles/ToolCallBubble';
import type { ToolPair } from '../tool-bubbles/ToolCallBubble';
import { parseShowUiPayload } from './showUiPayload';
import { isAskAnswered, markAskAnswered, releaseAskAnswer, subscribeAskAnswers } from './askAnswerRegistry';
import VendoredToolUi from '@toolui/VendoredToolUi';
import { API_BASE, getAuthToken } from '@/shared/config';

// The choice components that replaced AskUserQuestion, which always had an "Other" escape hatch.
const FREE_TEXT_COMPONENTS = new Set(['option-list', 'question-flow']);

interface AskUiBubbleProps {
  pair: ToolPair;
  sessionId: string;
  isPending: boolean;
  suppressReveal: boolean;
  onAnswered?: () => void;
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
function AskUiBubble({ pair, sessionId, isPending, suppressReveal, onAnswered }: AskUiBubbleProps): React.ReactElement {
  const payload = parseShowUiPayload(pair);
  const [submitted, setSubmitted] = useState(false);
  const [orphaned, setOrphaned] = useState(false);
  const [freeText, setFreeText] = useState('');
  // The choice captured at click time, so the component flips to its receipt the INSTANT the user
  // answers instead of staying clickable until the agent's tool result lands seconds later.
  const [localChoice, setLocalChoice] = useState<unknown>(undefined);
  const answered = parseResultResponse(pair);
  const freeTextAnswer =
    answered?.action === 'free_text' && answered.value && typeof answered.value === 'object'
      ? String((answered.value as Record<string, unknown>).text ?? '')
      : null;

  const componentId = payload && payload.component === 'vendored' ? String(payload.props.id || '') : '';

  // message-draft's send gesture fires BOTH onAction('send') and onSend in one tick, before setSubmitted re-renders; the ref blocks the second POST (which would sit in the server's early buffer and could auto-answer a same-id re-ask).
  const inFlight = useRef(false);
  // Shared across every surface this same question renders on, so answering here disables it there too.
  const answeredElsewhere = useSyncExternalStore(
    subscribeAskAnswers,
    () => isAskAnswered(sessionId, componentId),
  );
  const respond = useCallback(
    (response: Record<string, unknown>) => {
      if (submitted || inFlight.current || isAskAnswered(sessionId, componentId)) return;
      inFlight.current = true;
      markAskAnswered(sessionId, componentId);
      setSubmitted(true);
      onAnswered?.();
      if (response.action !== 'free_text') {
        setLocalChoice(response.choice ?? response.value ?? undefined);
      }
      void fetch(`${API_BASE}/ui-requests/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({ session_id: sessionId, component_id: componentId, response }),
      })
        .then(async (r) => {
          const body = r.ok ? await r.json().catch(() => null) : null;
          if (!r.ok || (body && body.gone)) {
            // Nothing parked server-side (agent gone or this is a replayed transcript): say so instead of silently swallowing the click.
            inFlight.current = false;
            releaseAskAnswer(sessionId, componentId);
            setSubmitted(false);
            setLocalChoice(undefined);
            setOrphaned(true);
          }
        })
        .catch(() => { inFlight.current = false; releaseAskAnswer(sessionId, componentId); setSubmitted(false); setLocalChoice(undefined); setOrphaned(true); });
    },
    [submitted, sessionId, componentId, onAnswered],
  );

  // isPending gates clickability: once the session stops or completes, an unanswered ask must never look live (bounced asks used to revive as clickable dupes whose answers vanished into the 45s buffer, ENG-232).
  const waiting = pair.result === null && !submitted && isPending && !answeredElsewhere;
  // A result that isn't the JSON answer envelope (timeout prose, validation bounce) means this ask is dead; it must not look answerable (ENG-232).
  const expired = (pair.result !== null && answered === null)
    || (pair.result === null && !isPending && !submitted && localChoice === undefined);

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
        : { choice: (answered?.choice as string) ?? (localChoice as string | undefined) };
    }
    if (waiting) {
      const base = {
        onAction: (actionId: string, state: unknown) => {
          if (actionId === 'cancel') return;
          respond({ action: actionId, value: state ?? null });
        },
      };
      // message-draft's send flow fires onSend (after its undo grace), not onAction; without this the send animation completes while nothing reaches the agent.
      if (payload.name === 'message-draft') {
        return { ...base, onSend: () => respond({ action: 'send', value: null }) };
      }
      // question-flow never fires onAction: the flat one-step wire shape routes to Progressive mode whose Next fires onSelect(ids), and the multi-step shape finishes via onComplete(answers); unwired, the flow completed visually while delivering nothing (ENG-232).
      if (payload.name === 'question-flow') {
        return {
          ...base,
          onSelect: (selection: unknown) => respond({ action: 'select', value: selection ?? null }),
          onComplete: (answers: unknown) => respond({ action: 'complete', value: answers ?? null }),
        };
      }
      return base;
    }
    // A free-text answer isn't an option id; passing it as `choice` would fail their contract.
    if (freeTextAnswer !== null) return {};
    const answeredValue = answered && 'value' in answered ? answered.value : localChoice;
    // question-flow's receipt contract is {title, summary:[{label,value}]}, not the raw answer; a raw array or object crashes its summary.map (ENG-232).
    if (payload.name === 'question-flow') {
      if (answeredValue === undefined || answeredValue === null) return {};
      const rp = (payload.props ?? {}) as Record<string, unknown>;
      const receiptTitle = typeof rp.title === 'string' && rp.title.trim() ? rp.title : 'Answered';
      const entries: Array<[string, string]> = Array.isArray(answeredValue)
        ? [['Choice', answeredValue.map(String).join(', ')]]
        : typeof answeredValue === 'object'
          ? Object.entries(answeredValue as Record<string, unknown>).map(
              ([k, v]): [string, string] => [k, Array.isArray(v) ? v.map(String).join(', ') : String(v)],
            )
          : [['Choice', String(answeredValue)]];
      const summary = entries.filter(([, v]) => v.trim().length > 0).map(([label, value]) => ({ label, value }));
      if (summary.length === 0) return {};
      return { choice: { title: receiptTitle, summary } };
    }
    if (answered && 'value' in answered) return { choice: answered.value };
    // Result not landed yet but the user already clicked: the captured choice renders the receipt now.
    return localChoice !== undefined ? { choice: localChoice } : {};
  }, [payload, waiting, respond, answered, freeTextAnswer, localChoice]);

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

  // The vendored choice contracts carry no question field, so agents' title/description props silently vanish and the user sees options with no question; render them as a host header instead (ENG-227).
  const rawProps = (payload.props ?? {}) as Record<string, unknown>;
  const questionTitle: string = [rawProps.title, rawProps.question, rawProps.prompt, rawProps.heading]
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? '';
  const questionDesc: string = typeof rawProps.description === 'string' && rawProps.description !== questionTitle
    ? rawProps.description : '';
  return (
    <Box sx={{ my: 1, contain: 'layout style' }} data-select-type="tool-ui-ask" data-select-id={pair.id} data-select-meta={JSON.stringify({ component: payload.name })}>
      {(questionTitle || questionDesc) && (
        <Box sx={{ mb: 0.75, px: 0.5 }}>
          {questionTitle && (
            <Typography sx={{ fontSize: '0.9375rem', fontWeight: 600, color: 'text.primary', lineHeight: 1.35 }}>
              {questionTitle}
            </Typography>
          )}
          {questionDesc && (
            <Typography sx={{ fontSize: '0.8125rem', color: 'text.secondary', mt: 0.25, lineHeight: 1.4 }}>
              {questionDesc}
            </Typography>
          )}
        </Box>
      )}
      <Box sx={expired ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <VendoredToolUi name={payload.name} props={payload.props} extraProps={extraProps} />
      </Box>
      {expired && (
        <Box sx={{ fontSize: '0.75rem', opacity: 0.55, pt: 0.5 }}>
          This question expired before it was answered; if the agent asked again, use the newer card.
        </Box>
      )}
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
          This answer didn't reach the agent (it may have stopped, expired, or the connection dropped). Try again.
        </Box>
      )}
    </Box>
  );
}

export default AskUiBubble;
