#!/usr/bin/env node
/**
 * Dev-only smoke check: spawn `node dist/index.js` with stdio, send an MCP
 * `tools/list` request, print the count + names + which are gated.
 *
 * Usage:
 *   node scripts/dev-list-tools.mjs                   # default flags
 *   INSTAGRAM_MCP_ENABLE_PUBLISHING=true node scripts/dev-list-tools.mjs
 *   INSTAGRAM_MCP_ENABLE_PUBLISHING=true \
 *     INSTAGRAM_MCP_ENABLE_COMMENTMODERATION=true \
 *     INSTAGRAM_MCP_ENABLE_MESSAGING=true \
 *     node scripts/dev-list-tools.mjs
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = resolve(__dirname, "..", "dist", "index.js");

const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buffer = "";
let initialized = false;

const send = (obj) => {
  const payload = JSON.stringify(obj);
  child.stdin.write(`${payload}\n`);
};

const finish = (toolNames) => {
  process.stdout.write(`tool_count=${toolNames.length}\n`);
  for (const name of toolNames) process.stdout.write(`  ${name}\n`);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 100);
};

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1 && !initialized) {
      initialized = true;
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (msg.id === 2 && msg.result?.tools) {
      finish(msg.result.tools.map((t) => t.name));
    }
  }
});

child.on("exit", (code) => {
  if (code !== null && code !== 0) {
    process.stderr.write(`child exited with code ${code}\n`);
    process.exit(code);
  }
});

setTimeout(() => {
  process.stderr.write("dev-list-tools: timed out after 10s\n");
  child.kill("SIGKILL");
  process.exit(2);
}, 10_000);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dev-list-tools", version: "0.0.0" },
  },
});
