// Cmd+C works in every window, not just the first (ENG-289).
//
// The app never called setApplicationMenu, so macOS was left with Electron's implicit default and
// the Edit accelerators were whatever that happened to bind. The menu is process-global while its
// items act on whichever webContents holds focus, so "which window" is decided at keypress time by
// role dispatch, not by whatever window the menu was built next to. Declaring the menu ourselves
// makes that dispatch explicit and identical in the first window and the tenth.
//
// ROLES ONLY, deliberately. A hand-written copy handler has to answer "copy from where", and the
// answer is a focused-webContents lookup that is wrong for a <webview> guest exactly when the user
// is inside one. Chromium already resolves roles against the focused contents, including guests,
// so the correct implementation is the one where we write no logic at all.
//
// macOS only: on Windows and Linux setting a menu paints a visible menu bar this app has never had.

const APP_NAME = 'OpenSwarm';

/** The template, separated from the Electron call so it can be asserted without an app instance. */
function applicationMenuTemplate() {
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}

function installApplicationMenu(electron) {
  if (process.platform !== 'darwin') return false;
  const { Menu } = electron;
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()));
  return true;
}

module.exports = { applicationMenuTemplate, installApplicationMenu, APP_NAME };
