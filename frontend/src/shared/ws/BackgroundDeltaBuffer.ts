export interface PendingDelta {
  messageId: string;
  text: string;
}

// Coalesces stream deltas for the ONE backgrounded keep-alive session socket: nobody is reading
// that transcript, so frame-rate Redux dispatches are pure heat (ENG-329). Deltas for the same
// message concatenate; a delta for a DIFFERENT message evicts the pending one so per-session
// ordering can never invert. The socket flushes on a 1s timer, on reopen, and on any non-delta
// event, so no text is ever lost, it just lands in 1Hz batches while backgrounded.
export class BackgroundDeltaBuffer {
  private pending: PendingDelta | null = null;

  // Buffer this delta; returns a delta that must dispatch FIRST to preserve order, or null.
  add(messageId: string, delta: string): PendingDelta | null {
    if (this.pending && this.pending.messageId !== messageId) {
      const evicted = this.pending;
      this.pending = { messageId, text: delta };
      return evicted;
    }
    if (this.pending) {
      this.pending.text += delta;
      return null;
    }
    this.pending = { messageId, text: delta };
    return null;
  }

  take(): PendingDelta | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  get pendingMessageId(): string | null {
    return this.pending?.messageId ?? null;
  }
}
