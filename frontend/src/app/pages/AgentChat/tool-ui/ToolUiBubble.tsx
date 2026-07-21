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
    <Box sx={{ my: 1, contain: 'layout style' }} data-select-type="tool-ui" data-select-id={pair.id} data-select-meta={JSON.stringify({ component: payload.component })}>
      <ShowUiWidgetView payload={payload} />
    </Box>
  );
}

export default ToolUiBubble;
