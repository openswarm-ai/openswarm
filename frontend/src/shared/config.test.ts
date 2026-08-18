// Characterization of the global fetch interceptor + token acquisition in shared/config.ts. The module installs the interceptor and preloads the token at import, so it is loaded ONCE over a dispatching transport stub (what the interceptor captures as its raw transport) and each case steers the stub and the token state instead of reloading; `window` is the global object, as in a renderer.
import assert from 'node:assert/strict';
import { before, mock, test } from 'node:test';

const TOKEN_URL = 'http://localhost:8324/api/dev/token';
const apiUrl = (name: string) => `http://localhost:8324/api/test/${name}`;

type Impl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const g = globalThis as any;
let tokenCallDepth = -1;
let current: Impl = async (input) => {
  if (String(input) === TOKEN_URL) {
    tokenCallDepth = (new Error().stack ?? '').split('\n').length;
    return jsonResponse({ token: 'tok_1' });
  }
  return jsonResponse({});
};
const underlying = mock.fn<Impl>((input, init) => current(input, init));
const callsTo = (url: string) => underlying.mock.calls.filter((c) => String(c.arguments[0]) === url);
const tokenCallsSince = (mark: number) => callsTo(TOKEN_URL).filter((c) => underlying.mock.calls.indexOf(c) >= mark);
const mark = () => underlying.mock.calls.length;
const patchedFetch = () => g.window.fetch as typeof fetch;

let cfg: typeof import('./config');
before(async () => {
  Error.stackTraceLimit = 500;
  g.window = g;
  g.location = { hostname: 'localhost', reload: () => {} };
  g.__OPENSWARM_PORT__ = 8324;
  delete g.openswarm;
  g.fetch = underlying;
  cfg = await import('./config');
});

// Empty the cache without a bridge in the way: a failing forced refresh clears it (that behaviour is itself under test below).
async function emptyTokenCache() {
  const previous = current;
  current = async (input) => {
    if (String(input) === TOKEN_URL) throw new TypeError('reset');
    return previous(input);
  };
  await cfg.refreshAuthToken();
  assert.equal(cfg.getAuthToken(), '');
  current = previous;
}

test('token acquisition is recursion-free: shallow stack, one request, no bearer on the token request', async () => {
  // Pre-fix mechanism: refreshAuthToken's fetch re-enters the interceptor BEFORE _authTokenPromise is assigned (an async fn suspends only at its first await), so ensureAuthToken starts another refresh, which re-enters again — unbounded SYNCHRONOUS recursion until RangeError, which the interceptor's catch then rescues via the raw transport; the token still resolves, so the sharp pin is the stack depth when the transport is actually called.
  const tok = await Promise.race([
    cfg.ensureAuthToken(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('token acquisition deadlocked')), 2000)),
  ]);
  assert.equal(tok, 'tok_1');
  const calls = callsTo(TOKEN_URL);
  assert.equal(calls.length, 1); // the import-time preload; ensureAuthToken shared it
  assert.ok(tokenCallDepth > 0);
  assert.ok(tokenCallDepth < 50, `token transport called ${tokenCallDepth} frames deep`); // pre-fix: hundreds of interceptor frames
  assert.equal(new Headers(calls[0].arguments[1]?.headers).has('Authorization'), false);
});

test('single-flight: concurrent callers share ONE token request', async () => {
  await emptyTokenCache();
  current = async () => jsonResponse({ token: 'tok_1' });
  const m = mark();
  const [a, b] = await Promise.all([cfg.ensureAuthToken(), cfg.ensureAuthToken()]);
  assert.equal(a, 'tok_1');
  assert.equal(b, 'tok_1');
  assert.equal(tokenCallsSince(m).length, 1);
  assert.equal(cfg.getAuthToken(), 'tok_1');
});

