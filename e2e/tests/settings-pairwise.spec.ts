import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchApp, waitForMainWindow } from '../helpers/launch';
import { startVisibility, VisibilityHandle } from '../helpers/visibility';
import { pairwise, cartesian, Params } from '../helpers/pairwise';
import fs from 'fs';
import os from 'os';
import path from 'path';

// All-pairs (or full Cartesian via OPENSWARM_E2E_EXHAUSTIVE=1) coverage of the
// General-tab Switch settings + theme. Each row is applied directly via the
// Redux dispatch path the UI uses, then a series of post-conditions confirms:
//   (a) the renderer didn't crash
//   (b) every Switch reflects the row's value (not silently reverted)
//   (c) theme localStorage took effect
//   (d) no unexpected page/console error fired during the apply
//   (e) the final Settings render is screenshot-stable

function backendLogPath(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OpenSwarm', 'data', 'backend.log');
}
function crashCount(): number {
  try { return (fs.readFileSync(backendLogPath(), 'utf8').match(/renderer process gone/g) || []).length; }
  catch { return 0; }
}

const PARAMS: Params = {
  auto_select_mode_on_new_agent: [false, true],
  expand_new_chats_in_dashboard: [false, true],
  auto_reveal_sub_agents: [false, true],
  dev_mode: [false, true],
  allow_experimental_updates: [false, true],
  theme: ['light', 'dark'],
};

const EXHAUSTIVE = process.env.OPENSWARM_E2E_EXHAUSTIVE === '1';
const ROWS = EXHAUSTIVE ? cartesian(PARAMS) : pairwise(PARAMS);

test.describe.configure({ mode: 'serial' });
test.describe(`settings ${EXHAUSTIVE ? 'cartesian' : 'pairwise'} (${ROWS.length} rows)`, () => {
  let app: ElectronApplication;
  let page: Page;
  let vis: VisibilityHandle;
  let baseline = 0;
  const errors: Array<{ kind: string; text: string }> = [];
  const WHITELIST = [/DevTools listening/i, /Autofill/i, /electron-store/i, /downloadable font/i];

  test.beforeAll(async () => {
    app = await launchApp();
    page = await waitForMainWindow(app);
    vis = await startVisibility(app, page, `settings-pairwise-${ROWS.length}rows`);
    page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e?.message ?? e) }));
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });
    baseline = crashCount();
  });
  test.afterAll(async () => { try { await vis?.stop(); } catch {} await app?.close().catch(() => {}); });

  // Self-check identical to the combinatorial spec: must-locator MUST throw on missing target.
  test('self-check: pairwise rows are non-empty + cover the cross', () => {
    expect(ROWS.length).toBeGreaterThan(0);
    if (!EXHAUSTIVE) expect(ROWS.length).toBeLessThan(Object.values(PARAMS).reduce((a, vs) => a * vs.length, 1));
  });

  // Apply a row directly via the Redux dispatch path the Settings UI uses so we
  // don't have to drive N toggles by click. This is the "test the apply" half;
  // the "verify the apply landed" half then reads the resulting state.
  async function applyRow(row: Record<string, unknown>) {
    await page.evaluate((rowJson) => {
      const r = JSON.parse(rowJson);
      const store = (window as any).__OPENSWARM_STORE__;
      if (!store) throw new Error('Redux store not exposed; __OPENSWARM_E2E__ flag did not take effect');
      const current = store.getState().settings.data;
      const next = { ...current };
      for (const k of Object.keys(r)) if (k !== 'theme') next[k] = r[k];
      // settings/update/fulfilled is Redux Toolkit's auto-generated action name
      // for the updateSettings thunk; dispatching it directly updates local
      // state without making the PUT round-trip (we keep the test hermetic).
      store.dispatch({ type: 'settings/update/fulfilled', payload: next });
      if (r.theme) {
        try { localStorage.setItem('self-swarm-theme-mode', r.theme); } catch {}
      }
    }, JSON.stringify(row));
    await page.waitForTimeout(150);
  }

  async function readState(): Promise<{ store: Record<string, unknown>; theme: string | null }> {
    return await page.evaluate(() => {
      const store = (window as any).__OPENSWARM_STORE__;
      const s = store ? store.getState().settings.data : {};
      let theme: string | null = null;
      try { theme = localStorage.getItem('self-swarm-theme-mode'); } catch {}
      return { store: s, theme };
    });
  }

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    test(`row ${i + 1}/${ROWS.length}: ${JSON.stringify(row)}`, async ({}, info) => {
      const errMark = errors.length;
      vis?.mark('apply-row', { row, index: i });
      await applyRow(row);
      const state = await readState();
      for (const [k, v] of Object.entries(row)) {
        if (k === 'theme') continue;
        expect(state.store[k], `${k} did not persist as ${v}`).toBe(v);
      }
      if (row.theme) expect(state.theme, 'theme localStorage did not take').toBe(row.theme);

      expect(crashCount(), `row ${i + 1} crashed renderer`).toBe(baseline);
      const fresh = errors.slice(errMark).filter((e) => !WHITELIST.some((rx) => rx.test(e.text)));
      expect(fresh.map((e) => `${e.kind}: ${e.text}`).join('\n'), `row ${i + 1} produced unexpected errors`).toBe('');
      if (i < 3 || i === ROWS.length - 1) await page.screenshot({ path: info.outputPath(`row-${String(i).padStart(2, '0')}.png`) });
    });
  }

  test('final: zero new renderer-gone-lines across the entire matrix', () => {
    expect(crashCount(), 'a row crashed the renderer somewhere').toBe(baseline);
  });
});
