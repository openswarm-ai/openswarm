import { InstagramMcpError } from "./errors.js";
import { runPublishedBuddySubprocess, shouldUseNpmOAuthFallback } from "./npm-connect-fallback.js";
import { refreshAccessToken, runOAuthFlow, type RunOAuthFlowOpts } from "./oauth.js";
import {
  createTokenStore,
  type CreateTokenStoreOpts,
  type StoredToken,
  type TokenStore,
} from "./token-store.js";
import { log } from "./logger.js";

/** Auto-refresh the long-lived token if it expires within this window. */
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthStateOpts {
  store?: TokenStore;
  storeOpts?: CreateTokenStoreOpts;
  /** Inject into OAuth flow (tests). */
  oauthOpts?: RunOAuthFlowOpts;
  /** Override refresh transport (tests). */
  refresh?: (token: string) => Promise<{ access_token: string; expires_in: number }>;
  /** Override Date.now (tests). */
  now?: () => number;
}

/**
 * Owns the stored token and brokers refresh + connect/disconnect. The Graph
 * client reads the live token via `getToken()` on every request, so token
 * rotations are picked up automatically.
 */
export class AuthState {
  private token: StoredToken | null = null;
  private loaded = false;

  constructor(
    private readonly store: TokenStore,
    private readonly opts: AuthStateOpts = {},
  ) {}

  static async create(opts: AuthStateOpts = {}): Promise<AuthState> {
    const store = opts.store ?? (await createTokenStore(opts.storeOpts));
    const self = new AuthState(store, opts);
    await self.init();
    return self;
  }

  private get nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async init(): Promise<void> {
    if (this.loaded) return;
    try {
      this.token = await this.store.load();
      log.info("auth_state_loaded", {
        connected: this.token !== null,
        backend: this.store.describe(),
      });
    } catch (err) {
      log.warn("auth_state_load_failed", { reason: (err as Error).message });
      this.token = null;
    }
    this.loaded = true;
  }

  /** Re-read token from disk/keychain (e.g. after npx OAuth wrote it). */
  private async reloadFromStore(): Promise<void> {
    try {
      this.token = await this.store.load();
      log.info("auth_state_reloaded", {
        connected: this.token !== null,
        backend: this.store.describe(),
      });
    } catch (err) {
      log.warn("auth_state_reload_failed", { reason: (err as Error).message });
      this.token = null;
    }
  }

  isConnected(): boolean {
    return this.token !== null;
  }

  /**
   * Returns the live access token (refreshing if needed). Null if unconnected.
   * Graph-client callers should pair this with their own NotConnectedError.
   */
  async getToken(): Promise<string | null> {
    if (!this.token) return null;
    await this.refreshIfNeeded();
    return this.token?.access_token ?? null;
  }

  async getUserId(): Promise<string | null> {
    return this.token?.user_id ?? null;
  }

  getGrantedScopes(): string[] {
    return this.token?.granted_scopes ?? [];
  }

  getExpiresAt(): number | null {
    return this.token?.expires_at ?? null;
  }

  async connect(): Promise<StoredToken> {
    if (shouldUseNpmOAuthFallback()) {
      log.info("auth_state_connect_via_npm_package");
      process.stderr.write(
        "instagram-mcp-buddy: no embedded Meta app — OAuth runs via `npx -y instagram-mcp-buddy connect`. Set INSTAGRAM_MCP_NO_NPX_FALLBACK=1 to require INSTAGRAM_MCP_APP_*.\n",
      );
      await runPublishedBuddySubprocess("connect");
      await this.reloadFromStore();
      if (!this.token) {
        throw new InstagramMcpError(
          "OAuth finished but no token was found locally. Complete the browser login, or run instagram_connect again.",
        );
      }
      log.info("auth_state_connected", {
        user_id: this.token.user_id,
        expires_at: new Date(this.token.expires_at).toISOString(),
        scopes: this.token.granted_scopes,
      });
      return this.token;
    }

    const token = await runOAuthFlow(this.opts.oauthOpts);
    this.token = token;
    await this.store.save(token);
    log.info("auth_state_connected", {
      user_id: token.user_id,
      expires_at: new Date(token.expires_at).toISOString(),
      scopes: token.granted_scopes,
    });
    return token;
  }

  async disconnect(): Promise<void> {
    this.token = null;
    await this.store.clear();
    log.info("auth_state_disconnected");
  }

  async refreshIfNeeded(): Promise<void> {
    if (!this.token) return;
    const msLeft = this.token.expires_at - this.nowMs;
    if (msLeft > REFRESH_THRESHOLD_MS) return;

    log.info("auth_state_refreshing", { msLeft });
    try {
      const refreshFn = this.opts.refresh ?? refreshAccessToken;
      const refreshed = await refreshFn(this.token.access_token);
      this.token = {
        ...this.token,
        access_token: refreshed.access_token,
        expires_at: this.nowMs + refreshed.expires_in * 1000,
        obtained_at: this.nowMs,
      };
      await this.store.save(this.token);
      log.info("auth_state_refreshed", {
        expires_at: new Date(this.token.expires_at).toISOString(),
      });
    } catch (err) {
      log.warn("auth_state_refresh_failed", { reason: (err as Error).message });
      // Don't clear — the existing token may still work for a bit. Let the
      // next Graph request surface the real auth error if it doesn't.
    }
  }
}
