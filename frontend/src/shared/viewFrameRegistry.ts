// Srcdoc app-card iframes keyed by card key. Mirror of viewWebviewRegistry for the outputs that render as an iframe instead of a <webview> (no serve URL): the dashboard's arrow-key handler needs a handle on the card's content to scroll it, and a srcdoc frame is same-origin, so no IPC is involved.
const registry = new Map<string, HTMLIFrameElement>();

export function registerViewFrame(cardKey: string, frame: HTMLIFrameElement): void {
  registry.set(cardKey, frame);
}

export function unregisterViewFrame(cardKey: string): void {
  registry.delete(cardKey);
}

export function getViewFrame(cardKey: string): HTMLIFrameElement | undefined {
  return registry.get(cardKey);
}
