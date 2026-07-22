// Local speech-to-text via whisper.cpp, kept WARM so a phrase transcribes in ~0.2s instead of the
// ~16s cold-model-load a fresh CLI pays every time. We spawn `whisper-server` once (model loaded),
// then POST audio to it per utterance. Same "bundle a binary + manage its lifecycle" shape as the
// 9router subprocess: dev uses the system whisper.cpp, prod uses the per-arch binary + model we ship.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const MODEL_FILE = 'ggml-base.en.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

// First-run model fetch, so a dev build (or a prod build that shipped without the model) still works
// instead of dead-ending on "no model". Progress is exposed so the pill can say "Preparing voice 40%".
const download = { active: false, pct: 0, error: null };

function downloadModel(dest) {
  if (download.active) return;
  download.active = true;
  download.pct = 0;
  download.error = null;
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) {}
  const tmp = `${dest}.part`;
  const file = fs.createWriteStream(tmp);
  const req = https.get(MODEL_URL, (res) => {
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      // Follow HuggingFace's CDN redirect once.
      https.get(res.headers.location, (r2) => pipeTo(r2, file, tmp, dest)).on('error', onErr);
      return;
    }
    pipeTo(res, file, tmp, dest);
  });
  req.on('error', onErr);
  function onErr(e) { download.active = false; download.error = String(e && e.message ? e.message : e); try { file.close(); fs.unlinkSync(tmp); } catch (_) {} }
}

function pipeTo(res, file, tmp, dest) {
  const total = Number(res.headers['content-length'] || 0);
  let got = 0;
  res.on('data', (c) => { got += c.length; if (total) download.pct = Math.round((got / total) * 100); });
  res.pipe(file);
  file.on('finish', () => file.close(() => {
    try { fs.renameSync(tmp, dest); download.pct = 100; } catch (e) { download.error = String(e); }
    download.active = false;
  }));
  res.on('error', () => { download.active = false; download.error = 'stream-error'; try { fs.unlinkSync(tmp); } catch (_) {} });
}

function modelStatus() {
  return { downloading: download.active, pct: download.pct, error: download.error };
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

// Resolve the model file. Env override, then bundled, then a dev cache under the app's data dir.
function resolveModel(resourceDir, userDataDir) {
  if (process.env.OPENSWARM_WHISPER_MODEL && fs.existsSync(process.env.OPENSWARM_WHISPER_MODEL)) {
    return process.env.OPENSWARM_WHISPER_MODEL;
  }
  const bundled = path.join(resourceDir, MODEL_FILE);
  if (fs.existsSync(bundled)) return bundled;
  const cached = path.join(userDataDir, 'whisper', MODEL_FILE);
  if (fs.existsSync(cached)) return cached;
  return null;
}

let proc = null;
let port = 0;
let readyPromise = null;

function pickPort() {
  // Fixed-ish high port; whisper-server has no ephemeral-port reporting, so we pick and probe.
  return 8300 + Math.floor(Math.random() * 400);
}

async function waitForReady(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { method: 'GET' });
      if (res.status) return true; // any HTTP answer means the socket is serving
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Boot the warm server once. resourceDir = where a packaged build put the binary+model; userDataDir
// = app.getPath('userData') for the dev cache. Returns the port, or throws with an actionable reason.
async function ensureServer(resourceDir, userDataDir) {
  if (proc && port) return port;
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const bin = resolveBinary(resourceDir);
    const model = resolveModel(resourceDir, userDataDir);
    if (!model) {
      readyPromise = null;
      // Kick off a one-time background fetch to the dev cache so the NEXT dictation just works.
      downloadModel(path.join(userDataDir, 'whisper', MODEL_FILE));
      throw new Error(download.active ? 'model-downloading' : 'no-model');
    }
    const p = pickPort();
    const child = spawn(bin, ['-m', model, '--port', String(p), '-nt', '--convert'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', () => { proc = null; port = 0; });
    child.on('exit', () => { proc = null; port = 0; readyPromise = null; });
    const ok = await waitForReady(p, 20000);
    if (!ok) {
      try { child.kill(); } catch (_) {}
      readyPromise = null;
      throw new Error('server-timeout');
    }
    proc = child;
    port = p;
    return p;
  })();
  return readyPromise;
}

// Transcribe a 16kHz-mono WAV buffer to text. The renderer records + encodes the WAV so the audio
// never crosses a CORS boundary; we POST from the main process where there is none.
async function transcribe(resourceDir, userDataDir, wavBuffer) {
  const p = await ensureServer(resourceDir, userDataDir);
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'text');
  const res = await fetch(`http://127.0.0.1:${p}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper-http-${res.status}`);
  const text = (await res.text()).trim();
  return text;
}

function stopServer() {
  if (proc) {
    try { proc.kill(); } catch (_) {}
  }
  proc = null;
  port = 0;
  readyPromise = null;
}

module.exports = { ensureServer, transcribe, stopServer, resolveBinary, resolveModel, modelStatus };
