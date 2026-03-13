import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/templates`;

export interface TemplateField {
  name: string;
  type: 'str' | 'int' | 'float' | 'select' | 'multi-select' | 'literal';
  options?: string[];
  default?: any;
  required: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  fields: TemplateField[];
  tags: string[];
}

interface TemplatesState {
  items: Record<string, PromptTemplate>;
  loading: boolean;
  loaded: boolean;
}

const initialState: TemplatesState = {
  items: {},
  loading: false,
  loaded: false,
};

export const fetchTemplates = createAsyncThunk(
  'templates/fetch',
  async () => {
    const res = await fetch(`${API_BASE}/list`);
    const data = await res.json();
    return data.templates as PromptTemplate[];
  },
  { condition: (_, { getState }) => !(getState() as { templates: TemplatesState }).templates.loading },
);

export const createTemplate = createAsyncThunk(
  'templates/create',
  async (body: Omit<PromptTemplate, 'id'>) => {
    const res = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.template as PromptTemplate;
  }
);

export const updateTemplate = createAsyncThunk(
  'templates/update',
  async ({ id, ...updates }: Partial<PromptTemplate> & { id: string }) => {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    return data.template as PromptTemplate;
  }
);

export const deleteTemplate = createAsyncThunk('templates/delete', async (id: string) => {
  await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  return id;
});

export const renderTemplate = createAsyncThunk(
  'templates/render',
  async ({ templateId, values }: { templateId: string; values: Record<string, any> }) => {
    const res = await fetch(`${API_BASE}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId, values }),
    });
    const data = await res.json();
    return data.rendered as string;
  }
);

const templatesSlice = createSlice({
  name: 'templates',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchTemplates.pending, (state) => { state.loading = true; })
      .addCase(fetchTemplates.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const t of action.payload) {
          state.items[t.id] = t;
        }
      })
      .addCase(fetchTemplates.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(createTemplate.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(updateTemplate.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(deleteTemplate.fulfilled, (state, action) => {
        delete state.items[action.payload];
      });
  },
});

export default templatesSlice.reducer;
