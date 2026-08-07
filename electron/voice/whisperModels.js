// The dictation model catalog: which whisper builds we offer, where they come from, and how a
// chosen one gets onto disk intact. Split out of whisperService.js because "which file" and "the
// running server" are different jobs with different failure modes.
//
// Only English models: dictation lands in the user's own text field, and the .en builds are both
// smaller and more accurate than their multilingual siblings at the same size. Quantized (q5_1)
// variants are the field default (Handy and FluidVoice both standardised on quantized weights);
// they trade a sliver of accuracy for a third of the download.
//
// sha256 is the trust anchor. These are the HuggingFace LFS object ids, which ARE the file digests,
// so a truncated, resumed-wrong, or proxy-substituted body is rejected instead of handed to a
// native parser.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MODELS = [
  { id: 'tiny.en-q5_1', file: 'ggml-tiny.en-q5_1.bin', label: 'Tiny', note: 'Fastest, but gets lost past ~15s of speech', bytes: 32166155, sha256: 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b' },
  { id: 'base.en-q5_1', file: 'ggml-base.en-q5_1.bin', label: 'Base (compact)', note: 'Base quality and speed, 90MB less to download and hold', bytes: 59721011, sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f' },
  { id: 'base.en', file: 'ggml-base.en.bin', label: 'Base', note: 'Fast and light; the instant fallback while Small downloads', bytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  { id: 'small.en-q5_1', file: 'ggml-small.en-q5_1.bin', label: 'Small', note: 'Most accurate, the default; steadier on accents and noise', bytes: 190098681, sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30' },
  { id: 'small-q5_1', file: 'ggml-small-q5_1.bin', label: 'Small (multilingual)', note: 'Auto-detects the spoken language; slightly less sharp on English', bytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
];
// Measured on an M2 (quiet machine, 3.5s/8.1s/26.4s utterances, median of 5):
//   tiny  174/154/241ms  base-q5_1  212/414/656ms  base  208/398/734ms  small  865/1108/1869ms
// small.en-q5_1 is the default (Eric's call, 2026-08-05: accuracy first): streaming partials hide
// most of its extra decode cost, and the bundled base.en serves instantly while it downloads.
// large-v3-turbo is deliberately absent, it measured both slowest and least accurate here
// (4.1s on a 3.5s clip, and it fell apart on the long one).

const DEFAULT_MODEL_ID = 'small.en-q5_1';
const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

function modelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL_ID);
}

function modelDir(userDataDir) {
  return path.join(userDataDir, 'whisper');
}

function modelPath(userDataDir, id) {
  return path.join(modelDir(userDataDir), modelById(id).file);
}

// A file is only "installed" once it is exactly the size the catalog says. A short file is a
// half-download someone's disk filled up on, and whisper would die parsing it.
function isInstalled(userDataDir, id) {
  const m = modelById(id);
  try { return fs.statSync(modelPath(userDataDir, id)).size === m.bytes; } catch (_) { return false; }
}

// Resolve the model file to actually load: env override, then the user's pick, then anything else
// already on disk, then bundled. Never returns a path that isn't a complete file.
function resolveModelFile(resourceDir, userDataDir, id) {
  if (process.env.OPENSWARM_WHISPER_MODEL && fs.existsSync(process.env.OPENSWARM_WHISPER_MODEL)) {
    return process.env.OPENSWARM_WHISPER_MODEL;
  }
  if (id && isInstalled(userDataDir, id)) return modelPath(userDataDir, id);
  const bundled = path.join(resourceDir, modelById(DEFAULT_MODEL_ID).file);
  if (fs.existsSync(bundled)) return bundled;
  // The user's pick isn't down yet but something else is: dictate with what we have rather than
  // dead-ending on "no model" while a 190MB download runs.
  const fallback = MODELS.find((m) => isInstalled(userDataDir, m.id));
  return fallback ? modelPath(userDataDir, fallback.id) : null;
}

const download = { active: false, id: null, pct: 0, error: null };

function downloadStatus() {
  return { downloading: download.active, id: download.id, pct: download.pct, error: download.error };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Fetch a catalog model into the user data dir. One at a time, resumable-free but atomic: bytes land
// in a .part file that only gets its real name after the digest matches.
function downloadModel(userDataDir, id) {
  if (download.active) return;
  const m = modelById(id);
  const dest = modelPath(userDataDir, m.id);
  download.active = true;
  download.id = m.id;
  download.pct = 0;
  download.error = null;
  try { fs.mkdirSync(modelDir(userDataDir), { recursive: true }); } catch (_) {}
  const tmp = `${dest}.part`;
  try { fs.unlinkSync(tmp); } catch (_) {}

  const fail = (msg) => {
    download.active = false;
    download.error = String(msg);
    try { fs.unlinkSync(tmp); } catch (_) {}
  };

  // HuggingFace bounces resolve -> CDN -> signed URL, so follow redirects instead of assuming one hop.
  const fetchUrl = (url, hops) => {
    if (hops > 6) { fail('too-many-redirects'); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'openswarm-voice' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume(); // drain so the socket frees
        fetchUrl(new URL(res.headers.location, url).toString(), hops + 1);
        return;
      }
      if (code !== 200) { res.resume(); fail(`http-${code}`); return; }
      let got = 0;
      const file = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        download.pct = Math.min(99, Math.round((got / m.bytes) * 100));
        // A server that keeps sending past the advertised size must not be allowed to fill the disk.
        if (got > m.bytes) { req.destroy(); fail('oversize'); }
      });
      res.pipe(file);
      file.on('finish', () => file.close(async () => {
        if (!download.active) return; // already failed out
        if (got !== m.bytes) { fail('truncated'); return; }
        try {
          const digest = await sha256File(tmp);
          if (digest !== m.sha256) { fail('checksum-mismatch'); return; }
          fs.renameSync(tmp, dest);
          download.pct = 100;
          download.active = false;
        } catch (e) { fail(e && e.message ? e.message : e); }
      }));
      res.on('error', () => fail('stream-error'));
      file.on('error', () => fail('write-error'));
    });
    req.on('error', (e) => fail(e && e.message ? e.message : e));
  };
  fetchUrl(`${BASE_URL}${m.file}`, 0);
}

// What Settings renders: every model, its size, and whether it is already on this machine.
function catalog(userDataDir) {
  return MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    note: m.note,
    sizeMb: Math.round(m.bytes / 1048576),
    installed: isInstalled(userDataDir, m.id),
  }));
}

module.exports = { MODELS, DEFAULT_MODEL_ID, catalog, downloadModel, downloadStatus, isInstalled, modelById, modelPath, resolveModelFile };
