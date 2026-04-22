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
  // Analytics endpoint not implemented yet - return empty summary
  return {
    total_sessions: 0,
    total_cost_usd: 0,
    total_messages: 0,
    total_tool_calls: 0,
    avg_duration_seconds: 0,
    avg_cost_per_session: 0,
    completion_rate: 0,
    models_used: {},
    providers_used: {},
    top_tools: {},
    status_breakdown: {},
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    cost_by_model: {},
    cost_by_provider: {},
    cost_source: 'none',
    nine_router_available: false,
    total_requests: 0,
  } as UsageSummary;
});

export const fetchCostBreakdown = createAsyncThunk(
  'analytics/fetchCostBreakdown',
  async (period: string = '7d') => {
    // Cost breakdown endpoint not implemented yet - return empty breakdown
    return {
      available: false,
      period,
      total_cost: 0,
      total_requests: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      by_model: {},
      by_provider: {},
    } as CostBreakdown;
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
