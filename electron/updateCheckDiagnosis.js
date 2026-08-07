// Why a Windows Squirrel update check goes SILENT, told as something the user can act on.
//
// The built-in Squirrel autoUpdater reports only via events. When a corporate proxy or antivirus
// kills its request internally, or Update.exe dies without an error event, NO event ever arrives:
// the renderer's spinner just spins. The main process arms a watchdog around the check; when it
// fires, it probes the two things that actually distinguish the causes (does the update helper
// still exist on disk, can this machine reach the release feed) and maps them here.
//
// Pure mapping so it is unit-testable: cd electron && node --test updateCheckDiagnosis.test.js

'use strict';

function diagnoseSilentUpdateCheck({ updateExeExists, feedReachable }) {
  if (!updateExeExists) {
    return 'The Windows update helper is missing, which usually means antivirus quarantined it. Reinstall OpenSwarm from openswarm.com to restore updates.';
  }
  if (!feedReachable) {
    return 'Could not reach the update server. A firewall or proxy may be blocking github.com; OpenSwarm will keep retrying in the background.';
  }
  return 'The update check stalled without a response. Security software may be blocking the updater; reinstalling OpenSwarm usually clears it.';
}

module.exports = { diagnoseSilentUpdateCheck };
