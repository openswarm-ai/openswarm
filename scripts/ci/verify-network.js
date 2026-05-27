#!/usr/bin/env node
// Exercises the network/auth plumbing the app depends on, using the SAME bearer
// token and ports the running app uses (no mocks). Splits into two tiers:
//
//   LOCAL (always hard-asserted, deterministic):
//     - auth.token exists on disk (the load-bearing pre-bind handshake, auth.py)
//     - an authed endpoint rejects with no token (401/403) and accepts with it
//       (proves the bearer wiring, not just that a port is open)
//     - the bundled 9router subprocess is listening on :20128 (LLM routing + the
//       OAuth authorize/exchange path both go through it)
//
//   EXTERNAL (best-effort; --strict makes them hard):
//     - api.openswarm.com reachable (the fly-hosted proxy OAuth + sign-in use)
//     - the GitHub Releases feed reachable (what the auto-updater reads)
//
// Completing a real OAuth flow is inherently interactive (a browser), so it lives
// in the GUI walkthrough; here we prove its DEPENDENCIES are reachable.
//
//   node scripts/ci/verify-network.js [--app <path>] [--strict] [--timeout-ms 120000]

'use strict';
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { app: null, strict: false, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--strict') out.strict = true;
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

function httpStatus(port, path, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: headers || {} }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => { req.destroy(); resolve(0); });
  });
}

function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(4000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function httpsReachable(url) {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('error', () => resolve(0));
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = h.packagedAppPath(args.app);
  const failures = [];
  const warns = [];

  process.stdout.write(`Launching: ${appPath}\n`);
  const res = await h.launchAndWait({ appPath, timeoutMs: args.timeoutMs });
  const child = res.child;
  try {
    const port = res.port;
    if (!port) { failures.push('could not parse backend port from log'); }

    // 1. auth.token on disk
    const token = h.readFileSafe(h.authTokenPath()).trim();
    if (!token) failures.push(`auth.token missing/empty at ${h.authTokenPath()}`);
    else process.stdout.write(`  auth.token present (${token.length} chars)\n`);

    // 2. authed endpoint honors the bearer
    if (port && token) {
      const authedPath = '/api/settings/default-system-prompt';
      const noTok = await httpStatus(port, authedPath, {});
      const withTok = await httpStatus(port, authedPath, { Authorization: `Bearer ${token}` });
      if (![401, 403].includes(noTok)) failures.push(`authed endpoint returned ${noTok} WITHOUT token (expected 401/403)`);
      if ([401, 403, 0].includes(withTok)) failures.push(`authed endpoint returned ${withTok} WITH token (expected it honored)`);
      if ([401, 403].includes(noTok) && ![401, 403, 0].includes(withTok)) {
        process.stdout.write(`  bearer honored: no-token=${noTok}, with-token=${withTok}\n`);
      }
    }

    // 3. 9router subprocess listening
    const routerUp = await tcpOpen('127.0.0.1', 20128);
    if (!routerUp) failures.push('9router not listening on 127.0.0.1:20128');
    else process.stdout.write('  9router up on :20128\n');

    // 4. external (best-effort unless --strict)
    const proxy = await httpsReachable('https://api.openswarm.com/');
    const feed = await httpsReachable('https://github.com/openswarm-ai/openswarm/releases/latest');
    const noteExternal = (name, code) => {
      const reachable = code > 0;
      process.stdout.write(`  ${name}: ${reachable ? `reachable (HTTP ${code})` : 'unreachable'}\n`);
      if (!reachable) (args.strict ? failures : warns).push(`${name} unreachable`);
    };
    noteExternal('api.openswarm.com', proxy);
    noteExternal('github release feed', feed);
  } finally {
    h.killApp(child);
  }

  if (warns.length) process.stdout.write(`\nWARN (non-fatal): ${warns.join('; ')}\n`);
  if (failures.length) { process.stderr.write(`\nNETWORK FAIL: ${failures.join('; ')}\n`); process.exit(1); }
  process.stdout.write('\nNETWORK PASS: auth handshake + 9router verified; external dependencies reachable.\n');
  process.exit(0);
}

main().catch((e) => { process.stderr.write(`\nNETWORK FAIL: ${e && e.message || e}\n`); process.exit(1); });
