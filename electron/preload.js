const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  const port = await ipcRenderer.invoke('get-backend-port');
  const webviewPreloadPath = await ipcRenderer.invoke('get-webview-preload-path');

  contextBridge.exposeInMainWorld('__OPENSWARM_PORT__', port);

  contextBridge.exposeInMainWorld('openswarm', {
    getBackendPort: () => port,
    getWebviewPreloadPath: () => webviewPreloadPath,

    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
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
  });
})();
