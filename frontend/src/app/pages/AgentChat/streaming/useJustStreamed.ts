import { useEffect, useRef, useState } from 'react';

// A tool's live pill is already on screen when it commits, so re-running the mount reveal on the committed bubble flashes the exact same row. Remember the id that just stopped streaming for a beat and let that one bubble skip its entrance, so the hand-off is seamless. 500ms is slack for the commit render to land after the stream clears (they don't always arrive on the same frame).
export function useJustStreamed(streamingMessageId: string | null): string | null {
  const [justStreamedId, setJustStreamedId] = useState<string | null>(null);
  const prevRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = streamingMessageId;
    if (prev && !streamingMessageId) {
      setJustStreamedId(prev);
      const t = setTimeout(() => setJustStreamedId(null), 500);
      return () => clearTimeout(t);
    }
  }, [streamingMessageId]);
  return justStreamedId;
}
