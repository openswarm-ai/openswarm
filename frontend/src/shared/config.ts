import { noteBackendFailure, noteBackendSuccess, noteRequestStalled, setBackendProber } from '@/shared/backendConnection';
import { bypassesGetCache, mutationClearsGetCache } from '@/shared/getCachePolicy';

// Import-safe outside a renderer: reducers that import API_BASE also run under node:test, where there
// is no window. The module then answers with the defaults and installs nothing.
const hasWindow = typeof window !== 'undefined';
const _w = (hasWindow ? window : {}) as any;
// Prefer the preload-injected port; if it's missing (preload raced the backend port being picked), re-query the live value before falling back to 8324. The bare 8324 guess is wrong on any machine where the backend landed on a fallback port (e.g. 8324 was held by a leftover backend); see the self-heal below.
const port =
  _w.__OPENSWARM_PORT__ ||
  (_w.openswarm && typeof _w.openswarm.getBackendPortLive === 'function'
    ? _w.openswarm.getBackendPortLive()
    : 0) ||
  8324;
const host = (hasWindow && window.location.hostname) || 'localhost';

export const API_BASE = `http://${host}:${port}/api`;
export const WS_BASE = `ws://${host}:${port}`;
// Must match openswarm-cloud's PUBLIC_BASE_URL (fly.toml) and the Google OAuth redirect URI.
export const OPENSWARM_DEFAULT_PROXY_URL = 'https://api.openswarm.com';

// Per-install token from Electron preload; cached after first resolve. Call refreshAuthToken() on 4401.
let _authTokenCache: string = '';
let _authTokenPromise: Promise<string> | null = null;

export function getAuthToken(): string {
  return _authTokenCache;
}

export async function refreshAuthToken(): Promise<string> {
  const ow = (window as any).openswarm;
  if (ow && typeof ow.getAuthToken === 'function') {
    try {
      const tok = await ow.getAuthToken();
      _authTokenCache = typeof tok === 'string' ? tok : '';
    } catch {
      _authTokenCache = '';
    }
    return _authTokenCache;
  }
  // Dev (split-port, no Electron preload): the backend hands us the token over localhost. The route 404s in packaged builds, so this only fires under run.sh.
  try {
    const r = await fetch(`http://${host}:${port}/api/dev/token`);
    if (r.ok) {
      const data = await r.json();
      _authTokenCache = typeof data?.token === 'string' ? data.token : '';
    }
  } catch {
    _authTokenCache = '';
  }
  return _authTokenCache;
}

/** Resolve auth token once; concurrent callers share the same promise. */
export function ensureAuthToken(): Promise<string> {
  if (_authTokenPromise) return _authTokenPromise;
  _authTokenPromise = refreshAuthToken().then((tok) => {
    // A boot race can resolve EMPTY (backend hadn't written the token file yet); memoizing that
    // left the renderer auth-dead until a manual reload (ENG-207). Empty = not an answer; retry.
    if (!tok) _authTokenPromise = null;
    return tok;
  });
  return _authTokenPromise;
}

// Self-heal: if our backend calls start failing with a network error (the renderer is pinned to a stale/wrong port), re-query the live port and reload once onto it. Guarded to one attempt per page-load and only when the live port actually differs, so a genuinely-down backend can't cause a reload loop.
let _portHealTried = false;
function _maybeHealBackendPort(): void {
  if (_portHealTried) return;
  try {
    const ow = (window as any).openswarm;
    const live = ow && typeof ow.getBackendPortLive === 'function' ? ow.getBackendPortLive() : null;
    if (typeof live === 'number' && live > 0 && live !== port) {
      _portHealTried = true;
      window.location.reload();
    }
  } catch {
    /* never let a heal attempt throw into the fetch path */
  }
}

// Global fetch interceptor: attaches bearer for our API + dedupes/caches GETs in a 1s window. Cache is keyed `METHOD URL`, GET-only (mutations pass through); non-2xx never cached.
const _inflightFetches = new Map<string, Promise<Response>>();
const _cachedFetches = new Map<string, { resp: Response; expiresAt: number }>();
const _GET_CACHE_TTL_MS = 1000;

