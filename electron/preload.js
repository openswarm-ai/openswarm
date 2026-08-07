const { contextBridge, ipcRenderer } = require('electron');


// E2E gate: set the renderer flag BEFORE any page script parses so the
// production-build store-on-window expose fires deterministically when
// Playwright launches with OPENSWARM_E2E=1. Read from the Chromium switch
// the main process appended; no-op for normal user launches.
try {
  const args = (typeof process !== 'undefined' && process.argv) ? process.argv : [];
  if (args.some((a) => /--openswarm-e2e(=1)?$/.test(a))) {
    contextBridge.exposeInMainWorld('__OPENSWARM_E2E__', true);
  }
} catch (e) { console.log('[diag][preload] e2e-flag setup failed:', e && e.message); }

// Synchronous exposure. The previous async IIFE (await ipcRenderer.invoke) raced React mount: any code reading window.openswarm during the gap (BrowserCard's Electron-detection falling back to iframe mode, AgentChat's auth-token call throwing) saw undefined. sendSync blocks the renderer for one IPC round-trip during preload before any user-visible paint, so window.openswarm is guaranteed to exist before the first frontend bundle evaluates.
const port = ipcRenderer.sendSync('get-backend-port-sync');
const webviewPreloadPath = ipcRenderer.sendSync('get-webview-preload-path-sync');

contextBridge.exposeInMainWorld('__OPENSWARM_PORT__', port);

