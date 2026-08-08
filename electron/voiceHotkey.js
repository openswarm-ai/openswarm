const { app, globalShortcut, ipcMain, systemPreferences } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Voice dictation hotkey, user-rebindable (Settings > Interface > Dictation shortcut), two tiers:
//
//   NATIVE (uiohook-napi event tap): sees real key-down AND key-up globally, in or out of focus,
//   immune to macOS's letter-keyup-under-Cmd suppression, so the keyboard gets TRUE hold-to-talk
//   exactly like the mic buttons. Listen-only (never swallows keys from other apps).
//
//   FALLBACK (globalShortcut while unfocused + before-input relay while focused): press-to-toggle,
//   key-ups undetectable there.
//
// THE TRAP THIS FILE IS SHAPED AROUND: on macOS a listen-only keyboard tap needs the Input
// Monitoring grant, which is SEPARATE from Accessibility, and a tap without it starts cleanly and
// then delivers nothing (caught live on the packaged build). So "tap started" proves nothing; the
// fallback stays armed until the tap delivers its first real key event. To keep the two paths from
// double-firing on one press, fallback sends are deferred 90ms and skipped when the tap just
// handled a key; a deaf tap never updates that timestamp, so the fallback always fires.
//
// F5 is deliberately NOT a default: macOS's media-key layer routes it to Siri before any app sees
// it. It stays bindable for users who have remapped that key at the OS level.

// Wispr grammar: the fn/Globe key IS the dictation key on Mac; Windows gets the same bottom-corner
// hold as Ctrl+Win (a bare laptop Fn never reaches the OS there). The old chord stays as the legacy
// fallback tier until the primary proves alive, so a missing grant never strands dictation keyless.
const DEFAULT_COMBO = process.platform === 'darwin' ? 'Fn' : process.platform === 'win32' ? 'Ctrl+Meta' : 'Ctrl+Shift+d';
const LEGACY_COMBO = process.platform === 'darwin' ? 'Meta+Shift+d' : 'Ctrl+Shift+d';
const TAP_FRESH_MS = 200;
const FALLBACK_DEFER_MS = 90;

