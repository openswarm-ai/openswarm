import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';
import { Skill } from '@/shared/state/skillsSlice';

const SKILL_REGISTRY_API = `${API_BASE}/skill-registry`;

export interface RegistrySkill {
  name: string;
  description: string;
  folder: string;
  category: string;
  repositoryUrl: string;
}

export interface RegistrySkillDetail extends RegistrySkill {
  content: string;
}

interface SkillRegistryState {
  skills: RegistrySkill[];
  total: number;
  loading: boolean;
  query: string;
  offset: number;
  stats: { total: number; categories: Record<string, number>; lastUpdated: number } | null;
  detail: RegistrySkillDetail | null;
  detailLoading: boolean;
  outdated: string[];
}

const initialState: SkillRegistryState = {
  skills: [],
  total: 0,
  loading: false,
  query: '',
  offset: 0,
  stats: null,
  detail: null,
  detailLoading: false,
  outdated: [],
};

export const searchSkillRegistry = createAsyncThunk(
  'skillRegistry/search',
  async ({ q, limit = 20, offset = 0, sort = 'name', category = '' }: { q: string; limit?: number; offset?: number; sort?: string; category?: string }) => {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset), sort, category });
    const res = await fetch(`${SKILL_REGISTRY_API}/search?${params}`);
    if (!res.ok) throw new Error(`Skill registry search failed: ${res.status}`);
    return (await res.json()) as { skills: RegistrySkill[]; total: number; offset: number; limit: number };
  },
);

export const fetchSkillRegistryStats = createAsyncThunk('skillRegistry/stats', async () => {
  const res = await fetch(`${SKILL_REGISTRY_API}/stats`);
  return (await res.json()) as { total: number; categories: Record<string, number>; lastUpdated: number };
});

export const fetchAllRegistrySkills = createAsyncThunk(
  'skillRegistry/fetchAll',
  async () => {
    const params = new URLSearchParams({ q: '', limit: '100', offset: '0', sort: 'name', category: '' });
    const res = await fetch(`${SKILL_REGISTRY_API}/search?${params}`);
    if (!res.ok) throw new Error(`Skill registry fetchAll failed: ${res.status}`);
    return (await res.json()) as { skills: RegistrySkill[]; total: number; offset: number; limit: number };
  },
);

export const fetchSkillDetail = createAsyncThunk(
  'skillRegistry/detail',
  async (name: string) => {
    const res = await fetch(`${SKILL_REGISTRY_API}/detail/${encodeURIComponent(name)}`);
    const data = await res.json();
    return data.skill as RegistrySkillDetail;
  },
);

export interface CuratedInstallResult {
  installed: boolean;
  skill: Skill;
  files: string[];
  scripts: string[];
}

// Curated install fetches the WHOLE skill folder (scripts/assets), not just SKILL.md, so multi-file skills land complete. Caller refreshes the local skills list after.
export const installCuratedSkill = createAsyncThunk(
  'skillRegistry/installCurated',
  async (folder: string) => {
    const res = await fetch(`${SKILL_REGISTRY_API}/install-curated`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `install failed (${res.status})`);
    }
    return (await res.json()) as CuratedInstallResult;
  },
);

export interface SkillUpdatesResult {
  outdated: string[];
  checked: string[];
  unknown: string[];
}

// Which installed skills have a newer version upstream. Curated checks are free (cached tree); community checks are best-effort.
export const fetchSkillUpdates = createAsyncThunk('skillRegistry/updates', async () => {
  const res = await fetch(`${SKILL_REGISTRY_API}/updates`);
  if (!res.ok) throw new Error(`updates check failed (${res.status})`);
  return (await res.json()) as SkillUpdatesResult;
});

