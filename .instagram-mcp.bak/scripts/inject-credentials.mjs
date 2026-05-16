#!/usr/bin/env node
/**
 * Rewrite the REPLACE_AT_BUILD placeholders in dist/oauth-config.js with the
 * real Meta App credentials at npm publish time.
 *
 * Hard fails (exit 1) if:
 *   - META_APP_ID / META_APP_SECRET (or INSTAGRAM_MCP_APP_*) are missing
 *   - either value still equals REPLACE_AT_BUILD
 *   - dist/oauth-config.js is missing (forgot to run `tsc`)
 *   - either placeholder is not found in the file
 *
 * Logs the SHA-256 of the resulting file so the maintainer can verify the
 * credentials made it in.
 *
 * Invocation:
 *   META_APP_ID=... META_APP_SECRET=... npm run publish:npm
 *   # or same values as .env.example:
 *   INSTAGRAM_MCP_APP_ID=... INSTAGRAM_MCP_APP_SECRET=... npm run inject:credentials
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TARGET = resolve(__dirname, "..", "dist", "oauth-config.js");
const PLACEHOLDER = "REPLACE_AT_BUILD";

function die(msg) {
  process.stderr.write(`inject-credentials: ${msg}\n`);
  process.exit(1);
}

function loadDotEnvFiles() {
  const applyLine = (line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq === -1) return;
    const key = t.slice(0, eq).trim();
    if (!key) return;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  };
  for (const p of [
    resolve(process.cwd(), ".env"),
    resolve(__dirname, "..", ".env"),
  ]) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) applyLine(line);
    } catch {
      /* ignore */
    }
  }
}

loadDotEnvFiles();

const id = process.env.META_APP_ID || process.env.INSTAGRAM_MCP_APP_ID;
const secret = process.env.META_APP_SECRET || process.env.INSTAGRAM_MCP_APP_SECRET;

if (!id)
  die(
    "META_APP_ID (or INSTAGRAM_MCP_APP_ID) is required in env or instagram-mcp/.env. " +
      "Refusing to inject. If you copied .env.example, fill in the values on the " +
      "INSTAGRAM_MCP_APP_ID= and INSTAGRAM_MCP_APP_SECRET= lines — those lines must " +
      "NOT start with # or they are ignored.",
  );
if (!secret)
  die(
    "META_APP_SECRET (or INSTAGRAM_MCP_APP_SECRET) is required in env or instagram-mcp/.env. " +
      "Refusing to inject. Use uncommented INSTAGRAM_MCP_APP_SECRET=your_secret (no leading #).",
  );
if (id === PLACEHOLDER) die("META_APP_ID is the placeholder. Refusing to inject.");
if (secret === PLACEHOLDER)
  die("META_APP_SECRET is the placeholder. Refusing to inject.");

let original;
try {
  original = await readFile(TARGET, "utf8");
} catch (err) {
  die(
    `cannot read ${TARGET}: ${err.message}. Did you run \`tsc\` first? (npm run publish:npm does this for you.)`,
  );
}

// Target ONLY the two export-const fallback strings. The literal
// "REPLACE_AT_BUILD" survives in comments and in `hasInjectedCredentials()`,
// which is intentional — that function still correctly returns true after
// real credentials are injected because the real values won't equal the
// placeholder string.
const ID_PATTERN =
  /(META_APP_ID\s*=\s*process\.env\.INSTAGRAM_MCP_APP_ID\s*\?\?\s*")REPLACE_AT_BUILD(")/;
const SECRET_PATTERN =
  /(META_APP_SECRET\s*=\s*process\.env\.INSTAGRAM_MCP_APP_SECRET\s*\?\?\s*")REPLACE_AT_BUILD(")/;

if (!ID_PATTERN.test(original)) {
  die(
    `META_APP_ID placeholder line not found in ${TARGET}. Either credentials were already injected, or the build output changed shape.`,
  );
}
if (!SECRET_PATTERN.test(original)) {
  die(
    `META_APP_SECRET placeholder line not found in ${TARGET}. Either credentials were already injected, or the build output changed shape.`,
  );
}

// String-literal injection: backslash- and quote-escape just in case.
const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const next = original
  .replace(ID_PATTERN, `$1${escape(id)}$2`)
  .replace(SECRET_PATTERN, `$1${escape(secret)}$2`);

await writeFile(TARGET, next, "utf8");

const sha = createHash("sha256").update(next).digest("hex");
process.stdout.write(
  `inject-credentials: injected META_APP_ID + META_APP_SECRET into ${TARGET}\n`,
);
process.stdout.write(`inject-credentials: sha256(${TARGET}) = ${sha}\n`);
process.stdout.write(
  `inject-credentials: META_APP_ID prefix = ${id.slice(0, 4)}*** (length ${id.length})\n`,
);
process.stdout.write(
  `inject-credentials: META_APP_SECRET prefix = ${secret.slice(0, 4)}*** (length ${secret.length})\n`,
);
