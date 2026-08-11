// webview.insertText silently NO-OPS when the guest page has no focused editable, so dictation
// "landed" in a browser and vanished (ENG-254). Ask the guest first; only a confirmed editable
// earns the insert, everything else falls through to the visible composer fallback.
export async function guestHasEditableFocus(wv: { executeJavaScript?: (code: string) => Promise<unknown> }): Promise<boolean> {
  if (!wv.executeJavaScript) return false;
  try {
    const ok = await Promise.race([
      wv.executeJavaScript(
        '(() => { const a = document.activeElement; return !!(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)); })()',
      ),
      // A suspended or wedged guest never answers; treat silence as "no target" instead of hanging the paste.
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 800); }),
    ]);
    return ok === true;
  } catch {
    return false;
  }
}
