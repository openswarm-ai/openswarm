import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Repo root is two levels up from this file (e2e/helpers/).
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Resolve the PACKAGED Electron binary for the current OS. Override with
// E2E_APP_PATH to point at any built artifact. We deliberately drive the packaged
// build (asar, bundled python-env, real paths) — not `electron .` on source —
// because that is what ships and what the plan requires us to verify.
export function packagedAppPath(): string {
  if (process.env.E2E_APP_PATH) return process.env.E2E_APP_PATH;
  const dist = path.join(REPO_ROOT, 'electron', 'dist');
  const candidates =
    process.platform === 'win32'
      ? [path.join(dist, 'win-unpacked', 'OpenSwarm.exe')]
      : process.platform === 'darwin'
        ? [
            path.join(dist, 'mac-arm64', 'OpenSwarm.app', 'Contents', 'MacOS', 'OpenSwarm'),
            path.join(dist, 'mac', 'OpenSwarm.app', 'Contents', 'MacOS', 'OpenSwarm'),
            path.join(dist, 'mac-universal', 'OpenSwarm.app', 'Contents', 'MacOS', 'OpenSwarm'),
          ]
        : [path.join(dist, 'linux-unpacked', 'openswarm')];
  const found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!found) throw new Error(`Packaged app not found. Build first or set E2E_APP_PATH. Looked in:\n  ${candidates.join('\n  ')}`);
  return found;
}

// On a clean profile (fresh CI runner) the SignInGate modal blocks the UI so
// every Playwright click lands on the backdrop instead of the real button,
// silently greening the test. Pre-seed user_id BEFORE launch so the gate
// dismisses. We only seed when no settings.json exists, so this never touches
// a developer's signed-in machine.
function seedTestUserIfClean(): void {
  // Gate on CI so a developer running `npm test` locally never has their real
  // (or absent) sign-in state replaced with a fake one.
  if (process.env.CI !== 'true' && process.env.OPENSWARM_E2E_SEED !== '1') return;
  const userData =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'OpenSwarm', 'data', 'settings')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'settings')
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OpenSwarm', 'data', 'settings');
  const file = path.join(userData, 'settings.json');
  // verify-all may have created the file without a user_id (no auth flow); we
  // re-seed in that case too. Only existing-with-real-user_id is left alone.
  let existing: any = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = {}; }
  const merged: any = { ...existing };
  if (!merged.user_id) {
    merged.user_id = 'e2e-fake-user';
    merged.user_email = 'e2e@openswarm.test';
  }
  // Provider keys: read from env each launch so a key never has to live on disk
  // outside the per-user app-support dir (and so rotating just means a new shell).
  const envKeys: Array<[string, string]> = [
    ['ANTHROPIC_API_KEY', 'anthropic_api_key'],
    ['OPENAI_API_KEY', 'openai_api_key'],
    ['GOOGLE_API_KEY', 'google_api_key'],
    ['OPENROUTER_API_KEY', 'openrouter_api_key'],
  ];
  for (const [envName, field] of envKeys) {
    const v = process.env[envName];
    if (v && v.trim()) merged[field] = v.trim();
  }
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}

// Public: lets specs ask whether at least one provider key is wired so they can
// test.skip themselves on legs where no key is present, rather than try to drive
// a real turn against an unconfigured backend.
export function hasAnyProviderKey(): boolean {
  return ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']
    .some((k) => !!(process.env[k] && process.env[k]!.trim()));
}

export async function launchApp(): Promise<ElectronApplication> {
  seedTestUserIfClean();
  const app = await electron.launch({ executablePath: packagedAppPath(), args: [] });
  // The frontend bundle gates `__OPENSWARM_STORE__` exposure on
  // `__OPENSWARM_E2E__` being truthy at module-load time. Adding an init
  // script BEFORE the main page navigates guarantees the flag is set before
  // bundle.js parses, so specs that read the Redux store directly work
  // against the production build.
  try { await app.context().addInitScript({ content: '(window).__OPENSWARM_E2E__ = true;' }); } catch { /* best effort */ }
  return app;
}

// The app opens a splash window first, then the main window that loads the React
// frontend and exposes window.openswarm. Poll all windows until one has the
// bridge AND the React root has mounted (first meaningful paint), then return it.
export async function waitForMainWindow(app: ElectronApplication, timeoutMs = 120_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        const ready = await w.evaluate(() => {
          const hasBridge = typeof (window as any).openswarm?.getBackendPort === 'function';
          const root = document.getElementById('root');
          return hasBridge && !!root && root.childElementCount > 0;
        });
        if (ready) return w;
      } catch { /* window navigating or not ready; keep polling */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('main window with mounted React root never appeared');
}

// Read the build-info.json the build stamped, so tests can assert the running
// app's provenance matches the artifact on disk.
export function readBuildInfo(): { sha: string; shortSha: string; channel: string; version: string } {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'electron', 'build-info.json'), 'utf8'));
}
