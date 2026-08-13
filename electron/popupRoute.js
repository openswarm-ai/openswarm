// Where should a window.open from inside the app end up? (ENG-279)
//
// Two very different callers share one handler:
//
//   the MAIN window opening a provider sign-in (Anthropic's OAuth popup). That wants a real
//   native child window and always has; it is app-level auth, nothing to do with browsing.
//
//   a BROWSER CARD's guest page opening "Sign in with Google", an SSO handoff, a consent or
//   payment screen. That used to spawn a native window too, which sits outside the browser-card
//   system and therefore has no browser_id. An agent driving that card simply cannot see it: the
//   flow stops dead at the popup and the run looks stalled for no visible reason.
//
// So the opener decides. A tab disposition was already routed into a card; now anything opened by
// a card goes to a card as well, which makes "a popup from a card that no agent can address"
// unrepresentable rather than merely unlikely.

/**
 * @param {string} contentsType  webContents.getType(): 'webview' for a browser card's guest
 * @param {string} disposition   Electron's window-open disposition
 * @returns {'card'|'native'}
 */
function popupRoute(contentsType, disposition) {
  if (disposition === 'foreground-tab' || disposition === 'background-tab') return 'card';
  // Anything a browser card opens belongs to that card's world, whatever the disposition.
  if (contentsType === 'webview') return 'card';
  return 'native';
}

module.exports = { popupRoute };
