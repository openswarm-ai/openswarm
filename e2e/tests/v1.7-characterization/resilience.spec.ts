import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { api, bootIntoDashboard, closeSessionQuietly, dispatch, launchSessionWithCard, select } from './support';

// Characterization of the resilience claims in the 1.7.7 release notes: the board never wipes on a
// momentary read error, and a lost local connection retries, heals, and only speaks up when it cannot.
// The outage tests kill the packaged backend for real (the app's own respawn brings it back).

// The packaged backend is a child of the app: uvicorn on the port the renderer reports.
function backendPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uvicorn*backend.main:app*--port ${port}*' } | Select-Object -ExpandProperty ProcessId"`,
        { encoding: 'utf8', timeout: 20_000 },
      );
      const pid = parseInt(out.trim().split(/\s+/)[0] || '', 10);
      return Number.isFinite(pid) ? pid : null;
    }
    const out = execSync(`ps -axo pid=,command= | grep -F -- "uvicorn backend.main:app" | grep -F -- "--port ${port}" | grep -v grep`, { encoding: 'utf8' });
    const pid = parseInt(out.trim().split(/\s+/)[0] || '', 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

test.describe.configure({ mode: 'serial' });
test.describe('characterization: resilience (1.7.7)', () => {
  let app: ElectronApplication;
  let win: Page;
  let dashboardId: string;
  let sessionId: string;
  const created: string[] = [];

  test.beforeAll(async () => {
    ({ app, win, dashboardId } = await bootIntoDashboard());
  });
  test.afterAll(async () => {
    for (const id of created) await closeSessionQuietly(win, id).catch(() => {});
    await app?.close().catch(() => {});
  });

  const sessionIds = () => select(win, (s) => Object.keys(s.agents.sessions));
  const cardIds = () => select(win, (s) => Object.keys(s.dashboardLayout.cards));

  test('1.7.7 F2: a failed or unscoped sessions read never wipes the board', async () => {
    sessionId = await launchSessionWithCard(win, dashboardId, 'Characterization board');
    created.push(sessionId);
    // Make the session strippable in principle: settled and no longer tracked as a live notification.
    await dispatch(win, { type: 'agents/updateSessionStatus', payload: { sessionId, status: 'completed' } });
    await dispatch(win, { type: 'agents/dismissAgentNotification', payload: sessionId });
    expect(await sessionIds()).toContain(sessionId);
    expect(await cardIds()).toContain(sessionId);
    // A read error lands in .rejected, which strips nothing.
    await dispatch(win, { type: 'agents/fetchSessions/rejected', error: { message: 'sessions fetch failed: 500' }, meta: { arg: { dashboardId }, requestId: 'char-r1', requestStatus: 'rejected' } } as any);
    // An UNSCOPED empty answer has no authority to delete anything (memory-only after a respawn).
    await dispatch(win, { type: 'agents/fetchSessions/fulfilled', payload: [], meta: { arg: {}, requestId: 'char-r2', requestStatus: 'fulfilled' } } as any);
    // Another dashboard's list is only authoritative for its own sessions.
    await dispatch(win, { type: 'agents/fetchSessions/fulfilled', payload: [], meta: { arg: { dashboardId: 'some-other-dashboard' }, requestId: 'char-r3', requestStatus: 'fulfilled' } } as any);
    await win.waitForTimeout(1200);
    expect(await sessionIds()).toContain(sessionId);
    expect(await cardIds()).toContain(sessionId);
    await expect(win.locator(`[data-select-type="agent-card"][data-select-id="${sessionId}"]`)).toBeVisible();
    // The backend's own list for this dashboard still carries the session: the read path is honest.
    const { status, body } = await api<{ sessions: Array<{ id: string }> }>(win, `/agents/sessions?dashboard_id=${dashboardId}`);
    expect(status).toBe(200);
    expect(body.sessions.some((s) => s.id === sessionId)).toBe(true);
  });

});

// Each outage test boots its own app: the respawn budget and the renderer's reachability state both
// start clean, exactly as they would on the boot a user actually experiences.
test.describe('characterization: resilience — lost local connection (1.7.7 F6)', () => {
  let app: ElectronApplication;
  let win: Page;
  test.beforeEach(async () => { ({ app, win } = await bootIntoDashboard()); });
  test.afterEach(async () => { await app?.close().catch(() => {}); });

  const health = () => win.evaluate(async () => {
    const port = (window as any).openswarm.getBackendPort();
    const host = window.location.hostname || 'localhost';
    try { return (await fetch(`http://${host}:${port}/api/health/check`, { cache: 'no-store' })).status; } catch { return 0; }
  });

  test('1.7.7 F6: a lost local connection retries and heals itself, without a scary card', async () => {
    const port: number = await win.evaluate(() => (window as any).openswarm.getBackendPort());
    const pid = backendPid(port);
    test.skip(pid === null, 'could not identify the packaged backend process on this host');
    const pill = win.getByText('Reconnecting to OpenSwarm…');
    process.kill(pid!, 'SIGKILL');
    // The app respawns it (bounded, backoff); a quick recovery must be silent — no pill flashes.
    // (A cold packaged-Python boot on a CI runner can take a while; the budget is generous.)
    let pillSeen = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await pill.count()) pillSeen = true;
      const status = await health();
      const livePid = backendPid(port);
      if (status === 200 && livePid !== null && livePid !== pid) break;
      await win.waitForTimeout(500);
    }
    expect(await health(), 'the backend must be back on the same port').toBe(200);
    expect(pillSeen, 'a recovery inside the pill grace period must not flash the reconnecting pill').toBe(false);
  });

  test('1.7.7 F6: when it cannot heal quickly, it says so plainly, and heals when it can', async () => {
    const port: number = await win.evaluate(() => (window as any).openswarm.getBackendPort());
    test.skip(backendPid(port) === null, 'could not identify the packaged backend process on this host');
    const pill = win.getByText('Reconnecting to OpenSwarm…');
    // The pill is deliberately slow to speak: a GET only counts as a failure after its whole retry
    // ladder, two of those flip the connection to down, and the pill waits a further grace period. So
    // keep the outage continuous well past that: kill each respawn as it appears (the budget is
    // bounded, so at most four, leaving the fifth to heal) while the renderer keeps asking.
    const killed = new Set<number>();
    const stopAt = Date.now() + 45_000;
    let live = backendPid(port);
    const asking = setInterval(() => { void health().catch(() => 0); }, 400);
    try {
      while (Date.now() < stopAt && killed.size < 4) {
        if (live !== null && !killed.has(live)) { try { process.kill(live, 'SIGKILL'); } catch { /* already gone */ } killed.add(live); }
        if (await pill.count()) break;
        await win.waitForTimeout(200);
        live = backendPid(port);
      }
      await expect(pill).toBeVisible({ timeout: 40_000 });
    } finally {
      clearInterval(asking);
    }
    // Now the app's next respawn is left alone: it heals, and the pill withdraws.
    await expect.poll(health, { timeout: 90_000, intervals: [1000] }).toBe(200);
    await expect(pill).toBeHidden({ timeout: 30_000 });
  });
});
