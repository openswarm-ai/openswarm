// What channel should the updater be on, given the build we are running and what the user stored?
//
// This was two independent booleans set in two places, and they could disagree. Measured on
// 1.7.8-exp.1: install the experimental DMG, never open Settings, quit. The stored toggle is its
// default false, allowDowngrade was unconditionally true, so the updater took "default" to mean
// "opted out", found stable 1.7.7 and installed it. CFBundleShortVersionString went 1.7.8-exp.1 ->
// 1.7.7 with no user action beyond quitting. The old code even says "a fresh install is never on a
// prerelease", which is the assumption that failed.
//
// The rule, in one place: installing a prerelease IS the opt-in. Only an explicit false is an opt-out.

/**
 * @param {string} runningVersion  e.g. "1.7.8-exp.1" or "1.7.7"
 * @param {unknown} stored         allow_experimental_updates as read from settings; undefined when never set
 * @returns {{allowPrerelease: boolean, allowDowngrade: boolean, seedStoredTo: boolean|null}}
 */
function experimentalChannelDecision(runningVersion, stored) {
  const isPrerelease = String(runningVersion || '').includes('-');
  const explicit = stored === true || stored === false;
  const allowPrerelease = explicit ? stored === true : isPrerelease;
  // Downgrades exist so we can un-ship a bad stable release. A prerelease build may only take one
  // when the user actually turned the toggle off, never because nobody has touched it yet.
  const allowDowngrade = isPrerelease ? explicit && stored === false : true;
  // Writing the inferred value back keeps the renderer's own push from re-asserting the default.
  const seedStoredTo = !explicit && isPrerelease ? true : null;
  return { allowPrerelease, allowDowngrade, seedStoredTo };
}

module.exports = { experimentalChannelDecision };
