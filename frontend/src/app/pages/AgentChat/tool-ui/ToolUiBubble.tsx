import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import ToolCallBubble from '../tool-bubbles/ToolCallBubble';
import type { ToolPair } from '../tool-bubbles/ToolCallBubble';
import { parseShowUiPayload, freezeIfDone } from './showUiPayload';
import ShowUiWidgetView from './ShowUiWidgetView';

interface ToolUiBubbleProps {
  pair: ToolPair;
  sessionId: string;
  isPending: boolean;
  suppressReveal: boolean;
  sessionRunning?: boolean;
}

/** Renders a ShowUI call as its inline component; any schema mismatch falls back to the plain tool bubble. */
function ToolUiBubble({ pair, sessionId, isPending, suppressReveal, sessionRunning = false }: ToolUiBubbleProps): React.ReactElement {
  const rawPayload = parseShowUiPayload(pair);
  const payload = useMemo(
    () => (rawPayload ? freezeIfDone(rawPayload, sessionRunning) : null),
    [rawPayload, sessionRunning],
  );
  if (!payload) {
    return (
      <ToolCallBubble call={pair.call} result={pair.result} isPending={isPending} sessionId={sessionId} suppressReveal={suppressReveal} />
    );
  }
  return (
    <Box
      sx={{
        my: 1,
        contain: 'layout style',
        // One-shot entrance (assistant-ui's fade + rise + blur-in): the card arrives, it doesn't pop.
        animation: 'toolUiEnter 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        '@keyframes toolUiEnter': {
          from: { opacity: 0, transform: 'translateY(6px)', filter: 'blur(2px)' },
          to: { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
        },
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
      data-select-type="tool-ui"
      data-select-id={pair.id}
      data-select-meta={JSON.stringify({ component: payload.component })}
    >
      <ShowUiWidgetView payload={payload} />
    </Box>
  );
}

export default ToolUiBubble;
