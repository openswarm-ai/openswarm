// Turning an updater failure into something the user can act on.
//
// electron-updater reports check, download and install failures through one 'error' event, so the
// message a user sees is whatever this mapping decides. The default used to be "Update check
// failed. Please try again later." for everything that was not a Chromium net:: error, which is a
// dead end: the two most common real causes (running from the DMG on macOS, a quarantined
// Update.exe on Windows) never resolve themselves no matter how long you wait, and the user is told
// to wait. Each branch below names a failure the user can actually fix.

'use strict';

/**
 * @param {unknown} err the error electron-updater emitted
 * @param {boolean} allowPrerelease whether the experimental channel is on
 * @returns {string} a message safe to show in Settings
 */
function friendlyUpdateError(err, allowPrerelease) {
  const raw = ((err && err.message) || String(err) || '').toLowerCase();
  // Experimental on, but there is no pre-release to fetch: the provider 404s looking for the
  // pre-release channel feed.
  if (allowPrerelease && /404|not found|cannot find|no published|latest.*\.yml/.test(raw)) {
    // A 404 here means the FEED broke (most often a release mid-publish), not that no build
    // exists; claiming "you are on the latest version" told users the opposite of the truth
    // during every publish window (ENG-319 class).
    return 'Could not fetch the experimental build feed. This is usually a release being published right now; try again in a few minutes.';
  }
  if (/net::|enotfound|etimedout|econnrefused|getaddrinfo|network/.test(raw)) {
    return 'Could not reach the update server. Check your connection and try again.';
  }
  // Running from the DMG or a Gatekeeper-translocated copy in ~/Downloads. Squirrel.Mac refuses
  // deterministically, so this user can never update until the app moves.
  if (/read-only volume|read only volume|translocat/.test(raw)) {
    return 'Move OpenSwarm to your Applications folder, then check again. Updates cannot install while it runs from the disk image.';
  }
  // Windows Squirrel missing or quarantined by antivirus; retrying never fixes it either.
  if (/can not find squirrel|cannot find squirrel|update\.exe/.test(raw)) {
    return 'The updater is missing, which usually means antivirus quarantined it. Reinstall from openswarm.com to fix it.';
  }
  // Reachability failures whose text carries no net:: token, so they would otherwise look unexplained.
  if (/http error|econnreset|certificate|self.signed|\b403\b|\b429\b|econnaborted/.test(raw)) {
    return 'The update server refused the request. Check your VPN or network, then try again.';
  }
  if (/enospc|no space/.test(raw)) {
    return 'Not enough disk space to download the update. Free up some space and try again.';
  }
  return 'Update check failed. Please try again later.';
}

module.exports = { friendlyUpdateError };
