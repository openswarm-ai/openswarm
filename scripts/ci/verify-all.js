#!/usr/bin/env node
// Runs every verifier in sequence and aggregates; CI's entry point after building. --require-signed/--strict harden the signature/network gates. Exit 0 iff all pass.

'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = { app: null, requireSigned: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--require-signed') out.requireSigned = true;
    else if (argv[i] === '--strict') out.strict = true;
  }
  return out;
}

function run(label, script, extra) {
  process.stdout.write(`\n${'='.repeat(64)}\n== ${label}\n${'='.repeat(64)}\n`);
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...extra], { stdio: 'inherit' });
  return r.status === 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appArg = args.app ? ['--app', args.app] : [];

  const steps = [
    // Pure-logic gates run first - cheap, no build needed, fail fast.
    ['deps fully pinned (reproducible backend builds)', 'verify-deps-pinned.js', []],
    ['no build-host paths leaked into the artifact', 'verify-host-leakage.js', appArg],
    // App-launching gates.
    ['boot / paint / serve / provenance', 'verify-packaged-app.js', appArg],
    ['code-signing state', 'verify-signature.js', [...(args.app ? ['--target', args.app] : []), ...(args.requireSigned ? ['--require-signed'] : [])]],
    ['resilience (locked-port + multi-instance)', 'verify-resilience.js', appArg],
    ['network / auth / 9router', 'verify-network.js', [...appArg, ...(args.strict ? ['--strict'] : [])]],
    ['boot beacon + preflight', 'verify-boot-beacon.js', appArg],
    ['real agent turn (opt-in: OPENSWARM_E2E_AGENT=1)', 'verify-agent-turn.js', appArg],
  ];

  const results = steps.map(([label, script, extra]) => [label, run(label, script, extra)]);

  process.stdout.write(`\n${'='.repeat(64)}\n== SUMMARY\n${'='.repeat(64)}\n`);
  let allOk = true;
  for (const [label, ok] of results) { process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n`); if (!ok) allOk = false; }
  process.stdout.write('\n');
  process.exit(allOk ? 0 : 1);
}

main();
