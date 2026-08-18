// Pure URL selection between the legacy /serve/ preview and the new-mode Vite runtime URL (the hook in useRuntimePreviewUrl.ts owns the runtime lifecycle; this is the render-time pick).
export interface PickPreviewUrlOptions {
  workspaceId: string | null | undefined;
  /** Pre-new-mode URL the component used (serve/index.html); overridden by frontendUrl when ready. */
  legacyUrl: string | undefined;
  frontendUrl: string | null;
  isNewMode: boolean;
}

export interface PickPreviewUrlResult {
  /** undefined => render placeholder (new-mode and Vite not bound yet). */
  url: string | undefined;
  isBooting: boolean;
}

export function pickPreviewUrl(opts: PickPreviewUrlOptions): PickPreviewUrlResult {
  const { legacyUrl, frontendUrl, isNewMode, workspaceId } = opts;
  if (!workspaceId) {
    return { url: legacyUrl, isBooting: false };
  }
  if (isNewMode && !frontendUrl) {
    return { url: undefined, isBooting: true };
  }
  return { url: frontendUrl ?? legacyUrl, isBooting: false };
}
