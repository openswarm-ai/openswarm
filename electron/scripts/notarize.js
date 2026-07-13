// Hand-rolled notarization: `notarytool submit --wait` SIGBUSes on this macOS (its progress
// printer dies ~30s after upload, crash dumps 2026-07-13), so we submit WITHOUT --wait and poll
// `notarytool info` with short-lived calls that never reach the crashing code path. We staple
// here too because @electron/notarize (which normally staples) is out of the loop.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30 * 1000;
const POLL_DEADLINE_MS = 90 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function xcrun(args) {
  const { stdout } = await execFileAsync('xcrun', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('Skipping notarization (CSC_IDENTITY_AUTO_DISCOVERY=false)');
    return;
  }

  // Prefer a stored notarytool keychain profile: an app-specific password in env
  // silently 401s the day Apple rotates it; the keychain profile is durable.
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;
  const hasEnvCreds =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;

  if (!keychainProfile && !hasEnvCreds) {
    console.log('Skipping notarization (no APPLE_KEYCHAIN_PROFILE and no APPLE_ID/password/team)');
    return;
  }

  const authArgs = keychainProfile
    ? ['--keychain-profile', keychainProfile]
    : [
        '--apple-id',
        process.env.APPLE_ID,
        '--password',
        process.env.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id',
        process.env.APPLE_TEAM_ID,
      ];

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const zipPath = path.join(os.tmpdir(), `openswarm-notarize-${Date.now()}.zip`);

  console.log(`Notarizing ${appPath} (submit, then poll)...`);
  try {
    await execFileAsync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]);

    const submitted = JSON.parse(
      await xcrun(['notarytool', 'submit', zipPath, ...authArgs, '--output-format', 'json'])
    );
    if (!submitted.id) {
      throw new Error(`notarytool submit returned no id: ${JSON.stringify(submitted)}`);
    }
    console.log(`Notarization submitted (id ${submitted.id}); polling until Apple decides...`);

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let status = 'In Progress';
    while (status === 'In Progress' && Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      try {
        const info = JSON.parse(
          await xcrun(['notarytool', 'info', submitted.id, ...authArgs, '--output-format', 'json'])
        );
        status = info.status;
      } catch {
        // One flaky poll is fine; the next tick asks again.
      }
    }

    if (status !== 'Accepted') {
      let notaryLog = '';
      try {
        notaryLog = await xcrun(['notarytool', 'log', submitted.id, ...authArgs]);
      } catch {}
      throw new Error(`Notarization ended ${status} (id ${submitted.id})\n${notaryLog}`);
    }

    await xcrun(['stapler', 'staple', appPath]);
    console.log('Notarization complete (Accepted + stapled).');
  } finally {
    try {
      fs.unlinkSync(zipPath);
    } catch {}
  }
};
