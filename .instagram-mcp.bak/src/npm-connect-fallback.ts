import { spawn } from "node:child_process";
import { InstagramMcpError } from "./errors.js";
import { hasInjectedCredentials } from "./oauth-config.js";

/**
 * Local workspaces / git checkouts ship REPLACE_AT_BUILD unless you inject
 * credentials or set INSTAGRAM_MCP_APP_* . Published `instagram-mcp-buddy`
 * on npm already embeds the maintainer Meta app. When this process has no
 * credentials, we delegate connect (and optionally logout) to that package
 * via npx so users are not forced to create a Meta developer app.
 *
 * Set INSTAGRAM_MCP_NO_NPX_FALLBACK=1 to disable (air‑gapped / policy).
 *
 * `runPublishedBuddySubprocess` sets INSTAGRAM_MCP_NPX_DELEGATE_CHILD=1 on the
 * child so the npx-invoked process never delegates again (avoids infinite npx).
 */
const DELEGATE_CHILD_ENV = "INSTAGRAM_MCP_NPX_DELEGATE_CHILD";

export function shouldUseNpmOAuthFallback(): boolean {
  if (process.env.INSTAGRAM_MCP_NO_NPX_FALLBACK === "1") return false;
  if (process.env[DELEGATE_CHILD_ENV] === "1") return false;
  return !hasInjectedCredentials();
}

export interface RunPublishedBuddySubprocessOpts {
  /** Emit the last non-empty stdout line as JSON (connect CLI contract). */
  forwardStdoutJsonLine?: boolean;
}

/**
 * Run `npx -y instagram-mcp-buddy <subcommand>` with the current env (feature
 * flags, etc.). Forwards child stderr to our stderr; collects stdout.
 */
export async function runPublishedBuddySubprocess(
  subcommand: "connect" | "logout",
  opts: RunPublishedBuddySubprocessOpts = {},
): Promise<string | undefined> {
  const isWin = process.platform === "win32";
  const child = spawn("npx", ["-y", "instagram-mcp-buddy", subcommand], {
    env: { ...process.env, [DELEGATE_CHILD_ENV]: "1" },
    stdio: ["inherit", "pipe", "pipe"],
    shell: isWin,
    windowsHide: isWin,
  });

  let out = "";
  let err = "";
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (e) => {
      reject(
        new InstagramMcpError(
          `Failed to spawn npx (is Node/npm installed and on PATH?): ${(e as Error).message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        const msg = (err || out).trim() || `npx instagram-mcp-buddy ${subcommand} exited ${code}`;
        reject(new InstagramMcpError(msg));
        return;
      }
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
      if (opts.forwardStdoutJsonLine && line) {
        process.stdout.write(`${line}\n`);
      }
      resolve(line);
    });
  });
}