function _installAuthFetchInterceptor() {
  if ((window as any).__OPENSWARM_FETCH_PATCHED__) return;
  (window as any).__OPENSWARM_FETCH_PATCHED__ = true;

  const originalFetch = window.fetch.bind(window);
  // Reachability probe uses the RAW fetch: any HTTP response (401 included) proves the backend
  // is back, and it must never recurse into the retry/dedupe logic below.
  setBackendProber(() => originalFetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000), cache: 'no-store' }));

  // Loopback calls answer in ms; anything past this is a dead/wedged backend, and an unbounded
  // hang here is exactly the silent forever-spinner class (ENG-241). Generous enough for a big
  // .swarm export, still bounded. Callers with their own AbortSignal keep it via AbortSignal.any.
  const ATTEMPT_TIMEOUT_MS = 30000;
  // Spans the measured ~4.2s packaged-backend respawn (kill-to-listening), so a GET fired the
  // instant the backend dies succeeds on the last attempt instead of surfacing a one-off error.
  const GET_RETRY_DELAYS_MS = [500, 1500, 2600];
  const isTransientStatus = (s: number) => s === 502 || s === 503 || s === 504;

  const attemptInit = (finalInit: RequestInit | undefined): RequestInit => {
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const callerSignal = finalInit?.signal;
    return { ...(finalInit ?? {}), signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout };
  };

  // Anything on loopback that hasn't answered in 8s is stalled, not slow; ask the prober rather than
  // waiting out the attempt timeout, so a squatted/wedged port surfaces in seconds (ENG-242).
  const STALL_MS = 8000;
  const withStallWatch = async (run: () => Promise<Response>): Promise<Response> => {
    const stall = setTimeout(() => noteRequestStalled(), STALL_MS);
    try { return await run(); } finally { clearTimeout(stall); }
  };

  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const isOurApi = url.startsWith(API_BASE) || url.startsWith(`http://${host}:${port}/`);
      if (!isOurApi) return originalFetch(input, init);

      const existingHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const callerSetAuth = existingHeaders.has('Authorization') || existingHeaders.has('authorization');

      let finalInit: RequestInit | undefined = init;
      if (!callerSetAuth) {
        const token = _authTokenCache || (await ensureAuthToken());
        if (token) {
          existingHeaders.set('Authorization', `Bearer ${token}`);
          finalInit = { ...(init ?? {}), headers: existingHeaders };
        }
      }

      const method = (
        finalInit?.method
        ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();

      // Mutations never auto-retry (not idempotent) and keep their own timing (some POSTs are
      // legitimately slow); they still feed the reachability signal so the UI stays honest.
      if (method !== 'GET') {
        try {
          const resp = await withStallWatch(() => originalFetch(input, finalInit));
          noteBackendSuccess();
          // A refresh right after a save must see the save: a list GET cached moments before the
          // mutation (a panel's mount fetch, a poll) would otherwise answer the refresh with the
          // pre-save list, and the UI sits stale until something else refetches (Settings > Memory
          // showed "Nothing saved yet" for a fact the store already held).
          if (mutationClearsGetCache(method)) _cachedFetches.clear();
          return resp;
        } catch (err) {
          noteBackendFailure();
          _maybeHealBackendPort();
          throw err;
        }
      }

      const cacheKey = `GET ${url}`;

      // A caller that asked for no-store/reload gets the network; the dedupe cache is for bursts of
      // identical default reads (twenty cards mounting), not for a read that wants fresh truth.
      const wantsFresh = bypassesGetCache(finalInit?.cache ?? (input instanceof Request ? input.cache : undefined));
      const cached = _cachedFetches.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() && !wantsFresh) {
        return cached.resp.clone();
      } else if (cached && (wantsFresh || cached.expiresAt <= Date.now())) {
        _cachedFetches.delete(cacheKey);
      }

      // Same for an identical GET already in flight: joining one that started before a mutation
      // would hand a fresh-wanting caller the pre-mutation answer.
      const inflight = _inflightFetches.get(cacheKey);
      if (inflight && !wantsFresh) {
        const resp = await inflight;
        return resp.clone();
      }

      // Bounded retry: a backend respawn (measured ~4.2s door-to-door) or a transient 5xx must
      // not permanently fail an idempotent read; a genuinely dead backend fails fast and flips
      // the reachability signal instead of hanging forever.
      const runWithRetry = async (): Promise<Response> => {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt <= GET_RETRY_DELAYS_MS.length; attempt++) {
          try {
            const resp = await withStallWatch(() => originalFetch(input, attemptInit(finalInit)));
            if (isTransientStatus(resp.status) && attempt < GET_RETRY_DELAYS_MS.length) {
              await new Promise((r) => setTimeout(r, GET_RETRY_DELAYS_MS[attempt]));
              continue;
            }
            noteBackendSuccess();
            return resp;
          } catch (err) {
            lastErr = err;
            // A caller-driven abort is a real answer, never something to retry through.
            if (finalInit?.signal?.aborted) throw err;
            if (attempt < GET_RETRY_DELAYS_MS.length) {
              await new Promise((r) => setTimeout(r, GET_RETRY_DELAYS_MS[attempt]));
              continue;
            }
          }
        }
        noteBackendFailure();
        _maybeHealBackendPort();
        throw lastErr;
      };

      const promise = runWithRetry().then((resp) => {
        if (resp.ok) {
          _cachedFetches.set(cacheKey, {
            resp: resp.clone(),
            expiresAt: Date.now() + _GET_CACHE_TTL_MS,
          });
        }
        return resp;
      });
      _inflightFetches.set(cacheKey, promise);
      try {
        const resp = await promise;
        return resp.clone();
      } finally {
        _inflightFetches.delete(cacheKey);
      }
    } catch (err) {
      // Interceptor plumbing must never turn a workable request into a failure; fall through raw.
      if (err instanceof TypeError || (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') throw err;
      return originalFetch(input, init);
    }
  };
}

if (hasWindow) {
  _installAuthFetchInterceptor();
  ensureAuthToken();
}