// "Meta+Shift+d" (renderer parts format, same as new_agent_shortcut) -> matcher pieces.
// "Fn" and "Ctrl+Meta" are special: modifier-only triggers no accelerator grammar can express.
function parseCombo(str) {
  const raw = String(str || DEFAULT_COMBO);
  if (raw === 'Fn') return { special: 'fn', key: '', mods: { meta: false, ctrl: false, alt: false, shift: false }, accel: 'Fn' };
  if (raw === 'Ctrl+Meta') return { special: 'ctrlmeta', key: '', mods: { meta: true, ctrl: true, alt: false, shift: false }, accel: 'Ctrl+Meta' };
  const parts = raw.split('+').filter(Boolean);
  const key = parts[parts.length - 1] || 'd';
  const mods = {
    meta: parts.includes('Meta'),
    ctrl: parts.includes('Ctrl') || parts.includes('Control'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
  };
  const accel = [
    mods.meta ? 'Meta' : null,
    mods.ctrl ? 'Control' : null,
    mods.alt ? 'Alt' : null,
    mods.shift ? 'Shift' : null,
    key.length === 1 ? key.toUpperCase() : key,
  ].filter(Boolean).join('+');
  return { special: null, key, mods, accel };
}

// Resolve (or dev-compile) the native fn watcher, then call back with a path or null (legacy tiers
// stay primary on null). The dev compile is async: a first-boot swiftc must never freeze startup.
function resolveFnWatcherBinary(cb) {
  if (process.platform !== 'darwin') { cb(null); return; }
  const bundled = path.join(process.resourcesPath || '', 'fn-watcher', 'fn-watcher');
  if (fs.existsSync(bundled)) { cb(bundled); return; }
  const src = path.join(__dirname, 'native', 'fn-watcher.swift');
  if (!fs.existsSync(src)) { cb(null); return; }
  const out = path.join(app.getPath('userData'), 'fn-watcher-bin');
  try { fs.mkdirSync(out, { recursive: true }); } catch (_) {}
  const bin = path.join(out, 'fn-watcher');
  try {
    if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) { cb(bin); return; }
  } catch (_) { /* fall through to compile */ }
  const cc = spawn('swiftc', ['-O', '-o', bin, src], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  cc.stderr.on('data', (c) => { err = (err + String(c)).slice(-400); });
  cc.on('error', () => cb(null));
  cc.on('exit', (code) => {
    if (code !== 0) { console.log('[voice] fn watcher compile failed:', err.slice(0, 200)); cb(null); return; }
    cb(bin);
  });
}

function uiohookKeycodeFor(key, UiohookKey) {
  if (key.length === 1 && /[a-z]/i.test(key)) return UiohookKey[key.toUpperCase()];
  if (key.length === 1 && /[0-9]/.test(key)) return UiohookKey[key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return UiohookKey[key];
  if (key === ' ' || key === 'Space') return UiohookKey.Space;
  return undefined; // unmappable for the tap; the fallback tiers still cover it
}

function installVoiceHotkey(getMainWindow) {
  const send = (channel) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };

  let combo = parseCombo(DEFAULT_COMBO);
  // Special combos (Fn, Ctrl+Meta) have no accelerator; the LEGACY chord backs them until proven.
  let fallbackCombo = combo.special ? parseCombo(LEGACY_COMBO) : combo;
  let tapProven = false;
  let fnProven = false;
  let lastTapKeyMs = 0;
  let registeredAccel = null;

  const unregisterFallbackShortcut = () => {
    if (!registeredAccel) return;
    try { globalShortcut.unregister(registeredAccel); } catch (_) {}
    registeredAccel = null;
  };

  // Fallback toggle, deferred so a live tap's hold-down wins the same press. The freshness guard
  // only applies when the tap can SERVE the primary: under an fn primary the tap sees every key yet
  // handles none, and ambient typing was suppressing the legacy chord entirely (caught live).
  const sendFallbackToggle = () => {
    setTimeout(() => {
      if (combo.special !== 'fn' && Date.now() - lastTapKeyMs < TAP_FRESH_MS) return;
      send('voice:toggle');
    }, FALLBACK_DEFER_MS);
  };

  // Only the tier that can actually SERVE the primary combo may retire the fallbacks: the uiohook
  // tap cannot see fn (keycode 63 is VC_UNDEFINED), so with an fn primary a proven tap must not
  // silence the legacy chord (caught live: focused Cmd+Shift+D went dead the moment any key flowed).
  const primaryProven = () => (combo.special === 'fn' ? fnProven : (tapProven || fnProven));

  // Fallback shortcut stays registered while unfocused until the primary tier proves alive.
  const registerVoiceShortcut = () => {
    if (primaryProven()) return;
    if (registeredAccel === fallbackCombo.accel) return;
    unregisterFallbackShortcut();
    try {
      if (globalShortcut.register(fallbackCombo.accel, sendFallbackToggle)) registeredAccel = fallbackCombo.accel;
    } catch (_) { /* a taken shortcut just means no global hotkey; the pill still works */ }
  };

  // ---- fn/Globe primary tier (macOS): the native watcher, since no JS tap can see keycode 63 ----
  let fnProc = null;
  let quitReaperWired = false;
  const startFnWatcher = () => {
    if (process.platform !== 'darwin' || combo.special !== 'fn' || fnProc) return;
    resolveFnWatcherBinary((bin) => {
      if (!bin) { console.log('[voice] no fn watcher binary, legacy hotkey stays primary'); return; }
      if (combo.special !== 'fn' || fnProc) return; // rebound or raced while compiling
      startFnWatcherWith(bin);
    });
  };
  // Kill fn-watchers left by a previous OpenSwarm that died badly. will-quit is the ONLY thing that
  // reaps ours, and it never runs on a crash or a force-quit, so each bad exit strands a process
  // holding a GLOBAL keyboard tap forever (one was found alive after 2h35m). They accumulate, and
  // every extra one re-sends fn, so dictation double-toggles. We are a single-instance app about to
  // spawn our own, which makes this the one moment any other fn-watcher is provably not ours.
  const sweepStrayFnWatchers = (bin) => {
    try {
      const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 4000 });
      for (const pid of strayFnWatcherPids(String((out && out.stdout) || ''), bin, process.pid)) {
        try { process.kill(pid, 'SIGKILL'); console.log('[voice] reaped stray fn watcher', pid); } catch (_) {}
      }
    } catch (_) { /* a machine where ps is restricted must still arm the watcher */ }
  };
  const startFnWatcherWith = (bin) => {
    sweepStrayFnWatchers(bin);
    try {
      fnProc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      console.log('[voice] fn watcher spawn failed:', e && e.message);
      fnProc = null;
      return;
    }
    let buf = '';
    fnProc.stdout.on('data', (c) => {
      buf += String(c);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === 'd' || line === 'u') {
          if (!fnProven) {
            fnProven = true;
            unregisterFallbackShortcut();
            console.log('[voice] fn watcher PROVEN (events flowing), fn hold-to-talk enabled');
          }
          if (combo.special === 'fn') send(line === 'd' ? 'voice:hold-down' : 'voice:hold-up');
        } else if (line.startsWith('e')) {
          console.log('[voice] fn watcher error:', line);
        }
      }
    });
    fnProc.on('exit', (code) => {
      console.log(`[voice] fn watcher exited code=${code}; legacy hotkey resumes`);
      fnProc = null;
      fnProven = false;
      registerVoiceShortcut();
    });
    if (!quitReaperWired) {
      quitReaperWired = true;
      app.on('will-quit', () => { try { fnProc && fnProc.kill('SIGKILL'); } catch (_) {} });
    }
    console.log('[voice] fn watcher armed (awaiting first event to prove Input Monitoring)');
    // macOS's own Globe-key action (emoji picker by default) fires on a quick fn tap alongside us;
    // tell the renderer once so it can point the user at "Press Globe key to: Do Nothing".
    require('child_process').exec('defaults read com.apple.HIToolbox AppleFnUsageType', (err, out) => {
      const usage = err ? '2' : String(out).trim();
      if (usage !== '0') {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('voice:globe-conflict');
        console.log(`[voice] Globe key system action is active (AppleFnUsageType=${usage}); quick fn taps also trigger it`);
      }
    });
  };

  let tapKeycode;
  let UiohookKeyRef = null;

  const tryStartNativeTap = () => {
    try {
      if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
        console.log('[voice] no Accessibility grant, keyboard stays press-to-toggle');
        return false;
      }
      const { uIOhook, UiohookKey } = require('uiohook-napi');
      UiohookKeyRef = UiohookKey;
      tapKeycode = uiohookKeycodeFor(combo.key, UiohookKey);
      const MOD_KEYS = new Set([
        UiohookKey.Ctrl, UiohookKey.CtrlRight, UiohookKey.Shift, UiohookKey.ShiftRight,
        UiohookKey.Meta, UiohookKey.MetaRight, UiohookKey.Alt, UiohookKey.AltRight,
      ]);
      let held = false;

      const markAlive = () => {
        lastTapKeyMs = Date.now();
        if (!tapProven) {
          tapProven = true;
          if (primaryProven()) unregisterFallbackShortcut();
          console.log('[voice] native key tap PROVEN (events flowing), hold-to-talk enabled');
        }
      };

      const modsMatch = (e) =>
        (!combo.mods.meta || e.metaKey) &&
        (!combo.mods.ctrl || e.ctrlKey) &&
        (!combo.mods.alt || e.altKey) &&
        (!combo.mods.shift || e.shiftKey);

      uIOhook.on('keydown', (e) => {
        markAlive();
        if (held) return;
        // Ctrl+Win chord (the Windows fn-equivalent): either modifier landing second completes it.
        if (combo.special === 'ctrlmeta') {
          const isMeta = e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight;
          const isCtrl = e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight;
          if ((isMeta && e.ctrlKey) || (isCtrl && e.metaKey)) {
            held = true;
            send('voice:hold-down');
          }
          return;
        }
        if (tapKeycode === undefined) return;
        if (e.keycode === tapKeycode && modsMatch(e)) {
          held = true;
          send('voice:hold-down');
        }
      });
      uIOhook.on('keyup', (e) => {
        markAlive();
        if (!held) return;
        if (e.keycode === tapKeycode || MOD_KEYS.has(e.keycode)) {
          held = false;
          send('voice:hold-up');
        }
      });

      uIOhook.start();
      app.on('will-quit', () => { try { uIOhook.stop(); } catch (_) {} });
      console.log('[voice] native key tap armed (awaiting first event to prove Input Monitoring)');
      return true;
    } catch (e) {
      console.log('[voice] native key tap unavailable (continuing with toggle):', e && e.message);
      return false;
    }
  };
  tryStartNativeTap();
  startFnWatcher();
  registerVoiceShortcut();
  app.on('browser-window-focus', unregisterFallbackShortcut);
  app.on('browser-window-blur', registerVoiceShortcut);

  // The focused-window relay matches the FALLBACK chord: special primaries (fn, Ctrl+Win) are
  // invisible to renderer key events, their tiers prove themselves through native taps instead.
  const inputMatchesCombo = (input) => {
    const c = fallbackCombo;
    const k = c.key;
    const keyHit = k.length === 1
      ? (input.code === `Key${k.toUpperCase()}` || (input.key || '').toLowerCase() === k.toLowerCase())
      : (input.code === k || input.key === k);
    return keyHit &&
      (!c.mods.meta || input.meta) &&
      (!c.mods.ctrl || input.control) &&
      (!c.mods.alt || input.alt) &&
      (!c.mods.shift || input.shift);
  };

  const installVoiceHoldRelay = (contents) => {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (inputMatchesCombo(input)) {
        if (!primaryProven()) sendFallbackToggle();
        event.preventDefault();
      }
    });
  };
  // Installed via web-contents-created: the main window is born later in the whenReady sequence, and
  // webview guests swallow keys when a page has focus, so every window/guest gets the relay.
  app.on('web-contents-created', (event, contents) => {
    const t = contents.getType();
    if (t === 'window' || t === 'webview') installVoiceHoldRelay(contents);
  });

  // Renderer pushes the user's saved combo on boot and whenever Settings changes it.
  ipcMain.on('voice:set-hotkey', (_e, comboStr) => {
    const next = parseCombo(comboStr);
    if (next.accel === combo.accel) return;
    combo = next;
    fallbackCombo = combo.special ? parseCombo(LEGACY_COMBO) : combo;
    if (UiohookKeyRef && !combo.special) tapKeycode = uiohookKeycodeFor(combo.key, UiohookKeyRef);
    startFnWatcher();
    unregisterFallbackShortcut();
    registerVoiceShortcut();
    console.log('[voice] hotkey set to', combo.accel);
  });

  ipcMain.handle('voice:hold-capable', () => tapProven || fnProven);
  // Settings' "Hold to talk" fires the Accessibility prompt; Input Monitoring has no Electron API,
  // but a running tap makes macOS list the app in that pane for the user to flip.
  ipcMain.handle('voice:request-hold-permission', () => {
    if (process.platform === 'darwin' && !tapProven) {
      try { systemPreferences.isTrustedAccessibilityClient(true); } catch (_) {}
    }
    return tapProven;
  });
  // Fires the real TCC mic prompt BEFORE the first capture: with the entitlement present but no
  // prior grant, getUserMedia would still fail once and burn the user's first dictation attempt.
  ipcMain.handle('voice:request-mic-access', async () => {
    if (process.platform !== 'darwin') return true;
    try {
      if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
      return await systemPreferences.askForMediaAccess('microphone');
    } catch (_) {
      return false;
    }
  });
}

/**
 * PIDs of fn-watcher processes that are NOT this app's, given `ps -eo pid=,args=` output.
 *
 * Matched on the absolute binary path so an unrelated program never matches, and our own pid is
 * excluded. Pure so the selection can be tested; the killing stays at the call site.
 */
function strayFnWatcherPids(psOutput, binPath, selfPid) {
  const pids = [];
  if (!binPath) return pids;
  for (const line of String(psOutput || '').split('\n')) {
    if (line.indexOf(binPath) < 0) continue;
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) continue;
    pids.push(pid);
  }
  return pids;
}

module.exports = { installVoiceHotkey, strayFnWatcherPids };