test('a forced refresh failure is never shadowed by a stale token: the next ensureAuthToken returns the NEW token', async () => {
  // The 4401 path (WebSocketManager) calls refreshAuthToken() directly; if that forced refresh fails, ensureAuthToken must re-acquire — a still-resolved earlier _authTokenPromise returning stale tok_1 is the defect (single-flight must be in-flight-only, not resolved-forever).
  let phase: 'tok1' | 'fail' | 'tok2' = 'tok1';
  current = async (input) => {
    if (String(input) === TOKEN_URL) {
      if (phase === 'fail') throw new TypeError('backend restarting');
      return jsonResponse({ token: phase === 'tok1' ? 'tok_1' : 'tok_2' });
    }
    return jsonResponse({});
  };
  await emptyTokenCache();
  assert.equal(await cfg.ensureAuthToken(), 'tok_1');
  phase = 'fail';
  assert.equal(await cfg.refreshAuthToken(), ''); // forced refresh fails and clears the cache
  phase = 'tok2';
  assert.equal(await cfg.ensureAuthToken(), 'tok_2'); // never stale tok_1
  assert.equal(cfg.getAuthToken(), 'tok_2');
});

test('a non-OK token response also clears the cache: forced 500 refresh yields "", then tok_2, never stale tok_1', async () => {
  // Only THROWN transport errors hit refreshAuthToken's catch; an HTTP 500 lands in the `r.ok` branch, which must clear the cache too — otherwise the forced refresh returns stale tok_1 and the cache short-circuit keeps serving it.
  let phase: 'tok1' | 'http500' | 'tok2' = 'tok1';
  current = async (input) => {
    if (String(input) === TOKEN_URL) {
      if (phase === 'http500') return new Response('backend error', { status: 500 });
      return jsonResponse({ token: phase === 'tok1' ? 'tok_1' : 'tok_2' });
    }
    return jsonResponse({});
  };
  await emptyTokenCache();
  assert.equal(await cfg.ensureAuthToken(), 'tok_1');
  phase = 'http500';
  assert.equal(await cfg.refreshAuthToken(), '');
  assert.equal(cfg.getAuthToken(), '');
  phase = 'tok2';
  assert.equal(await cfg.ensureAuthToken(), 'tok_2'); // never stale tok_1
  assert.equal(cfg.getAuthToken(), 'tok_2');
});

test('a failed refresh is not poisoned: the next ensureAuthToken retries and succeeds', async () => {
  let up = false;
  current = async (input) => {
    if (String(input) === TOKEN_URL) {
      if (!up) throw new TypeError('backend not up yet');
      return jsonResponse({ token: 'tok_2' });
    }
    return jsonResponse({});
  };
  await emptyTokenCache();
  assert.equal(await cfg.ensureAuthToken(), '');
  up = true;
  assert.equal(await cfg.ensureAuthToken(), 'tok_2');
  assert.equal(cfg.getAuthToken(), 'tok_2');
});

test('local API requests get the bearer once the token is resolved; foreign origins pass through untouched', async () => {
  current = async (input) => (String(input) === TOKEN_URL ? jsonResponse({ token: 'tok_1' }) : jsonResponse({ ok: true }));
  await emptyTokenCache();
  await cfg.ensureAuthToken();
  const url = apiUrl('bearer');
  await patchedFetch()(url, { method: 'POST', body: '{}' });
  assert.equal(new Headers((callsTo(url)[0].arguments[1] as RequestInit).headers).get('Authorization'), 'Bearer tok_1');
  await patchedFetch()('https://example.com/x');
  assert.equal(callsTo('https://example.com/x')[0].arguments[1], undefined);
});

test('a caller-set Authorization header is never overwritten', async () => {
  current = async (input) => (String(input) === TOKEN_URL ? jsonResponse({ token: 'tok_1' }) : jsonResponse({}));
  const url = apiUrl('caller-auth');
  await patchedFetch()(url, { method: 'POST', headers: { Authorization: 'Bearer mine' } });
  assert.equal(new Headers((callsTo(url)[0].arguments[1] as RequestInit).headers).get('Authorization'), 'Bearer mine');
});

