import React, { useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import ToolCallBubble from '../tool-bubbles/ToolCallBubble';
import { toolUiBubblePropsEqual, type ToolUiBubbleProps } from './toolUiBubbleEqual';
import { perfBaselineFor } from '@/shared/perfBaseline';
import { parseShowUiPayload, freezeIfDone } from './showUiPayload';
import ShowUiWidgetView from './ShowUiWidgetView';
import WidgetCopyChip from './WidgetCopyChip';


/** Renders a ShowUI call as its inline component; any schema mismatch falls back to the plain tool bubble. */
function ToolUiBubble({ pair, sessionId, isPending, suppressReveal, sessionRunning = false }: ToolUiBubbleProps): React.ReactElement {
  // Keyed on the message objects, not the pair: the transcript rebuilds its pair list on every delta while the messages keep their identity.
  const rawPayload = useMemo(() => parseShowUiPayload(pair), [pair.call, pair.result]);
  const widgetRef = useRef<HTMLDivElement>(null);
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
      ref={widgetRef}
      sx={{
        my: 1,
        position: 'relative',
        contain: 'layout style',
        // One-shot entrance (assistant-ui's fade + rise + blur-in): the card arrives, it doesn't pop.
        animation: 'toolUiEnter 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        '@keyframes toolUiEnter': {
          from: { opacity: 0, transform: 'translateY(6px)', filter: 'blur(2px)' },
          to: { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
        },
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        '&:hover .osw-widget-copy': { opacity: 1 },
      }}
      data-select-type="tool-ui"
      data-select-id={pair.id}
      data-select-meta={JSON.stringify({ component: payload.component })}
    >
      <WidgetCopyChip
        component={payload.component === 'vendored' ? payload.name : payload.component}
        props={payload.props as Record<string, unknown>}
        containerRef={widgetRef}
      />
      <ShowUiWidgetView payload={payload} />
    </Box>
  );
}

export default perfBaselineFor('ambient') ? ToolUiBubble : React.memo(ToolUiBubble, toolUiBubblePropsEqual);
