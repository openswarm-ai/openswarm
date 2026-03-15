const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  const port = await ipcRenderer.invoke('get-backend-port');

  contextBridge.exposeInMainWorld('__OPENSWARM_PORT__', port);

  contextBridge.exposeInMainWorld('openswarm', {
    getBackendPort: () => port,
  });
})();
