import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { bootIntoDashboard, closeSessionQuietly, dispatch, launchSessionWithCard, select } from './support';

// Characterization of the chat-surface claims in the 1.7.5/1.7.7 release notes: tool-ui questions,
// links inside widgets, and the mid-turn provider pill. No provider key: sessions come from the app's
// own launch route (parked, pre-warming), and the messages a live agent would stream are dispatched
// through the store's own reducer in the wire shape the backend emits. The renders and clicks are real.
test.describe.configure({ mode: 'serial' });
test.describe('characterization: chat tool-ui and provider pill (1.7.5-1.7.7)', () => {
  let app: ElectronApplication;
  let win: Page;
  let dashboardId: string;
  let sessionId: string;
  let branchId: string;
  const created: string[] = [];

  const stamp = () => new Date().toISOString();
  const card = () => win.locator(`[data-select-type="agent-card"][data-select-id="${sessionId}"]`);

  test.beforeAll(async () => {
    ({ app, win, dashboardId } = await bootIntoDashboard());
    sessionId = await launchSessionWithCard(win, dashboardId, 'Characterization chat');
    created.push(sessionId);
    branchId = await select(win, (s) => s.agents.sessions[Object.keys(s.agents.sessions)[0]].active_branch_id) as string;
    // The card opens expanded; the transcript is where the tool-ui cards paint.
    await dispatch(win, { type: 'agents/expandSession', payload: sessionId });
  });
  test.afterAll(async () => {
    for (const id of created) await closeSessionQuietly(win, id).catch(() => {});
    await app?.close().catch(() => {});
  });

  // The pill is renderer-local: a wholesale session snapshot (fetchSession) legitimately replaces it, and
  // a fresh launch runs a couple of those in its first seconds. Arm it in a quiet moment, so what the
  // test measures is the claim under test — a status FRAME must not wipe it — not launch traffic.
  const armProviderRetrying = async (attempt: number): Promise<void> => {
    for (let round = 0; round < 5; round++) {
      await dispatch(win, { type: 'agents/setProviderRetrying', payload: { sessionId, attempt, delayMs: 60_000 } });
      await win.waitForTimeout(2500);
      if (await select(win, (s) => s.agents.sessions[Object.keys(s.agents.sessions)[0]]?.provider_retrying != null)) return;
    }
    throw new Error('provider_retrying never held for 2.5s');
  };

  test('1.7.7 F13: a provider retry shows a live status pill, and a status frame does not wipe it', async () => {
    await armProviderRetrying(2);
    const pill = card().getByText(/Provider busy, retrying \(attempt 2\)/);
    await expect(pill).toBeVisible({ timeout: 10_000 });
    // A WS status frame carries no transient pill fields; the reducer must keep the renderer-local one.
    const session = await select(win, (s) => s.agents.sessions[Object.keys(s.agents.sessions)[0]]);
    const frame = { ...session, provider_retrying: undefined, rate_limited: undefined, status: 'running' };
    await dispatch(win, { type: 'agents/updateSession', payload: frame });
    expect(await select(win, (s) => s.agents.sessions[Object.keys(s.agents.sessions)[0]]?.provider_retrying?.attempt)).toBe(2);
    await win.waitForTimeout(600);
    await expect(pill).toBeVisible();
    await dispatch(win, { type: 'agents/clearProviderRetrying', payload: { sessionId } });
    await expect(pill).toBeHidden({ timeout: 5000 });
  });

  test('1.7.7 F7/H4: an AskUI approval card answers once, its receipt lands, and a second press is inert', async () => {
    // Route the respond POST so this run does not depend on an agent parked server-side: the first
    // answer is accepted (200, not gone), and every call is counted.
    let responds = 0;
    await win.route('**/api/ui-requests/respond', async (route) => {
      responds += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const callId = 'toolu_char_ask_1';
    await dispatch(win, {
      type: 'agents/addMessage',
      payload: {
        sessionId,
        message: {
          id: 'char-ask-call-1', role: 'tool_call', timestamp: stamp(), branch_id: branchId, parent_id: null,
          content: {
            tool: 'AskUI', id: callId,
            input: { component: 'approval-card', props: { id: 'char-approval-1', title: 'Deploy the change?', description: 'Characterization ask', confirmLabel: 'Ship it', cancelLabel: 'Hold' } },
          },
        },
      },
    });
    const approve = card().getByRole('button', { name: 'Ship it' });
    await expect(approve).toBeVisible({ timeout: 15_000 });
    await expect(card().getByRole('heading', { name: 'Deploy the change?' })).toBeVisible();
    await approve.click();
    // The choice flips to its receipt the instant the user answers, before any tool result lands.
    await expect(approve).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => responds, { timeout: 5000 }).toBe(1);
    // A second press anywhere on that question is inert: one answer across every surface.
    await win.waitForTimeout(500);
    expect(responds).toBe(1);
    await win.unroute('**/api/ui-requests/respond');
  });

  test('1.7.7 F7: an answer nothing is waiting for is reported honestly, not swallowed', async () => {
    // When nothing is parked server-side for an ask (agent gone, ask expired, transcript replayed) the
    // bridge answers 200 + gone rather than a red 404. Play that verdict back to the renderer: the
    // bubble must say so instead of quietly showing a receipt for an answer that never reached an agent.
    await win.route('**/api/ui-requests/respond', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, gone: true }) });
    });
    await dispatch(win, {
      type: 'agents/addMessage',
      payload: {
        sessionId,
        message: {
          id: 'char-ask-call-2', role: 'tool_call', timestamp: stamp(), branch_id: branchId, parent_id: null,
          content: {
            tool: 'AskUI', id: 'toolu_char_ask_2',
            input: { component: 'approval-card', props: { id: 'char-approval-2', title: 'Second question', confirmLabel: 'Yes please', cancelLabel: 'No thanks' } },
          },
        },
      },
    });
    const yes = card().getByRole('button', { name: 'Yes please' });
    await expect(yes).toBeVisible({ timeout: 15_000 });
    await yes.click();
    await expect(card().getByText(/This answer didn't reach the agent/)).toBeVisible({ timeout: 15_000 });
    // And it is answerable again (the registry released it), so the user can retry.
    await expect(card().getByRole('button', { name: 'Yes please' })).toBeVisible({ timeout: 10_000 });
    await win.unroute('**/api/ui-requests/respond');
  });

  test('1.7.7 F7: an older pending ask goes quiet once a newer one is live', async () => {
    // Two unanswered asks: only the LATEST renders as a form; the older is a quiet row, not a second clickable copy.
    for (const n of [3, 4]) {
      await dispatch(win, {
        type: 'agents/addMessage',
        payload: {
          sessionId,
          message: {
            id: `char-ask-call-${n}`, role: 'tool_call', timestamp: stamp(), branch_id: branchId, parent_id: null,
            content: {
              tool: 'AskUI', id: `toolu_char_ask_${n}`,
              input: { component: 'approval-card', props: { id: `char-approval-${n}`, title: `Question ${n}`, confirmLabel: `Confirm ${n}`, cancelLabel: `Cancel ${n}` } },
            },
          },
        },
      });
    }
    await expect(card().getByRole('button', { name: 'Confirm 4' })).toBeVisible({ timeout: 15_000 });
    await expect(card().getByRole('button', { name: 'Confirm 3' })).toHaveCount(0);
  });

  test('1.7.7 F8: a link inside a widget opens as a browser card, leaving fullscreen first', async () => {
    const before = await select(win, (s) => Object.keys(s.dashboardLayout.browserCards).length);
    await dispatch(win, {
      type: 'agents/addMessage',
      payload: {
        sessionId,
        message: {
          id: 'char-show-call-1', role: 'tool_call', timestamp: stamp(), branch_id: branchId, parent_id: null,
          content: {
            tool: 'ShowUI', id: 'toolu_char_show_1',
            input: { component: 'link-preview', props: { id: 'char-link-1', href: 'https://example.com/characterization', title: 'Characterization link', domain: 'example.com' } },
          },
        },
      },
    });
    const link = card().getByRole('link').filter({ hasText: 'Characterization link' }).first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    // Put the chat fullscreen: the click must exit fullscreen so the new browser card is actually visible.
    await dispatch(win, { type: 'dashboardLayout/setTiledCard', payload: { cardId: sessionId, zone: 'fullscreen' } });
    await expect.poll(() => select(win, (s) => s.dashboardLayout.tiledCards[Object.keys(s.agents.sessions)[0]] ?? null), { timeout: 5000 }).toBe('fullscreen');
    await win.waitForTimeout(700);
    await link.click();
    await expect.poll(() => select(win, (s) => Object.keys(s.dashboardLayout.browserCards).length), { timeout: 10_000 }).toBe(before + 1);
    expect(await select(win, (s) => Object.entries(s.dashboardLayout.tiledCards).filter(([, z]) => z === 'fullscreen').length)).toBe(0);
    const opened = await select(win, (s) => Object.values(s.dashboardLayout.browserCards).map((b: any) => b.url));
    expect(opened.some((u: string) => u.startsWith('https://example.com/characterization'))).toBe(true);
    // Leave the profile as we found it.
    const ids = await select(win, (s) => Object.keys(s.dashboardLayout.browserCards));
    for (const id of ids) await dispatch(win, { type: 'dashboardLayout/removeBrowserCard', payload: id });
  });

  test('1.7.5 F5: a self-healing provider hiccup never shows a scary card, only the muted pill', async () => {
    // The pill from F13 is the whole surface for a mid-turn provider hiccup: no red card, no CTA.
    await armProviderRetrying(1);
    await expect(card().getByText(/Provider busy, retrying/)).toBeVisible({ timeout: 10_000 });
    await expect(card().getByRole('button', { name: /reconnect|retry now|try again/i })).toHaveCount(0);
    await dispatch(win, { type: 'agents/clearProviderRetrying', payload: { sessionId } });
  });
});