test('two GETs inside the window share one transport call; both responses are independently readable', async () => {
  current = async (input) => (String(input) === TOKEN_URL ? jsonResponse({ token: 'tok_1' }) : jsonResponse({ n: 1 }));
  await cfg.ensureAuthToken();
  const url = apiUrl('dedupe');
  const [r1, r2] = await Promise.all([patchedFetch()(url), patchedFetch()(url)]);
  assert.deepEqual(await r1.json(), { n: 1 });
  assert.deepEqual(await r2.json(), { n: 1 });
  assert.equal(callsTo(url).length, 1);
});

test('mutations are never deduped: two POSTs are two transport calls', async () => {
  current = async (input) => (String(input) === TOKEN_URL ? jsonResponse({ token: 'tok_1' }) : jsonResponse({}));
  await cfg.ensureAuthToken();
  const url = apiUrl('mutations');
  await patchedFetch()(url, { method: 'POST', body: '{}' });
  await patchedFetch()(url, { method: 'POST', body: '{}' });
  assert.equal(callsTo(url).length, 2);
});

test('a local API transport failure consults the live port (self-heal hook) at once and the bounded GET retry recovers', async () => {
  const url = apiUrl('recover');
  let apiAttempts = 0;
  current = async (input) => {
    if (String(input) === TOKEN_URL) return jsonResponse({ token: 'tok_1' });
    if (String(input) === url) {
      apiAttempts += 1;
      if (apiAttempts === 1) throw new TypeError('connection refused');
      return jsonResponse({ recovered: true });
    }
    return jsonResponse({});
  };
  const getBackendPortLive = mock.fn(() => 8324); // same port → no reload, but the heal hook must be consulted
  g.openswarm = { getBackendPortLive, getAuthToken: async () => 'tok_pre' };
  try {
    await cfg.ensureAuthToken();
    const resp = await patchedFetch()(url);
    assert.deepEqual(await resp.json(), { recovered: true });
    assert.ok(getBackendPortLive.mock.calls.length >= 1);
    assert.equal(apiAttempts, 2);
  } finally {
    delete g.openswarm;
  }
});

test('a rejected token transport attempt heals in the catch path: port consulted, honest empty token, the next ensure retries, still no bearer', async () => {
  // Discriminates `return await originalFetch(...)` from `return originalFetch(...)` on the token bypass: without the await the rejection escapes patchedFetch AFTER it has returned, the catch (port self-heal) never runs, so the live-port hook is never consulted; the failure stays honest (no silent raw retry) and an empty resolve is never memoized, so the next ensureAuthToken() acquires the token.
  let tokenAttempts = 0;
  current = async (input) => {
    if (String(input) === TOKEN_URL) {
      tokenAttempts += 1;
      if (tokenAttempts === 1) throw new TypeError('connection refused');
      return jsonResponse({ token: 'tok_heal' });
    }
    return jsonResponse({});
  };
  const getBackendPortLive = mock.fn(() => 8324); // same port → consulted, but no reload
  g.openswarm = { getBackendPortLive }; // no getAuthToken on the bridge: the HTTP dev-token route stays in play while the heal hook exists
  try {
    const m = mark();
    assert.equal(await cfg.refreshAuthToken(), ''); // the failing attempt: healed, honest empty
    assert.equal(getBackendPortLive.mock.calls.length, 1);
    assert.equal(tokenCallsSince(m).length, 1); // no hidden raw retry
    assert.equal(await cfg.ensureAuthToken(), 'tok_heal'); // the next ensure acquires it
    const calls = tokenCallsSince(m);
    assert.equal(calls.length, 2);
    for (const call of calls) assert.equal(new Headers(call.arguments[1]?.headers).has('Authorization'), false);
    assert.equal(cfg.getAuthToken(), 'tok_heal');
  } finally {
    delete g.openswarm;
  }
});

test('preload bridge (Electron path) wins over the dev-token route and its failure is caught', async () => {
  await emptyTokenCache();
  current = async () => jsonResponse({ token: 'never' });
  g.openswarm = { getAuthToken: async () => { throw new Error('bridge broken'); } };
  try {
    const m = mark();
    assert.equal(await cfg.ensureAuthToken(), '');
    assert.equal(tokenCallsSince(m).length, 0); // never falls through to the HTTP route when a bridge exists
  } finally {
    delete g.openswarm;
  }
});
