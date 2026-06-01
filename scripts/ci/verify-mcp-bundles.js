#!/usr/bin/env node
// Asserts each vendored MCP bundle in the packaged artifact actually starts and answers an MCP initialize handshake. A corrupted esbuild output or a node-version mismatch leaves MCP silently broken while every boot/health check stays green; this gate fails the build red instead.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { app: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--app') out.app = argv[++i];
  return out;
}

function bundlesRoot(appExe) {
  if (process.platform === 'darwin') {
    const i = appExe.indexOf('.app');
    const appRoot = i === -1 ? appExe : appExe.slice(0, i + 4);
    return path.join(appRoot, 'Contents', 'Resources', 'backend', 'mcp-bundles');
  }
  return path.join(path.dirname(appExe), 'resources', 'backend', 'mcp-bundles');
}

// POSIX ships node under bin/ (node/<arch>/bin/node); Windows drops it (node.exe
// straight under arch). Must mirror electron/main.js getBundledNodePath() or this
// gate cant find the binary it bundled and false-fails a perfectly good build.
function bundledNode(appExe) {
  if (process.platform === 'win32') return path.join(path.dirname(appExe), 'resources', 'node', 'x64', 'node.exe');
  if (process.platform === 'darwin') {
    const i = appExe.indexOf('.app');
    const appRoot = i === -1 ? appExe : appExe.slice(0, i + 4);
    return path.join(appRoot, 'Contents', 'Resources', 'node', process.arch, 'bin', 'node');
  }
  return path.join(path.dirname(appExe), 'resources', 'node', process.arch, 'bin', 'node');
}

// Locate the JS entry for each bundle. Single-file bundles ship as <name>.js;
// directory bundles (multi-file) have package.json + dist/index.js.
function discoverEntries(root) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.endsWith('.js')) out.push({ name: e.name.replace(/\.js$/, ''), entry: full });
    else if (e.isDirectory()) {
      const candidates = [
        path.join(full, 'dist', 'index.js'),
        path.join(full, 'index.js'),
        path.join(full, 'build', 'index.js'),
      ];
      const hit = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
      if (hit) out.push({ name: e.name, entry: hit });
    }
  }
  return out;
}

// Drive one MCP initialize handshake over the bundle's stdio. A working server
// responds to {jsonrpc:"2.0",id:1,method:"initialize",...} with a result that
// includes a protocolVersion. We don't care about the version string, only
// that we got a non-error JSON-RPC response back.
function probeBundle(nodePath, entryPath, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [entryPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch {} resolve(result); };
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
      // MCP frames are newline-delimited JSON; look for the first parseable response with id=1.
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && (msg.result || msg.error)) {
            finish({ ok: !!msg.result, response: msg, stderr });
            return;
          }
        } catch { /* partial frame */ }
      }
    });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => finish({ ok: false, error: String(e), stderr }));
    child.on('exit', (code) => { if (!done) finish({ ok: false, exitCode: code, stderr }); });
    setTimeout(() => finish({ ok: false, error: 'timeout', stderr }), timeoutMs);
    // Send the initialize request. clientInfo is required by the spec.
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-mcp-bundles', version: '0.1' } } });
    try { child.stdin.write(req + '\n'); } catch (e) { finish({ ok: false, error: String(e), stderr }); }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appExe = h.packagedAppPath(args.app);
  const root = bundlesRoot(appExe);
  const node = bundledNode(appExe);

  process.stdout.write(`MCP bundles root: ${root}\n`);
  process.stdout.write(`Bundled node:     ${node}\n`);
  if (!fs.existsSync(root)) { process.stderr.write(`\nMCP-BUNDLES FAIL: bundles dir missing at ${root}\n`); process.exit(1); }
  if (!fs.existsSync(node)) { process.stderr.write(`\nMCP-BUNDLES FAIL: bundled node not at ${node}\n`); process.exit(1); }

  const entries = discoverEntries(root);
  if (entries.length === 0) { process.stderr.write(`\nMCP-BUNDLES FAIL: no MCP bundle entries found under ${root}\n`); process.exit(1); }
  process.stdout.write(`Discovered ${entries.length} bundle(s): ${entries.map((e) => e.name).join(', ')}\n\n`);

  const failures = [];
  for (const e of entries) {
    process.stdout.write(`  probing ${e.name} ... `);
    const r = await probeBundle(node, e.entry);
    if (r.ok) process.stdout.write('ok\n');
    else {
      process.stdout.write('FAIL\n');
      failures.push({ name: e.name, ...r });
    }
  }

  if (failures.length) {
    process.stderr.write(`\nMCP-BUNDLES FAIL: ${failures.length}/${entries.length} bundle(s) did not respond to initialize:\n`);
    for (const f of failures) {
      process.stderr.write(`  - ${f.name}: ${f.error || `exit ${f.exitCode}`}\n`);
      if (f.stderr) process.stderr.write(`    stderr: ${f.stderr.trim().slice(0, 400)}\n`);
    }
    process.exit(1);
  }

  process.stdout.write('\nMCP-BUNDLES PASS: every shipped bundle starts and answers initialize.\n');
  process.exit(0);
}

main().catch((e) => { process.stderr.write(`\nMCP-BUNDLES FAIL: ${e && e.message || e}\n`); process.exit(1); });
