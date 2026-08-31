const { app, BrowserWindow, globalShortcut, ipcMain, shell, systemPreferences } = require('electron');
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
// How long a tap may stay silent before we stop calling it "awaiting proof" and call it broken.
const FN_PROOF_GRACE_MS = 60_000;
// How often to re-ask "was the user typing while the watcher stayed silent?".
const FN_DEAF_POLL_MS = 15_000;
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
  // App-scoped by default (ENG-341): hotkeys act only while an OpenSwarm window is focused, unless
  // the user opts into dictate-anywhere in Settings.
  let worksAnywhere = false;
  const send = (channel) => {
    if (!worksAnywhere && BrowserWindow.getFocusedWindow() === null) return;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };

  let combo = parseCombo(DEFAULT_COMBO);
  // Special combos (Fn, Ctrl+Meta) have no accelerator; the LEGACY chord backs them until proven.
  let fallbackCombo = combo.special ? parseCombo(LEGACY_COMBO) : combo;
  let tapProven = false;
  let fnProven = false;
  // What the watcher TOLD us, as opposed to what we guessed from it still being alive.
  let fnPermission = 'unknown';
  let fnWireAlive = false;
  // Proof the USER was at the keyboard, which is what makes a silent tap mean anything.
  let rendererSawKeys = false;
  let unusableNotified = false;
  let lastHotkeyIssue = null;
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
      if (combo.special !== 'fn' && Date.now() - lastTapKeyMs < TAP_FRESH_MS) {
        console.log('[voice] fallback toggle suppressed (a live tap is serving the primary)');
        return;
      }
      const focused = BrowserWindow.getFocusedWindow() !== null;
      console.log(`[voice] fallback toggle -> voice:toggle (focused=${focused}, anywhere=${worksAnywhere})`);
      send('voice:toggle');
    }, FALLBACK_DEFER_MS);
  };

  // A dictation key that does nothing, forever, with nothing said, is the actual bug here: fn is
  // the default, only the native watcher can see it, and app-scoped mode registers no global
  // fallback, so a deaf tap left the user with no trigger AND no signal. Whenever the primary
  // cannot serve, say so once and name the chord that does work right now.
  const notifyPrimaryUnusable = (reason) => {
    if (unusableNotified || primaryProven()) return;
    unusableNotified = true;
    // Remembered, not just fired: arming happens at boot and the renderer subscribes later, so a
    // pure event is delivered to nobody and the warning goes silent again (caught live).
    lastHotkeyIssue = { ok: false, reason, fallback: fallbackCombo.accel };
    console.log(`[voice] fn primary unusable (${reason}); dictation falls back to ${fallbackCombo.accel}`);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('voice:primary-unusable', { reason, fallback: fallbackCombo.accel });
    }
  };

  // Only the tier that can actually SERVE the primary combo may retire the fallbacks: the uiohook
  // tap cannot see fn (keycode 63 is VC_UNDEFINED), so with an fn primary a proven tap must not
  // silence the legacy chord (caught live: focused Cmd+Shift+D went dead the moment any key flowed).
  const primaryProven = () => (combo.special === 'fn' ? fnProven : (tapProven || fnProven));

  // Fallback shortcut stays registered while unfocused until the primary tier proves alive.
  const registerVoiceShortcut = () => {
    if (!worksAnywhere) return;
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
  // `asked` runs once the Input Monitoring request is actually in flight (or provably never will
  // be). Anything that touches Accessibility must wait for it; see rdar://7381305.
  const startFnWatcher = (noPrompt, asked) => {
    const done = () => { if (typeof asked === 'function') asked(); };
    if (process.platform !== 'darwin' || combo.special !== 'fn' || fnProc) { done(); return; }
    resolveFnWatcherBinary((bin) => {
      if (!bin) {
        console.log('[voice] no fn watcher binary, legacy hotkey stays primary');
        notifyPrimaryUnusable('no-watcher-binary');
        done();
        return;
      }
      if (combo.special !== 'fn' || fnProc) { done(); return; }
      startFnWatcherWith(bin, noPrompt === true);
      done();
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
  // Focus re-arms the watcher's tap: a tap another app registered after ours head-inserts AHEAD of
  // ours and can eat fn with no disable event delivered, so this is the only recovery (ENG-317).
  let lastFnPokeMs = 0;
  const pokeFnWatcher = () => {
    if (!fnProc || !fnProc.stdin || !fnProc.stdin.writable) return;
    const now = Date.now();
    if (now - lastFnPokeMs < 1000) return;
    lastFnPokeMs = now;
    try { fnProc.stdin.write('r\n'); } catch (_) {}
  };
  const startFnWatcherWith = (bin, noPrompt) => {
    sweepStrayFnWatchers(bin);
    try {
      // stdin stays open on purpose: "r\n" re-arms the tap, and EOF tells an orphaned watcher to die.
      fnProc = spawn(bin, noPrompt ? ['--no-prompt'] : [], { stdio: ['pipe', 'pipe', 'ignore'] });
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
        if (line === 'p granted' || line === 'p denied') {
          fnPermission = line.slice(2);
          console.log(`[voice] fn watcher Input Monitoring: ${fnPermission}`);
          if (fnPermission === 'denied') notifyPrimaryUnusable('input-monitoring-denied');
        } else if (line === 't ok') {
          console.log('[voice] fn watcher tap created');
        } else if (line === 'w') {
          fnWireAlive = true;
          console.log('[voice] fn watcher wire alive (tap is receiving key events)');
        } else if (line === 'd' || line === 'u') {
          if (!fnProven) {
            fnProven = true;
            unregisterFallbackShortcut();
            console.log('[voice] fn watcher PROVEN (events flowing), fn hold-to-talk enabled');
            // Withdraw the fallback notice, or a key that started working keeps telling the user it is broken.
            lastHotkeyIssue = null;
            if (unusableNotified) {
              unusableNotified = false;
              const w = getMainWindow();
              if (w && !w.isDestroyed()) w.webContents.send('voice:primary-usable');
            }
          }
          if (combo.special === 'fn') send(line === 'd' ? 'voice:hold-down' : 'voice:hold-up');
        } else if (line.startsWith('e')) {
          console.log('[voice] fn watcher error:', line);
          // The watcher deliberately stays alive when denied (it keeps the app listed in the
          // Input Monitoring pane), so liveness proves nothing and this line is the signal.
          if (line.includes('no-permission')) notifyPrimaryUnusable('input-monitoring-denied');
        }
      }
    });
    fnProc.on('exit', (code) => {
      console.log(`[voice] fn watcher exited code=${code}; legacy hotkey resumes`);
      notifyPrimaryUnusable(`watcher-exit-${code}`);
      fnProc = null;
      fnProven = false;
      registerVoiceShortcut();
    });
    if (!quitReaperWired) {
      quitReaperWired = true;
      app.on('will-quit', () => { try { fnProc && fnProc.kill('SIGKILL'); } catch (_) {} });
    }
    console.log('[voice] fn watcher armed (awaiting first event to prove Input Monitoring)');
    // Armed is not working. If the tap is still deaf after a spell of real use, that is a dead key,
    // not a shy one, and the user deserves to hear it rather than keep pressing a key that no
    // longer does anything (it regressed silently once already).
    // "No fn events yet" is NOT evidence of a deaf tap. The watcher only taps flagsChanged, so
    // wireAlive needs a MODIFIER press; a user who reads the screen, clicks around, or types a
    // lowercase prompt produces none. The old fixed timer therefore told anyone who was merely
    // quiet for a minute that their fn key was broken, which is a lying status, and it pushed them
    // onto the fallback chord for a key that worked fine (observed 2026-08-30 on a packaged build:
    // "granted" then "tap-deaf" on a tap that was never touched).
    //
    // Deafness is only a fact when the user WAS at the keyboard and the watcher still heard nothing,
    // so wait for that pairing instead of for the clock, and keep waiting rather than giving up.
    const deafPoll = setInterval(() => {
      if (unusableNotified || primaryProven() || !fnProc) { clearInterval(deafPoll); return; }
      if (fnWireAlive) { clearInterval(deafPoll); return; }
      if (!rendererSawKeys) return;
      clearInterval(deafPoll);
      notifyPrimaryUnusable('tap-deaf');
    }, FN_DEAF_POLL_MS);
    if (typeof deafPoll.unref === 'function') deafPoll.unref();
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
  // Arming the native tiers is what raises macOS's Input Monitoring prompt, so a fresh install must
  // NOT arm at boot (ENG-341): the prompt fires at first dictation use instead, with context.
  let tiersArmed = false;
  const armNativeTiers = () => {
    if (tiersArmed) return;
    tiersArmed = true;
    // ORDER IS LOAD-BEARING (rdar://7381305 / FB7381305): once AXIsProcessTrustedWithOptions has
    // been called, IOHIDRequestAccess stops raising the Input Monitoring dialog entirely. Electron's
    // isTrustedAccessibilityClient IS that call, and tryStartNativeTap makes it, so asking for the
    // tap first is what silently ate the fn prompt. Ask for Input Monitoring FIRST, always.
    // It has to be a CALLBACK: the dev path compiles the watcher first, so a plain statement order
    // still let the Accessibility check win on wall-clock and the prompt stayed dead.
    const armTapTier = () => {
      const tapOk = tryStartNativeTap();
      // Ctrl+Win is the Windows fn-equivalent and ONLY this tap can see it, so a tap that never
      // loads is the same dead key as a deaf fn watcher. Off macOS there is no TCC to blame, which
      // is exactly why it would otherwise fail with nothing said at all.
      if (tapOk === false && combo.special === 'ctrlmeta') notifyPrimaryUnusable('native-tap-unavailable');
      registerVoiceShortcut();
    };
    let tapArmed = false;
    const armTapOnce = () => { if (!tapArmed) { tapArmed = true; armTapTier(); } };
    startFnWatcher(false, armTapOnce);
    // A wedged swiftc must never cost the user their chord tier.
    setTimeout(armTapOnce, 8000);
  };
  try {
    if (fs.existsSync(path.join(app.getPath('userData'), 'dictation-used'))) armNativeTiers();
    // No marker yet: fn is the DEFAULT hotkey, and the watcher is the only thing that can see it,
    // so probe it in --no-prompt mode. Machines with Input Monitoring already granted get a working
    // fn immediately; ungranted machines exit silently and never see a boot-time TCC prompt (ENG-341).
    else if (combo.special === 'fn') startFnWatcher(true);
  } catch (_) {}
  // Coming back from System Settings is the moment a denial most likely just became a grant, and a
  // NEW child process gets a fresh TCC verdict, so retry there instead of demanding a relaunch.
  let lastGrantRetryMs = 0;
  // Gated on the user having actually gone to the pane. Retrying on EVERY focus re-raised the
  // notice the user had just dismissed, which is its own small betrayal, and spawned a doomed
  // watcher each time for a grant nobody was changing.
  let sentToGrantPane = false;
  const retryFnAfterGrant = () => {
    if (!sentToGrantPane) return;
    if (process.platform !== 'darwin' || combo.special !== 'fn' || fnProc) return;
    const now = Date.now();
    if (now - lastGrantRetryMs < 5000) return;
    lastGrantRetryMs = now;
    sentToGrantPane = false;
    unusableNotified = false;
    lastHotkeyIssue = null;
    startFnWatcher(true);
  };
  app.on('browser-window-focus', () => { unregisterFallbackShortcut(); pokeFnWatcher(); retryFnAfterGrant(); });
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

  const relayProven = new Set();
  const installVoiceHoldRelay = (contents) => {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      // The relay is the ONLY path a chord has while app-scoped, so knowing it is actually wired
      // beats inferring it from an absence of complaints.
      rendererSawKeys = true;
      if (!relayProven.has(contents.id)) {
        relayProven.add(contents.id);
        console.log(`[voice] relay live on webContents ${contents.id} (${contents.getType()}), first key=${input.key}`);
      }
      // A bare Fn keydown Chromium happens to deliver while focused is both dictation intent
      // (full-arm the tiers, prompt lands with context) and a press that must WORK right now.
      if (input.key === 'Fn' || input.code === 'Fn') {
        // Whether Chromium delivers a bare Fn at all decides if a permission-free fn is even
        // possible; on most Macs it never arrives, which is why the native watcher exists.
        console.log('[voice] Chromium delivered a bare Fn key event to the focused window');
      }
      if (combo.special === 'fn' && !primaryProven() && (input.key === 'Fn' || input.code === 'Fn')) {
        armNativeTiers();
        sendFallbackToggle();
        event.preventDefault();
        return;
      }
      if (inputMatchesCombo(input)) {
        console.log(`[voice] fallback chord seen in focused window (${fallbackCombo.accel}), primaryProven=${primaryProven()}`);
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
    if (tiersArmed) startFnWatcher();
    else if (combo.special === 'fn') startFnWatcher(true);
    unregisterFallbackShortcut();
    registerVoiceShortcut();
    console.log('[voice] hotkey set to', combo.accel);
  });

  // Renderer pushes the dictate-anywhere setting on boot and on change.
  ipcMain.on('voice:set-scope', (_e, anywhere) => {
    worksAnywhere = anywhere === true;
    if (!worksAnywhere) unregisterFallbackShortcut();
    else if (tiersArmed && BrowserWindow.getFocusedWindow() === null) registerVoiceShortcut();
  });

  // The grant is the ONLY thing that fixes a denied fn key, and macOS will not re-prompt once the
  // user has said no, so hand them the exact pane instead of a dead key and a shrug.
  ipcMain.handle('voice:open-input-monitoring', () => {
    if (process.platform !== 'darwin') return false;
    try {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
      sentToGrantPane = true;
      return true;
    } catch (_) { return false; }
  });

  // Pull, so a renderer that mounts (or reloads) after arming still learns the truth.
  ipcMain.handle('voice:hotkey-issue', () => lastHotkeyIssue);

  ipcMain.handle('voice:hold-capable', () => tapProven || fnProven);
  // Settings' "Hold to talk" fires the Accessibility prompt; Input Monitoring has no Electron API,
  // but a running tap makes macOS list the app in that pane for the user to flip.
  ipcMain.handle('voice:request-hold-permission', () => {
    armNativeTiers();
    askForFnPermission();
    if (process.platform === 'darwin' && !tapProven) {
      try { systemPreferences.isTrustedAccessibilityClient(true); } catch (_) {}
    }
    return tapProven;
  });
  // Deliberately re-asked on every dictation attempt, not once per launch: armNativeTiers is
  // one-shot, so a user who was denied (or dismissed the prompt) could never be asked again, which
  // is how a permission you are willing to grant turns into a key that just never works.
  let lastFnAskMs = 0;
  const askForFnPermission = () => {
    if (process.platform !== 'darwin' || combo.special !== 'fn' || fnProc) return;
    const now = Date.now();
    if (now - lastFnAskMs < 10_000) return;
    lastFnAskMs = now;
    unusableNotified = false;
    startFnWatcher();
  };

  // Fires the real TCC mic prompt BEFORE the first capture: with the entitlement present but no
  // prior grant, getUserMedia would still fail once and burn the user's first dictation attempt.
  ipcMain.handle('voice:request-mic-access', async () => {
    armNativeTiers();
    // Using dictation IS the intent that earns the fn prompt, every time, not just the first.
    askForFnPermission();
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
