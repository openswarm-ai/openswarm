import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

export interface SubscriptionConnection {
  provider: string;
  isActive?: boolean;
  testStatus?: string;
  [key: string]: any;
}

export interface SubscriptionStatus {
  running: boolean;
  providers?:
    | { connections?: SubscriptionConnection[] }
    | SubscriptionConnection[];
  models?: any[];
  [key: string]: any;
}

export interface DeadProvider {
  provider: string;
  label: string;
}

export interface SubscriptionsState {
  status: SubscriptionStatus | null;
  healthDead: DeadProvider[];
  healthCliMissing: boolean;
  healthToastOpen: boolean;
}

// Minimal slice shape for selectors; avoids circular type import from store.ts.
type WithSubscriptions = { subscriptions: SubscriptionsState };

const initialState: SubscriptionsState = {
  status: null,
  healthDead: [],
  healthCliMissing: false,
  healthToastOpen: false,
};

/** Mirror /agents/subscriptions/status into Redux; preserveTransient debounces is_running() false negatives. */
export const fetchSubscriptionStatus = createAsyncThunk(
  'subscriptions/fetchStatus',
  async (opts: { preserveTransient?: boolean } | undefined, { getState }) => {
    const prev = (getState() as WithSubscriptions).subscriptions.status;
    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/status`);
      const data = (await r.json()) as SubscriptionStatus;
      if (opts?.preserveTransient && prev?.running && !data?.running) return prev;
      return data;
    } catch {
      return prev ?? ({ running: false, providers: [], models: [] } as SubscriptionStatus);
    }
  },
);

/** Boot-time login-health check; `skipped` means the router wasn't up yet, caller may retry once. */
export const fetchProviderHealth = createAsyncThunk(
  'subscriptions/fetchHealth',
  async (): Promise<{ dead: DeadProvider[]; skipped: boolean; cli_missing?: boolean }> => {
    const r = await fetch(`${API_BASE}/agents/subscriptions/health`);
    return (await r.json()) as { dead: DeadProvider[]; skipped: boolean; cli_missing?: boolean };
  },
);

const subscriptionsSlice = createSlice({
  name: 'subscriptions',
  initialState,
  reducers: {
    setSubscriptionStatus(state, action: PayloadAction<SubscriptionStatus | null>) {
      state.status = action.payload;
    },
    // Optimistic: 9Router /providers lags /exchange, so refetching right after would clobber the just-connected state with stale data. The 30s poller reconciles.
    // The backend re-probes a "mid-refresh" 401 on its own after the rotation window and pushes the verdict here; the boot-time fetch is long gone by then.
    healthReported(state, action: PayloadAction<{ dead: DeadProvider[] }>) {
      state.healthDead = action.payload.dead ?? [];
      state.healthToastOpen = state.healthDead.length > 0 || state.healthCliMissing;
    },
    markSubscriptionConnected(state, action: PayloadAction<{ provider: string }>) {
      if (!state.status) return;
      const { provider } = action.payload;
      const isArr = Array.isArray(state.status.providers);
      const conns: SubscriptionConnection[] = isArr
        ? (state.status.providers as SubscriptionConnection[])
        : ((state.status.providers as { connections?: SubscriptionConnection[] } | undefined)?.connections ?? []);
      const existing = conns.find((c) => c.provider === provider);
      if (existing) {
        existing.isActive = true;
        existing.testStatus = 'active';
      } else {
        conns.push({ provider, isActive: true, testStatus: 'active' });
      }
      if (isArr) {
        state.status.providers = conns;
      } else {
        state.status.providers = { connections: conns };
      }
    },
    hideProviderHealthToast(state) {
      state.healthToastOpen = false;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchSubscriptionStatus.fulfilled, (state, action) => {
      state.status = action.payload;
    });
    builder.addCase(fetchProviderHealth.fulfilled, (state, action) => {
      // cli_missing is filesystem truth, valid even when the router probe was skipped.
      state.healthCliMissing = action.payload.cli_missing ?? false;
      if (action.payload.skipped) {
        state.healthToastOpen = state.healthToastOpen || state.healthCliMissing;
        return;
      }
      state.healthDead = action.payload.dead ?? [];
      state.healthToastOpen = state.healthDead.length > 0 || state.healthCliMissing;
    });
  },
});

export const { setSubscriptionStatus, markSubscriptionConnected, hideProviderHealthToast, healthReported } = subscriptionsSlice.actions;

// Stable empty ref so the selector doesn't hand back a fresh [] each call (forces needless rerenders).
const EMPTY_CONNECTIONS: SubscriptionConnection[] = [];

/** Unwraps the polymorphic `providers` shape (modern object vs legacy array). */
let p_lastRows: SubscriptionConnection[] | null = null;
let p_lastFiltered: SubscriptionConnection[] | null = null;

export function selectSubscriptionConnections(
  state: WithSubscriptions,
): SubscriptionConnection[] {
  const providers = state.subscriptions.status?.providers;
  if (!providers) return EMPTY_CONNECTIONS;
  const rows = Array.isArray(providers) ? providers : (providers.connections ?? EMPTY_CONNECTIONS);
  // The free-trial/Pro lane is an OpenSwarm-managed router row, not a connection the USER made; counting it made a fresh trial look "connected" (dead Connect-beat rows, premature onConnected, phantom green rings). Memoized per rows identity so useSelector consumers don't churn.
  if (rows === p_lastRows && p_lastFiltered) return p_lastFiltered;
  const filtered = rows.filter((p) => !/\(OpenSwarm-managed\)/.test(p.name ?? ''));
  p_lastRows = rows;
  p_lastFiltered = filtered.length === rows.length ? rows : filtered;
  return p_lastFiltered;
}

export function hasAnyActiveSubscription(state: WithSubscriptions): boolean {
  return selectSubscriptionConnections(state).some(
    (p) => p.isActive || p.testStatus === 'active',
  );
}

export default subscriptionsSlice.reducer;
