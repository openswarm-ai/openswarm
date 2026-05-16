import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function applyDotEnvLine(line: string): void {
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
}

/**
 * Load optional `.env` before `oauth-config` reads INSTAGRAM_MCP_APP_*.
 * Skipped under Vitest / NODE_ENV=test so unit tests control env explicitly.
 */
export function loadInstagramBuddyEnvFromDisk(): void {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined ||
    process.env.VITEST_WORKER_ID !== undefined
  ) {
    return;
  }

  const roots = [process.cwd(), resolve(__dirname, "..")];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const name of [".env", ".env.local"]) {
      const path = resolve(root, name);
      if (seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf8");
        for (const line of content.split(/\r?\n/)) applyDotEnvLine(line);
      } catch {
        /* ignore unreadable .env */
      }
    }
  }
}

loadInstagramBuddyEnvFromDisk();
