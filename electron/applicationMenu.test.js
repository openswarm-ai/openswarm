// Run: node --test electron/applicationMenu.test.js
//
// ENG-289: "open a second window, select text, Cmd+C, nothing is copied; the same steps in the
// first window work." The app never declared an application menu, so the Edit accelerators were
// whatever Electron's implicit default bound. The menu is process-global and its items act on the
// FOCUSED webContents, so declaring it ourselves is what makes the second window behave like the
// first.
//
// These assert the two properties that decide whether the bug can come back: the Edit accelerators
// exist at all, and they are ROLES (Chromium resolves those against the focused contents, including
// a <webview> guest) rather than hand-written handlers that have to guess at a target.
const test = require('node:test');
const assert = require('node:assert/strict');

const { applicationMenuTemplate, installApplicationMenu } = require('./applicationMenu');

function editSubmenu() {
  const edit = applicationMenuTemplate().find((m) => m.label === 'Edit');
  assert.ok(edit, 'there must be an Edit menu; it is what binds Cmd+C on macOS');
  return edit.submenu;
}

test('the clipboard accelerators are all present', () => {
  const roles = editSubmenu().map((i) => i.role).filter(Boolean);
  for (const needed of ['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo']) {
    assert.ok(roles.includes(needed), `Edit menu is missing the ${needed} role`);
  }
});

test('clipboard items are roles, never hand-written click handlers', () => {
  // A click handler would have to resolve "copy from where" itself, and that lookup is wrong for a
  // webview guest exactly when the user is typing inside one.
  for (const item of editSubmenu()) {
    if (item.type === 'separator') continue;
    assert.ok(item.role, `Edit item ${JSON.stringify(item)} must be a role`);
    assert.equal(item.click, undefined, `Edit item ${item.role} must not carry a click handler`);
  }
});

test('no item pins itself to a specific window', () => {
  const json = JSON.stringify(applicationMenuTemplate());
  assert.ok(!json.includes('mainWindow'), 'a menu bound to one window is exactly the reported bug');
  assert.ok(!json.includes('webContents'), 'roles resolve the target themselves; do not capture one');
});

test('the menu is installed on macOS and skipped elsewhere', () => {
  const calls = [];
  const fake = { Menu: { setApplicationMenu: (m) => calls.push(m), buildFromTemplate: (t) => t } };
  const real = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.equal(installApplicationMenu(fake), true);
    assert.equal(calls.length, 1, 'macOS must get an explicit menu');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(installApplicationMenu(fake), false, 'Windows would paint a menu bar this app never had');
    assert.equal(calls.length, 1);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
});

test('main.js actually installs it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'main.js'), 'utf8');
  assert.match(src, /installApplicationMenu/, 'a menu module nothing calls fixes nothing');
});
