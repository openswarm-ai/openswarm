// Frontend test runner, zero new dependencies: esbuild (already a dependency of
// the build chain) bundles each *.test.ts(x) with its imports and path aliases
// resolved, then Node's built-in test runner executes the result.
//
// Why not jest/vitest: this worktree's node_modules is shared, and the whole job
// here is running our own pure logic. If component/DOM tests are ever needed,
// that is the moment to add a real DOM environment, not before.
import { build } from 'esbuild';
import { globSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const tests = globSync('src/**/*.test.{ts,tsx}', { cwd: root }).sort();
if (tests.length === 0) {
  console.error('no test files found (src/**/*.test.ts(x))');
  process.exit(1);
}

// Build INSIDE the package, not tmpdir: anything left external (react-dom/server) has to
// resolve through frontend/node_modules, and a tmpdir has no node_modules to walk up to.
// One fixed dir, wiped up front, so a Ctrl-C'd run litters the repo once instead of forever.
let status = 1;
const outDir = path.join(root, '.test-build');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
try {
  await build({
    entryPoints: tests.map((t) => path.join(root, t)),
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'warning',
    // node builtins stay external, and so does react-dom/server: esbuild's CJS interop
    // cannot follow its conditional require chain, so bundling it dies at import time.
    // react rides along as external for a subtler reason: react-dom/server resolves its OWN react
    // from node_modules, so bundling a second copy leaves the hook dispatcher null and every
    // component that calls useContext dies with "Cannot read properties of null".
    external: ['node:*', 'react-dom/server', 'react'],
    alias: { '@': path.join(root, 'src'), '@toolui': path.join(root, 'src/toolui') },
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff2': 'empty', '.mp4': 'empty' },
  });
  const built = globSync('**/*.mjs', { cwd: outDir }).concat(globSync('**/*.js', { cwd: outDir }));
  const setup = path.join(root, 'scripts/test-globals.mjs');
  const res = spawnSync(process.execPath, ['--import', setup, '--test', ...built.map((f) => path.join(outDir, f))],
    { stdio: 'inherit', cwd: root });
  status = res.status ?? 1;
} finally {
  // Exit AFTER this block, never inside the try: process.exit() skips finally outright,
  // which is how every single run used to leave its build dir behind.
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(status);
