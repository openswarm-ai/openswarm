const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  const port = await ipcRenderer.invoke('get-backend-port');
  const webviewPreloadPath = await ipcRenderer.invoke('get-webview-preload-path');

  contextBridge.exposeInMainWorld('__OPENSWARM_PORT__', port);

  contextBridge.exposeInMainWorld('openswarm', {
    getBackendPort: () => port,
    getWebviewPreloadPath: () => webviewPreloadPath,

    // Per-install auth token required for WS + HTTP calls to the
    // localhost backend. Returns a Promise<string>. The renderer should
    // await this on startup and include the token on every WS URL
    // (`?token=...`) and HTTP request (`Authorization: Bearer ...`).
    // We deliberately do NOT expose the token as a plain window global
    // or a sync getter — contextBridge + IPC keeps it off the
    // renderer's global object so third-party scripts (including any
    // code that leaks through <webview>) can't scrape it.
    getAuthToken: () => ipcRenderer.invoke('get-auth-token'),

    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Returns the persisted install state (app_install_id, ref, ...).
    // Renderer attaches the ref to Stripe checkout + sign-in flows so
    // the cloud can credit the affiliate. Resolves to {} if no state yet.
    getInstallState: () => ipcRenderer.invoke('get-install-state'),
    connectSlack: () => ipcRenderer.invoke('connect-slack'),
    sendCdpCommand: (wcId, method, params) => ipcRenderer.invoke('send-cdp-command', wcId, method, params),
    cdpCacheSet: (wcId, indexMap) => ipcRenderer.invoke('cdp-cache-set', wcId, indexMap),
    cdpCacheGet: (wcId) => ipcRenderer.invoke('cdp-cache-get', wcId),
    cdpCacheClear: (wcId) => ipcRenderer.invoke('cdp-cache-clear', wcId),
    capturePage: (rect) => ipcRenderer.invoke('capture-page', rect),
    getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),

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
      const listener = (_event, url, webContentsId) => cb(url, webContentsId);
      ipcRenderer.on('webview-new-window', listener);
      return () => ipcRenderer.removeListener('webview-new-window', listener);
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

    // Window blur/focus events — analytics signal for "user switched
    // to another app" (temp-churn measurement). Throttled in main.js to
    // at most once per 2s per direction so OS-level focus storms don't
    // pollute the event stream.
    onWindowFocus: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('openswarm:window-focus', listener);
      return () => ipcRenderer.removeListener('openswarm:window-focus', listener);
    },

    // Workflow lifecycle IPCs. ScheduleFacet uses these to render the
    // app-open status badge and the one-click "Fix" to enable launch-at-
    // login (and the tray, which is enabled by default once setup runs).
    getAppOpenInfo: () => ipcRenderer.invoke('workflows:get-app-open-info'),
    setLoginItem: (value) => ipcRenderer.invoke('workflows:set-login-item', value),
    enableTray: (_value) => Promise.resolve(true),
    getActiveRuns: () => ipcRenderer.invoke('workflows:get-active'),
    notify: (payload) => ipcRenderer.invoke('workflows:notify', payload),
    // Subscribed by WebSocketManager so notification button clicks
    // (Looks good / Re-run / Adjust / Open) route back into the app.
    onNotificationAction: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('workflow:notification-action', listener);
      return () => ipcRenderer.removeListener('workflow:notification-action', listener);
    },

    // OAuth popup callback. Fires when any child webContents navigates to
    // localhost:20128/callback?code=... — main.js watches for this and
    // forwards the parsed params here. Used as a belt-and-suspenders
    // alongside window.opener.postMessage (which silently fails on some
    // Anthropic flows that reset the opener chain during redirect).
    onOauthCallback: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on('openswarm:oauth-callback', listener);
      return () => ipcRenderer.removeListener('openswarm:oauth-callback', listener);
    },
  });
})();
