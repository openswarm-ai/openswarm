#!/usr/bin/env node
// Phase 5a promotion gate: before a draft release is allowed to become "latest",
// prove both auto-updater feeds exist, agree on version, and that their assets
// actually resolve. A release that ships latest.yml but not latest-mac.yml (or
// with mismatched versions) silently strands one platform's users on the old
// build, which is the exact "broken latest" failure this gate exists to stop.
//
// Usage:
//   node scripts/release/verify-release.js --dir <artifacts-dir> --expect-version 1.2.3
//   node scripts/release/verify-release.js --dir <dir> --expect-version 1.2.3 \
//        --base-url https://github.com/openswarm-ai/openswarm/releases/download/v1.2.3
//
// --dir            directory containing latest.yml + latest-mac.yml
// --expect-version version both feeds (and their filenames) must match
// --base-url       if given, HEAD-check every referenced asset resolves (200)
//
// Exit 0 = promotable. Exit 1 = blocked (prints the first blocking reason).

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const FEEDS = ['latest.yml', 'latest-mac.yml'];

function parseArgs(argv) {
  const out = { dir: null, expectVersion: null, baseUrl: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--expect-version') out.expectVersion = argv[++i];
    else if (argv[i] === '--base-url') out.baseUrl = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

// Minimal electron-builder-feed parser. We only need `version:` and the asset
// filenames (top-level `path:` plus each `- url:` under `files:`). Avoiding a
// YAML dependency keeps this runnable on a bare CI node with no install step.
function parseFeed(text) {
  const version = (text.match(/^version:\s*(.+)$/m) || [])[1];
  const assets = new Set();
  const topPath = (text.match(/^path:\s*(.+)$/m) || [])[1];
  if (topPath) assets.add(topPath.trim());
  const urlRe = /^\s*-?\s*url:\s*(.+)$/gm;
  let m;
  while ((m = urlRe.exec(text)) !== null) assets.add(m[1].trim());
  return { version: version ? version.trim() : null, assets: [...assets] };
}

function headOk(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      // GitHub release assets 302 to a signed CDN URL; follow one hop.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        headOk(res.headers.location).then(resolve);
      } else {
        resolve(res.statusCode === 200);
      }
    });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function fail(msg, json) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else process.stderr.write(`BLOCKED: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) fail('--dir <artifacts-dir> is required', args.json);

  const feeds = {};
  for (const name of FEEDS) {
    const p = path.join(args.dir, name);
    if (!fs.existsSync(p)) fail(`missing feed: ${name} (one platform would be stranded on the old build)`, args.json);
    feeds[name] = parseFeed(fs.readFileSync(p, 'utf8'));
    if (!feeds[name].version) fail(`${name} has no version: field`, args.json);
  }

  const versions = FEEDS.map((n) => feeds[n].version);
  if (new Set(versions).size !== 1) {
    fail(`version mismatch across feeds: ${FEEDS.map((n) => `${n}=${feeds[n].version}`).join(', ')}`, args.json);
  }
  const releaseVersion = versions[0];

  if (args.expectVersion) {
    const want = args.expectVersion.replace(/^v/, '');
    if (releaseVersion !== want) fail(`feeds say ${releaseVersion} but expected ${want}`, args.json);
  }

  if (args.baseUrl) {
    const base = args.baseUrl.replace(/\/+$/, '');
    for (const name of FEEDS) {
      // The .yml itself must resolve, plus every asset it points at.
      const toCheck = [name, ...feeds[name].assets];
      for (const asset of toCheck) {
        const url = `${base}/${asset}`;
        // eslint-disable-next-line no-await-in-loop
        const ok = await headOk(url);
        if (!ok) fail(`asset does not resolve (HEAD != 200): ${url}`, args.json);
      }
    }
  }

  const result = { ok: true, version: releaseVersion, feeds: FEEDS, checkedUrls: !!args.baseUrl };
  if (args.json) process.stdout.write(JSON.stringify(result) + '\n');
  else {
    process.stdout.write(`\nPROMOTABLE: both feeds present, version ${releaseVersion} agrees`);
    process.stdout.write(args.baseUrl ? ', all assets resolve.\n\n' : ' (URL check skipped; pass --base-url to enable).\n\n');
  }
}

main();
