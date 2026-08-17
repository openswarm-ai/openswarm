import { expect, ElectronApplication, Locator, Page } from '@playwright/test';
import { launchApp, waitForMainWindow } from '../../helpers/launch';

// Shared plumbing for the 1.7.4-1.7.7 characterization specs. Everything drives the PACKAGED app
// through the same doors a user (or the app itself) uses: the Redux store the packaged renderer
// exposes under OPENSWARM_E2E=1, and the renderer's own fetch (already bearer-patched by
// shared/config.ts), so no spec ever handles a token or a port by hand.

export interface AppHandle {
  app: ElectronApplication;
  win: Page;
  dashboardId: string;
}

// Launch, wait for the dashboard to be the LOADED one (entering a dashboard resets the per-dashboard
// layout and then fetches the saved one; anything dispatched inside that window is wiped), and clear
// the release card so its overlay can't sit over what a spec opens next.
export async function bootIntoDashboard(): Promise<AppHandle> {
  const app = await launchApp();
  const win = await waitForMainWindow(app);
  await win.waitForFunction(() => {
    const route = window.location.hash.match(/^#\/dashboard\/([^/?#]+)/);
    const store = (window as any).__OPENSWARM_STORE__;
    if (!route || !store) return false;
    const layout = store.getState().dashboardLayout;
    return layout.initialized === true && layout.loading === false;
  }, null, { timeout: 120_000 });
  const gotIt = win.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) await gotIt.first().click({ timeout: 5000 }).catch(() => {});
  const dashboardId = await win.evaluate(() => window.location.hash.match(/^#\/dashboard\/([^/?#]+)/)![1]);
  return { app, win, dashboardId };
}

export async function dispatch(win: Page, action: { type: string; payload?: unknown; meta?: unknown }): Promise<void> {
  await win.evaluate((a) => { (window as any).__OPENSWARM_STORE__.dispatch(a); }, action);
}

// A store read; the selector runs inside the renderer, so pass a self-contained function.
export async function select<T>(win: Page, selector: (state: any) => T): Promise<T> {
  return win.evaluate((src) => {
    const fn = new Function('state', `return (${src})(state);`) as (state: unknown) => unknown;
    return fn((window as any).__OPENSWARM_STORE__.getState());
  }, selector.toString()) as Promise<T>;
}

// The renderer's fetch against the packaged backend: same origin, same auth, same retry policy the app uses.
export async function api<T = any>(win: Page, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  return win.evaluate(async ({ path, init }) => {
    const port = (window as any).openswarm.getBackendPort();
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }, { path, init }) as Promise<{ status: number; body: T }>;
}

// A live session with a card on the current dashboard, created through the app's own launch route and
// its own reducer (no provider key needed: the launch parks a session and pre-warms in the background).
export async function launchSessionWithCard(win: Page, dashboardId: string, name: string): Promise<string> {
  const { status, body } = await api<{ session: { id: string } }>(win, '/agents/launch', { method: 'POST', body: { name, dashboard_id: dashboardId } });
  expect(status, 'agents/launch').toBe(200);
  await dispatch(win, { type: 'agents/launchAgent/fulfilled', payload: body.session });
  await expect(win.locator(`[data-select-type="agent-card"][data-select-id="${body.session.id}"]`)).toBeVisible({ timeout: 15_000 });
  return body.session.id;
}

// Close through the app's own route + reducer, so the card leaves and the session lands in history.
export async function closeSessionQuietly(win: Page, sessionId: string): Promise<void> {
  await api(win, `/agents/sessions/${sessionId}/close`, { method: 'POST' }).catch(() => {});
  await dispatch(win, { type: 'agents/closeSession/fulfilled', payload: sessionId });
}

export async function openSettingsCard(win: Page, tab?: string): Promise<Locator> {
  await dispatch(win, { type: 'dashboardLayout/openSettingsCard', payload: tab ? { tab } : undefined });
  const close = win.locator('[data-onboarding="settings-close-button"]').first();
  await expect(close).toBeVisible({ timeout: 15_000 });
  return close;
}

// The window lights are pointer-inert until their .osw-card is hovered (a card crossing can't hit-test
// through the dots) and Playwright hit-tests before it moves the mouse; opening also pans to the card.
// So: let it settle, cross the card the way a hand does, then click the dot.
export async function clickWindowLight(win: Page, light: Locator): Promise<void> {
  await settle(light);
  await win.locator('.osw-card', { has: light }).last().hover({ timeout: 8000 });
  await light.click({ timeout: 8000 });
}

export async function closeSettingsCard(win: Page): Promise<void> {
  const close = win.locator('[data-onboarding="settings-close-button"]').first();
  if (!(await close.count())) return;
  await clickWindowLight(win, close);
  await expect(close).toBeHidden({ timeout: 8000 });
}

// Resolves once the element's box is unchanged across two polls 300ms apart (a pan/zoom has finished).
export async function settle(target: Locator, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  while (Date.now() < deadline) {
    const box = JSON.stringify(await target.boundingBox());
    if (box !== 'null' && box === previous) return;
    previous = box;
    await target.page().waitForTimeout(300);
  }
}

// The painted camera: the canvas content layer's transform is written imperatively per gesture frame,
// so it is the truth about whether a wheel or a drag moved the world.
export async function paintedCamera(win: Page): Promise<string> {
  return win.evaluate(() => {
    const content = document.querySelector('[data-canvas-content]') as HTMLElement | null;
    return content ? content.style.transform || getComputedStyle(content).transform : 'missing';
  });
}
