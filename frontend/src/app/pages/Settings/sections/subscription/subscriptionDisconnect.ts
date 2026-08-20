/**
 * Disconnect, extracted from SubscriptionCards so the one invariant that matters is testable:
 * the spinner is ALWAYS released, whatever any step does.
 *
 * Inline, the refresh that follows the disconnect sat outside the try. fetchStatus() unwraps a
 * redux thunk, so a rejected refresh throws, and that throw sailed straight past
 * setDisconnecting(null): the row spun forever with no exit but closing Settings, while the
 * disconnect it was reporting on had usually already succeeded. Ending a spinner belongs in a
 * finally, never on the happy path. It lives here rather than in the component because the test
 * runner deliberately has no DOM (see scripts/run-tests.mjs).
 */

export interface DisconnectResponse {
  ok?: boolean;
  error?: string;
}

export interface DisconnectCtx {
  providerId: string;
  apiBase: string;
  fetchStatus: () => Promise<unknown>;
  refreshPickerModels: () => void;
  setDisconnectError: (e: { provider: string; message: string } | null) => void;
  setDisconnecting: (v: string | null) => void;
  // Injected so the test can drive real failure shapes without a DOM or a network.
  fetchImpl?: typeof fetch;
}

export async function performDisconnect(ctx: DisconnectCtx): Promise<void> {
  const {
    providerId, apiBase, fetchStatus, refreshPickerModels,
    setDisconnectError, setDisconnecting,
  } = ctx;
  const doFetch = ctx.fetchImpl ?? fetch;

  setDisconnectError(null);
  setDisconnecting(providerId);
  try {
    try {
      const r = await doFetch(`${apiBase}/agents/subscriptions/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = (await r.json().catch(() => ({}))) as DisconnectResponse;
      if (!r.ok || !data.ok) {
        setDisconnectError({
          provider: providerId,
          message: data.error || 'Could not disconnect. Please try again.',
        });
      }
    } catch {
      setDisconnectError({
        provider: providerId,
        message: 'Could not reach OpenSwarm. Please try again.',
      });
    }
    try {
      // A stale row self-corrects on the next poll; a stuck spinner never does, so this is best-effort.
      await fetchStatus();
      refreshPickerModels();
    } catch {
      // Swallowed on purpose: a failed refresh must not decide whether the spinner ends.
    }
  } finally {
    setDisconnecting(null);
  }
}
