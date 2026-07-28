// The user-agent half of borrowing a sign-in out of the user's real Chrome.
//
// Borrowing the session and presenting as the browser that earned it are ONE decision. Our browser
// cards deliberately advertise an "openswarm/<ver>" product token, because Google's sign-in rejects
// a bare Chrome UA as not-genuine-Chrome. But the anti-bot layer in front of a borrowed site checks
// the session against the UA it was minted for, so that same token reads as "this is not the
// browser that logged in" and the session is refused. Measured live: medium (7 entries) and
// instagram (10 entries) both imported cleanly and both still reported signed-out.
//
// main.js needs a real Electron to load, so the two pure functions are lifted out of the source and
// exercised directly. That keeps the test honest about WHICH code it covers: if either function is
// renamed or reshaped, the extraction fails loudly rather than silently testing a stale copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function lift(name) {
  const m = SRC.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} not found in main.js; did the borrowed-session UA path change shape?`);
  return m[0];
}

// eslint-disable-next-line no-eval
eval(`${lift('bareChromeUserAgent')}\nvar p_borrowedSessionDomains = new Set();\n${lift('hostHasBorrowedSession')}`);

const APP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) openswarm/1.5.8 Chrome/148.0.7778.218 Electron/42.3.3 Safari/537.36';
const REAL_CHROME = /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/;

test('a borrowed site sees a UA indistinguishable from real Chrome', () => {
  const bare = bareChromeUserAgent(APP_UA);
  assert.match(bare, REAL_CHROME);
  assert.ok(!/openswarm/i.test(bare), 'the product token is the whole tell; it must be gone');
  assert.ok(!/Electron/i.test(bare), 'the Electron token must be gone too');
});

test('the Chrome version is preserved, not invented', () => {
  // sec-ch-ua headers carry the real version. Substituting a different one here would make the UA
  // and the client hints disagree, which is a louder tell than the token we just removed.
  assert.ok(bareChromeUserAgent(APP_UA).includes('Chrome/148.0.7778.218'));
});

test('a UA with no product token is left exactly alone', () => {
  const already = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/148.0.7778.218 Safari/537.36';
  assert.strictEqual(bareChromeUserAgent(already), already);
});

test('empty and malformed input degrade to a string, never a throw', () => {
  for (const bad of [undefined, null, '', 123, {}]) {
    assert.strictEqual(typeof bareChromeUserAgent(bad), 'string');
  }
});

test('only borrowed sites are rewritten', () => {
  p_borrowedSessionDomains.clear();
  assert.strictEqual(hostHasBorrowedSession('https://medium.com/'), false,
    'nothing borrowed yet means nothing is rewritten');
  p_borrowedSessionDomains.add('medium.com');
  assert.strictEqual(hostHasBorrowedSession('https://medium.com/me'), true);
  assert.strictEqual(hostHasBorrowedSession('https://cdn.medium.com/x.js'), true,
    'subdomains of a borrowed site carry the same session');
});

test('a lookalike domain is never treated as borrowed', () => {
  // Suffix matching done wrong is how "notmedium.com" or "medium.com.evil.net" would inherit the
  // borrowed identity. Only the exact host or a real dot-separated subdomain may match.
  p_borrowedSessionDomains.clear();
  p_borrowedSessionDomains.add('medium.com');
  assert.strictEqual(hostHasBorrowedSession('https://notmedium.com/'), false);
  assert.strictEqual(hostHasBorrowedSession('https://medium.com.evil.net/'), false);
  assert.strictEqual(hostHasBorrowedSession('https://google.com/'), false,
    'Google must keep the product token: its own sign-in is what the token exists to satisfy');
});

test('a malformed URL is not a borrowed site', () => {
  p_borrowedSessionDomains.clear();
  p_borrowedSessionDomains.add('medium.com');
  assert.strictEqual(hostHasBorrowedSession('not a url'), false);
  assert.strictEqual(hostHasBorrowedSession(''), false);
});

test('the borrowed-domain list survives a restart', () => {
  // The cookies live in a PERSISTENT partition, so they outlive a quit. This list has to as well:
  // the backend memoizes "already borrowed" and skips re-importing, so when Electron came back with
  // an empty set the site kept its session while silently no longer being told we were plain
  // Chrome. That desync produced a false negative during the 2026-07-27 measurements.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borrowed-'));
  const scope = {
    p_borrowedSessionDomains: new Set(),
    app: { getPath: () => dir },
    path,
    fs,
  };
  const body = `${lift('p_borrowedDomainsPath')}\n${lift('loadBorrowedDomains')}\n${lift('saveBorrowedDomains')}\n`;
  const run = new Function(
    'p_borrowedSessionDomains', 'app', 'path', 'fs',
    `${body}; return { loadBorrowedDomains, saveBorrowedDomains, set: p_borrowedSessionDomains };`,
  );

  const first = run(scope.p_borrowedSessionDomains, scope.app, path, fs);
  first.set.add('medium.com');
  first.set.add('claude.ai');
  first.saveBorrowedDomains();

  // A fresh process: new empty set, same on-disk file.
  const second = run(new Set(), scope.app, path, fs);
  second.loadBorrowedDomains();
  assert.deepStrictEqual([...second.set].sort(), ['claude.ai', 'medium.com']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing or corrupt list is not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borrowed-bad-'));
  const body = `${lift('p_borrowedDomainsPath')}\n${lift('loadBorrowedDomains')}\n${lift('saveBorrowedDomains')}\n`;
  const run = new Function(
    'p_borrowedSessionDomains', 'app', 'path', 'fs',
    `${body}; return { loadBorrowedDomains, set: p_borrowedSessionDomains };`,
  );
  const app = { getPath: () => dir };

  const fresh = run(new Set(), app, path, fs);
  fresh.loadBorrowedDomains();           // no file at all
  assert.strictEqual(fresh.set.size, 0);

  fs.writeFileSync(path.join(dir, 'borrowed-session-domains.json'), '{not json');
  const corrupt = run(new Set(), app, path, fs);
  corrupt.loadBorrowedDomains();         // garbage on disk
  assert.strictEqual(corrupt.set.size, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('clearing browsing data drops the borrowed claims with it', () => {
  // Cookies are gone, so continuing to present as the browser that earned them is a lie about a
  // session that no longer exists.
  const handler = SRC.slice(SRC.indexOf("ipcMain.handle('browser:clear-data'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.match(body, /p_borrowedSessionDomains\.clear\(\)/);
  assert.match(body, /saveBorrowedDomains\(\)/);
});

test('the list is restored before any card can load a site', () => {
  const configureAt = SRC.indexOf('configureBrowsingSession(session.fromPartition(BROWSER_PARTITION)');
  const loadAt = SRC.indexOf('loadBorrowedDomains();');
  assert.ok(configureAt > 0 && loadAt > configureAt,
    'loadBorrowedDomains must run during startup, right after the partition is configured');
});

test('importing a session is what registers the domain', () => {
  // The two halves must stay wired together: cookies applied without the matching UA get refused,
  // which is exactly the bug this whole path exists to fix.
  assert.match(SRC, /p_borrowedSessionDomains\.add\(d\);\s*\n\s*saveBorrowedDomains\(\);/,
    'writePartitionCookies must register the domain it borrowed for AND persist it');
});

test('the request header is actually rewritten for borrowed sites', () => {
  assert.match(SRC, /borrowed && lk === 'user-agent'/,
    'the onBeforeSendHeaders hook must swap the UA on borrowed sites');
});
