const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  const port = await ipcRenderer.invoke('get-backend-port');

  contextBridge.exposeInMainWorld('__OPENSWARM_PORT__', port);

  contextBridge.exposeInMainWorld('openswarm', {
    getBackendPort: () => port,

    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    capturePage: (rect) => ipcRenderer.invoke('capture-page', rect),
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
  });
})();