// Re-fetch an installed skill from its recorded source and overwrite it in place, bumping its version. Caller refreshes the local skills list + updates after.
export const updateInstalledSkill = createAsyncThunk(
  'skillRegistry/updateInstalled',
  async (skillId: string) => {
    const res = await fetch(`${SKILL_REGISTRY_API}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_id: skillId }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `update failed (${res.status})`);
    }
    return (await res.json()) as { updated: boolean; skill: Skill; scripts: string[]; secret_findings: string[] };
  },
);

const skillRegistrySlice = createSlice({
  name: 'skillRegistry',
  initialState,
  reducers: {
    clearSkillDetail(state) {
      state.detail = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(searchSkillRegistry.pending, (state, action) => {
        state.loading = true;
        state.query = action.meta.arg.q;
        state.offset = action.meta.arg.offset ?? 0;
      })
      .addCase(searchSkillRegistry.fulfilled, (state, action) => {
        state.loading = false;
        if (!action.payload || !Array.isArray(action.payload.skills)) return;
        if (action.meta.arg.offset && action.meta.arg.offset > 0) {
          state.skills = [...state.skills, ...action.payload.skills];
        } else {
          state.skills = action.payload.skills;
        }
        state.total = action.payload.total;
      })
      .addCase(searchSkillRegistry.rejected, (state) => {
        state.loading = false;
      })
      .addCase(fetchSkillRegistryStats.fulfilled, (state, action) => {
        state.stats = action.payload;
      })
      .addCase(fetchAllRegistrySkills.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchAllRegistrySkills.fulfilled, (state, action) => {
        state.loading = false;
        state.skills = action.payload.skills;
        state.total = action.payload.total;
      })
      .addCase(fetchAllRegistrySkills.rejected, (state) => {
        state.loading = false;
      })
      .addCase(fetchSkillDetail.pending, (state) => {
        state.detailLoading = true;
      })
      .addCase(fetchSkillDetail.fulfilled, (state, action) => {
        state.detailLoading = false;
        state.detail = action.payload;
      })
      .addCase(fetchSkillDetail.rejected, (state) => {
        state.detailLoading = false;
      })
      .addCase(fetchSkillUpdates.fulfilled, (state, action) => {
        state.outdated = action.payload.outdated;
      });
  },
});

export const { clearSkillDetail } = skillRegistrySlice.actions;
export default skillRegistrySlice.reducer;

// --------------------------------------------------------------------------- Community source (skills.sh wild registry). Kept as plain async helpers, not slice thunks: the CommunitySkillsDialog owns its own local state, so there's nothing to put in the store. Auth headers are injected by the global fetch interceptor (see shared/config.ts). ---------------------------------------------------------------------------

export interface CommunitySkill {
  name: string;
  description: string;
  source: string;   // GitHub owner/repo, e.g. "anthropics/skills"
  skillId: string;
  installs: number;
}

export interface InstallDisclosure {
  name: string;
  description: string;
  repo_url: string;
  skill_md: string;
  files: string[];
  scripts: string[];
  has_scripts: boolean;
  secret_findings: string[];
}

// The grammar people copy out of READMEs; cheap local gate so plain searches never buy a round-trip.
export const INSTALL_COMMAND_RE = /^(npx|npm|pnpm|bunx|yarn)\s|skills\.sh\//i;

export async function parseInstallCommand(command: string): Promise<string | null> {
  const res = await fetch(`${SKILL_REGISTRY_API}/parse-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { skill_id: string | null };
  return data.skill_id ?? null;
}

export async function searchCommunitySkills(q: string): Promise<CommunitySkill[]> {
  const params = new URLSearchParams({ q, limit: '30', source: 'community' });
  const res = await fetch(`${SKILL_REGISTRY_API}/search?${params}`);
  if (!res.ok) throw new Error(`community search failed: ${res.status}`);
  const data = await res.json();
  return (data.skills ?? []) as CommunitySkill[];
}

export async function installCommunitySkill(
  source: string,
  skillId: string,
  confirm: boolean,
): Promise<{ installed: boolean; disclosure: InstallDisclosure }> {
  const res = await fetch(`${SKILL_REGISTRY_API}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, skill_id: skillId, confirm }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `install failed: ${res.status}`);
  }
  return res.json();
}
