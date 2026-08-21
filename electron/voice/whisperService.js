// Local speech-to-text via whisper.cpp, kept WARM so a phrase transcribes in ~0.2s instead of the
// ~16s cold-model-load a fresh CLI pays every time. We spawn `whisper-server` once (model loaded),
// then POST audio to it per utterance. Same "bundle a binary + manage its lifecycle" shape as the
// 9router subprocess: dev uses the system whisper.cpp, prod uses the per-arch binary + model we ship.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const whisperModels = require('./whisperModels');

// Which catalog model the user picked. Settings pushes it in; until then the catalog default wins.
let selectedModelId = whisperModels.DEFAULT_MODEL_ID;
// The user's personal glossary, pushed from Settings; fed to whisper as a decode prompt so names
// and jargon bias recognition without any retraining (the classic initial-prompt trick).
let dictionaryPrompt = '';

function setDictionary(words) {
  const clean = String(words || '').split(',').map((w) => w.trim()).filter(Boolean).slice(0, 60);
  dictionaryPrompt = clean.length ? `Glossary: ${clean.join(', ')}.` : '';
}

function modelStatus() {
  return whisperModels.downloadStatus();
}

// Resolve the whisper-server binary. Env override wins (dev convenience), then the bundled per-arch
// copy, then whatever is on PATH so a dev machine with `brew install whisper-cpp` just works.
function resolveBinary(resourceDir) {
  if (process.env.OPENSWARM_WHISPER_BIN && fs.existsSync(process.env.OPENSWARM_WHISPER_BIN)) {
    return process.env.OPENSWARM_WHISPER_BIN;
  }
  const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  const bundled = path.join(resourceDir, exe);
  if (fs.existsSync(bundled)) return bundled;
  const brew = process.platform === 'win32' ? null : '/opt/homebrew/bin/whisper-server';
  if (brew && fs.existsSync(brew)) return brew;
  return exe; // last resort: hope it is on PATH
}

function resolveModel(resourceDir, userDataDir) {
  return whisperModels.resolveModelFile(resourceDir, userDataDir, selectedModelId);
}

let proc = null;
// Tracked from SPAWN, not from ready: a quit during the 15-38s model load used to see proc=null, kill nothing, and orphan the child (and leaked servers wedge every later boot's Metal init).
let bootingChild = null;
let port = 0;
let readyPromise = null;
let idleTimer = null;
let loadedModelFile = null;

// A warm server holds ~210MB (measured, base.en). Free it after a long quiet spell; the reload that
// costs is the FIRST one on a cold page cache, and boot-warm already paid that.
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

// Let the OS name a free port instead of guessing one. A guessed port that is already taken makes
// whisper exit(1) AND makes our readiness probe accept the squatter's reply as proof of life, so we
// would happily POST the user's audio at a stranger.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      probe.close(() => resolve(addr.port));
    });
  });
}

async function waitForReady(child, p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false; // died mid-load; stop waiting
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { method: 'GET' });
      if (res.status) return true; // the socket is ours and it is serving
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function p_touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; stopServer(); }, IDLE_UNLOAD_MS);
  if (idleTimer.unref) idleTimer.unref(); // an idle countdown must never be the reason the app won't quit
}

// NEVER os.tmpdir(): ggml readdirs the cwd hunting for backend dylibs before printing a byte, and a real user temp dir can hold hundreds of thousands of entries (measured 237k+, 25s to enumerate), stalling the server past its ready budget with zero output.
function p_privateCwd(userDataDir) {
  const dir = path.join(userDataDir, 'whisper-tmp');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return os.tmpdir(); }
  return dir;
}

// A leaked server from a dead session wedges every NEW server's Metal init (machine-wide dead dictation), so before booting, kill any instance of OUR binary that is not one of our live children.
function p_sweepStrays(bin) {
  if (process.platform === 'win32' || !bin.startsWith('/')) return;
  try {
    const out = require('child_process').execSync('ps -axo pid=,command=', { encoding: 'utf8', timeout: 3000 });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m || !(m[2] === bin || m[2].startsWith(bin + ' '))) continue;
      const pid = Number(m[1]);
      if ((proc && pid === proc.pid) || (bootingChild && pid === bootingChild.pid)) continue;
      try { process.kill(pid, 'SIGKILL'); console.log(`[voice] swept stray whisper-server pid=${pid}`); } catch (_) {}
    }
  } catch (_) { /* sweep is best-effort */ }
}

