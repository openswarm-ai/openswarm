// Mac-only crash watchdog. Spawned detached by main.js on startup (packaged
// builds only). Polls the parent PID; when the parent dies, decides whether
// to relaunch the .app bundle.
//
// FIVE GUARDS prevent false-positive relaunches. ALL must pass to relaunch:
//   1. Platform = darwin AND env vars populated. (Anything else: silent exit.)
//   2. Parent ran > MIN_UPTIME_MS before dying. Anything shorter = startup
//      crash loop, refuse to keep spawning a broken binary.
//   3. No clean-quit lock present. main.js writes this lock in `before-quit`
//      when the user intentionally Cmd+Q's so we know the exit was deliberate.
//   4. No updating.lock present. The auto-updater writes this around the swap
//      so the parent dying mid-update doesn't get treated as a crash.
//   5. Fewer than MAX_RELAUNCHES in the last RELAUNCH_WINDOW_MS. Crash-loop
//      cap so a chronically broken build doesn't hammer the user infinitely.
//
// On EVERY failure mode, the watchdog silently exits. The worst case is "app
// crashes and doesn't relaunch", which is exactly the current behavior with
// no watchdog — i.e., this can't make things worse than they are.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PARENT_PID = parseInt(process.env.OPENSWARM_PARENT_PID || '0', 10);
const APP_BUNDLE_PATH = process.env.OPENSWARM_APP_BUNDLE_PATH || '';
const PARENT_START_TIME = parseInt(process.env.OPENSWARM_PARENT_START_TIME || '0', 10);

if (process.platform !== 'darwin' || !PARENT_PID || !APP_BUNDLE_PATH || !PARENT_START_TIME) {
  process.exit(0);
}

const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'openswarm');
const UPDATING_LOCK = path.join(SUPPORT_DIR, 'updating.lock');
const CLEAN_QUIT_LOCK = path.join(SUPPORT_DIR, 'clean-quit.lock');
const RELAUNCH_LOG = path.join(SUPPORT_DIR, 'crash-watchdog-relaunches.log');

const MIN_UPTIME_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const RELAUNCH_WINDOW_MS = 60 * 60 * 1000;
const MAX_RELAUNCHES = 3;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function countRecentRelaunches() {
  if (!fs.existsSync(RELAUNCH_LOG)) return 0;
  try {
    const lines = fs.readFileSync(RELAUNCH_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - RELAUNCH_WINDOW_MS;
    return lines.filter((ln) => parseInt(ln, 10) > cutoff).length;
  } catch (_) { return 0; }
}

function recordRelaunch() {
  try {
    if (!fs.existsSync(SUPPORT_DIR)) fs.mkdirSync(SUPPORT_DIR, { recursive: true });
    fs.appendFileSync(RELAUNCH_LOG, `${Date.now()}\n`);
  } catch (_) {}
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async function watch() {
  while (isAlive(PARENT_PID)) {
    await sleep(POLL_INTERVAL_MS);
  }

  // Parent died. Now check ALL five guards (platform already verified above).

  // Guard 2: parent ran long enough to rule out startup crash loop.
  const uptime = Date.now() - PARENT_START_TIME;
  if (uptime < MIN_UPTIME_MS) process.exit(0);

  // Guard 3: clean quit (Cmd+Q, intentional). Consume the lock so the next
  // crash doesn't accidentally read a stale signal.
  if (fs.existsSync(CLEAN_QUIT_LOCK)) {
    try { fs.unlinkSync(CLEAN_QUIT_LOCK); } catch (_) {}
    process.exit(0);
  }

  // Guard 4: auto-updater is doing the swap. Parent dying is expected.
  if (fs.existsSync(UPDATING_LOCK)) process.exit(0);

  // Guard 5: cap repeats in the window.
  if (countRecentRelaunches() >= MAX_RELAUNCHES) process.exit(0);

  // All guards passed: relaunch. `open -n` opens a fresh instance even if the
  // app is registered, which it always will be (LaunchServices remembers).
  recordRelaunch();
  try {
    spawn('open', ['-n', APP_BUNDLE_PATH], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
  process.exit(0);
})();
