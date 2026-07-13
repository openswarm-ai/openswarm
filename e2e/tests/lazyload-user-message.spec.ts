import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchApp, waitForMainWindow, hasAnyProviderKey } from '../helpers/launch';

const MARKER = 'E2E_LAZYLOAD_MARKER';
const BIG_LINE = 'The quick brown fox jumps over the lazy dog, repeated to build bulk. ';
const BIG_TEXT = `${MARKER}\n` + Array.from({ length: 400 }, (_, i) => `paragraph ${i}: ${BIG_LINE.repeat(6)}`).join('\n\n');
const SHORT_TEXT = `${MARKER}_SHORT short control message`;

async function sendAndGetBubble(page: Page, text: string) {
  const editor = page.locator('[data-onboarding="chat-input"]').first();
  await editor.click();
  await page.keyboard.insertText(text);
  const sendBtn = page.locator('[data-onboarding="chat-send-button"]');
  await expect(sendBtn, 'send button never enabled; provider likely unconfigured').toBeVisible({ timeout: 10_000 });
  await sendBtn.click();
  const bubble = page.locator(`[data-select-type="message"][data-select-meta*="${MARKER}"]`).last();
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  return bubble;
}

async function scrollableAncestor(page: Page, bubble: ReturnType<Page['locator']>) {
  return bubble.evaluateHandle((el) => {
    let node: HTMLElement | null = el.parentElement;
    while (node && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement;
    return node;
  });
}

test.describe('user message lazy-load', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    test.skip(!hasAnyProviderKey(), 'no provider env key set; pass ANTHROPIC_API_KEY or OPENAI_API_KEY etc. to enable');
    test.skip(process.env.CI !== 'true' && process.env.OPENSWARM_E2E_SEED !== '1', 'seed gate not enabled; set OPENSWARM_E2E_SEED=1 for local runs');
    app = await launchApp();
    page = await waitForMainWindow(app);
    const newAgentBtn = page.locator('[data-onboarding="new-agent-button"]');
    await expect(newAgentBtn).toBeVisible({ timeout: 15_000 });
    await newAgentBtn.click();
    await expect(page.locator('[data-onboarding="chat-input"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
  });

  test('short message renders in full (no regression)', async () => {
    const bubble = await sendAndGetBubble(page, SHORT_TEXT);
    const rendered = (await bubble.innerText()).trim();
    expect(rendered).toContain(SHORT_TEXT);
  });

  test('large pasted message does not render fully at once', async () => {
    const t0 = Date.now();
    const bubble = await sendAndGetBubble(page, BIG_TEXT);
    expect(Date.now() - t0, 'send-to-visible took too long; likely un-windowed full render').toBeLessThan(5_000);

    const renderedLen = (await bubble.innerText()).length;
    expect(renderedLen, 'bubble rendered its entire text at once; windowing did not engage').toBeLessThan(BIG_TEXT.length * 0.5);

    // Scroll the transcript away from and back to the message; the visible slice
    // should change but stay bounded both times, proving blocks mount/unmount
    // rather than the whole message staying resident once rendered.
    const scrollEl = await scrollableAncestor(page, bubble);
    await page.evaluate((el) => { if (el) (el as HTMLElement).scrollTop = 0; }, scrollEl);
    await page.waitForTimeout(500);
    await page.evaluate((el) => { if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight; }, scrollEl);
    await page.waitForTimeout(500);
    const rescannedLen = (await bubble.innerText()).length;
    expect(rescannedLen, 'bubble rendered its entire text after scrolling back').toBeLessThan(BIG_TEXT.length * 0.5);
  });
});
