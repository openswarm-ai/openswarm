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

  // On a genuinely fresh profile OnboardingV3 opens a full-screen welcome modal
  // ("Welcome." + an ArrowRight icon, OnboardingV3Root IntroBeat)
  // and nothing behind it is clickable, so every spec that wants to reach the app stalls on step one.
  // useOnboardingV3Gate treats ANY onboarding_v3 value as "not a fresh install", which is what an e2e profile is.
  //
  // This deliberately makes first-run onboarding untestable here, and that gap is not
  // closable from the test side: IntroBeat's button has no text, aria-label,
  // data-onboarding or data-testid, so there is no stable way to drive it.
  //
  // TODO: first-run onboarding needs a spec of its own, and it cannot live in this
  // suite -- every spec calling launchApp() arrives here already seeded past the modal.
  // It also needs a genuinely fresh profile on EVERY run, because a packaged build cannot
  // replay the flow: useOnboardingV3Gate's osw_force_onboarding replay hatch is gated off
  // by NODE_ENV === 'production'. Blocked on giving IntroBeat's button an accessible name;
  // that single change closes both the a11y hole and this coverage gap.
  if (!merged.onboarding_v3) {
    merged.onboarding_v3 = 'skipped';
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
  // OPENSWARM_E2E=1 is read by electron/main.js BEFORE the renderer launches; it
  // appends a Chromium switch the preload reads to set window.__OPENSWARM_E2E__
  // before bundle.js parses, so the production store-on-window gate fires
  // deterministically (no addInitScript race).
  // Diagnostic: OPENSWARM_E2E_DISABLE_GPU=1 launches with GPU/compositing off, to
  // tell apart a real renderer crash from a headless-GPU-context 0xC0000005 that
  // only reproduces under automated launch. Not used by default.
  const extraArgs = process.env.OPENSWARM_E2E_DISABLE_GPU === '1'
    ? ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer']
    : [];
  // Diagnostic: pass --js-flags=--no-opt on the launch command line (guaranteed
  // to reach the RENDERER V8, unlike main.js appendSwitch which may only affect
  // the main process). Used to confirm whether the renderer crash is the V8 bug.
  if (process.env.OPENSWARM_E2E_NOOPT === '1') extraArgs.push('--js-flags=--no-opt');
  const app = await electron.launch({
    executablePath: packagedAppPath(),
    args: extraArgs,
    env: { ...process.env, OPENSWARM_E2E: '1' },
  });
  // Belt-and-braces: addInitScript ALSO sets the flag in case a future Electron
  // changes the cmdline propagation. If either path works, the spec succeeds.
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
