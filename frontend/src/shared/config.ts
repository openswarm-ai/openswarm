const port = (window as any).__OPENSWARM_PORT__ || 8324;
const host = window.location.hostname || 'localhost';

export const API_BASE = `http://${host}:${port}/api`;
export const WS_BASE = `ws://${host}:${port}`;
// Must match openswarm-cloud's PUBLIC_BASE_URL (fly.toml) and the redirect
// URI registered on the Google OAuth client. The historical `.ai` value
// resolved to NXDOMAIN — fine while no frontend caller used it directly,
// but the v1.0.29 sign-in gate is the first frontend caller that
// constructs URLs from this constant, so the typo had to go.
export const OPENSWARM_DEFAULT_PROXY_URL = 'https://api.openswarm.com';

// Per-install auth token. Fetched from Electron's main process via the
// preload contextBridge. We cache it after first resolution so every
// API/WS call is synchronous. On Electron hot-reload the token rotates;
// call `refreshAuthToken()` from a 4401 WS handler to pick up a new
// one without a full page reload.
let _authTokenCache: string = '';
let _authTokenPromise: Promise<string> | null = null;
let _originalFetchForAuth: typeof window.fetch | null = null;

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
  } else {
    // Plain browser mode has no Electron preload bridge. Bootstrap the same
    // per-install bearer from a localhost-origin-gated backend endpoint so
    // normal API calls (/api/settings, /ws, etc.) can authenticate.
    try {
      const fetchForAuth = _originalFetchForAuth ?? window.fetch.bind(window);
      const resp = await fetchForAuth(`${API_BASE}/auth/browser-token`, {
        method: 'GET',
        credentials: 'include',
      });
      if (resp.ok) {
        const data = (await resp.json()) as { token?: string };
        _authTokenCache = typeof data.token === 'string' ? data.token : '';
      } else {
        _authTokenCache = '';
      }
    } catch {
      _authTokenCache = '';
    }
  }
  return _authTokenCache;
}

// Resolve-once helper: the first call kicks off the IPC request; any
// concurrent calls reuse the same promise. Frontend bootstrap awaits
// this before the first API call so the token is ready.
export function ensureAuthToken(): Promise<string> {
  if (_authTokenPromise) return _authTokenPromise;
  _authTokenPromise = refreshAuthToken();
  return _authTokenPromise;
}

// Install a global fetch interceptor so every fetch(API_BASE + ...)
// call site gets the Authorization header without touching each site.
// Covers the analytics, settings, agents, dashboards, etc. fetches.
// Only applies to requests that target our own API_BASE — pass-through
// for every other URL (3rd-party APIs, asset CDNs, etc.).
//
// Layered on top of the auth-injection: a tiny in-flight dedupe + 1s
// success cache for GETs. The onboarding flow + dashboard load fire the
// same `GET /api/agents/sessions/<id>` / `GET /api/skills/list` /
// `GET /api/skills/workspace/<id>` two-to-five times in quick
// succession when components mount near-simultaneously — without
// dedupe we paid a full roundtrip every time. With this in place the
// second-through-Nth call inside a 1 s window either piggybacks on
// the in-flight promise OR reads a freshly-cached Response. Cache is
// keyed by `METHOD URL`, scoped to GET only (mutations always fall
// through), and a Response.clone() per consumer keeps each caller's
// body stream independent. Non-2xx responses are NOT cached so a
// transient 5xx can't poison the next click.
const _inflightFetches = new Map<string, Promise<Response>>();
const _cachedFetches = new Map<string, { resp: Response; expiresAt: number }>();
const _GET_CACHE_TTL_MS = 1000;

function _installAuthFetchInterceptor() {
  if ((window as any).__OPENSWARM_FETCH_PATCHED__) return;
  (window as any).__OPENSWARM_FETCH_PATCHED__ = true;

  const originalFetch = window.fetch.bind(window);
  _originalFetchForAuth = originalFetch;
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // Only attach token for our own API. Everything else flows through.
      const isOurApi = url.startsWith(API_BASE) || url.startsWith(`http://${host}:${port}/`);
      if (!isOurApi) return originalFetch(input, init);

      // Don't override an explicit Authorization the caller already set.
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

      // Only GET is safe to dedupe + cache. POST/PUT/PATCH/DELETE have
      // side effects — collapsing two intentional calls (e.g. user
      // double-clicked Send) would be wrong, so we always pass through.
      if (method !== 'GET') {
        return originalFetch(input, finalInit);
      }

      const cacheKey = `GET ${url}`;

      const cached = _cachedFetches.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.resp.clone();
      } else if (cached) {
        _cachedFetches.delete(cacheKey);
      }

      const inflight = _inflightFetches.get(cacheKey);
      if (inflight) {
        const resp = await inflight;
        return resp.clone();
      }

      const promise = originalFetch(input, finalInit).then((resp) => {
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
    } catch {
      return originalFetch(input, init);
    }
  };
}

// Call immediately on module load — config.ts is imported by the main
// entry point, so this runs before any component-level fetch.
_installAuthFetchInterceptor();
// Kick off token resolution in the background so it's warm by the
// time the first request goes out.
ensureAuthToken();
