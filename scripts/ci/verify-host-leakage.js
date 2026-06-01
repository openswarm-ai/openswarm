#!/usr/bin/env node
// Scans the packaged artifact for absolute paths pointing at the BUILD host (e.g. C:\Users\EricZ, /Users/<dev>) baked into shipped files - the exact "works on my machine" failure mode where a path resolves on the dev's box but never on a user's.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { app: null, allow: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--allow') out.allow.push(argv[++i]);
  }
  return out;
}

// Build-host paths a packaged artifact must NEVER contain.
function hostPatterns() {
  const homeWin = `C:\\Users\\${os.userInfo().username}`;
  const homePosix = (process.env.HOME || '');
  const patterns = [];
  // Windows-style: backslashes get JSON-double-escaped in source maps, so we
  // search both literal-backslash and double-backslash forms.
  if (process.platform === 'win32') {
    patterns.push(homeWin);
    patterns.push(homeWin.replace(/\\/g, '\\\\'));
    patterns.push(homeWin.replace(/\\/g, '/'));
  }
  // POSIX-style: any /Users/<dev> or /home/<dev> from the build machine - but
  // skip the GENERIC CI home (/Users/runner, /home/runner). It is too broad: it
  // matches third-party packages' own embedded paths (e.g. 9router's Rust deps
  // ship /Users/runner/.cargo from the package publisher's CI), which are NOT a
  // leak of THIS build host. The /Users/runner/work workspace pattern below is
  // the precise CI build-path detector; the bare home is for a real dev box.
  if (homePosix && !/^\/(Users|home)\/runner\/?$/.test(homePosix)) patterns.push(homePosix);
  // Source-map sentinels often containing dev-only roots.
  patterns.push('/Users/runner/work');   // GH Actions macos runner work dir
  patterns.push('D:\\a\\openswarm');     // GH Actions windows runner work dir
  patterns.push('/home/runner/work');    // GH Actions linux runner work dir
  // Belt-and-braces: literal username - but skip generic CI/shared accounts whose
  // names are common English words. GitHub runners are literally "runner", which
  // collides with the word everywhere (asyncio "runner is not initialized",
  // jest-runner, "Browser sub-agent runner") and buries real leaks in noise; the
  // home + work-dir patterns already catch a genuine leak from those accounts.
  const uname = os.userInfo().username;
  if (uname && !/^(runner|runneradmin|user|admin|administrator|root|ubuntu)$/i.test(uname)) patterns.push(uname);
  return Array.from(new Set(patterns.filter((p) => p && p.length > 4)));
}

// File extensions worth scanning. We skip binaries (large + irrelevant) and
// only inspect text-ish files where a path could meaningfully be baked.
function shouldScan(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.map', '.cfg', '.ini', '.toml', '.yml', '.yaml', '.py'].includes(ext)) return true;
  // app.asar is a packed binary holding the entire main+renderer JS bundle. We
  // string-scan it the same way - false positives are unlikely on host-path
  // patterns because they don't naturally appear in minified bundle bytes.
  if (file.endsWith('.asar')) return true;
  return false;
}

// Files known to bake build paths by design (PEP 610 pip metadata, debug
// manifests etc.). Allowed by default so the gate stays quiet on benign
// noise and loud on real leakage.
const DEFAULT_ALLOW = [
  /\.dist-info[\\/]direct_url\.json$/,   // PEP 610 install provenance, not read at runtime
  /\.dist-info[\\/]RECORD$/,             // wheel file list, lists relative paths only
  /\.dist-info[\\/]sboms[\\/]/,          // CycloneDX SBOMs bake the wheel PUBLISHER's CI path (e.g. /Users/runner/work), never ours
];

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Pure: scan a byte buffer for any of the patterns. Used by both the disk
// path (scanFile) and the selftest harness, which feeds synthetic buffers
// to mutation-check the gate's discrimination.
function scanBuffer(buf, patterns) {
  const text = Buffer.isBuffer(buf) ? buf.toString('binary') : String(buf);
  const hits = [];
  for (const pat of patterns) {
    let idx = 0;
    while ((idx = text.indexOf(pat, idx)) !== -1) {
      const start = Math.max(0, idx - 24);
      const end = Math.min(text.length, idx + pat.length + 40);
      hits.push({ pattern: pat, offset: idx, context: text.slice(start, end).replace(/[\x00-\x1f]/g, '.') });
      idx += pat.length;
      if (hits.length > 3) break;
    }
  }
  return hits;
}

function scanFile(file, patterns) {
  try { return scanBuffer(fs.readFileSync(file), patterns); }
  catch { return []; }
}

module.exports = { hostPatterns, scanBuffer, scanFile, shouldScan, DEFAULT_ALLOW };

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appExe = h.packagedAppPath(args.app);
  // For an unpacked Electron build the artifact dir is the .exe's parent (Windows)
  // or two levels above the binary inside the .app (macOS).
  const artifactRoot = process.platform === 'darwin'
    ? path.dirname(path.dirname(path.dirname(appExe)))
    : path.dirname(appExe);

  process.stdout.write(`Scanning artifact root: ${artifactRoot}\n`);
  const patterns = hostPatterns();
  const allow = args.allow;
  process.stdout.write(`Looking for ${patterns.length} host-path pattern(s): ${patterns.join(', ')}\n`);

  const files = walk(artifactRoot).filter(shouldScan);
  process.stdout.write(`Scanning ${files.length} text-ish files...\n`);

  const findings = [];
  for (const f of files) {
    const hits = scanFile(f, patterns);
    if (!hits.length) continue;
    // Built-in known-benign + caller-supplied allow regexes.
    if (DEFAULT_ALLOW.some((rx) => rx.test(f))) continue;
    if (allow.some((rx) => new RegExp(rx).test(f))) continue;
    findings.push({ file: f, hits });
  }

  if (findings.length === 0) {
    process.stdout.write('\nHOST-LEAKAGE PASS: no build-host paths found inside the packaged artifact.\n');
    process.exit(0);
  }

  process.stderr.write(`\nHOST-LEAKAGE FAIL: ${findings.length} file(s) contain build-host paths:\n`);
  for (const { file, hits } of findings.slice(0, 50)) {
    process.stderr.write(`\n  ${file}\n`);
    for (const h of hits.slice(0, 3)) process.stderr.write(`    @${h.offset} matches "${h.pattern}": ...${h.context}...\n`);
  }
  if (findings.length > 50) process.stderr.write(`\n  ...and ${findings.length - 50} more files.\n`);
  process.stderr.write('\nThese paths exist on the build host but will not exist on a user machine.\n');
  process.stderr.write('Pass --allow <regex> to whitelist false positives (e.g. webpack source-map dev paths).\n');
  process.exit(1);
}

if (require.main === module) main();
