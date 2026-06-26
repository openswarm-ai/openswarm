import type { Dispatch } from '@reduxjs/toolkit';
import { removeViewCard } from '@/shared/state/dashboardLayoutSlice';
import { getViewWebview } from '@/shared/viewWebviewRegistry';

// A wedged app must never hold a card open; cap the whole quiesce so delete stays responsive. Common case (about:blank is a trivial nav) resolves in well under this.
const QUIESCE_BUDGET_MS = 250;

// Navigate a doomed card's webview to about:blank so the running app's heavy GPU surfaces are released BEFORE React destroys the <webview>, leaving only a trivial surface to tear down. Bounded + fail-open.
export async function quiesceViewWebview(outputId: string): Promise<void> {
  const wv = getViewWebview(outputId);
  if (!wv) return;
  try {
    await Promise.race([
      wv.loadURL('about:blank').catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, QUIESCE_BUDGET_MS)),
    ]);
  } catch {
    // webview already torn down; nothing to quiesce
  }
}

// Quiesce a card's live preview surface, THEN remove it. Every view-card delete path routes through here so none rips a live <webview> GPU surface out mid-composite. Awaited in a loop (multi-select Delete, orphan prune) the teardowns SERIALIZE, which is what stops the simultaneous "non-existent mailbox" pile-up that kills the GPU process.
export async function removeViewCardCleanly(outputId: string, dispatch: Dispatch): Promise<void> {
  await quiesceViewWebview(outputId);
  dispatch(removeViewCard(outputId));
}
