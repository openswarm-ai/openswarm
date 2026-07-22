import React, { useEffect, useState } from 'react';
import { AgentMessage } from '@/shared/state/agentsSlice';
import MessageBubble from './MessageBubble';
import { useSmoothText } from './useSmoothText';

interface Props {
  message: AgentMessage;
  // Captured once at mount: a message that arrived whole mid-run types itself out; history never re-animates.
  animate: boolean;
  onGrew?: () => void;
  viewportHeight?: number;
  viewportWidth?: number;
  scrollRoot?: Element | null;
}

/** Short post-tool answers often COMMIT whole and skip the streaming slice entirely, so they popped
    while true streams typed. Route fresh commits through the same smooth reveal (assistant-ui's
    drain pattern), then settle into the identical committed render so the handoff can't flash. */
function BurstRevealBubble({ message, animate, onGrew, viewportHeight, viewportWidth, scrollRoot }: Props): React.ReactElement {
  const [shouldAnimate] = useState(animate);
  const full = typeof message.content === 'string' ? message.content : '';
  const [done, setDone] = useState(!shouldAnimate || full.length === 0);
  const { text, revealRef } = useSmoothText(full, !done);
  useEffect(() => {
    if (!done && text.length >= full.length) setDone(true);
  }, [done, text.length, full.length]);
  const grewRef = React.useRef(onGrew);
  grewRef.current = onGrew;
  useEffect(() => {
    if (!done) grewRef.current?.();
  }, [text.length, done]);
  if (done) {
    return <MessageBubble message={message} viewportHeight={viewportHeight} viewportWidth={viewportWidth} scrollRoot={scrollRoot} />;
  }
  return (
    <MessageBubble
      message={{ ...message, content: text }}
      isStreaming
      revealRef={revealRef}
      viewportHeight={viewportHeight}
      viewportWidth={viewportWidth}
      scrollRoot={scrollRoot}
    />
  );
}

export default BurstRevealBubble;
