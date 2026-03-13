import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/mcp-registry`;

export interface McpServer {
  name: string;
  title: string;
  description: string;
  version: string;
  remoteUrl: string;
  remoteType: string;
  repositoryUrl: string;
  websiteUrl: string;
  iconUrl: string;
  stars: number | null;
  source: string;
}

export interface McpServerDetail extends McpServer {
  environmentVariables: { name: string; description: string; default?: string; format?: string }[];
  keywords: string[];
  license: string;
}

interface McpRegistryState {
  servers: McpServer[];
  total: number;
  loading: boolean;
  query: string;
  offset: number;
  stats: { total: number; google: number; community: number; lastUpdated: number } | null;
  detail: McpServerDetail | null;
  detailLoading: boolean;
}

const initialState: McpRegistryState = {
  servers: [],
  total: 0,
  loading: false,
  query: '',
  offset: 0,
  stats: null,
  detail: null,
  detailLoading: false,
};

export const searchRegistry = createAsyncThunk(
  'mcpRegistry/search',
  async ({ q, limit = 20, offset = 0, sort = 'name', source = '' }: { q: string; limit?: number; offset?: number; sort?: string; source?: string }) => {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset), sort, source });
    const res = await fetch(`${API_BASE}/search?${params}`);
    return (await res.json()) as { servers: McpServer[]; total: number; offset: number; limit: number };
  }
);

export const fetchRegistryStats = createAsyncThunk('mcpRegistry/stats', async () => {
  const res = await fetch(`${API_BASE}/stats`);
  return (await res.json()) as { total: number; google: number; community: number; lastUpdated: number };
});

export const fetchServerDetail = createAsyncThunk(
  'mcpRegistry/detail',
  async (name: string) => {
    const res = await fetch(`${API_BASE}/detail/${encodeURIComponent(name)}`);
    const data = await res.json();
    return data.server as McpServerDetail;
  }
);

const mcpRegistrySlice = createSlice({
  name: 'mcpRegistry',
  initialState,
  reducers: {
    clearDetail(state) {
      state.detail = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(searchRegistry.pending, (state, action) => {
        state.loading = true;
        state.query = action.meta.arg.q;
        state.offset = action.meta.arg.offset ?? 0;
      })
      .addCase(searchRegistry.fulfilled, (state, action) => {
        state.loading = false;
        if (action.meta.arg.offset && action.meta.arg.offset > 0) {
          state.servers = [...state.servers, ...action.payload.servers];
        } else {
          state.servers = action.payload.servers;
        }
        state.total = action.payload.total;
      })
      .addCase(searchRegistry.rejected, (state) => {
        state.loading = false;
      })
      .addCase(fetchRegistryStats.fulfilled, (state, action) => {
        state.stats = action.payload;
      })
      .addCase(fetchServerDetail.pending, (state) => {
        state.detailLoading = true;
      })
      .addCase(fetchServerDetail.fulfilled, (state, action) => {
        state.detailLoading = false;
        state.detail = action.payload;
      })
      .addCase(fetchServerDetail.rejected, (state) => {
        state.detailLoading = false;
      });
  },
});

export const { clearDetail } = mcpRegistrySlice.actions;
export default mcpRegistrySlice.reducer;
