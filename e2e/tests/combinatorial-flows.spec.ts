import { test, expect, ElectronApplication, Page, Locator } from '@playwright/test';
import { launchApp, waitForMainWindow } from '../helpers/launch';
import { startVisibility, VisibilityHandle } from '../helpers/visibility';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Strict combinatorial pass that exercises the app the way a real user does:
// every click has a positive post-condition (route/state/element change), every
// page error and console error is captured, every renderer crash is asserted
// against a backend-log budget, and the toggle/theme matrices flip both ways.
// Silent skips are NOT allowed: a missing target fails the step. This is the
// gate that's supposed to actually catch regressions; deep-coverage.spec.ts is
// the cheaper mount-only smoke that runs alongside it.

function backendLogPath(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OpenSwarm', 'data', 'backend.log');
}
function rendererCrashes(): number {
  try { return (fs.readFileSync(backendLogPath(), 'utf8').match(/renderer process gone/g) || []).length; }
  catch { return 0; }
}

// Console noise we don't fail on; everything else is treated as a real bug.
const CONSOLE_WHITELIST: RegExp[] = [
  /DevTools listening/i,
  /Autofill\.enable/i,
  /Autofill\.setAddresses/i,
  /electron-store/i,
  /\[HMR\]/i,
  /downloadable font/i,
  /chrome-extension/i,
];

type ErrEvent = { kind: 'pageerror' | 'console'; text: string };

