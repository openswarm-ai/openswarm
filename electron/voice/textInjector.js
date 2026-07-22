// Drop transcribed text into whatever app currently has focus, WhisperFlow-style. We can't synthesize
// raw keystrokes from a sandboxed renderer, so the durable trick is the clipboard: stash the user's
// existing clipboard, write our text, fire the OS paste chord, then restore the clipboard a beat later
// so we don't clobber what they had. macOS paste needs Accessibility permission (same wall clicky hits).

const { clipboard } = require('electron');
const { exec } = require('child_process');

function pasteFrontmost() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec('osascript -e \'tell application "System Events" to keystroke "v" using command down\'', (err) => resolve(!err));
    } else if (process.platform === 'win32') {
      // SendWait "^v" = Ctrl+V into the focused control.
      exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"', (err) => resolve(!err));
    } else {
      resolve(false);
    }
  });
}

// Write text to the clipboard and paste it into the focused field, then put the old clipboard back so
// dictation is non-destructive. Returns false if we couldn't fire the paste (e.g. no Accessibility grant).
async function injectText(text) {
  if (!text) return false;
  const previous = clipboard.readText();
  clipboard.writeText(text);
  const pasted = await pasteFrontmost();
  // Restore after the paste has had time to read the clipboard. If the paste failed the text stays on
  // the clipboard so the user can paste it by hand rather than losing the dictation entirely.
  if (pasted) {
    setTimeout(() => {
      try { if (clipboard.readText() === text) clipboard.writeText(previous); } catch (_) {}
    }, 400);
  }
  return pasted;
}

module.exports = { injectText };
