import { store } from '../state/store';
import { streamStart, streamEnd } from '../state/streamingSlice';
import type { WSEvent } from './types';
import type { WsEventHandlerContext, WsEventHandlerResult } from './eventHandlerTypes';

const STREAM_EVENTS = new Set(['agent:stream_start', 'agent:stream_delta', 'agent:stream_end']);

export function handleAgentStreamEvent(msg: WSEvent, context: WsEventHandlerContext): WsEventHandlerResult {
  const { event, session_id, data } = msg;
  if (!STREAM_EVENTS.has(event)) return null;

  if (context.skipStreamEvents) return false;

  // Replay-skip guard. The WS resume protocol replays buffered events from the ring buffer with seq > last_seq.
  // `resumeAcked` flips to true when server:hello arrives, which the server sends after replay completes.
  if (!context.resumeAcked) return true;

  if (event === 'agent:stream_start') {
    if (session_id && data.message_id) {
      store.dispatch(streamStart({
        sessionId: session_id,
        messageId: data.message_id,
        role: data.role,
        toolName: data.tool_name,
      }));
    }
    return true;
  }

  if (event === 'agent:stream_delta') {
    if (session_id && data.message_id) {
      context.dispatchDelta(session_id, data.message_id, data.delta);
    }
    return true;
  }

  if (session_id && data.message_id) {
    store.dispatch(streamEnd({
      sessionId: session_id,
      messageId: data.message_id,
    }));
  }
  return true;
}