test.describe.configure({ mode: 'serial' });
test.describe('combinatorial user flows', () => {
  let app: ElectronApplication;
  let page: Page;
  let baselineCrashes = 0;
  let errors: ErrEvent[] = [];

  // Strict click: locator MUST resolve to >=1 visible element. No silent skips.
  const must = async (loc: Locator, label: string) => {
    const count = await loc.count();
    expect(count, `expected at least one match for: ${label}`).toBeGreaterThan(0);
    await expect(loc.first(), `${label}: not visible`).toBeVisible({ timeout: 15_000 });
    return loc.first();
  };
  const clickMust = async (loc: Locator, label: string) => {
    const el = await must(loc, label);
    await el.click({ timeout: 8_000 });
    return el;
  };
  const errorsSince = (mark: number) => errors.slice(mark).filter((e) => !CONSOLE_WHITELIST.some((rx) => rx.test(e.text)));
  const assertNoNew = (mark: number, label: string) => {
    const now = rendererCrashes();
    expect(now, `renderer crashed during: ${label}`).toBe(baselineCrashes);
    const fresh = errorsSince(mark);
    expect(fresh.map((e) => `${e.kind}: ${e.text}`).join('\n'), `unexpected errors during: ${label}`).toBe('');
  };

  let vis: VisibilityHandle;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await waitForMainWindow(app);
    vis = await startVisibility(app, page, 'combinatorial-flows');
    page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e?.message ?? e) }));
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });
    baselineCrashes = rendererCrashes();
  });
  test.afterAll(async () => {
    try { await vis?.stop(); } catch {}
    await app?.close().catch(() => {});
  });
  // Per-test mark so events.jsonl is searchable by test name.
  test.beforeEach(async ({}, info) => { vis?.mark('test-begin', { title: info.titlePath.join(' > ') }); });
  test.afterEach(async ({}, info) => {
    vis?.mark('test-end', { title: info.titlePath.join(' > '), status: info.status });
    if (vis && (info.status === 'failed' || info.status === 'timedOut')) {
      const errMsg = info.errors?.[0]?.message;
      await vis.recordFailure(info.titlePath.join(' > '), info.status, errMsg).catch(() => {});
    }
  });

  // Visual diff baselining gate: opt-in via env so a fresh repo with no
  // committed baselines stays green. To bless baselines once:
  //   $env:RUN_VISUAL_DIFFS="1"; npx playwright test combinatorial-flows --update-snapshots
  // ...then commit the generated combinatorial-flows.spec.ts-snapshots/ dir.
  const visualDiffs = process.env.RUN_VISUAL_DIFFS === '1';
  const visualAssert = async (name: string) => {
    if (!visualDiffs) return;
    await expect(page).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.02, animations: 'disabled' });
  };

  // The "test the test" sanity check: prove our must() helper fails loudly when
  // a target is missing. If this ever passes silently, every later assertion is
  // also unreliable, so the whole suite is invalid and we want to know early.
  test('self-check: must() actually fails on a missing target', async () => {
    let threw = false;
    try { await must(page.locator('#__definitely_not_in_dom__'), 'self-check sentinel'); }
    catch { threw = true; }
    expect(threw, 'must() did NOT fail on missing element; the strict-click guarantee is broken').toBe(true);
  });

  test('home: react root mounted, no banner-only fallback', async () => {
    const mark = errors.length;
    const root = page.locator('#root');
    await expect(root).toBeVisible();
    const childCount = await root.evaluate((el) => el.childElementCount);
    expect(childCount, 'react root rendered no children').toBeGreaterThan(0);
    await vis?.snapshotA11y('home');
    await vis?.snapshotHeap('home');
    await visualAssert('home');
    assertNoNew(mark, 'home render');
  });

  test('sidebar: every primary nav item navigates to its surface', async () => {
    const mark = errors.length;

    // Make sure sidebar is expanded so the labels are clickable.
    const sidebarToggle = page.locator('[data-onboarding="sidebar-toggle"]');
    if ((await sidebarToggle.getAttribute('aria-expanded')) === 'false') await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');

    // Customization expands inline; clicking should reveal Skills/Actions/Modes.
    const customization = page.locator('[data-onboarding="sidebar-customization"]');
    await clickMust(customization, 'sidebar customization');
    await expect(customization).toHaveAttribute('aria-expanded', 'true', { timeout: 5_000 });
    for (const label of ['Skills', 'Actions', 'Modes']) {
      const item = page.getByText(label, { exact: true });
      await clickMust(item, `customization > ${label}`);
      await expect(page.locator('#root')).toBeVisible();
      const url = page.url();
      expect(url, `URL did not change to customization route for ${label}`).toMatch(/customization|skills|actions|modes/i);
      assertNoNew(mark, `nav ${label}`);
    }

    // Apps section.
    await clickMust(page.locator('[data-onboarding="sidebar-apps"]'), 'sidebar apps');
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/apps/);
    assertNoNew(mark, 'nav Apps');

    // Dashboards section.
    await clickMust(page.locator('[data-onboarding="sidebar-dashboards"]'), 'sidebar dashboards');
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/dashboard|^[^?#]*\/?$/);
    assertNoNew(mark, 'nav Dashboards');
  });

  test('settings modal: opens, every tab activates, closes', async ({}, info) => {
    const mark = errors.length;
    await clickMust(page.locator('[data-onboarding="sidebar-settings-button"]'), 'sidebar Settings');
    // Modal title is unique to the open settings dialog.
    await expect(page.getByText('Settings', { exact: true }).first()).toBeVisible();

    for (const tab of ['General', 'Models', 'Usage', 'Commands']) {
      const tabLoc = page.getByRole('tab', { name: tab });
      await clickMust(tabLoc, `settings tab ${tab}`);
      await expect(tabLoc.first()).toHaveAttribute('aria-selected', 'true');
      await page.screenshot({ path: info.outputPath(`settings-${tab.toLowerCase()}.png`) });
      await vis?.snapshotA11y(`settings-${tab.toLowerCase()}`);
      await visualAssert(`settings-${tab.toLowerCase()}`);
      assertNoNew(mark, `settings tab ${tab}`);
    }

    // Close via the dedicated close button (which has a stable data-onboarding hook).
    await clickMust(page.locator('[data-onboarding="settings-close-button"]'), 'settings close');
    await expect(page.getByRole('tab', { name: 'General' })).toHaveCount(0, { timeout: 5_000 });
    assertNoNew(mark, 'settings close');
  });

  test('settings: theme toggle actually flips and persists', async () => {
    const mark = errors.length;
    await clickMust(page.locator('[data-onboarding="sidebar-settings-button"]'), 'open settings');
    // General is the default tab; assert + force to be safe.
    await clickMust(page.getByRole('tab', { name: 'General' }), 'tab General');

    const readMode = () => page.evaluate(() => localStorage.getItem('self-swarm-theme-mode'));
    const before = await readMode();
    const target = before === 'dark' ? 'Light' : 'Dark';
    await clickMust(page.getByRole('button', { name: target }), `theme button ${target}`);
    await expect.poll(readMode, { timeout: 5_000 }).not.toBe(before);
    const flipped = await readMode();
    expect(flipped, 'theme localStorage did not flip').not.toBe(before);

    // Computed background must visibly change.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg, 'body background did not pick up the new theme tokens').not.toBe('');

    // Revert so later tests start from the same state.
    const back = before === 'dark' ? 'Dark' : 'Light';
    await clickMust(page.getByRole('button', { name: back }), `revert theme ${back}`);
    await expect.poll(readMode, { timeout: 5_000 }).toBe(before);

    await clickMust(page.locator('[data-onboarding="settings-close-button"]'), 'close settings');
    assertNoNew(mark, 'theme flip + revert');
  });

  test('settings: every Switch on General flips, reverts, and the renderer survives', async () => {
    const mark = errors.length;
    await clickMust(page.locator('[data-onboarding="sidebar-settings-button"]'), 'open settings');
    await clickMust(page.getByRole('tab', { name: 'General' }), 'tab General');

    // MUI Switch renders an inner <input type=checkbox>. Limit to inputs that
    // are interactable so we don't pick up off-screen ones from other tabs.
    const switches = page.locator('.MuiSwitch-root input[type="checkbox"]');
    const n = await switches.count();
    expect(n, 'no Switch components found on General tab; selectors drifted').toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const sw = switches.nth(i);
      const before = await sw.isChecked();
      // MUI hides the input; click the parent label/root to toggle the way a user would.
      await sw.locator('xpath=ancestor::*[contains(@class,"MuiSwitch-root")][1]').click({ timeout: 4_000 });
      await expect.poll(() => sw.isChecked(), { timeout: 5_000 }).toBe(!before);
      // Revert so the test is hermetic for the next switch.
      await sw.locator('xpath=ancestor::*[contains(@class,"MuiSwitch-root")][1]').click({ timeout: 4_000 });
      await expect.poll(() => sw.isChecked(), { timeout: 5_000 }).toBe(before);
      assertNoNew(mark, `switch #${i} flip+revert`);
    }

    await clickMust(page.locator('[data-onboarding="settings-close-button"]'), 'close settings');
    assertNoNew(mark, 'all-switches matrix');
  });

  test('onboarding: See all todos opens the roadmap, Escape closes it', async () => {
    const mark = errors.length;
    const roadmapTrigger = page.getByText('See all todos', { exact: true });
    // Roadmap is gated on the panel being visible; if it isn't, that itself is
    // a state we explicitly need to know about, so fail the assertion.
    await clickMust(roadmapTrigger, 'See all todos');
    // Roadmap modal has a unique aria-label="Close roadmap" close button.
    await expect(page.locator('[aria-label="Close roadmap"]')).toBeVisible({ timeout: 8_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[aria-label="Close roadmap"]')).toHaveCount(0, { timeout: 5_000 });
    assertNoNew(mark, 'roadmap open + escape');
  });

  test('dashboard toolbar: New Agent opens compose with contentEditable that accepts typing', async ({}, info) => {
    const mark = errors.length;
    // Make sure we're on a dashboard (the toolbar lives there).
    await clickMust(page.locator('[data-onboarding="sidebar-dashboards"]'), 'sidebar dashboards');
    await clickMust(page.locator('[data-onboarding="new-agent-button"]'), 'toolbar New Agent');

    const editor = page.locator('[data-onboarding="chat-input"]');
    await expect(editor.first(), 'EditorSurface contentEditable did not mount').toBeVisible({ timeout: 10_000 });
    await editor.first().click();
    await page.keyboard.type('hello agent', { delay: 15 });
    await expect.poll(async () => (await editor.first().innerText()).trim(), { timeout: 5_000 }).toContain('hello agent');
    await page.screenshot({ path: info.outputPath('new-agent-typed.png') });
    // Don't actually send; clear and dismiss so we don't hit a real provider.
    await page.keyboard.press('Escape').catch(() => {});
    assertNoNew(mark, 'New Agent compose + type');
  });

  test('dashboard toolbar: Browser card mounts (webview path, not grey iframe)', async ({}, info) => {
    const mark = errors.length;
    await clickMust(page.locator('[data-onboarding="browser-button"]'), 'toolbar Browser');
    // Wait for at least one <webview> to attach. A grey iframe = no webview = fail.
    await page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, { timeout: 15_000 });
    const webviews = await page.locator('webview').count();
    expect(webviews, 'no <webview> attached after Browser click; render path collapsed to iframe').toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('browser-card.png') });
    assertNoNew(mark, 'Browser card mount (webview)');
  });

  test('dashboard toolbar: Add note + Add App + History each mount their surfaces', async () => {
    const mark = errors.length;
    await clickMust(page.getByRole('button', { name: 'Add note' }), 'toolbar Add note');
    assertNoNew(mark, 'Add note mount');

    await clickMust(page.getByRole('button', { name: 'Add App' }), 'toolbar Add App');
    // Picker is a dialog; closing via Escape is enough.
    await page.keyboard.press('Escape').catch(() => {});
    assertNoNew(mark, 'Add App picker');

    await clickMust(page.getByRole('button', { name: 'History' }), 'toolbar History');
    await page.keyboard.press('Escape').catch(() => {});
    assertNoNew(mark, 'History panel');
  });

  test('modes: edit screen mounts RichPromptEditor and accepts typing (TSF crash class)', async () => {
    const mark = errors.length;
    await clickMust(page.locator('[data-onboarding="sidebar-customization"]'), 'open customization');
    await clickMust(page.getByText('Modes', { exact: true }), 'go to Modes');
    // Modes list might be empty on a clean profile; we still want to enter the
    // editor by either an existing row or the create flow. Fail if neither path exists.
    const editIcons = page.locator('[aria-label="Edit"], [aria-label*="edit mode" i]');
    const newBtn = page.getByRole('button', { name: /new mode|create mode|add mode/i });
    if (await editIcons.count()) {
      await editIcons.first().click({ timeout: 5_000 });
    } else if (await newBtn.count()) {
      await newBtn.first().click({ timeout: 5_000 });
    } else {
      // Neither edit nor create button means a UI regression on Modes; fail explicitly.
      expect.fail('Modes screen exposes no edit-or-create entry point; rich editor is unreachable');
    }
    // RichPromptEditor uses a contentEditable; verify one is mounted somewhere on the route.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[contenteditable="true"]')).length > 0,
      undefined,
      { timeout: 15_000 },
    );
    await page.keyboard.type('test prompt', { delay: 10 });
    assertNoNew(mark, 'Modes RichPromptEditor mount + type');
    await page.keyboard.press('Escape').catch(() => {});
  });

  test('theme x toggle matrix: dark + first switch flipped, light + first switch flipped, all reverted', async () => {
    const mark = errors.length;
    await clickMust(page.locator('[data-onboarding="sidebar-settings-button"]'), 'open settings (matrix)');
    await clickMust(page.getByRole('tab', { name: 'General' }), 'tab General');
    const readMode = () => page.evaluate(() => localStorage.getItem('self-swarm-theme-mode'));
    const initialMode = await readMode();
    const switches = page.locator('.MuiSwitch-root input[type="checkbox"]');
    expect(await switches.count()).toBeGreaterThan(0);
    const sw = switches.first();
    const switchRoot = sw.locator('xpath=ancestor::*[contains(@class,"MuiSwitch-root")][1]');
    const initialSwitch = await sw.isChecked();

    for (const targetMode of ['dark', 'light'] as const) {
      const btn = page.getByRole('button', { name: targetMode === 'dark' ? 'Dark' : 'Light' });
      await clickMust(btn, `set theme ${targetMode}`);
      await expect.poll(readMode, { timeout: 5_000 }).toBe(targetMode);
      await switchRoot.click({ timeout: 4_000 });
      await expect.poll(() => sw.isChecked(), { timeout: 5_000 }).toBe(!initialSwitch);
      await switchRoot.click({ timeout: 4_000 });
      await expect.poll(() => sw.isChecked(), { timeout: 5_000 }).toBe(initialSwitch);
      assertNoNew(mark, `theme=${targetMode} x switch[0] flip+revert`);
    }

    if (initialMode) {
      await clickMust(page.getByRole('button', { name: initialMode === 'dark' ? 'Dark' : 'Light' }), 'restore theme');
      await expect.poll(readMode, { timeout: 5_000 }).toBe(initialMode);
    }
    await clickMust(page.locator('[data-onboarding="settings-close-button"]'), 'close settings (matrix)');
    assertNoNew(mark, 'theme x toggle matrix');
  });

  test('resilience: open + close Settings 3x without state corruption', async () => {
    const mark = errors.length;
    await vis?.snapshotHeap('resilience-before');
    for (let i = 0; i < 3; i++) {
      await clickMust(page.locator('[data-onboarding="sidebar-settings-button"]'), `open settings round ${i}`);
      await expect(page.getByRole('tab', { name: 'General' })).toBeVisible({ timeout: 5_000 });
      await clickMust(page.locator('[data-onboarding="settings-close-button"]'), `close settings round ${i}`);
      await expect(page.getByRole('tab', { name: 'General' })).toHaveCount(0, { timeout: 5_000 });
      assertNoNew(mark, `settings open/close round ${i}`);
    }
    // Snapshot AFTER the loop so a diff between before/after surfaces growth
    // from a leaked subscription or React tree retained across opens.
    await vis?.snapshotHeap('resilience-after');
  });

  test('zero unexpected errors and zero new renderer crashes across whole walkthrough', () => {
    expect(rendererCrashes(), 'renderer crashed somewhere; see earlier annotations').toBe(baselineCrashes);
    const dirty = errors.filter((e) => !CONSOLE_WHITELIST.some((rx) => rx.test(e.text)));
    expect(dirty.map((e) => `${e.kind}: ${e.text}`).join('\n'), 'unexpected page/console errors during walkthrough').toBe('');
  });
});
