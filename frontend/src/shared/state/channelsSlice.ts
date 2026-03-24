import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const CHANNELS_API = `${API_BASE}/channels`;

export interface ChannelAgentConfig {
  mode: string;
  model: string;
  system_prompt?: string;
  max_turns: number;
  allowed_tools?: string[];
}

export interface ChannelSecurityConfig {
  verify_signatures: boolean;
  allowlist: string[];
  blocklist: string[];
  rate_limit_per_minute: number;
  rate_limit_per_hour: number;
}

export interface VoiceConfig {
  mode: 'conversation' | 'notify';
  greeting_message: string;
  silence_timeout_ms: number;
  max_call_duration_seconds: number;
  gather_timeout_seconds: number;
  voice: string;
  language: string;
}

export interface TTSConfig {
  provider: 'twilio_say' | 'elevenlabs' | 'openai_tts' | 'edge_tts';
  auto_tts_mode: 'off' | 'always' | 'inbound' | 'tagged';
  elevenlabs_voice_id?: string;
  elevenlabs_model_id: string;
  openai_voice: string;
  skip_short_text: boolean;
  summarize_long_replies: boolean;
  max_tts_chars: number;
}

export interface STTConfig {
  provider: 'twilio_builtin' | 'deepgram' | 'openai_whisper';
  deepgram_model: string;
  language: string;
  fallback_chain: string[];
}

export interface ChannelConfig {
  id: string;
  name: string;
  channel_type: 'sms' | 'whatsapp' | 'voice';
  provider: 'twilio' | 'telnyx';
  enabled: boolean;
  phone_number: string;
  credentials: Record<string, string>;
  agent_config: ChannelAgentConfig;
  security: ChannelSecurityConfig;
  voice_config?: VoiceConfig;
  tts_config?: TTSConfig;
  stt_config?: STTConfig;
  status: 'inactive' | 'active' | 'error';
  status_message?: string;
  created_at: string;
  updated_at: string;
  last_message_at?: string;
  message_count: number;
}

export interface ChannelMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  media_urls: string[];
  timestamp: string;
  channel_type: string;
  provider_message_id?: string;
}

export interface ChannelConversation {
  id: string;
  channel_id: string;
  phone_number: string;
  agent_session_id?: string;
  messages: ChannelMessage[];
  created_at: string;
  updated_at: string;
  status: 'active' | 'closed';
}

interface ChannelsState {
  items: Record<string, ChannelConfig>;
  conversations: Record<string, ChannelConversation>;
  loading: boolean;
  loaded: boolean;
}

const initialState: ChannelsState = {
  items: {},
  conversations: {},
  loading: false,
  loaded: false,
};

export const fetchChannels = createAsyncThunk(
  'channels/fetch',
  async () => {
    const res = await fetch(`${CHANNELS_API}/list`);
    const data = await res.json();
    return data.channels as ChannelConfig[];
  },
  { condition: (_, { getState }) => !(getState() as { channels: ChannelsState }).channels.loading },
);

export const createChannel = createAsyncThunk(
  'channels/create',
  async (body: Partial<ChannelConfig> & { name: string }) => {
    const res = await fetch(`${CHANNELS_API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.channel as ChannelConfig;
  },
);

export const updateChannel = createAsyncThunk(
  'channels/update',
  async ({ id, ...updates }: Partial<ChannelConfig> & { id: string }) => {
    const res = await fetch(`${CHANNELS_API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    return data.channel as ChannelConfig;
  },
);

export const deleteChannel = createAsyncThunk(
  'channels/delete',
  async (id: string) => {
    await fetch(`${CHANNELS_API}/${id}`, { method: 'DELETE' });
    return id;
  },
);

export const enableChannel = createAsyncThunk(
  'channels/enable',
  async (id: string) => {
    const res = await fetch(`${CHANNELS_API}/${id}/enable`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to enable');
    return id;
  },
);

export const disableChannel = createAsyncThunk(
  'channels/disable',
  async (id: string) => {
    await fetch(`${CHANNELS_API}/${id}/disable`, { method: 'POST' });
    return id;
  },
);

export const testChannel = createAsyncThunk(
  'channels/test',
  async ({ id, to_number }: { id: string; to_number: string }) => {
    const res = await fetch(`${CHANNELS_API}/${id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_number }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Test failed' }));
      throw new Error(err.detail || 'Test failed');
    }
    return await res.json();
  },
);

export const fetchConversations = createAsyncThunk(
  'channels/fetchConversations',
  async (channelId: string) => {
    const res = await fetch(`${CHANNELS_API}/${channelId}/conversations`);
    const data = await res.json();
    return { channelId, conversations: data.conversations as ChannelConversation[] };
  },
);

export const sendOutbound = createAsyncThunk(
  'channels/sendOutbound',
  async ({ channelId, to_number, message }: { channelId: string; to_number: string; message: string }) => {
    const res = await fetch(`${CHANNELS_API}/${channelId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_number, message }),
    });
    return await res.json();
  },
);

export const initiateCall = createAsyncThunk(
  'channels/initiateCall',
  async ({ channelId, to_number }: { channelId: string; to_number: string }) => {
    const res = await fetch(`${CHANNELS_API}/${channelId}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_number }),
    });
    return await res.json();
  },
);

const channelsSlice = createSlice({
  name: 'channels',
  initialState,
  reducers: {
    updateChannelStatus(state, action: PayloadAction<{ channel_id: string; status: string }>) {
      const ch = state.items[action.payload.channel_id];
      if (ch) ch.status = action.payload.status as ChannelConfig['status'];
    },
    addInboundMessage(
      state,
      action: PayloadAction<{ channel_id: string; conversation_id: string; message: ChannelMessage }>,
    ) {
      const conv = state.conversations[action.payload.conversation_id];
      if (conv) {
        conv.messages.push(action.payload.message);
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchChannels.pending, (state) => { state.loading = true; })
      .addCase(fetchChannels.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const c of action.payload) state.items[c.id] = c;
      })
      .addCase(fetchChannels.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(createChannel.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(updateChannel.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(deleteChannel.fulfilled, (state, action) => { delete state.items[action.payload]; })
      .addCase(enableChannel.fulfilled, (state, action) => {
        const ch = state.items[action.payload];
        if (ch) { ch.enabled = true; ch.status = 'active'; }
      })
      .addCase(disableChannel.fulfilled, (state, action) => {
        const ch = state.items[action.payload];
        if (ch) { ch.enabled = false; ch.status = 'inactive'; }
      })
      .addCase(fetchConversations.fulfilled, (state, action) => {
        for (const conv of action.payload.conversations) {
          state.conversations[conv.id] = conv;
        }
      });
  },
});

export const { updateChannelStatus, addInboundMessage } = channelsSlice.actions;
export default channelsSlice.reducer;
