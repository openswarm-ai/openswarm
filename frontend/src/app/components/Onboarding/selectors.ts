// Central registry of data-onboarding / data-select-type selectors. Step files import S.*; never inline.

export const S = {
  sidebarApps: 'sidebar-apps',

  sidebarSettingsButton: 'sidebar-settings-button',
  sidebarDashboards: 'sidebar-dashboards',
  /** Top-bar ViewSidebar toggle; aria-expanded drives the expand-sidebar preflight. */
  sidebarToggle: 'sidebar-toggle',
  /** First row in Dashboards section; "click into a dashboard" hop targets this. */
  dashboardRowFirst: 'dashboard-row-first',

  newAgentButton: 'new-agent-button',
  browserButton: 'browser-button',
  canvasControls: 'canvas-controls',
  /** The top-right onboarding pill ("Continue"); the first-run welcome nudge points here. */
  onboardingContinueButton: 'onboarding-continue-button',

  dashboardToolbarApps: 'dashboard-toolbar-apps',

  /** Matched via data-select-type as fallback. */
  agentCard: 'agent-card',

  settingsModelsTab: 'settings-models-tab',
  settingsCloseButton: 'settings-close-button',
  settingsProSection: 'settings-pro-section',
  settingsExternalSubs: 'settings-external-subs',
  settingsApiKeys: 'settings-api-keys',
  settingsRestartTour: 'settings-restart-tour',

  chatInput: 'chat-input',
  chatSendButton: 'chat-send-button',
  elementSelectionToggle: 'element-selection-toggle',

  canvasFitToView: 'canvas-fit-to-view',
  canvasTidyLayout: 'canvas-tidy-layout',
  canvasMinimapToggle: 'canvas-minimap-toggle',

  appsNewButton: 'apps-new-button',
  appCardLatest: 'app-card-latest',

  browserUrlBar: 'browser-url-bar',
} as const;

export type SelectorKey = (typeof S)[keyof typeof S];

// Per-agent selectors resolve to the newest card so step 6 doesn't hijack step 5's agent.
const PER_AGENT_SELECTORS = new Set([
  'chat-input',
  'chat-send-button',
  'element-selection-toggle',
]);

/** Resolve a selector to a DOM node; per-agent selectors pick the newest spawn. */
export function resolveSelector(target: string): HTMLElement | null {
  const escaped = (window as any).CSS?.escape?.(target) ?? target;

  if (PER_AGENT_SELECTORS.has(target)) {
    const all = document.querySelectorAll<HTMLElement>(
      `[data-onboarding="${escaped}"]`,
    );
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    // Priority 1: App Builder's AgentChat scope. It mounts AgentChat without an agent-card wrapper.
    const appBuilderScope = document.querySelector<HTMLElement>(
      '[data-onboarding-scope="app-builder"]',
    );
    if (appBuilderScope) {
      const scoped = appBuilderScope.querySelector<HTMLElement>(
        `[data-onboarding="${escaped}"]`,
      );
      if (scoped) return scoped;
    }
    // Priority 2: dock toolbar's draft-ChatInput; outranks any existing agent-card.
    const dockScope = document.querySelector<HTMLElement>(
      '[data-onboarding-scope="dock"]',
    );
    if (dockScope) {
      const scoped = dockScope.querySelector<HTMLElement>(
        `[data-onboarding="${escaped}"]`,
      );
      if (scoped) return scoped;
    }

    // Priority 3: agent-card with the newest data-onboarding-spawn-ms (after dock collapses).
    const cards = document.querySelectorAll<HTMLElement>(
      '[data-select-type="agent-card"]',
    );
    let newestCard: HTMLElement | null = null;
    let newestSpawnMs = -Infinity;
    cards.forEach((card) => {
      const raw = card.getAttribute('data-onboarding-spawn-ms');
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > newestSpawnMs) {
        newestSpawnMs = n;
        newestCard = card;
      }
    });
    if (!newestCard && cards.length > 0) {
      newestCard = cards[cards.length - 1];
    }
    if (newestCard) {
      const scoped = (newestCard as HTMLElement).querySelector<HTMLElement>(
        `[data-onboarding="${escaped}"]`,
      );
      if (scoped) return scoped;
    }
    return all[all.length - 1];
  }

  const el =
    (document.querySelector(`[data-onboarding="${escaped}"]`) as HTMLElement | null) ??
    (document.querySelector(`[data-select-type="${escaped}"]`) as HTMLElement | null);
  return el;
}

/** Resolve when target mounts; 15s default to ride out heavy main-thread load on /apps/new. */
export function waitForSelector(
  target: string,
  timeoutMs = 15000,
): Promise<HTMLElement> {
  const existing = resolveSelector(target);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const obs = new MutationObserver(() => {
      const el = resolveSelector(target);
      if (el) {
        obs.disconnect();
        resolve(el);
      } else if (Date.now() - start > timeoutMs) {
        obs.disconnect();
        reject(new Error(`waitForSelector: "${target}" did not appear within ${timeoutMs}ms`));
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    // Poll as a safety net so the timeout path fires even if the DOM is quiet.
    setTimeout(() => {
      const el = resolveSelector(target);
      if (el) {
        obs.disconnect();
        resolve(el);
      } else {
        obs.disconnect();
        reject(new Error(`waitForSelector: "${target}" did not appear within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}
