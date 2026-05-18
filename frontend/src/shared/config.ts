const port = (window as any).__OPENSWARM_PORT__ || 8324;
const host = window.location.hostname || 'localhost';

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
  }
  return _authTokenCache;
}

/** Resolve auth token once; concurrent callers share the same promise. */
export function ensureAuthToken(): Promise<string> {
  if (_authTokenPromise) return _authTokenPromise;
  _authTokenPromise = refreshAuthToken();
  return _authTokenPromise;
}

// Global fetch interceptor: attaches bearer for our API + dedupes/caches GETs in a 1s window.
// Cache is keyed `METHOD URL`, GET-only (mutations pass through); non-2xx never cached.
const _inflightFetches = new Map<string, Promise<Response>>();
const _cachedFetches = new Map<string, { resp: Response; expiresAt: number }>();
const _GET_CACHE_TTL_MS = 1000;

function _installAuthFetchInterceptor() {
  if ((window as any).__OPENSWARM_FETCH_PATCHED__) return;
  (window as any).__OPENSWARM_FETCH_PATCHED__ = true;

  const originalFetch = window.fetch.bind(window);
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

      // Only GET is safe to dedupe/cache; mutations could collapse intentional double-clicks.
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

_installAuthFetchInterceptor();
ensureAuthToken();
