import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { bootIntoDashboard, closeSettingsCard, dispatch, openSettingsCard, paintedCamera, select } from './support';

// Characterization of the canvas / window-state claims in the 1.7.4-1.7.7 release notes
// (backend/apps/help/changelog.py), against the PACKAGED app with no provider key. Each test names
// the changelog line it pins. These are regression nets for the files that carry the behaviour
// (dashboardLayoutSlice, the canvas cards, the shell's dashboard host), so a later refactor of any of
// them has to keep the user-visible claim true, not just compile.
test.describe.configure({ mode: 'serial' });
test.describe('characterization: canvas, fullscreen, layout (1.7.4-1.7.7)', () => {
  let app: ElectronApplication;
  let win: Page;
  let dashboardId: string;

  test.beforeAll(async () => {
    ({ app, win, dashboardId } = await bootIntoDashboard());
  });
  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('1.7.4 H2: the spawn composer steps aside when a window is open', async () => {
    // Fresh dashboard, no sessions: the empty-state hero (with the composer) is the page.
    const hero = win.getByText('What do you want done?').first();
    await expect(hero).toBeVisible({ timeout: 15_000 });
    await openSettingsCard(win);
    await expect(hero).toBeHidden({ timeout: 10_000 });
    await closeSettingsCard(win);
    await expect(hero).toBeVisible({ timeout: 10_000 });
  });

  test('1.7.5 H3: a wheel inside a window stays in that window; over the canvas it drives the canvas', async () => {
    await openSettingsCard(win);
    const card = win.locator('[data-select-type="settings-card"]');
    await expect(card).toBeVisible();
    // Let the open-pan finish so the "before" camera is the resting one.
    await win.waitForTimeout(800);
    const before = await paintedCamera(win);
    const box = (await card.boundingBox())!;
    // Wheel over the body of the window (below its 42px header), a few notches each way.
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.wheel(0, 240);
    await win.mouse.wheel(0, -120);
    await win.waitForTimeout(400);
    expect(await paintedCamera(win), 'a wheel inside a window must not move the canvas').toBe(before);
    // Same gesture over empty canvas: the camera moves (mouse notch = zoom, trackpad = pan; either way it changes).
    const viewport = (await win.locator('[data-canvas-viewport]').boundingBox())!;
    const emptyX = Math.min(viewport.x + 60, box.x - 30 > viewport.x ? box.x - 30 : viewport.x + 60);
    await win.mouse.move(emptyX, viewport.y + viewport.height - 80);
    await win.mouse.wheel(0, 240);
    await expect.poll(() => paintedCamera(win), { timeout: 5000 }).not.toBe(before);
    await closeSettingsCard(win);
  });

  test('1.7.5 F1: the default canvas paints a flat wash, not an image texture that can drop', async () => {
    const wash = await win.evaluate(() => {
      const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement;
      const cs = getComputedStyle(viewport);
      return { backgroundImage: cs.backgroundImage, hasImgChild: !!viewport.querySelector(':scope > img') };
    });
    expect(wash.backgroundImage.includes('url(')).toBe(false);
    expect(wash.hasImgChild).toBe(false);
  });

  test('1.7.7 F11: nothing drags while a window is fullscreen, and canvas panning is locked', async () => {
    await openSettingsCard(win);
    await dispatch(win, { type: 'dashboardLayout/setTiledCard', payload: { cardId: 'settings', zone: 'fullscreen' } });
    const card = win.locator('[data-select-type="settings-card"]');
    await expect.poll(() => select(win, (s) => s.dashboardLayout.tiledCards.settings), { timeout: 5000 }).toBe('fullscreen');
    await win.waitForTimeout(900);
    const before = (await card.boundingBox())!;
    const cameraBefore = await paintedCamera(win);
    // A header drag (the strip above the traffic lights): in fullscreen this must be a no-op.
    await win.mouse.move(before.x + before.width / 2, before.y + 20);
    await win.mouse.down();
    for (let i = 1; i <= 8; i++) await win.mouse.move(before.x + before.width / 2 + i * 30, before.y + 20 + i * 15);
    await win.mouse.up();
    await win.waitForTimeout(500);
    const after = (await card.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    expect(await select(win, (s) => s.dashboardLayout.tiledCards.settings)).toBe('fullscreen');
    // A drag on the canvas itself is also inert while a window is fullscreen (drag joined the wheel gate).
    await win.mouse.move(before.x + 4, before.y + before.height - 4);
    await win.mouse.down();
    await win.mouse.move(before.x + 200, before.y + before.height - 60, { steps: 6 });
    await win.mouse.up();
    await win.waitForTimeout(400);
    expect(await paintedCamera(win)).toBe(cameraBefore);
    // Escape is one of the sanctioned exits.
    await win.keyboard.press('Escape');
    await expect.poll(() => select(win, (s) => s.dashboardLayout.tiledCards.settings ?? null), { timeout: 5000 }).toBeNull();
    await closeSettingsCard(win);
  });

  test('1.7.7 F11: there is exactly one fullscreen owner, ever, and a removed owner leaves no stuck fullscreen', async () => {
    // Two browser cards through the app's own reducer.
    await dispatch(win, { type: 'dashboardLayout/addBrowserCard', payload: { url: 'about:blank' } });
    await dispatch(win, { type: 'dashboardLayout/addBrowserCard', payload: { url: 'about:blank' } });
    const ids = await select(win, (s) => Object.keys(s.dashboardLayout.browserCards));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const [a, b] = ids.slice(-2);
    const owners = () => select(win, (s) => Object.entries(s.dashboardLayout.tiledCards as Record<string, string>).filter(([, z]) => z === 'fullscreen').map(([id]) => id));
    await dispatch(win, { type: 'dashboardLayout/setTiledCard', payload: { cardId: a, zone: 'fullscreen' } });
    expect(await owners()).toEqual([a]);
    // Crowning a second owner dethrones the first: two entries would fight over who hides the chrome and who gets the Escape.
    await dispatch(win, { type: 'dashboardLayout/setTiledCard', payload: { cardId: b, zone: 'fullscreen' } });
    expect(await owners()).toEqual([b]);
    // Removing the owner must not strand a chromeless shell.
    await dispatch(win, { type: 'dashboardLayout/removeBrowserCard', payload: b });
    await expect.poll(owners, { timeout: 5000 }).toEqual([]);
    // A tile request for a card that no longer exists is refused outright (the rail defers its dispatch, so the card can be gone by then).
    await dispatch(win, { type: 'dashboardLayout/setTiledCard', payload: { cardId: b, zone: 'fullscreen' } });
    expect(await owners()).toEqual([]);
    // Leave the profile as we found it.
    await dispatch(win, { type: 'dashboardLayout/removeBrowserCard', payload: a });
    await expect(win.locator('[data-onboarding="settings-close-button"]')).toHaveCount(0);
  });

  test('1.7.7 F14: dock tiles for apps and browsers are images or glyphs, never letters', async () => {
    await dispatch(win, { type: 'dashboardLayout/addBrowserCard', payload: { url: 'about:blank' } });
    const id = (await select(win, (s) => Object.keys(s.dashboardLayout.browserCards))).at(-1)!;
    const tiles = win.locator('[data-desktop-dock] [aria-label]');
    await expect.poll(() => tiles.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const audit = await win.evaluate(() =>
      Array.from(document.querySelectorAll('[data-desktop-dock] [aria-label]')).map((tile) => ({
        label: tile.getAttribute('aria-label') || '',
        pictorial: tile.querySelectorAll('img, svg').length > 0,
        // Any bare glyph text would be a letter/number standing in for the mark.
        looseText: (tile as HTMLElement).innerText.replace(/\s+/g, ''),
      })),
    );
    for (const tile of audit) {
      expect(tile.pictorial, `${tile.label}: tile must carry an image or glyph`).toBe(true);
      expect(tile.looseText, `${tile.label}: no letters or numbers as the mark`).toBe('');
    }
    await dispatch(win, { type: 'dashboardLayout/removeBrowserCard', payload: id });
  });
});
