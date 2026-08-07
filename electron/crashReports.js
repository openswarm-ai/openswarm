// ENG-102: a crash without a report blinds every other crash bug. Each fatal signal writes one
// JSON report (metadata + the backend log tail) into userData/crash-reports and, when possible,
// tells the user where it landed. Renderer/GPU deaths and main-process throws all route here.
const path = require('path');
const fs = require('fs');

const MAX_REPORTS = 30;
const LOG_TAIL_BYTES = 64 * 1024;

let p_app = null;
let p_notify = null;

function init(app, notifyFn) {
  p_app = app;
  p_notify = notifyFn || null;
}

function reportsDir() {
  const dir = path.join(p_app.getPath('userData'), 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backendLogTail() {
  try {
    const logPath = path.join(p_app.getPath('userData'), 'data', 'backend.log');
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, 'r');
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    while (files.length > MAX_REPORTS) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (_) {}
}

function writeCrashReport(kind, details) {
  try {
    const dir = reportsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `crash-${stamp}-${kind}.json`);
    const report = {
      kind,
      at: new Date().toISOString(),
      appVersion: p_app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      details,
      backendLogTail: backendLogTail(),
    };
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    prune(dir);
    if (p_notify) {
      p_notify({
        title: 'OpenSwarm hit a problem',
        body: 'A crash report was saved. Help > Report a bug attaches it automatically.',
      });
    }
    return file;
  } catch (err) {
    console.error('[crash-reports] failed to write report:', err && err.message);
    return null;
  }
}

// Reports written since the previous launch; the renderer surfaces "last session crashed".
function unseenReports() {
  try {
    const dir = reportsDir();
    const marker = path.join(dir, '.last-seen');
    let last = 0;
    try { last = fs.statSync(marker).mtimeMs; } catch (_) {}
    const fresh = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .filter((p) => { try { return fs.statSync(p).mtimeMs > last; } catch (_) { return false; } });
    fs.writeFileSync(marker, String(Date.now()));
    return fresh;
  } catch (_) {
    return [];
  }
}

module.exports = { init, writeCrashReport, unseenReports };
