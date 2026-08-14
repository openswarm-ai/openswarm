// Run: node --test electron/crashReports.test.js
//
// ENG-265 / ENG-285. Four real renderer crashes were fired at the packaged app and NO crash report
// appeared, with no error line either. That left three indistinguishable explanations: the handler
// never ran, dedupe suppressed it, or the session cap was hit. `writeCrashReport` returned a bare
// null on two of those paths and said nothing, so the instrumentation built to diagnose a crash was
// itself undiagnosable.
//
// These assert that a decline is always ANNOUNCED. A crash handler that silently declines is worse
// than one that fails loudly, because the silence is read as "no crash happened".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const crash = require('./crashReports.js');

function withCapturedWarn(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.warn = original; }
  return lines;
}

function initInTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osw-crash-'));
  crash.init({
    getVersion: () => '0.0.0-test',
    getPath: () => dir,
  }, null);
  return dir;
}

test('a deduped report says so instead of returning silently', () => {
  initInTemp();
  const first = crash.writeCrashReport('renderer-gone', { message: 'crashed' });
  assert.ok(first, 'the first report should be written');
  const lines = withCapturedWarn(() => {
    const second = crash.writeCrashReport('renderer-gone', { message: 'crashed' });
    assert.equal(second, null, 'an identical crash inside the window must still be suppressed');
  });
  assert.ok(
    lines.some((l) => l.includes('declined') && l.includes('deduped')),
    `a suppressed report announced nothing; lines were ${JSON.stringify(lines)}`,
  );
});

test('the announcement carries the fingerprint and the repeat count, not just a word', () => {
  initInTemp();
  crash.writeCrashReport('gpu-gone', { message: 'oom' });
  const lines = withCapturedWarn(() => crash.writeCrashReport('gpu-gone', { message: 'oom' }));
  assert.ok(lines.some((l) => /seen \d+x/.test(l)), `no repeat count in ${JSON.stringify(lines)}`);
});

test('a DIFFERENT crash is not deduped, so the guard cannot swallow real reports', () => {
  initInTemp();
  assert.ok(crash.writeCrashReport('renderer-gone', { message: 'crashed' }));
  assert.ok(
    crash.writeCrashReport('renderer-gone', { message: 'oom' }),
    'a different fingerprint was suppressed; the dedupe is too broad',
  );
});

test('the session cap announces itself rather than going quiet', () => {
  initInTemp();
  for (let i = 0; i < crash.MAX_REPORTS_PER_SESSION; i++) {
    crash.writeCrashReport('renderer-gone', { message: `distinct-${i}` });
  }
  const lines = withCapturedWarn(() => {
    const over = crash.writeCrashReport('renderer-gone', { message: 'one-too-many' });
    assert.equal(over, null, 'the cap must still hold');
  });
  assert.ok(
    lines.some((l) => l.includes('declined') && l.includes('capped')),
    `hitting the cap announced nothing; lines were ${JSON.stringify(lines)}`,
  );
});
