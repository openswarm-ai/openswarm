// Node-runtime patch loaded via `node --require <this>` before 9router boots.
// Rewrites `max_tokens` to `max_completion_tokens` for GPT-5 calls (which 9router still emits) and floors completion tokens at 32K for reasoning headroom.
// Hostname-gated to api.openai.com; every step is try/catch so failure falls back to baseline behavior.

'use strict';

const _https = require('https');
const _http = require('http');

// Pin 9router's listening socket to loopback. It carries the user's provider
// API keys and auth.py's security model assumes localhost-only, but with no HOST
// env the node server binds 0.0.0.0 (all interfaces): that exposes it to the LAN
// AND trips the Windows firewall "allow Node.js" prompt. Rewrite server listen()
// to force 127.0.0.1 when no real host is given; fully try/catched so any surprise
// falls back to original behavior rather than breaking router boot.
(function pinLoopback() {
  try {
    const net = require('net');
    const _listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function patchedListen(...args) {
      try {
        const a0 = args[0];
        const isPort = typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0));
        if (isPort) {
          const h = args[1];
          const wildcard = h == null || typeof h === 'function' || h === '0.0.0.0' || h === '::';
          if (wildcard) {
            const rest = typeof h === 'function' ? args.slice(1) : args.slice(2);
            return _listen.call(this, a0, '127.0.0.1', ...rest);
          }
        } else if (a0 && typeof a0 === 'object' && a0.port != null && a0.path == null) {
          if (a0.host == null || a0.host === '0.0.0.0' || a0.host === '::') {
            args[0] = Object.assign({}, a0, { host: '127.0.0.1' });
          }
        }
      } catch (_) {}
      return _listen.apply(this, args);
    };
  } catch (_) {}
})();

// Claude OAuth completion. Anthropic only whitelists localhost:20128/callback as the
// redirect, so Claude's callback HAS to land here on 9Router (unlike Gemini, which goes
// straight to the backend, and Codex, which has its own :1455 listener). We previously
// 302'd the user's browser across ports to the backend, but a cross-port plain-http
// localhost redirect silently fails in browsers that HTTPS-upgrade or block it, which
// hung "Connecting…" for some users (browser-dependent, Claude-only). Fix: run the code
// exchange server-to-server (9Router -> backend, same machine, no browser in the loop)
// and hand the browser a static close-page. The browser only ever talks to :20128.
// Idempotent via the backend's _pending_oauth.pop + _completed_oauth.
(function patchOauthCallbackExchange() {
  try {
    const http = require('http');
    const origEmit = http.Server.prototype.emit;
    const closePage =
      '<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,system-ui;' +
      'text-align:center;color:#888;padding-top:80px;background:#1a1a1a">' +
      'You can close this tab, and any other login tab still open.</body>';
    http.Server.prototype.emit = function patchedEmit(event, req, res) {
      if (event === 'request' && req && res) {
        try {
          const url = req.url || '';
          if (url.startsWith('/callback?')) {
            const backendPort = process.env.OPENSWARM_PORT || '8324';
            const path = '/api/subscriptions/callback' + url.slice('/callback'.length);
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              try { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(closePage); } catch (_) {}
            };
            try {
              const proxyReq = http.request(
                { host: '127.0.0.1', port: backendPort, path: path, method: 'GET' },
                (proxyRes) => { proxyRes.resume(); proxyRes.on('end', finish); }
              );
              proxyReq.on('error', finish);
              proxyReq.setTimeout(5000, () => { try { proxyReq.destroy(); } catch (_) {} finish(); });
              proxyReq.end();
            } catch (_) { finish(); }
            return true;
          }
        } catch (_) {}
      }
      return origEmit.apply(this, arguments);
    };
  } catch (_) {}
})();

const TARGET_HOSTS = new Set(['api.openai.com']);
const DEBUG = process.env.OPENSWARM_DEBUG_GPT5_PATCH === '1';

function _log(msg) {
  if (DEBUG) {
    try { process.stderr.write('[openswarm-gpt5-patch] ' + msg + '\n'); } catch (_) {}
  }
}

function isGpt5Model(model) {
  if (typeof model !== 'string') return false;
  let m = model.trim().toLowerCase();
  if (!m) return false;
  // Strip 9router prefixes; don't blindly strip cp- (could be a non-OpenAI custom node).
  const prefixes = ['cp-openai/', 'openai/', 'cx/', 'openrouter/', 'or:openai/'];
  for (const p of prefixes) {
    if (m.startsWith(p)) { m = m.slice(p.length); break; }
  }
  return m.startsWith('gpt-5');
}

// GPT-5 burns 8-30K reasoning tokens before any output; the CLI's default 4096 caps before content lands. Floor at 32K and only raise, never lower.
const GPT5_MIN_COMPLETION_TOKENS = 32768;

