// Where should a window.open from inside the app end up? (ENG-279)
//
// A tab disposition has always been reopened as a card, and stays that way. A real window.open must
// NOT be, and that is the whole point of this file.
//
// Measured 2026-08-13 with an isolated Electron probe over a real http origin (data: URLs are
// opaque origins and would have faked the result), arms proven different before reading the verdict:
//
//   native popup : window.opener = true,  opener received AUTH_CODE_12345
//   reopened card: window.opener = false, opener received NOTHING
//
// OAuth popups hand the authorization code back through window.opener.postMessage, so reopening one
// as a card hangs the flow AFTER the user has already signed in. That is strictly worse than the
// blindness it was meant to fix: the agent stalls either way, and now the human's sign-in is burnt
// too. So the opener relationship wins; making popups agent-addressable has to happen some other
// way (register the native popup's webContents id, which the CDP layer can already drive).
function popupRoute(contentsType, disposition) {
  if (disposition === 'foreground-tab' || disposition === 'background-tab') return 'card';
  return 'native';
}

module.exports = { popupRoute };
