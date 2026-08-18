export type WSEvent = {
  event: string;
  session_id?: string;
  data: Record<string, any>;
  seq?: number;
};

export interface WSManagerOptions {
  skipStreamEvents?: boolean;
  // Session-scoped WSes opt into resume + connection-state dispatches by passing this. Dashboard WS doesn't.
  sessionId?: string;
}

export interface QueuedFrame {
  event: string;
  data: Record<string, any>;
  // Lets the future server-side dedup index match retries to originals. Today the server treats most events idempotently anyway.
  client_msg_id: string;
}
