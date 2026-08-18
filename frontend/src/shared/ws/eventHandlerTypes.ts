export type WsEventHandlerContext = {
  resumeAcked: boolean;
  skipStreamEvents: boolean;
  dispatchDelta: (sessionId: string, messageId: string, delta: string) => void;
};

export type WsEventHandlerResult = boolean | null;
