import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { launchApp, waitForMainWindow } from '../helpers/launch';

// A chat you open and have not typed into yet must survive a backend crash the same way it survives
// a normal quit. Until launch snapshotted the session at birth it lived only in memory until its
// first turn ended, so a crash (here: the packaged backend is really killed; the app respawns it)
// followed by a fresh renderer left the respawned backend with nothing to promote into the
// dashboard's list, and the board came back without the card. No provider key needed.
test.describe.configure({ mode: 'serial' });
test.describe('a parked chat survives a backend crash', () => {
  let app: ElectronApplication;
  let win: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    win = await waitForMainWindow(app);
  });
  test.afterAll(async () => { await app?.close().catch(() => {}); });

  const dashboardReady = () => win.waitForFunction(() => {
    const store = (window as any).__OPENSWARM_STORE__;
    if (!store || !/^#\/dashboard\//.test(window.location.hash)) return false;
    const layout = store.getState().dashboardLayout;
    return layout.initialized === true && layout.loading === false;
  }, null, { timeout: 120_000 });

  // The packaged backend is a child of the app: uvicorn on the port the renderer reports.
  function backendPid(port: number): number | null {
    try {
      if (process.platform === 'win32') {
        const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uvicorn*backend.main:app*--port ${port}*' } | Select-Object -ExpandProperty ProcessId"`, { encoding: 'utf8', timeout: 20_000 });
        const pid = parseInt(out.trim().split(/\s+/)[0] || '', 10);
        return Number.isFinite(pid) ? pid : null;
      }
      const out = execSync(`ps -axo pid=,command= | grep -F -- "uvicorn backend.main:app" | grep -F -- "--port ${port}" | grep -v grep`, { encoding: 'utf8' });
      const pid = parseInt(out.trim().split(/\s+/)[0] || '', 10);
      return Number.isFinite(pid) ? pid : null;
    } catch { return null; }
  }

  const health = () => win.evaluate(async () => {
    const port = (window as any).openswarm.getBackendPort();
    const host = window.location.hostname || 'localhost';
    try { return (await fetch(`http://${host}:${port}/api/health/check`, { cache: 'no-store' })).status; } catch { return 0; }
  });

  test('a chat opened before the crash is still on the board after the app comes back', async () => {
    await dashboardReady();
    const gotIt = win.getByRole('button', { name: 'Got it' });
    if (await gotIt.count()) await gotIt.first().click({ timeout: 5000 }).catch(() => {});
    const port: number = await win.evaluate(() => (window as any).openswarm.getBackendPort());
    const pid = backendPid(port);
    test.skip(pid === null, 'could not identify the packaged backend process on this host');

    // Open a chat through the app's own launch route and reducer; do not send anything.
    const sessionId: string = await win.evaluate(async () => {
      const port = (window as any).openswarm.getBackendPort();
      const host = window.location.hostname || 'localhost';
      const dashboardId = window.location.hash.match(/^#\/dashboard\/([^/?#]+)/)![1];
      const res = await fetch(`http://${host}:${port}/api/agents/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Parked before the crash', dashboard_id: dashboardId }) });
      const data = await res.json();
      (window as any).__OPENSWARM_STORE__.dispatch({ type: 'agents/launchAgent/fulfilled', payload: data.session });
      return data.session.id;
    });
    await expect(win.locator(`[data-select-type="agent-card"][data-select-id="${sessionId}"]`)).toBeVisible({ timeout: 15_000 });
    // Let the renderer's debounced layout save land the card on the persisted board.
    await win.waitForTimeout(3000);

    // Crash the backend for real; the app respawns it (bounded, backoff).
    process.kill(pid!, 'SIGKILL');
    await expect.poll(async () => (await health()) === 200 && backendPid(port) !== pid, { timeout: 120_000, intervals: [1000] }).toBe(true);

    // A fresh renderer has no memory of the chat: what comes back is what the backend can list.
    await win.reload();
    await dashboardReady();
    await expect.poll(() => win.evaluate(() => Object.keys((window as any).__OPENSWARM_STORE__.getState().dashboardLayout.cards)), { timeout: 30_000 }).toContain(sessionId);
    await expect(win.locator(`[data-select-type="agent-card"][data-select-id="${sessionId}"]`)).toBeVisible({ timeout: 15_000 });
  });
});
