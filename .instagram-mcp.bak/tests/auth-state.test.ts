import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthState } from "../src/auth-state.js";
import type { StoredToken, TokenStore } from "../src/token-store.js";

function makeStore(initial: StoredToken | null = null): TokenStore {
  let current = initial;
  return {
    load: vi.fn(async () => current),
    save: vi.fn(async (t: StoredToken) => {
      current = t;
    }),
    clear: vi.fn(async () => {
      current = null;
    }),
    describe: () => "in-memory",
  };
}

const DAY = 24 * 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;

function tokenExpiringInDays(days: number): StoredToken {
  return {
    access_token: `access_token_${days}d_old`,
    user_id: "17841400000000000",
    expires_at: FIXED_NOW + days * DAY,
    obtained_at: FIXED_NOW - (60 - days) * DAY,
    granted_scopes: ["instagram_business_basic"],
  };
}

describe("AuthState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unconnected when the store has nothing", async () => {
    const state = await AuthState.create({ store: makeStore(null) });
    expect(state.isConnected()).toBe(false);
    expect(await state.getToken()).toBeNull();
  });

  it("loads an existing token on init", async () => {
    const stored = tokenExpiringInDays(45);
    const state = await AuthState.create({ store: makeStore(stored) });
    expect(state.isConnected()).toBe(true);
    expect(await state.getUserId()).toBe(stored.user_id);
    expect(await state.getToken()).toBe(stored.access_token);
  });

  it("does NOT refresh when expiry is > 7 days away", async () => {
    const stored = tokenExpiringInDays(30);
    const refreshFn = vi.fn();
    const state = await AuthState.create({
      store: makeStore(stored),
      now: () => FIXED_NOW,
      refresh: refreshFn,
    });
    await state.refreshIfNeeded();
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("auto-refreshes when expiry is <= 7 days away", async () => {
    const stored = tokenExpiringInDays(5);
    const store = makeStore(stored);
    const refreshFn = vi.fn().mockResolvedValue({
      access_token: "refreshed_token",
      expires_in: 60 * 24 * 60 * 60, // 60 days
    });
    const state = await AuthState.create({
      store,
      now: () => FIXED_NOW,
      refresh: refreshFn,
    });
    await state.refreshIfNeeded();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(refreshFn).toHaveBeenCalledWith(stored.access_token);
    expect(await state.getToken()).toBe("refreshed_token");
    expect(store.save).toHaveBeenCalled();
  });

  it("getToken auto-refreshes inline", async () => {
    const stored = tokenExpiringInDays(3);
    const refreshFn = vi.fn().mockResolvedValue({
      access_token: "auto_refreshed",
      expires_in: 60 * 24 * 60 * 60,
    });
    const state = await AuthState.create({
      store: makeStore(stored),
      now: () => FIXED_NOW,
      refresh: refreshFn,
    });
    expect(await state.getToken()).toBe("auto_refreshed");
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("keeps the old token if refresh fails", async () => {
    const stored = tokenExpiringInDays(2);
    const refreshFn = vi.fn().mockRejectedValue(new Error("Meta is down"));
    const state = await AuthState.create({
      store: makeStore(stored),
      now: () => FIXED_NOW,
      refresh: refreshFn,
    });
    expect(await state.getToken()).toBe(stored.access_token);
    expect(refreshFn).toHaveBeenCalled();
  });

  it("disconnect clears the store and forgets the token", async () => {
    const stored = tokenExpiringInDays(30);
    const store = makeStore(stored);
    const state = await AuthState.create({ store });
    await state.disconnect();
    expect(state.isConnected()).toBe(false);
    expect(store.clear).toHaveBeenCalled();
    expect(await state.getToken()).toBeNull();
  });

  it("getGrantedScopes returns whatever the stored token recorded", async () => {
    const stored = tokenExpiringInDays(30);
    const state = await AuthState.create({ store: makeStore(stored) });
    expect(state.getGrantedScopes()).toEqual(stored.granted_scopes);
  });
});
