#!/usr/bin/env node
// Runs every renderer unit test (src/**/*.test.ts, *.test.tsx) under node:test, with tsx doing the
// TypeScript. One command for CI and for a dev machine: `node scripts/run-tests.mjs`, optionally
// followed by file paths to run a subset. Exits non-zero if any test fails or nothing was found.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testFile = (p) => /\.test\.tsx?$/.test(p);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (testFile(p)) out.push(p);
  }
  return out;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : walk(join(root, 'src'), []).sort();
if (files.length === 0) {
  console.error('run-tests: no test files found under src/');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
