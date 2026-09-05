import type { ToolPair } from '../tool-bubbles/ToolCallBubble';

export interface ToolUiBubbleProps {
  pair: ToolPair;
  sessionId: string;
  isPending: boolean;
  suppressReveal: boolean;
  sessionRunning?: boolean;
}

/** The transcript re-renders on every streamed delta and rebuilds every pair object; the messages inside keep their identity, so that is what decides whether a ShowUI bubble has anything new to draw. */
export function toolUiBubblePropsEqual(prev: ToolUiBubbleProps, next: ToolUiBubbleProps): boolean {
  return prev.pair.call === next.pair.call
    && prev.pair.result === next.pair.result
    && prev.sessionId === next.sessionId
    && prev.isPending === next.isPending
    && prev.suppressReveal === next.suppressReveal
    && (prev.sessionRunning ?? false) === (next.sessionRunning ?? false);
}
