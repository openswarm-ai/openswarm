// @electron/notarize 3.x is ESM-only, so a top-level require() throws
// ERR_REQUIRE_ESM the moment electron-builder loads this afterSign hook — which
// it does for EVERY platform/build, breaking even unsigned Windows packaging.
// Import it lazily, after the skip checks, so it's only loaded when we actually
// notarize (signed macOS). Dynamic import() works from CommonJS.
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('Skipping notarization (CSC_IDENTITY_AUTO_DISCOVERY=false)');
    return;
  }

  // Prefer a stored notarytool keychain profile: an app-specific password in env
  // silently 401s the day Apple rotates it, taking a release down with it; the
  // keychain profile is durable and is the canonical local-publish credential.
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;
  const hasEnvCreds =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;

  if (!keychainProfile && !hasEnvCreds) {
    console.log('Skipping notarization (no APPLE_KEYCHAIN_PROFILE and no APPLE_ID/password/team)');
    return;
  }

  const { notarize } = await import('@electron/notarize');

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const runNotarize = () => {
    if (keychainProfile) {
      console.log(`Notarizing ${appPath} via keychain profile "${keychainProfile}"...`);
      return notarize({ tool: 'notarytool', appPath, keychainProfile });
    }
    console.log(`Notarizing ${appPath} via Apple ID env credentials...`);
    return notarize({
      tool: 'notarytool',
      appBundleId: 'com.clusterlabs.openswarm',
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
  };

  // Apple's wait-poll flakes after a successful upload; one hiccup shouldn't kill a 40-minute build.
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await runNotarize();
      break;
    } catch (err) {
      if (attempt === ATTEMPTS) throw err;
      const firstLine = String((err && err.message) || err).split('\n')[0];
      console.log(`Notarization attempt ${attempt}/${ATTEMPTS} failed (${firstLine}); retrying in 30s...`);
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }

  console.log('Notarization complete.');
};
