// Menubar tray that keeps the app resident after window close so scheduled workflows still fire.

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');

let trayInstance = null;
let enabled = false;
let backendPortRef = null;
let authTokenRef = null;

function iconPath(state) {
  // Windows tray prefers .ico (multi-res, crisp at any DPI); falls back to PNG if not shipped.
  if (process.platform === 'win32') {
    const ico = path.join(__dirname, 'assets', `tray-${state}.ico`);
    try {
      const fs = require('fs');
      if (fs.existsSync(ico)) return ico;
    } catch (_) {}
  }
  return path.join(__dirname, 'assets', `tray-${state}.png`);
}

function postPause(value) {
  return new Promise((resolve) => {
    if (!backendPortRef) return resolve(null);
    const data = '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: backendPortRef,
      path: value ? '/workflows/pause-all' : '/workflows/resume-all',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authTokenRef ? { Authorization: `Bearer ${authTokenRef}` } : {}) },
      timeout: 1500,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

function setStatus({ activeTitle = null, paused = false } = {}) {
  if (!trayInstance) return;
  const state = paused ? 'paused' : activeTitle ? 'running' : 'idle';
  const img = nativeImage.createFromPath(iconPath(state));
  if (process.platform === 'darwin' && !img.isEmpty()) img.setTemplateImage(true);
  trayInstance.setImage(img);
  const tooltip = paused
    ? 'OpenSwarm: schedules paused'
    : activeTitle
      ? `OpenSwarm: running ${activeTitle}`
      : 'OpenSwarm: idle';
  trayInstance.setToolTip(tooltip);
  rebuildMenu({ activeTitle, paused });
}

function rebuildMenu({ activeTitle, paused }) {
  if (!trayInstance) return;
  const menu = Menu.buildFromTemplate([
    {
      label: paused ? 'Schedules paused' : activeTitle ? `Running: ${activeTitle}` : 'Idle',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Open OpenSwarm', click: () => {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        if (wins[0]) { wins[0].show(); wins[0].focus(); }
        else { app.emit('activate'); }
      },
    },
    {
      label: paused ? 'Resume all schedules' : 'Pause all schedules',
      click: async () => { await postPause(!paused); setStatus({ activeTitle, paused: !paused }); },
    },
    { type: 'separator' },
    { label: 'Quit OpenSwarm', click: () => { app.quit(); } },
  ]);
  trayInstance.setContextMenu(menu);
}

function setup({ backendPort, authToken }) {
  backendPortRef = backendPort;
  authTokenRef = authToken;
  if (trayInstance) return trayInstance;
  try {
    const img = nativeImage.createFromPath(iconPath('idle'));
    if (process.platform === 'darwin' && !img.isEmpty()) img.setTemplateImage(true);
    trayInstance = new Tray(img);
    trayInstance.setToolTip('OpenSwarm: idle');
    enabled = true;
    rebuildMenu({ activeTitle: null, paused: false });
    // Cross-platform click parity: on macOS the context menu opens on
    // left-click automatically; on Windows/Linux left-click does
    // nothing by default. We attach a click handler that opens the
    // window on left-click (a Windows-typical pattern) so users on
    // those platforms aren't confused when the tray "doesn't work."
    if (process.platform !== 'darwin') {
      trayInstance.on('click', () => {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        if (wins[0]) { wins[0].show(); wins[0].focus(); }
        else { app.emit('activate'); }
      });
      // Right-click already shows the context menu on Windows/Linux
      // (Electron default), no extra wiring needed.
    }
  } catch (_) {
    trayInstance = null;
    enabled = false;
  }
  return trayInstance;
}

function destroy() {
  try { if (trayInstance) trayInstance.destroy(); } catch (_) {}
  trayInstance = null;
  enabled = false;
}

function isEnabled() { return enabled; }

module.exports = { setup, setStatus, destroy, isEnabled };
