// Live app-card preview webviews keyed by output id. The delete path looks a card's <webview> up here to quiesce its GPU surface BEFORE React rips the element out; without it, deleting a couple of large app cards at once tears down several live SharedImage surfaces in one frame, which piles up "non-existent mailbox" errors and kills the GPU process (taking the whole app down with no dump). Mirror of browserRegistry, for the non-CDP preview webviews.
export interface ViewWebview extends HTMLElement {
  loadURL: (url: string) => Promise<void>;
}

const registry = new Map<string, ViewWebview>();

export function registerViewWebview(outputId: string, wv: ViewWebview): void {
  registry.set(outputId, wv);
}

export function unregisterViewWebview(outputId: string): void {
  registry.delete(outputId);
}

export function getViewWebview(outputId: string): ViewWebview | undefined {
  return registry.get(outputId);
}
