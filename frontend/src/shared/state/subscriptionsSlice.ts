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

export interface SubscriptionsState {
  status: SubscriptionStatus | null;
}

// Minimal slice shape for selectors; avoids circular type import from store.ts.
type WithSubscriptions = { subscriptions: SubscriptionsState };

const initialState: SubscriptionsState = {
  status: null,
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

const subscriptionsSlice = createSlice({
  name: 'subscriptions',
  initialState,
  reducers: {
    setSubscriptionStatus(state, action: PayloadAction<SubscriptionStatus | null>) {
      state.status = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchSubscriptionStatus.fulfilled, (state, action) => {
      state.status = action.payload;
    });
  },
});

export const { setSubscriptionStatus } = subscriptionsSlice.actions;

/** Unwraps the polymorphic `providers` shape (modern object vs legacy array). */
export function selectSubscriptionConnections(
  state: WithSubscriptions,
): SubscriptionConnection[] {
  const providers = state.subscriptions.status?.providers;
  if (!providers) return [];
  if (Array.isArray(providers)) return providers;
  return providers.connections ?? [];
}

export function isProviderConnected(
  state: WithSubscriptions,
  providerId: string,
): boolean {
  return selectSubscriptionConnections(state).some(
    (p) => p.provider === providerId && (p.isActive || p.testStatus === 'active'),
  );
}

export function hasAnyActiveSubscription(state: WithSubscriptions): boolean {
  return selectSubscriptionConnections(state).some(
    (p) => p.isActive || p.testStatus === 'active',
  );
}

export default subscriptionsSlice.reducer;
