#!/usr/bin/env node
// Audits the electron-builder update feed (latest.yml / latest-mac.yml) without actually applying an update. Asserts: (a) feed parses, (b) advertised files exist locally, (c) advertised sha512 matches the on-disk file, (d) advertised size matches. A green release with a busted feed ships an update that bricks on apply for every user; this turns that class of bug red before publish.

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { dir: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--dir') out.dir = argv[++i];
  return out;
}

// Tiny YAML scrubber - electron-builder emits a simple flat-ish YAML with
// list-of-files. We don't pull a dependency for this; just regex it.
function parseFeed(text) {
  const version = (text.match(/^version:\s*(.+)$/m) || [])[1];
  const top = {
    path: (text.match(/^path:\s*(.+)$/m) || [])[1],
    sha512: (text.match(/^sha512:\s*(.+)$/m) || [])[1],
  };
  const files = [];
  const re = /-\s+url:\s*(.+)\s*\n\s+sha512:\s*(.+)\s*\n\s+size:\s*(\d+)/g;
  let m;
  while ((m = re.exec(text))) files.push({ url: m[1].trim(), sha512: m[2].trim(), size: Number(m[3]) });
  return { version, top, files };
}

function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(file));
  return hash.digest('base64');
}

function feedPaths(dir) {
  const out = [];
  for (const f of ['latest.yml', 'latest-mac.yml', 'latest-mac-arm64.yml', 'latest-linux.yml']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

module.exports = { parseFeed };

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir || path.join(h.REPO_ROOT, 'electron', 'dist');
  const feeds = feedPaths(dir);
  if (feeds.length === 0) { process.stdout.write(`SKIP: no update feeds under ${dir} (this is fine for builds without --publish).\n`); process.exit(0); }

  const failures = [];
  for (const feed of feeds) {
    process.stdout.write(`\nFeed: ${feed}\n`);
    const text = fs.readFileSync(feed, 'utf8');
    const parsed = parseFeed(text);
    if (!parsed.version) { failures.push(`${feed}: no version`); continue; }
    process.stdout.write(`  version: ${parsed.version}\n`);

    if (parsed.files.length === 0) { failures.push(`${feed}: feed lists zero files`); continue; }
    for (const f of parsed.files) {
      const full = path.join(dir, f.url);
      if (!fs.existsSync(full)) { failures.push(`${feed}: advertised file missing on disk: ${f.url}`); continue; }
      const size = fs.statSync(full).size;
      if (size !== f.size) { failures.push(`${feed}: ${f.url} size on disk ${size} != feed ${f.size}`); continue; }
      const actualSha = sha512Base64(full);
      if (actualSha !== f.sha512) { failures.push(`${feed}: ${f.url} sha512 mismatch (feed ${f.sha512.slice(0, 20)}... vs disk ${actualSha.slice(0, 20)}...)`); continue; }
      process.stdout.write(`  ok ${f.url} (${(size / 1048576).toFixed(0)} MB, sha512 verified)\n`);
    }

    // The top-level path/sha512 must match one of the file entries (oneClick installer pattern).
    if (parsed.top.path && parsed.top.sha512) {
      const ref = parsed.files.find((f) => f.url === parsed.top.path);
      if (!ref) failures.push(`${feed}: top-level path "${parsed.top.path}" not listed in files[]`);
      else if (ref.sha512 !== parsed.top.sha512) failures.push(`${feed}: top-level sha512 != files[].sha512 for ${parsed.top.path}`);
    }
  }

  if (failures.length) {
    process.stderr.write(`\nUPDATE-FEED FAIL: ${failures.length} problem(s)\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write('\nUPDATE-FEED PASS: every advertised file exists, hashes match, sizes match.\n');
  process.exit(0);
}

if (require.main === module) main();
