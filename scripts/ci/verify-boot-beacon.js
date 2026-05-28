#!/usr/bin/env node
// Asserts main.js boot observability: backend.log has the [preflight] line and the beacon POSTs /api/service/event with 200 (a 4xx or missing line fails - not just "a line exists").

'use strict';
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { app: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--app') out.app = argv[++i];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = h.packagedAppPath(args.app);
  process.stdout.write(`Launching: ${appPath}\n`);
  const res = await h.launchAndWait({ appPath, timeoutMs: 120000 });
  const child = res.child;
  const fail = (m) => { h.killApp(child); process.stderr.write(`\nBEACON FAIL: ${m}\n`); process.exit(1); };
  try {
    // Beacon fires 3s after first-paint; wait past that plus a network round-trip.
    await h.sleep(9000);
    const log = h.readFileSafe(res.logPath);

    const preflight = (log.match(/\[preflight\].*/) || [])[0];
    if (!preflight) fail('no [preflight] line in backend.log (preflight did not run)');
    if (!/\[perf\] first-paint/.test(log)) fail('no [perf] first-paint mark (UI never painted?)');

    const m = log.match(/"POST \/api\/service\/event HTTP\/[\d.]+" (\d{3})/);
    if (!m) fail('boot beacon never POSTed /api/service/event (did not fire)');
    if (m[1] !== '200') fail(`boot beacon POST /api/service/event returned ${m[1]} (expected 200 - beacon rejected)`);

    h.killApp(child);
    process.stdout.write('\nBEACON PASS: preflight logged and boot beacon delivered (200).\n');
    process.stdout.write(`  ${preflight}\n`);
    process.exit(0);
  } catch (e) { fail(e && e.message || String(e)); }
}

main().catch((e) => { process.stderr.write(`\nBEACON FAIL: ${e && e.message || e}\n`); process.exit(1); });
