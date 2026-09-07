import { test, expect, ElectronApplication, Locator, Page } from '@playwright/test';
import { launchApp, waitForMainWindow } from '../helpers/launch';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Deep interactive coverage: drives every reachable user-facing surface on the
// packaged app and asserts no renderer crashes per step. Runs on every gated CI
// push against the Windows leg (macOS legs were removed). Replaces the "I
// physically click everything" manual gap with a hermetic automated one that
// has no foreground-lock contention because CI runners have no competing app.

function backendLogPath(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OpenSwarm', 'data', 'backend.log');
}

function crashCount(): number {
  try { return (fs.readFileSync(backendLogPath(), 'utf8').match(/renderer process gone/g) || []).length; }
  catch { return 0; }
}

test.describe.configure({ mode: 'serial' });
test.describe('deep interactive coverage', () => {
  let app: ElectronApplication;
  let page: Page;
  let baseline = 0;

  const noNewCrashes = (label: string) => {
    const now = crashCount();
    expect(now, `renderer crashed during: ${label}`).toBe(baseline);
  };

  // Strict, with no opt-out: a missing target FAILS the step so an absent button can
  // never green a build.
  //
  // WAIT, don't sample. This used locator.count(), a point-in-time query with no
  // auto-wait, so it reported 0 for surfaces that mount a moment later and threw
  // "required target not visible" 27ms into a test. The app's own resolver waits 15s
  // for exactly this reason (frontend Onboarding/selectors.ts waitForSelector), so
  // match it.
  const TARGET_TIMEOUT_MS = 15_000;

  // A DOM dump of the running app found none of the targets the legacy tests below
  // reach for. Skipped rather than deleted so the lost coverage stays visible in the
  // report; see the rewritten tests at the bottom of this file for live equivalents.
  const STALE_UI = 'targets an earlier UI generation; the selector is absent from the running app';
  const safeClick = async (locator: Locator, label: string) => {
    await expect(locator.first(), `${label}: required target never became visible`)
      .toBeVisible({ timeout: TARGET_TIMEOUT_MS });
    await locator.first().click({ timeout: 5000 });
  };

  test.beforeAll(async () => {
    app = await launchApp();
    page = await waitForMainWindow(app);
    baseline = crashCount();
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('home renders a usable dashboard', async ({}, info) => {
    await expect(page.locator('[data-onboarding="canvas-controls"]'), 'canvas controls never mounted')
      .toBeVisible({ timeout: TARGET_TIMEOUT_MS });
    // Playwright matches accessible names by substring, so a
    // bare 'Send' also matches the "Send an agent to the web" suggestion chip
    // and `exact: true` rejects the ambiguity.
    await expect(page.getByRole('button', { name: 'Send', exact: true }), 'composer Send button never mounted')
      .toBeVisible({ timeout: TARGET_TIMEOUT_MS });
    await page.screenshot({ path: info.outputPath('home.png') });
    noNewCrashes('home render');
  });

  // The body below still targets the OLD Onboarding panel's top-right "Continue" pill;
  // OnboardingV3 replaced that surface with a full-screen "Welcome." card (OnboardingV3Root IntroBeat)
  // whose only control is an ArrowRight icon carrying no text, aria-label, data-onboarding or data-testid
  // so there is nothing stable to click. launch.ts now seeds onboarding_v3='skipped'
  // so that modal cannot block the rest of this walkthrough, which also means first-run onboarding
  // is not exercised here at all.
  //
  // TODO: give IntroBeat's button an accessible name, then rewrite this against it;
  // ideally as its own fresh-profile spec, since this file runs seeded past onboarding.
  test('onboarding panel opens on Continue', async ({}, info) => {
    test.skip(true, 'OnboardingV3 replaced the Continue pill; its arrow button has no accessible name to target');
    await safeClick(page.getByText(/^Continue/), 'Continue');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: info.outputPath('onboarding-step1.png') });
    noNewCrashes('onboarding step 1 mount');
  });

  test('roadmap (See all todos) renders all 8 steps', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByText('See all todos'), 'See all todos');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath('onboarding-roadmap.png') });
    noNewCrashes('onboarding roadmap mount');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  });

  test('Settings opens and every tab renders', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByText('Settings', { exact: true }), 'Settings nav');
    await page.waitForTimeout(1500);
    for (const tab of ['General', 'Models', 'Usage', 'Commands']) {
      const t = page.getByRole('tab', { name: tab }).first();
      if (await t.count()) {
        await t.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(900);
        await page.screenshot({ path: info.outputPath(`settings-${tab.toLowerCase()}.png`) });
        noNewCrashes(`Settings ${tab} tab`);
      }
    }
    await page.getByText('Close', { exact: true }).first().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(700);
  });

  test('Settings toggles flip + revert (effect verified)', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByText('Settings', { exact: true }), 'Settings nav for toggles');
    await page.waitForTimeout(1500);
    const toggles = page.locator('input[type="checkbox"], [role="switch"]');
    const n = Math.min(await toggles.count(), 5);
    for (let i = 0; i < n; i++) {
      const t = toggles.nth(i);
      const before = await t.isChecked().catch(() => null);
      await t.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(400);
      const after = await t.isChecked().catch(() => null);
      if (before !== null && after !== null) expect(after, `toggle #${i} did not flip`).not.toBe(before);
      await t.click({ timeout: 2000 }).catch(() => {});   // revert
      await page.waitForTimeout(300);
      noNewCrashes(`toggle ${i} flip+revert`);
    }
    await page.screenshot({ path: info.outputPath('settings-toggles.png') });
    await page.getByText('Close', { exact: true }).first().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(700);
  });

  test('Customization: Skills / Actions / Modes render', async ({}, info) => {
    test.skip(true, STALE_UI);
    for (const screen of ['Skills', 'Actions', 'Modes']) {
      await safeClick(page.getByText(screen, { exact: true }), screen);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: info.outputPath(`${screen.toLowerCase()}.png`) });
      noNewCrashes(screen);
    }
  });

  test('Modes editor (RichPromptEditor) opens without TSF crash', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByText('Modes', { exact: true }), 'Modes');
    await page.waitForTimeout(1200);
    // Modes list may be empty on a brand-new profile; this branch is the one
    // legitimate optional in this spec. If a row exists, we drive it strictly.
    const editIcons = page.locator('[aria-label="Edit"], [aria-label*="edit mode" i]');
    if (await editIcons.count()) {
      await editIcons.first().click({ timeout: 3000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: info.outputPath('mode-editor.png') });
      noNewCrashes('RichPromptEditor mount');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(600);
    } else {
      test.info().annotations.push({ type: 'skip', description: 'Modes: no existing modes on clean profile, edit path unreachable' });
    }
  });

  test('Dashboard canvas opens', async ({}, info) => {
    test.skip(true, STALE_UI);
    // A clean CI profile has no "Getting Started" (or any) dashboard, so open an
    // existing one if present, else create one via the sidebar "+" so the canvas
    // actually mounts instead of failing on a missing seed dashboard.
    const seed = page.getByText('Getting Started', { exact: true });
    if (await seed.count()) {
      await seed.first().click({ timeout: 5000 });
    } else {
      const toggle = page.locator('[data-onboarding="sidebar-toggle"]');
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click({ timeout: 5000 }).catch(() => {});
      await page.locator('[data-onboarding="sidebar-dashboards"]').click({ timeout: 5000 }).catch(() => {});
      const createBtn = page.locator('[data-onboarding="sidebar-dashboards"] button').first();
      if (await createBtn.count()) await createBtn.click({ timeout: 5000 }).catch(() => {});
      await expect.poll(() => page.url(), { timeout: 8000 }).toMatch(/\/dashboard\//);
    }
    await page.waitForTimeout(2000);
    await page.screenshot({ path: info.outputPath('dashboard-canvas.png') });
    noNewCrashes('dashboard canvas open');
  });

  test('New Agent compose box opens (EditorSurface contentEditable mount)', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByRole('button', { name: 'New Agent' }), 'New Agent');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: info.outputPath('new-agent-compose.png') });
    noNewCrashes('New Agent compose mount');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  });

  test('Browser card mounts (webview path)', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByRole('button', { name: 'Browser' }), 'Browser');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: info.outputPath('browser-card.png') });
    noNewCrashes('Browser card mount (webview)');
  });

  test('History panel opens', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByRole('button', { name: 'History' }), 'History');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath('history.png') });
    noNewCrashes('History panel mount');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  });

  test('Add App picker opens', async ({}, info) => {
    test.skip(true, STALE_UI);
    await safeClick(page.getByRole('button', { name: 'Add App' }), 'Add App');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath('add-app-picker.png') });
    noNewCrashes('Add App picker mount');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  });

  // ---------------------------------------------------------------------------
  // Rewritten against surfaces the app actually renders today. The tests above
  // were written for an earlier UI generation: a DOM dump of the running app found
  // ZERO of their sixteen targets present (no sidebar nav, no Settings/Skills/
  // Actions/Modes text, no New Agent / Browser / History / Add App buttons, and
  // only 4 of ~25 data-onboarding values from frontend Onboarding/selectors.ts).
  //
  // Each test below asserts an observable STATE CHANGE, not "a screenshot was taken"
  // and not "the renderer survived" -- so each one can name something the app could
  // do wrong that would turn it red.
  // ---------------------------------------------------------------------------

  test('What\'s-new panel dismisses when Got it is clicked', async () => {
    const panel = page.locator('[data-select-type="whats-new"]');
    await expect(panel, 'what\'s-new panel should be on screen for a fresh profile').toBeVisible({ timeout: TARGET_TIMEOUT_MS });
    await safeClick(page.getByRole('button', { name: 'Got it' }), 'Got it');
    // The point of the button: the panel goes away and stays away.
    await expect(panel, 'panel still visible after Got it').toBeHidden({ timeout: 10_000 });
    noNewCrashes('whats-new dismiss');
  });

  test('canvas zoom controls change the zoom readout', async () => {
    const controls = page.locator('[data-onboarding="canvas-controls"]');
    await expect(controls, 'canvas control cluster missing').toBeVisible({ timeout: TARGET_TIMEOUT_MS });
    const before = (await controls.innerText()).trim();
    await safeClick(page.getByRole('button', { name: 'Zoom in' }), 'Zoom in');
    // Zooming has to be observable somewhere. The cluster carries the % readout, so
    // its text must differ; an inert button leaves it identical and fails here.
    await expect
      .poll(async () => (await controls.innerText()).trim(), { timeout: 10_000, message: 'zoom readout unchanged after Zoom in' })
      .not.toBe(before);
    noNewCrashes('canvas zoom in');
  });

  // Deliberately LAST of the live tests. This one currently fails, and in serial mode a
  // failure buries everything after it -- so it sits where it can only cost itself.
  //
  // It is NOT failing on a stale selector. Playwright resolves the button, reports it
  // "visible, enabled and stable", completes a scrollIntoView, and still reports
  // "element is outside of the viewport" on every retry. The dashboard strip scrolls
  // horizontally (see the Scroll spaces left/right controls), so the control is real,
  // labelled, and unreachable by ordinary scrolling.
  //
  // TODO: decide which of these it is, then act.
  //   a) APP BUG -- if the spaces strip scrolls by CSS transform rather than native
  //      scrollTop/scrollLeft, the browser cannot bring the button into view and neither
  //      can a keyboard user tabbing to it. Fix the strip, and this test goes green on
  //      its own with no edit here.
  //   b) TEST GAP -- if the strip IS natively scrollable, drive "Scroll spaces right"
  //      until the button enters the viewport, then click. Assert the scroll happened so
  //      the loop cannot silently spin forever.
  test('New dashboard navigates to a different dashboard', async () => {
    const before = page.url();
    await safeClick(page.getByRole('button', { name: 'New dashboard' }), 'New dashboard');
    // A new board means a new route. Asserting the URL CHANGED (not merely that it
    // still looks like a dashboard URL) is what makes this fail if the button is inert.
    await expect
      .poll(() => page.url(), { timeout: 15_000, message: 'URL never changed after New dashboard' })
      .not.toBe(before);
    expect(page.url(), 'left the dashboard route entirely').toMatch(/\/dashboard\//);
    noNewCrashes('new dashboard');
  });

  test('zero new renderer-gone-lines across the entire walkthrough', () => {
    expect(crashCount(), 'one or more surfaces crashed the renderer; check earlier test annotations').toBe(baseline);
  });
});