contextBridge.exposeInMainWorld('openswarm', {
  getBackendPort: () => port,
  // Fresh re-query of the LIVE backend port (not the cached preload value).
  // Used by the renderer to self-heal if its cached port ever resolved wrong
  // (raced null -> 8324, or backend on a fallback port because 8324 was held).
  getBackendPortLive: () => {
    try { return ipcRenderer.sendSync('get-backend-port-sync'); } catch (_) { return port; }
  },
  getWebviewPreloadPath: () => webviewPreloadPath,

  // Per-install auth token required for WS + HTTP calls to the
  // localhost backend. Returns a Promise<string>. The renderer should
  // await this on startup and include the token on every WS URL
  // (`?token=...`) and HTTP request (`Authorization: Bearer ...`).
  // We deliberately do NOT expose the token as a plain window global
  // or a sync getter: contextBridge + IPC keeps it off the renderer's
  // global object so third-party scripts (including any code that
  // leaks through <webview>) can't scrape it.
  getAuthToken: () => ipcRenderer.invoke('get-auth-token'),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  // Arc-style chrome: the mac traffic lights hide at rest; the dashboard's top-edge hover reveals them.
  setWindowButtonsVisible: (visible) => ipcRenderer.invoke('set-window-buttons-visible', visible),
  // Native window bg tracks the theme so a live resize never paints the boot-dark color behind a light UI.
  setWindowBackground: (color) => ipcRenderer.invoke('set-window-background', color),
  setNewAgentShortcut: (combo) => ipcRenderer.send('set-new-agent-shortcut', combo),

  // Phase 2 provenance: { sha, shortSha, builtAt, channel } for the About panel.
  getBuildInfo: () => ipcRenderer.invoke('get-build-info'),

  // Phase 0 boot instrumentation: renderer calls this exactly once, when the
  // first streamed token of the first agent response paints. Fire-and-forget
  // (send, not invoke) so it never blocks the render path. Main dedupes.
  markFirstAgentResponse: () => ipcRenderer.send('perf:first-agent-response'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Returns the persisted install state (app_install_id, ref, ...).
  // Renderer attaches the ref to Stripe checkout + sign-in flows so
  // the cloud can credit the affiliate. Resolves to {} if no state yet.
  getInstallState: () => ipcRenderer.invoke('get-install-state'),
  // Factory reset: wipes the data dir and relaunches. Never resolves on success (the app exits first).
  hardReset: () => ipcRenderer.invoke('hard-reset'),
  // Clears cookies/cache/localStorage for the browser-card partition only (never the app's defaultSession). Logs you out of sites opened in browser cards.
  clearBrowserData: () => ipcRenderer.invoke('browser:clear-data'),
  connectSlack: () => ipcRenderer.invoke('connect-slack'),
  // Voice dictation (local whisper.cpp). transcribe takes a 16kHz-mono WAV ArrayBuffer; inject pastes
  // text into the frontmost app; warmup pre-loads the model; onVoiceToggle fires on the global hotkey.
  voiceWarmup: () => ipcRenderer.invoke('voice:warmup'),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  // Settings' model picker: the catalog with install state, and switching (downloads on demand).
  voiceModels: () => ipcRenderer.invoke('voice:models'),
  voiceSetModel: (id) => ipcRenderer.invoke('voice:set-model', id),
  voiceSetDictionary: (words) => ipcRenderer.send('voice:set-dictionary', words),
  voiceTranscribe: (wavArrayBuffer) => ipcRenderer.invoke('voice:transcribe', wavArrayBuffer),
  voiceInject: (text) => ipcRenderer.invoke('voice:inject', text),
  // Streaming dictation: chunks flow up fire-and-forget, live partials flow back down.
  voiceStreamStart: () => ipcRenderer.invoke('voice:stream-start'),
  voiceStreamChunk: (pcmArrayBuffer) => ipcRenderer.send('voice:stream-chunk', pcmArrayBuffer),
  voiceStreamStop: () => ipcRenderer.invoke('voice:stream-stop'),
  voiceStreamCancel: () => ipcRenderer.send('voice:stream-cancel'),
  onVoicePartial: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('voice:partial', listener);
    return () => ipcRenderer.removeListener('voice:partial', listener);
  },
  onVoiceToggle: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('voice:toggle', listener);
    return () => ipcRenderer.removeListener('voice:toggle', listener);
  },
  // Reveal a diagnostics folder in Finder/Explorer (path validated in main; diagnostics dir only).
  revealBundle: (folderPath) => ipcRenderer.invoke('help:reveal-bundle', folderPath),
  // Reveal a user-attached file in Finder/Explorer (reveal-only; main checks existence).
  revealPath: (filePath) => ipcRenderer.invoke('files:reveal', filePath),
  // Cmd/Ctrl+1..9: focus the Nth dock tile (0-based index arrives here).
  onDockShortcut: (cb) => {
    const listener = (_event, index) => cb(index);
    ipcRenderer.on('openswarm:dock-shortcut', listener);
    return () => ipcRenderer.removeListener('openswarm:dock-shortcut', listener);
  },

  // Native OS notification for a finished workflow run, posted by the MAIN process
  // so it survives a minimized/hidden/backgrounded renderer (the renderer's own
  // Notification API does not). Resolves true once it is handed to the OS, which can
  // still refuse it afterwards (main logs that). Fields are clamped in main;
  // onNotificationAction carries the clicked outcome back.
  notify: (payload) => ipcRenderer.invoke('workflow:notify', payload),
  onNotificationAction: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('workflow:notification-action', listener);
    return () => ipcRenderer.removeListener('workflow:notification-action', listener);
  },
  // True keyboard hold-to-talk needs the native key tap; renderers ask so Settings copy stays honest,
  // and request triggers the macOS Accessibility prompt when the tap is blocked on permission.
  setVoiceHotkey: (combo) => ipcRenderer.send('voice:set-hotkey', combo),
  voiceHoldCapable: () => ipcRenderer.invoke('voice:hold-capable'),
  voiceRequestHoldPermission: () => ipcRenderer.invoke('voice:request-hold-permission'),
  voiceRequestMicAccess: () => ipcRenderer.invoke('voice:request-mic-access'),
  haptic: (pattern) => ipcRenderer.invoke('haptic:perform', pattern),
  // Native-tap hold relay: real global key-down/key-up for the voice combo, focus-independent.
  onVoiceHold: (onDown, onUp) => {
    const down = () => onDown();
    const up = () => onUp();
    ipcRenderer.on('voice:hold-down', down);
    ipcRenderer.on('voice:hold-up', up);
    return () => { ipcRenderer.removeListener('voice:hold-down', down); ipcRenderer.removeListener('voice:hold-up', up); };
  },
  // Fires once at fn-watcher arm when macOS's own Globe-key action is still active (emoji picker on tap).
  onVoiceGlobeConflict: (cb) => {
    const h = () => cb();
    ipcRenderer.on('voice:globe-conflict', h);
    return () => ipcRenderer.removeListener('voice:globe-conflict', h);
  },
  // Hands a vetted social platform's partition cookies to its session-backed MCP shim (allowlisted domains only, gated again in the main process).
  getPartitionCookies: (domain) => ipcRenderer.invoke('get-partition-cookies', domain),
  // Silently reads the user's own chatgpt.com/claude.ai history offscreen (no card) for onboarding personalization; main owns the injected script + gates the provider.
  harvestUsage: (provider) => ipcRenderer.invoke('harvest-usage', provider),
  // Suspend/resume state capsule: stages a resumed webview's sessionStorage snapshot in main (keyed by webContents id, short TTL) so the guest preload can sync-take it at document-start. Fire-and-forget; main validates the sender.
  setSessionCapsule: (wcId, capsule) => ipcRenderer.send('browser-capsule-set', wcId, capsule),
  // Loads the user's own existing sign-in for a site INTO the browser partition so a blocked agent can continue as them. Writes only, never reads back; main re-checks every cookie belongs to the domain asked for.
  setPartitionCookies: (domain, cookies) => ipcRenderer.invoke('set-partition-cookies', domain, cookies),
  sendCdpCommand: (wcId, method, params, sessionId) => ipcRenderer.invoke('send-cdp-command', wcId, method, params, sessionId),
  cdpDetachClean: (wcId) => ipcRenderer.invoke('cdp-detach-clean', wcId),
  cdpCacheSet: (wcId, indexMap) => ipcRenderer.invoke('cdp-cache-set', wcId, indexMap),
  cdpCacheGet: (wcId) => ipcRenderer.invoke('cdp-cache-get', wcId),
  cdpCacheClear: (wcId) => ipcRenderer.invoke('cdp-cache-clear', wcId),
  cdpChildSessionsGet: (wcId) => ipcRenderer.invoke('cdp-child-sessions-get', wcId),
  cdpRoutesGet: (wcId, originFilter) => ipcRenderer.invoke('cdp-routes-get', wcId, originFilter),
  getWebviewConsole: (wcId) => ipcRenderer.invoke('get-webview-console', wcId),
  capturePage: (rect) => ipcRenderer.invoke('capture-page', rect),
  getAppIcon: (name) => ipcRenderer.invoke('get-app-icon', name),
  openApplication: (name) => ipcRenderer.invoke('open-application', name),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  getCrashRecoveryInfo: () => ipcRenderer.invoke('get-crash-recovery-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  setAllowPrerelease: (value) => ipcRenderer.invoke('set-allow-prerelease', value),

  onUpdateAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('update-available', listener);
    return () => ipcRenderer.removeListener('update-available', listener);
  },
  onUpdateNotAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('update-not-available', listener);
    return () => ipcRenderer.removeListener('update-not-available', listener);
  },
  onDownloadProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('update-downloaded', listener);
    return () => ipcRenderer.removeListener('update-downloaded', listener);
  },
  onUpdateError: (cb) => {
    const listener = (_event, message) => cb(message);
    ipcRenderer.on('update-error', listener);
    return () => ipcRenderer.removeListener('update-error', listener);
  },

  onWebviewNewWindow: (cb) => {
    const listener = (_event, url, webContentsId, disposition) => cb(url, webContentsId, disposition);
    ipcRenderer.on('webview-new-window', listener);
    return () => ipcRenderer.removeListener('webview-new-window', listener);
  },

  // Cmd/Ctrl+R, intercepted in main (kills the default-menu reload), so the renderer can reload the focused browser instead of the whole app.
  onReloadShortcut: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('openswarm:reload-shortcut', listener);
    return () => ipcRenderer.removeListener('openswarm:reload-shortcut', listener);
  },

  // Cmd/Ctrl+W with the window-close swallowed in main: the renderer closes the focused card instead.
  onCloseShortcut: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('openswarm:close-shortcut', listener);
    return () => ipcRenderer.removeListener('openswarm:close-shortcut', listener);
  },

  // Cmd/Ctrl+T: new tab in the last-interacted browser, else a new browser card.
  onNewTabShortcut: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('openswarm:newtab-shortcut', listener);
    return () => ipcRenderer.removeListener('openswarm:newtab-shortcut', listener);
  },

  // In-page browser shortcuts (zoom/find/tab-cycle) from a focused guest webview, carrying the guest's webContents id so the renderer targets that exact browser.
  onBrowserShortcut: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('openswarm:browser-shortcut', listener);
    return () => ipcRenderer.removeListener('openswarm:browser-shortcut', listener);
  },

  // Deep-link callback: fires when the OS opens the app with an
  // openswarm://auth?token=... URL (after Stripe-hosted checkout).
  onAuthUrl: (cb) => {
    const listener = (_event, url) => cb(url);
    ipcRenderer.on('openswarm:auth-url', listener);
    return () => ipcRenderer.removeListener('openswarm:auth-url', listener);
  },

  // OAuth claim deep-link channel. Receives openswarm://oauth/{provider}/complete
  // after the user finishes an OAuth flow in their browser.
  onOauthClaim: (cb) => {
    const listener = (_event, url) => cb(url);
    ipcRenderer.on('openswarm:oauth-claim', listener);
    return () => ipcRenderer.removeListener('openswarm:oauth-claim', listener);
  },

  // Window blur/focus events: analytics signal for "user switched to
  // another app" (temp-churn measurement). Throttled in main.js to at
  // most once per 2s per direction so OS-level focus storms don't
  // pollute the event stream.
  onWindowFocus: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('openswarm:window-focus', listener);
    return () => ipcRenderer.removeListener('openswarm:window-focus', listener);
  },

  // OAuth popup callback. Fires when any child webContents navigates
  // to localhost:20128/callback?code=... main.js watches for this and
  // forwards the parsed params here. Used as a belt-and-suspenders
  // alongside window.opener.postMessage (which silently fails on some
  // Anthropic flows that reset the opener chain during redirect).
  onOauthCallback: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('openswarm:oauth-callback', listener);
    return () => ipcRenderer.removeListener('openswarm:oauth-callback', listener);
  },
});