// 44-byte RIFF header + silence, 16kHz mono, matching what the renderer sends.
function p_silentWav(seconds) {
  const samples = Math.round(16000 * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

// A loaded model is not a ready one: the first inference pays a one-off graph/kernel allocation
// (measured ~180ms on an M2). Spend it on silence at boot so the user's first phrase doesn't.
async function p_primeGraph(p) {
  try {
    const form = new FormData();
    form.append('file', new Blob([p_silentWav(0.5)], { type: 'audio/wav' }), 'warm.wav');
    form.append('response_format', 'text');
    const res = await fetch(`http://127.0.0.1:${p}/inference`, { method: 'POST', body: form });
    await res.text();
  } catch (_) { /* priming is an optimization; a failure just means the first phrase pays it */ }
}

// Pull the one line a human can act on out of whisper's chatty output.
function p_reasonFrom(tail) {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const blame = lines.filter((l) => /error|failed|invalid|unable|cannot|no such|not found/i.test(l));
  const pick = blame.length ? blame[blame.length - 1] : lines[lines.length - 1];
  return pick ? `: ${pick.slice(0, 200)}` : '';
}

async function p_bootServer(resourceDir, userDataDir, extended = true) {
  const bin = resolveBinary(resourceDir);
  const model = resolveModel(resourceDir, userDataDir);
  if (!model) {
    // Kick off a one-time background fetch so the NEXT dictation just works.
    whisperModels.downloadModel(userDataDir, selectedModelId);
    throw new Error(whisperModels.downloadStatus().downloading ? 'model-downloading' : 'no-model');
  }
  loadedModelFile = model;
  p_sweepStrays(bin);
  const p = await freePort();
  // No --convert: our WAV is already 16kHz mono, and the flag makes whisper demand ffmpeg on PATH at boot; a Finder-launched app has no brew PATH, so it exited before ever binding the port.
  // Decode setup from the OSS-dictation survey (VoiceTypr/VoiceInk consensus): beam 5 over greedy,
  // suppress-nst kills non-speech captions AT the decoder, no-context stops cross-segment
  // hallucination carryover, flash-attn is a free Metal win. extended=false retries with the
  // minimal set so an older binary missing a flag can never kill dictation.
  const args = ['-m', model, '--port', String(p), '-nt', '-bs', '5'];
  if (extended) args.push('--suppress-nst', '--no-context', '--flash-attn');
  // A multilingual model (no .en in the filename) auto-detects the spoken language per utterance.
  if (!path.basename(model).includes('.en')) args.push('-l', 'auto');
  const child = spawn(bin, args, {
    cwd: p_privateCwd(userDataDir), // a writable, EMPTY dir: whisper writes temp files beside cwd, and ggml scans cwd at boot (see p_privateCwd)
    // BOTH pipes: whisper writes its fatal reasons to STDOUT and then exits 0, so an ignored stdout
    // turns "ffmpeg is missing" into an unexplained failure. Draining also stops the pipe buffer
    // filling and blocking the child.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bootingChild = child;
  // Keep a rolling tail rather than the last chunk: whisper prints its real reason and THEN keeps
  // banner-dumping, so "the most recent bytes" is reliably the least useful line it wrote.
  let tail = '';
  const drain = (c) => {
    const said = String(c);
    if (!said.trim()) return;
    tail = (tail + said).slice(-4000);
    console.log('[voice] whisper:', said.trim().slice(0, 400));
  };
  child.stdout.on('data', drain);
  child.stderr.on('data', drain);
  child.on('error', () => { if (bootingChild === child) bootingChild = null; proc = null; port = 0; });
  child.on('exit', (code) => { if (code) console.log(`[voice] whisper-server exited code=${code}`); if (bootingChild === child) bootingChild = null; proc = null; port = 0; readyPromise = null; });
  // Cold model load measured 15-38s on an M2; the old 20s budget timed out real first uses.
  const ok = await waitForReady(child, p, 60000);
  if (!ok) {
    bootingChild = null;
    try { child.kill('SIGKILL'); } catch (_) {}
    // An instantly-dead child with the extended flags is probably an older binary: retry minimal.
    if (extended && (child.exitCode !== null || child.signalCode !== null)) {
      console.log('[voice] extended decode flags rejected; retrying with the minimal set');
      return p_bootServer(resourceDir, userDataDir, false);
    }
    // A dead child is not a slow one. Whisper can die in ~0.1s with exit code 0 (a missing ffmpeg on
    // a Finder-launched PATH does exactly that), so report ITS reason instantly instead of making the
    // user sit through the full ready budget for a process that was never coming back.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`whisper-exited-${child.exitCode}${p_reasonFrom(tail)}`);
    }
    throw new Error('server-timeout');
  }
  proc = child;
  bootingChild = null;
  port = p;
  await p_primeGraph(p);
  p_touchIdle();
  return p;
}

// Boot the warm server once. resourceDir = where a packaged build put the binary+model; userDataDir
// = app.getPath('userData') for the dev cache. Returns the port, or throws with an actionable reason.
// The readyPromise is cleared AFTER it settles, never synchronously inside the async body: the old
// code reset it inside the IIFE where the outer assignment immediately overwrote the null, pinning a
// settled-rejected promise forever so every later call kept throwing "model-downloading" even after
// the model finished. Clearing on rejection here lets the next call retry cleanly.
async function ensureServer(resourceDir, userDataDir) {
  // The user's pick may still be missing (boot prefetch running or failed): pull it now, let whatever IS installed serve this dictation, and the model-switch check below hot-swaps once it lands.
  prefetchModel(resourceDir, userDataDir);
  // A warm server is only reusable if it holds the file we would load now: a model switch, or the
  // user's pick finishing its download while a fallback was serving, has to re-boot.
  if (proc && port && resolveModel(resourceDir, userDataDir) !== loadedModelFile) stopServer();
  if (proc && port) return port;
  if (readyPromise) return readyPromise;
  readyPromise = p_bootServer(resourceDir, userDataDir);
  try {
    return await readyPromise;
  } catch (err) {
    readyPromise = null;
    throw err;
  }
}

// Transcribe a 16kHz-mono WAV buffer to text. The renderer records + encodes the WAV so the audio
// never crosses a CORS boundary; we POST from the main process where there is none.
async function transcribe(resourceDir, userDataDir, wavBuffer) {
  const p = await ensureServer(resourceDir, userDataDir);
  markUsed(userDataDir);
  p_touchIdle();
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'text');
  // 0.2 + 0.2 fallback ladder is what VoiceTypr and VoiceInk ship; whisper's 0.0 greedy start
  // retries into hallucination on marginal audio.
  form.append('temperature', '0.2');
  form.append('temperature_inc', '0.2');
  if (dictionaryPrompt) form.append('prompt', dictionaryPrompt);
  const res = await fetch(`http://127.0.0.1:${p}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper-http-${res.status}`);
  const text = (await res.text()).trim();
  return text;
}

// Shipped builds carry no model (build-whisper.sh stages only the server), so a fresh install used to pay the 190MB download under its first dictation press; pulled at boot instead, and refused where no engine could ever run it.
function prefetchModel(resourceDir, userDataDir) {
  if (!fs.existsSync(resolveBinary(resourceDir))) return false;
  if (process.env.OPENSWARM_WHISPER_MODEL && fs.existsSync(process.env.OPENSWARM_WHISPER_MODEL)) return false;
  if (whisperModels.isInstalled(userDataDir, selectedModelId)) return false;
  if (whisperModels.downloadStatus().downloading) return false;
  whisperModels.downloadModel(userDataDir, selectedModelId);
  return true;
}

// A user who has never dictated should not pay a model-resident whisper-server for 10 minutes
// after every boot; the marker appears on the first real transcription and unlocks boot-warm for
// every boot after. Their one cold load lands under the first-ever phrase, same as VoiceInk.
function p_usedMarkerPath(userDataDir) {
  return path.join(userDataDir, 'dictation-used');
}

function markUsed(userDataDir) {
  try { fs.writeFileSync(p_usedMarkerPath(userDataDir), '1'); } catch (_) {}
}

function hasBeenUsed(userDataDir) {
  try { return fs.existsSync(p_usedMarkerPath(userDataDir)); } catch (_) { return false; }
}

// Boot the model in the background at app start so the expensive FIRST load (cold page cache, and on
// a packaged build the OS's first-exec check of the bundled binary) never lands under a keypress.
// Deliberately refuses to download: a user who never dictates should not silently pull 148MB.
// Returns whether a warm was actually started, so the caller can log the honest reason.
function warmInBackground(resourceDir, userDataDir) {
  if (proc || readyPromise) return true; // already warm or warming; ensureServer dedupes anyway
  if (!hasBeenUsed(userDataDir)) return false;
  if (!resolveModel(resourceDir, userDataDir)) return false;
  ensureServer(resourceDir, userDataDir).catch(() => {});
  return true;
}

function stopServer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // SIGKILL both: the server is stateless, and a mid-boot child left alive poisons the machine.
  if (proc) {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
  if (bootingChild) {
    try { bootingChild.kill('SIGKILL'); } catch (_) {}
  }
  proc = null;
  bootingChild = null;
  port = 0;
  readyPromise = null;
  loadedModelFile = null;
}

// Settings picked a different model. Downloads it if missing; the running server keeps serving the
// old one until the new file is complete, so switching never leaves dictation dead in between.
function setModel(userDataDir, id) {
  const next = whisperModels.modelById(id).id;
  if (next === selectedModelId) return whisperModels.isInstalled(userDataDir, next);
  selectedModelId = next;
  if (whisperModels.isInstalled(userDataDir, next)) return true;
  whisperModels.downloadModel(userDataDir, next);
  return false;
}

function selectedModel() {
  return selectedModelId;
}

function isWarm() {
  return Boolean(proc && port);
}

// Sleep evicts the GPU-side state a warm server built, so the first phrase after a lid-open pays for
// it again. Re-prime on wake instead of restarting: same fix openwhispr and VoiceInk landed.
async function reprimeAfterWake() {
  if (!isWarm()) return false;
  await p_primeGraph(port);
  return true;
}

module.exports = { ensureServer, warmInBackground, prefetchModel, reprimeAfterWake, transcribe, stopServer, isWarm, setModel, setDictionary, selectedModel, resolveBinary, resolveModel, modelStatus, markUsed, hasBeenUsed };
