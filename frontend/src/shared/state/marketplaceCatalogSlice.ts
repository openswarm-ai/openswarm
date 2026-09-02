import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';
import type { Listing } from '@/app/pages/Directory/packages/catalog';

const MARKETPLACE_API = `${API_BASE}/marketplace`;

// 'cache' means the sheet was unreachable and these are the last listings we saw, which the tab says out loud.
export type CatalogSource = 'sheet' | 'cache' | 'empty';

interface CatalogState {
  listings: Listing[];
  source: CatalogSource;
  loading: boolean;
  loaded: boolean;
  error: string;
}

const initialState: CatalogState = { listings: [], source: 'empty', loading: false, loaded: false, error: '' };

interface CatalogPayload {
  source: CatalogSource;
  count: number;
  listings: Listing[];
  error: string;
}

export const fetchMarketplaceListings = createAsyncThunk(
  'marketplaceCatalog/fetch',
  async (refresh: boolean = false) => {
    const res = await fetch(`${MARKETPLACE_API}/listings${refresh ? '?refresh=true' : ''}`);
    if (!res.ok) throw new Error(`Marketplace listings failed: ${res.status}`);
    return (await res.json()) as CatalogPayload;
  },
  { condition: (_, { getState }) => !(getState() as { marketplaceCatalog: CatalogState }).marketplaceCatalog.loading },
);

const marketplaceCatalogSlice = createSlice({
  name: 'marketplaceCatalog',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchMarketplaceListings.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchMarketplaceListings.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.listings = action.payload.listings;
        state.source = action.payload.source;
        state.error = action.payload.error;
      })
      .addCase(fetchMarketplaceListings.rejected, (state, action) => {
        state.loading = false;
        state.loaded = true;
        // Keep whatever listings we already had: a failed refresh must not empty a populated store.
        state.error = action.error.message || 'Could not reach the marketplace.';
      });
  },
});

export default marketplaceCatalogSlice.reducer;
