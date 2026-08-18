import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { api, bootIntoDashboard, closeSettingsCard, openSettingsCard } from './support';

// Characterization of the workflow and settings claims in the 1.7.4-1.7.7 release notes, against the
// packaged backend and the Settings window. No provider key: an off or deleted workflow is refused
// before anything would spawn, and memory / dictation defaults are plain state.
test.describe.configure({ mode: 'serial' });
test.describe('characterization: workflows and settings (1.7.4-1.7.7)', () => {
  let app: ElectronApplication;
  let win: Page;
  let dashboardId: string;
  const workflowIds: string[] = [];
  const factIds: string[] = [];

  test.beforeAll(async () => {
    ({ app, win, dashboardId } = await bootIntoDashboard());
  });
  test.afterAll(async () => {
    for (const id of workflowIds) {
      await api(win, `/workflows/${id}`, { method: 'DELETE' }).catch(() => {});
      await api(win, `/workflows/${id}/purge`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of factIds) await api(win, `/memory/${id}`, { method: 'DELETE' }).catch(() => {});
    await app?.close().catch(() => {});
  });

  // A schedule that is fully configured (so "on" really means on) but will not fire during the test.
  const schedule = (enabled: boolean) => ({ enabled, repeat_every: 12, repeat_unit: 'month', hour: 3, minute: 0, day_of_month: 1 });

  // A workflow with one real step and that schedule.
  async function createWorkflow(title: string, enabled: boolean): Promise<string> {
    const { status, body } = await api<{ id: string }>(win, '/workflows/create', {
      method: 'POST',
      body: {
        title, auto_named: false, unsaved: false, dashboard_id: dashboardId,
        steps: [{ text: 'Say hello and stop.', enabled: true }],
        schedule: schedule(enabled),
      },
    });
    expect(status, `workflows/create ${title}`).toBe(200);
    workflowIds.push(body.id);
    return body.id;
  }

  test('1.7.5 H2: switching a workflow off stops everything — Run Now is refused and the refusal shows in History', async () => {
    const id = await createWorkflow('Characterization: switched off', true);
    const patched = await api<{ schedule: { enabled: boolean } }>(win, `/workflows/${id}`, { method: 'PATCH', body: { schedule: schedule(false) } });
    expect(patched.status).toBe(200);
    expect(patched.body.schedule.enabled).toBe(false);
    const run = await api<{ run_id: string; status: string | null; error: string | null }>(win, `/workflows/${id}/run`, { method: 'POST', body: {} });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('skipped');
    expect(run.body.error).toMatch(/paused/i);
    // Recorded, not just returned: a refusal the user cannot see in History reads as the run vanishing.
    const { body: history } = await api<{ runs: Array<{ status: string; error: string | null; triggered_by: string }> }>(win, `/workflows/${id}/runs`);
    expect(history.runs.some((r) => r.status === 'skipped' && /paused/i.test(r.error ?? '') && r.triggered_by === 'manual')).toBe(true);
    // Turn it back on: the same route now admits the run (no key here, so it fails downstream, but it is no longer refused as paused).
    const reenabled = await api<{ schedule: { enabled: boolean } }>(win, `/workflows/${id}`, { method: 'PATCH', body: { schedule: schedule(true) } });
    expect(reenabled.body.schedule.enabled).toBe(true);
    const admitted = await api<{ status: string | null; error: string | null }>(win, `/workflows/${id}/run`, { method: 'POST', body: {} });
    expect(admitted.status).toBe(200);
    expect(admitted.body.error ?? '').not.toMatch(/paused/i);
  });

  test('1.7.5 H1: deleting a scheduled workflow makes it stay deleted — it cannot run from Run Now', async () => {
    const id = await createWorkflow('Characterization: deleted', true);
    const del = await api(win, `/workflows/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const run = await api<{ detail: string }>(win, `/workflows/${id}/run`, { method: 'POST', body: {} });
    expect(run.status).toBe(409);
    expect(run.body.detail).toMatch(/Trash/i);
    // It is in the trash, not resurrected into the live list.
    const { body: deleted } = await api<{ workflows?: Array<{ id: string }> } | Array<{ id: string }>>(win, '/workflows/deleted');
    const deletedIds = Array.isArray(deleted) ? deleted.map((w) => w.id) : (deleted.workflows ?? []).map((w) => w.id);
    expect(deletedIds).toContain(id);
    const { body: live } = await api<{ workflows?: Array<{ id: string }> } | Array<{ id: string }>>(win, '/workflows/list');
    const liveIds = Array.isArray(live) ? live.map((w) => w.id) : (live.workflows ?? []).map((w) => w.id);
    expect(liveIds).not.toContain(id);
  });

  test('1.7.7 H1: a fact you save in Settings → Memory is the whole memory, visible and editable', async () => {
    const text = `Characterization fact ${Date.now()}`;
    await openSettingsCard(win, 'memory');
    const input = win.getByPlaceholder('Add a fact agents should always know (Enter to save)');
    await expect(input).toBeVisible({ timeout: 15_000 });
    // The renderer serves identical GETs from a 1s cache; the panel's post-save refresh must not land
    // inside the window of the panel's own mount fetch, so let that second pass before typing.
    await win.waitForTimeout(1500);
    // Typed the way a hand types it: the draft is React state, and Enter reads it on the next commit.
    await input.click();
    await win.keyboard.type(text, { delay: 10 });
    await win.keyboard.press('Enter');
    // The window shows the saved fact (its own refresh runs the moment the save lands).
    await expect(win.locator('[data-select-type="settings-card"]').getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 });
    // And the list is the API's list: nothing hidden behind it.
    const { body } = await api<{ facts: Array<{ id: string; text: string; source: string }> }>(win, '/memory');
    const fact = body.facts.find((f) => f.text === text);
    expect(fact, 'the saved fact is in the memory store').toBeTruthy();
    expect(fact!.source).toBe('user');
    factIds.push(fact!.id);
    await closeSettingsCard(win);
  });

  test('1.7.4 F2: dictation cue sounds default to an audible level (70%)', async () => {
    await openSettingsCard(win, 'dictation');
    const row = win.locator('[data-select-id="dictation_sounds"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    const slider = row.getByRole('slider');
    await expect(slider).toHaveAttribute('aria-valuenow', '70');
    await closeSettingsCard(win);
  });
});
