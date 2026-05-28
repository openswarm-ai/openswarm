import { createSlice, PayloadAction, createAction } from '@reduxjs/toolkit';

// Cross-slice listeners on agents/* actions; createAction with the same name catches them.
const addMessageAction = createAction<{ sessionId: string; message: { id: string } }>('agents/addMessage');
const editMessageFulfilled = createAction<{ sessionId: string }>('agents/editMessage/fulfilled');
const clearSessionMessagesAction = createAction<string>('agents/clearSessionMessages');
const closeSessionFromWsAction = createAction<{ id: string }>('agents/closeSessionFromWs');
const removeSessionAction = createAction<string>('agents/removeSession');
const stopAgentFulfilledAction = createAction<string>('agents/stopAgent/fulfilled');

// Separate slice so per-char streaming mutations don't bubble through the sessions dict ref.

export interface StreamingMessage {
  id: string;
  role: 'assistant' | 'tool_call' | 'thinking';
  content: string;
  tool_name?: string;
}

interface StreamingState {
  /** Keyed by sessionId; entry exists iff a stream is in flight, removed on stream_end. */
  bySession: Record<string, StreamingMessage>;
}

const initialState: StreamingState = {
  bySession: {},
};

const streamingSlice = createSlice({
  name: 'streaming',
  initialState,
  reducers: {
    streamStart(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; role: StreamingMessage['role']; toolName?: string }>,
    ) {
      state.bySession[action.payload.sessionId] = {
        id: action.payload.messageId,
        role: action.payload.role,
        content: '',
        tool_name: action.payload.toolName,
      };
    },
    streamDelta(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; delta: string }>,
    ) {
      const entry = state.bySession[action.payload.sessionId];
      if (entry && entry.id === action.payload.messageId) {
        entry.content += action.payload.delta;
      }
    },
    streamEnd(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string }>,
    ) {
      const entry = state.bySession[action.payload.sessionId];
      if (entry && entry.id === action.payload.messageId) {
        delete state.bySession[action.payload.sessionId];
      }
    },
    /** Clear when a session is fully closed/removed, so stuck streaming entries don't leak. */
    clearStreamingForSession(state, action: PayloadAction<string>) {
      delete state.bySession[action.payload];
    },
  },
  extraReducers: (builder) => {
    // Final message lands: clear matching streaming placeholder; real bubble takes over.
    builder.addCase(addMessageAction, (state, action) => {
      const entry = state.bySession[action.payload.sessionId];
      if (entry && entry.id === action.payload.message.id) {
        delete state.bySession[action.payload.sessionId];
      }
    });
    // Edit/clear/close/remove wipes any in-flight streaming bubble; the session changed.
    builder.addCase(editMessageFulfilled, (state, action) => {
      delete state.bySession[action.payload.sessionId];
    });
    builder.addCase(clearSessionMessagesAction, (state, action) => {
      delete state.bySession[action.payload];
    });
    builder.addCase(closeSessionFromWsAction, (state, action) => {
      delete state.bySession[action.payload.id];
    });
    builder.addCase(removeSessionAction, (state, action) => {
      delete state.bySession[action.payload];
    });
    builder.addCase(stopAgentFulfilledAction, (state, action) => {
      delete state.bySession[action.payload];
    });
  },
});

export const { streamStart, streamDelta, streamEnd, clearStreamingForSession } = streamingSlice.actions;
export default streamingSlice.reducer;

/** Subscribes only to one session's stream entry; null when no stream is active. */
import { useAppSelector } from '@/shared/hooks';
export function useStreamingMessage(sessionId: string | null | undefined) {
  return useAppSelector((s) => sessionId ? s.streaming.bySession[sessionId] ?? null : null);
}
