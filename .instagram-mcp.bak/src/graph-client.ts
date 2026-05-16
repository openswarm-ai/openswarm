import type { AuthState } from "./auth-state.js";
import type { Config } from "./config.js";
import { API_BASE } from "./oauth-config.js";
import {
  GraphApiError,
  InstagramMcpError,
  NotConnectedError,
  mapGraphError,
} from "./errors.js";
import { log } from "./logger.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  authenticated?: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
    previous?: string;
  };
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

export class GraphClient {
  private readonly baseUrl: string;
  private readonly defaultTimeout: number;

  constructor(
    public readonly config: Config,
    private readonly authState: AuthState,
  ) {
    this.baseUrl = `${API_BASE}/${config.IG_GRAPH_API_VERSION}`;
    this.defaultTimeout = config.IG_DEFAULT_TIMEOUT_MS;
  }

  /** Authenticated user's IG Business Account id. Raises if unconnected. */
  async igUserId(): Promise<string> {
    const id = await this.authState.getUserId();
    if (!id) throw new NotConnectedError();
    return id;
  }

  /** Bare access to the AuthState (auth tools need this). */
  get auth(): AuthState {
    return this.authState;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const authenticated = opts.authenticated !== false;

    let token: string | null = null;
    if (authenticated) {
      token = await this.authState.getToken();
      if (!token) throw new NotConnectedError();
    }

    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    if (authenticated && token) {
      url.searchParams.set("access_token", token);
    }

    const headers: Record<string, string> = {
      "User-Agent": "instagram-mcp-buddy/0.1",
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeout;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await fetch(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const elapsed = Date.now() - started;

        this.checkUsageHeaders(res);

        if (res.ok) {
          log.debug("graph_api_call", { method, path, status: res.status, elapsedMs: elapsed });
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          if (!text) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new GraphApiError(`Non-JSON response: ${text.slice(0, 200)}`);
          }
        }

        const errText = await res.text();
        let errPayload: unknown;
        try {
          errPayload = JSON.parse(errText);
        } catch {
          errPayload = { error: { message: errText || res.statusText, code: res.status } };
        }
        const mapped = mapGraphError(errPayload);

        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < MAX_ATTEMPTS) {
          const wait = BACKOFF_MS[attempt - 1] ?? 4000;
          log.warn("graph_api_retry", {
            attempt,
            status: res.status,
            waitMs: wait,
            path,
          });
          await sleep(wait);
          continue;
        }
        log.error("graph_api_error", {
          method,
          path,
          status: res.status,
          message: mapped.message,
        });
        throw mapped;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof InstagramMcpError) throw err;
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          const wait = BACKOFF_MS[attempt - 1] ?? 4000;
          log.warn("graph_api_network_retry", {
            attempt,
            waitMs: wait,
            error: (err as Error).message,
          });
          await sleep(wait);
          continue;
        }
        throw new GraphApiError(
          `Network error after ${MAX_ATTEMPTS} attempts: ${(err as Error).message}`,
        );
      }
    }
    throw new GraphApiError(
      `Exhausted retries: ${(lastError as Error)?.message ?? "unknown"}`,
    );
  }

  async paginate<T>(
    path: string,
    opts: RequestOptions & { maxItems?: number } = {},
  ): Promise<{ items: T[]; nextCursor?: string }> {
    const maxItems = opts.maxItems ?? 100;
    const items: T[] = [];
    let nextCursor: string | undefined;
    let next: string | undefined;
    let currentPath = path;
    let currentQuery = opts.query;

    while (items.length < maxItems) {
      const res = await this.request<PaginatedResponse<T>>(currentPath, {
        ...opts,
        query: currentQuery,
      });
      const data = res?.data ?? [];
      for (const item of data) {
        if (items.length >= maxItems) break;
        items.push(item);
      }
      next = res?.paging?.next;
      nextCursor = res?.paging?.cursors?.after;
      if (!next || data.length === 0 || items.length >= maxItems) break;
      const nextUrl = new URL(next);
      currentPath = nextUrl.pathname.replace(/^\/v\d+\.\d+/, "");
      currentQuery = Object.fromEntries(nextUrl.searchParams.entries());
    }
    return { items, nextCursor };
  }

  private checkUsageHeaders(res: Response): void {
    const usageHeader =
      res.headers.get("x-business-use-case-usage") ??
      res.headers.get("x-app-usage");
    if (!usageHeader) return;
    try {
      const usage = JSON.parse(usageHeader);
      const numbers: number[] = [];
      const collect = (obj: unknown): void => {
        if (typeof obj !== "object" || obj === null) return;
        for (const v of Object.values(obj as Record<string, unknown>)) {
          if (typeof v === "number") numbers.push(v);
          else if (Array.isArray(v)) v.forEach(collect);
          else if (typeof v === "object" && v !== null) collect(v);
        }
      };
      collect(usage);
      const peak = numbers.length > 0 ? Math.max(...numbers) : 0;
      if (peak >= 75) {
        log.warn("graph_api_usage_high", { peakPercent: peak });
      }
    } catch {
      // Ignore.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
