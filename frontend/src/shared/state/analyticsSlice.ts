import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const ANALYTICS_API = `${API_BASE}/analytics`;

export interface AnalyticsSummary {
  total_sessions: number;
  total_cost_usd: number;
  total_messages: number;
  total_tool_calls: number;
  avg_session_duration_seconds: number;
  session_completion_rate: number;
  approval_rate: number;
  models_used: Record<string, number>;
  modes_used: Record<string, number>;
  top_tools: [string, number][];
}

export interface UsagePoint {
  date: string;
  sessions: number;
  cost: number;
}

export interface CostPoint {
  date: string;
  cost: number;
}

export interface ToolRank {
  tool: string;
  count: number;
}

export interface ApprovalStats {
  allow: number;
  deny: number;
  total: number;
  rate: number;
  avg_latency_ms: number;
}

export interface SessionStats {
  completed: number;
  stopped: number;
  error: number;
  total: number;
  completion_rate: number;
  avg_duration_seconds: number;
}

export interface HourlyPoint {
  hour: number;
  count: number;
}

export interface DurationBucket {
  label: string;
  count: number;
}

export interface CostByModel {
  model: string;
  cost: number;
  sessions: number;
}

export interface CumulativeCostPoint {
  date: string;
  cumulative: number;
  daily: number;
}

export interface ToolDuration {
  tool: string;
  calls: number;
  avg_ms: number;
  max_ms: number;
}

export interface SessionCost {
  timestamp: string;
  model: string;
  cost: number;
  duration: number;
  messages: number;
}

interface AnalyticsState {
  summary: AnalyticsSummary | null;
  usage: UsagePoint[];
  cost: CostPoint[];
  tools: ToolRank[];
  approvals: ApprovalStats | null;
  sessionStats: SessionStats | null;
  hourly: HourlyPoint[];
  durationDist: DurationBucket[];
  costByModel: CostByModel[];
  cumulativeCost: CumulativeCostPoint[];
  toolDurations: ToolDuration[];
  sessionCosts: SessionCost[];
  exportPreview: any | null;
  loading: boolean;
}

const initialState: AnalyticsState = {
  summary: null,
  usage: [],
  cost: [],
  tools: [],
  approvals: null,
  sessionStats: null,
  hourly: [],
  durationDist: [],
  costByModel: [],
  cumulativeCost: [],
  toolDurations: [],
  sessionCosts: [],
  exportPreview: null,
  loading: false,
};

export const fetchAnalyticsSummary = createAsyncThunk('analytics/fetchSummary', async () => {
  const res = await fetch(`${ANALYTICS_API}/summary`);
  return (await res.json()) as AnalyticsSummary;
});

export const fetchUsage = createAsyncThunk(
  'analytics/fetchUsage',
  async ({ period, range }: { period: string; range: number }) => {
    const res = await fetch(`${ANALYTICS_API}/usage?period=${period}&range=${range}`);
    const data = await res.json();
    return data.data as UsagePoint[];
  },
);

export const fetchCost = createAsyncThunk(
  'analytics/fetchCost',
  async ({ period, range }: { period: string; range: number }) => {
    const res = await fetch(`${ANALYTICS_API}/cost?period=${period}&range=${range}`);
    const data = await res.json();
    return data.data as CostPoint[];
  },
);

export const fetchTools = createAsyncThunk('analytics/fetchTools', async () => {
  const res = await fetch(`${ANALYTICS_API}/tools?limit=20`);
  const data = await res.json();
  return data.data as ToolRank[];
});

export const fetchApprovals = createAsyncThunk('analytics/fetchApprovals', async () => {
  const res = await fetch(`${ANALYTICS_API}/approvals`);
  return (await res.json()) as ApprovalStats;
});

export const fetchSessionStats = createAsyncThunk('analytics/fetchSessionStats', async () => {
  const res = await fetch(`${ANALYTICS_API}/sessions-stats`);
  return (await res.json()) as SessionStats;
});

export const fetchHourlyActivity = createAsyncThunk('analytics/fetchHourly', async () => {
  const res = await fetch(`${ANALYTICS_API}/hourly-activity`);
  const data = await res.json();
  return data.data as HourlyPoint[];
});

export const fetchDurationDistribution = createAsyncThunk('analytics/fetchDurationDist', async () => {
  const res = await fetch(`${ANALYTICS_API}/duration-distribution`);
  const data = await res.json();
  return data.data as DurationBucket[];
});

export const fetchCostByModel = createAsyncThunk('analytics/fetchCostByModel', async () => {
  const res = await fetch(`${ANALYTICS_API}/cost-by-model`);
  const data = await res.json();
  return data.data as CostByModel[];
});

export const fetchCumulativeCost = createAsyncThunk('analytics/fetchCumulativeCost', async () => {
  const res = await fetch(`${ANALYTICS_API}/cumulative-cost?range=90`);
  const data = await res.json();
  return data.data as CumulativeCostPoint[];
});

export const fetchToolDurations = createAsyncThunk('analytics/fetchToolDurations', async () => {
  const res = await fetch(`${ANALYTICS_API}/tool-durations`);
  const data = await res.json();
  return data.data as ToolDuration[];
});

export const fetchSessionCosts = createAsyncThunk('analytics/fetchSessionCosts', async () => {
  const res = await fetch(`${ANALYTICS_API}/cost-per-session?limit=50`);
  const data = await res.json();
  return data.data as SessionCost[];
});

export const fetchExportPreview = createAsyncThunk('analytics/fetchExportPreview', async () => {
  const res = await fetch(`${ANALYTICS_API}/export/preview`);
  return await res.json();
});

export const doExport = createAsyncThunk('analytics/doExport', async () => {
  const res = await fetch(`${ANALYTICS_API}/export`, { method: 'POST' });
  return await res.json();
});

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
      .addCase(fetchUsage.fulfilled, (state, action) => { state.usage = action.payload; })
      .addCase(fetchCost.fulfilled, (state, action) => { state.cost = action.payload; })
      .addCase(fetchTools.fulfilled, (state, action) => { state.tools = action.payload; })
      .addCase(fetchApprovals.fulfilled, (state, action) => { state.approvals = action.payload; })
      .addCase(fetchSessionStats.fulfilled, (state, action) => { state.sessionStats = action.payload; })
      .addCase(fetchHourlyActivity.fulfilled, (state, action) => { state.hourly = action.payload; })
      .addCase(fetchDurationDistribution.fulfilled, (state, action) => { state.durationDist = action.payload; })
      .addCase(fetchCostByModel.fulfilled, (state, action) => { state.costByModel = action.payload; })
      .addCase(fetchCumulativeCost.fulfilled, (state, action) => { state.cumulativeCost = action.payload; })
      .addCase(fetchToolDurations.fulfilled, (state, action) => { state.toolDurations = action.payload; })
      .addCase(fetchSessionCosts.fulfilled, (state, action) => { state.sessionCosts = action.payload; })
      .addCase(fetchExportPreview.fulfilled, (state, action) => { state.exportPreview = action.payload; });
  },
});

export default analyticsSlice.reducer;