function maybeRewriteBody(bodyStr) {
  if (typeof bodyStr !== 'string' || bodyStr.length === 0) return bodyStr;
  let parsed;
  try { parsed = JSON.parse(bodyStr); } catch { return bodyStr; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyStr;
  if (!isGpt5Model(parsed.model)) return bodyStr;
  let mutated = false;
  // Drop legacy field if both present, else OpenAI 400s on "both specified".
  if ('max_tokens' in parsed && 'max_completion_tokens' in parsed) {
    delete parsed.max_tokens;
    mutated = true;
    _log('dropped redundant max_tokens for ' + parsed.model);
  } else if ('max_tokens' in parsed) {
    parsed.max_completion_tokens = parsed.max_tokens;
    delete parsed.max_tokens;
    mutated = true;
    _log('rewrote max_tokens to max_completion_tokens for ' + parsed.model);
  }
  if (typeof parsed.max_completion_tokens === 'number' && parsed.max_completion_tokens < GPT5_MIN_COMPLETION_TOKENS) {
    const orig = parsed.max_completion_tokens;
    parsed.max_completion_tokens = GPT5_MIN_COMPLETION_TOKENS;
    mutated = true;
    _log('raised max_completion_tokens ' + orig + ' to ' + GPT5_MIN_COMPLETION_TOKENS + ' for ' + parsed.model);
  }
  return mutated ? JSON.stringify(parsed) : bodyStr;
}

function _hostFromOpts(opts) {
  if (!opts) return '';
  const raw = opts.hostname || opts.host || '';
  return String(raw).replace(/:\d+$/, '').toLowerCase();
}

function patchHttpRequest(orig) {
  return function patchedRequest() {
    const args = Array.prototype.slice.call(arguments);
    let opts = args[0];
    let host = '';
    try {
      if (typeof opts === 'string') host = new URL(opts).hostname.toLowerCase();
      else if (opts instanceof URL) host = opts.hostname.toLowerCase();
      else host = _hostFromOpts(opts);
    } catch (_) { host = ''; }

    if (!TARGET_HOSTS.has(host)) {
      return orig.apply(this, args);
    }

    let req;
    try { req = orig.apply(this, args); } catch (e) { throw e; }
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);
    const chunks = [];
    let isStringMode = null;

    function recordChunk(chunk) {
      if (chunk == null) return;
      if (typeof chunk === 'string') {
        if (isStringMode === false) {
          for (let i = 0; i < chunks.length; i++) chunks[i] = chunks[i].toString('utf8');
        }
        isStringMode = true;
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        if (isStringMode === true) {
          for (let i = 0; i < chunks.length; i++) chunks[i] = Buffer.from(chunks[i], 'utf8');
        }
        isStringMode = false;
        chunks.push(chunk);
      } else {
        throw new Error('unknown-chunk-shape');
      }
    }

    req.write = function patchedWrite(chunk) {
      const restArgs = Array.prototype.slice.call(arguments, 1);
      try {
        recordChunk(chunk);
        return true;
      } catch (_) {
        try {
          for (const c of chunks) origWrite(c);
          chunks.length = 0;
        } catch (_) {}
        return origWrite.apply(req, [chunk].concat(restArgs));
      }
    };

    req.end = function patchedEnd(chunk) {
      const restArgs = Array.prototype.slice.call(arguments, 1);
      try {
        recordChunk(chunk);
        let bodyStr = '';
        if (isStringMode === true) bodyStr = chunks.join('');
        else if (isStringMode === false) bodyStr = Buffer.concat(chunks).toString('utf8');
        const rewritten = maybeRewriteBody(bodyStr);
        if (rewritten !== bodyStr) {
          const newBuf = Buffer.from(rewritten, 'utf8');
          try {
            if (req.getHeader && typeof req.getHeader === 'function' && req.getHeader('content-length')) {
              req.setHeader('Content-Length', newBuf.length);
            }
          } catch (_) {}
          return origEnd.call(req, newBuf);
        }
        if (chunks.length === 0) return origEnd.apply(req, restArgs);
        if (isStringMode === true) return origEnd.call(req, chunks.join(''));
        return origEnd.call(req, Buffer.concat(chunks));
      } catch (_) {
        try {
          for (const c of chunks) origWrite(c);
          chunks.length = 0;
        } catch (_) {}
        if (chunk != null) return origEnd.apply(req, [chunk].concat(restArgs));
        return origEnd.apply(req, restArgs);
      }
    };

    return req;
  };
}

if (!_https.__openswarm_gpt5_patched) {
  try {
    _https.request = patchHttpRequest(_https.request);
    _http.request = patchHttpRequest(_http.request);
    _https.__openswarm_gpt5_patched = true;
    _http.__openswarm_gpt5_patched = true;
    _log('installed https.request + http.request interceptors');
  } catch (e) {
    _log('install failed: ' + (e && e.message ? e.message : String(e)));
  }
}

// Node 18+ fetch path; 9router uses fetch in some routes.
if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__openswarm_gpt5_patched) {
  try {
    const origFetch = globalThis.fetch;
    const patchedFetch = async function (input, init) {
      try {
        let url = '';
        if (typeof input === 'string') url = input;
        else if (input && typeof input === 'object') url = input.url || '';
        if (!url) return origFetch.call(this, input, init);
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return origFetch.call(this, input, init); }
        if (!TARGET_HOSTS.has(host)) return origFetch.call(this, input, init);
        if (init && typeof init.body === 'string') {
          const rewritten = maybeRewriteBody(init.body);
          if (rewritten !== init.body) {
            const newInit = Object.assign({}, init, { body: rewritten });
            const newLen = String(Buffer.byteLength(rewritten, 'utf8'));
            if (newInit.headers) {
              try {
                if (typeof Headers !== 'undefined' && newInit.headers instanceof Headers) {
                  if (newInit.headers.has('content-length')) newInit.headers.set('content-length', newLen);
                } else {
                  for (const k of Object.keys(newInit.headers)) {
                    if (k.toLowerCase() === 'content-length') newInit.headers[k] = newLen;
                  }
                }
              } catch (_) {}
            }
            return origFetch.call(this, input, newInit);
          }
        }
        return origFetch.call(this, input, init);
      } catch (_) {
        return origFetch.call(this, input, init);
      }
    };
    patchedFetch.__openswarm_gpt5_patched = true;
    globalThis.fetch = patchedFetch;
    _log('installed fetch interceptor');
  } catch (e) {
    _log('fetch install failed: ' + (e && e.message ? e.message : String(e)));
  }
}
