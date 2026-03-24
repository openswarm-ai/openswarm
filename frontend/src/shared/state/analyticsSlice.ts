import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const ANALYTICS_API = `${API_BASE}/analytics`;

export interface UsageSummary {
  total_sessions: number;
  total_cost_usd: number;
  total_messages: number;
  total_tool_calls: number;
  avg_duration_seconds: number;
  avg_cost_per_session: number;
  completion_rate: number;
  models_used: Record<string, number>;
  providers_used: Record<string, number>;
  top_tools: Record<string, number>;
  status_breakdown: Record<string, number>;
  // 9Router enrichment
  total_prompt_tokens: number;
  total_completion_tokens: number;
  cost_by_model: Record<string, { cost: number; requests: number; prompt_tokens: number; completion_tokens: number }>;
  cost_by_provider: Record<string, { cost: number; requests: number }>;
  cost_source: ' 9router' | 'sdk' | 'none';
  nine_router_available: boolean;
  total_requests: number;
}

export interface CostBreakdown {
  available: boolean;
  period: string;
  total_cost: number;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  by_model: Record<string, any>;
  by_provider: Record<string, any>;
}

interface AnalyticsState {
  summary: UsageSummary | null;
  costBreakdown: CostBreakdown | null;
  loading: boolean;
}

const initialState: AnalyticsState = {
  summary: null,
  costBreakdown: null,
  loading: false,
};

export const fetchAnalyticsSummary = createAsyncThunk('analytics/fetchSummary', async () => {
  const res = await fetch(`${ANALYTICS_API}/usage-summary`);
  return (await res.json()) as UsageSummary;
});

export const fetchCostBreakdown = createAsyncThunk(
  'analytics/fetchCostBreakdown',
  async (period: string = '7d') => {
    const res = await fetch(`${ANALYTICS_API}/cost-breakdown?period=${period}`);
    return (await res.json()) as CostBreakdown;
  },
);

const analyticsSlice = createSlice({
  name: 'analytics',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAnalyticsSummary.pending, (state) => { state.loading = true; })
      .addCase(fetchAnalyticsSummary.fulfilled, (state, action) => {
        state.loading = false;
        state.summary = action.payload;
      })
      .addCase(fetchAnalyticsSummary.rejected, (state) => { state.loading = false; })
      .addCase(fetchCostBreakdown.fulfilled, (state, action) => {
        state.costBreakdown = action.payload;
      });
  },
});

export default analyticsSlice.reducer;
