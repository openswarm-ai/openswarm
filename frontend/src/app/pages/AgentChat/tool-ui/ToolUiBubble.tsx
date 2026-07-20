import React from 'react';
import Box from '@mui/material/Box';
import ToolCallBubble from '../tool-bubbles/ToolCallBubble';
import type { ToolPair } from '../tool-bubbles/ToolCallBubble';
import { parseShowUiPayload } from './showUiPayload';
import WeatherWidget from './WeatherWidget';
import PlanWidget from './PlanWidget';
import StatsWidget from './StatsWidget';
import LinksWidget from './LinksWidget';

interface ToolUiBubbleProps {
  pair: ToolPair;
  sessionId: string;
  isPending: boolean;
  suppressReveal: boolean;
}

/** Renders a ShowUI call as its inline component; any schema mismatch falls back to the plain tool bubble. */
function ToolUiBubble({ pair, sessionId, isPending, suppressReveal }: ToolUiBubbleProps): React.ReactElement {
  const payload = parseShowUiPayload(pair);
  if (!payload) {
    return (
      <ToolCallBubble call={pair.call} result={pair.result} isPending={isPending} sessionId={sessionId} suppressReveal={suppressReveal} />
    );
  }
  return (
    <Box sx={{ my: 1, contain: 'layout style' }} data-select-type="tool-ui" data-select-id={pair.id} data-select-meta={JSON.stringify({ component: payload.component })}>
      {payload.component === 'weather' && <WeatherWidget props={payload.props} />}
      {payload.component === 'plan' && <PlanWidget props={payload.props} />}
      {payload.component === 'stats' && <StatsWidget props={payload.props} />}
      {payload.component === 'links' && <LinksWidget props={payload.props} />}
    </Box>
  );
}

export default ToolUiBubble;
