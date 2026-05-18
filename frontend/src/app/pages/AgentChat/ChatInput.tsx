import React, { useState, useRef, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import InputBase from '@mui/material/InputBase';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import Slider from '@mui/material/Slider';
import Collapse from '@mui/material/Collapse';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import StopIcon from '@mui/icons-material/Stop';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import CloseIcon from '@mui/icons-material/Close';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import Modal from '@mui/material/Modal';
import CircularProgress from '@mui/material/CircularProgress';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import CommandPicker, { CommandPickerItem, getToolGroupIcon } from '@/app/components/CommandPicker';
import { useElementSelection, SelectedElement } from '@/app/components/ElementSelectionContext';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { getClipboardCards, clearClipboard } from '@/shared/dashboardClipboard';
import { getWebview } from '@/shared/browserRegistry';
import { API_BASE, getAuthToken } from '@/shared/config';

/** Handles /context, /compact, /clear; returns true if intercepted so the prompt isn't sent to the agent. */
async function handleSlashCommand(cmd: string, sessionId: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  if (cmd === '/context') {
    window.dispatchEvent(new CustomEvent('openswarm:context-drawer', { detail: { sessionId, open: true } }));
    return true;
  }
  // /compact and /clear mount at /api/agents/sessions/{id}/..., not under the agents SubApp.
  if (cmd === '/compact') {
    try {
      await fetch(`${API_BASE}/agents/sessions/${sessionId}/compact`, { method: 'POST', headers });
    } catch {}
    return true;
  }
  if (cmd === '/clear') {
    try {
      await fetch(`${API_BASE}/agents/sessions/${sessionId}/clear`, { method: 'POST', headers });
    } catch {}
    return true;
  }
  return false;
}
import { ContextPath } from '@/app/components/DirectoryBrowser';
import {
  SKILL_PILL_ATTR,
  AttachedSkill,
  createSkillPillElement,
  serializeEditorContent,
  detectEditorTrigger,
  TriggerState,
  EMPTY_TRIGGER,
} from '@/app/components/richEditorUtils';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchModes } from '@/shared/state/modesSlice';
import { clearSessionMessages } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface AttachedImage {
  data: string;
  media_type: string;
  preview: string;
  // Set when preview uses createObjectURL; handleSend reads via FileReader to avoid retaining base64 in memory.
  _file?: File;
}

export interface ForcedToolGroup {
  label: string;
  tools: string[];
  icon?: React.ReactNode;
  iconKey?: string;
}

export type { AttachedSkill } from '@/app/components/richEditorUtils';

interface Props {
  onSend: (message: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: ContextPath[], forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => void;
  disabled?: boolean;
  mode: string;
  onModeChange: (mode: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  provider?: string;
  onProviderChange?: (provider: string) => void;
  isRunning?: boolean;
  onStop?: () => void;
  autoRunMode?: boolean;
  contextEstimate?: { used: number; limit: number };
  embedded?: boolean;
  autoFocus?: boolean;
  sessionId?: string;
  queueLength?: number;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto';
  onThinkingLevelChange?: (level: 'off' | 'low' | 'medium' | 'high' | 'auto') => void;
}

export interface ChatInputHandle {
  getConfig: () => { prompt: string; contextPaths: ContextPath[]; forcedTools: ForcedToolGroup[] };
  setContent: (prompt: string, contextPaths?: ContextPath[], forcedTools?: ForcedToolGroup[]) => void;
}

// Module-level draft store keyed by sessionId; survives unmount/remount and preserves skill pills via innerHTML.
const _draftStore = new Map<string, string>();
// 200ms debounce coalesces fast typing; innerHTML reads do full DOM serialization.
const _draftDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRAFT_DEBOUNCE_MS = 200;
function scheduleDraftSave(ownerId: string, getHtml: () => string) {
  const existing = _draftDebounceTimers.get(ownerId);
  if (existing) clearTimeout(existing);
  _draftDebounceTimers.set(ownerId, setTimeout(() => {
    _draftDebounceTimers.delete(ownerId);
    const html = getHtml();
    if (html && html !== '<br>') _draftStore.set(ownerId, html);
    else _draftStore.delete(ownerId);
  }, DRAFT_DEBOUNCE_MS));
}

const ICON_MAP: Record<string, React.ReactNode> = {
  smart_toy: <SmartToyOutlinedIcon sx={{ fontSize: 14 }} />,
  question_answer: <QuestionAnswerOutlinedIcon sx={{ fontSize: 14 }} />,
  map: <MapOutlinedIcon sx={{ fontSize: 14 }} />,
  category: <CategoryOutlinedIcon sx={{ fontSize: 14 }} />,
  tune: <TuneOutlinedIcon sx={{ fontSize: 14 }} />,
};

const FALLBACK_MODE_BASE = { label: 'Agent', icon: ICON_MAP.smart_toy };

const FALLBACK_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet 4.6', context_window: 1_000_000, reasoning: true },
  { value: 'opus', label: 'Claude Opus 4.6', context_window: 1_000_000, reasoning: true },
  { value: 'haiku', label: 'Claude Haiku 4.5', context_window: 200_000, reasoning: true },
];

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ContextRing: React.FC<{ used: number; limit: number; accentColor: string; trackColor: string }> = ({ used, limit, accentColor, trackColor }) => {
  if (used === 0) return null;
  const pct = Math.min((used / limit) * 100, 100);
  const size = 20;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  const tooltip = `${pct.toFixed(1)}% \u00B7 ${formatTokenCount(used)} / ${formatTokenCount(limit)} context used`;

  return (
    <Tooltip title={tooltip}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', p: 0.5 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={accentColor} strokeWidth={strokeWidth}
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </Box>
    </Tooltip>
  );
};

// Mirrors SubscriptionCard colors in Settings.
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#E8927A',
  openai: '#74AA9C',
  google: '#4285F4',
  gemini: '#4285F4',
  xai: '#8B949E',
  meta: '#0866FF',
  deepseek: '#4D6BFE',
  mistral: '#FF7000',
  qwen: '#A974FF',
  cohere: '#FF7759',
  openrouter: '#64748B',
};

const LS_RECENT_MODELS = 'openswarm.picker.recentModels';
const LS_RECENT_SEARCHES = 'openswarm.picker.recentSearches';
const RECENT_MODELS_MAX = 3;
const RECENT_SEARCHES_MAX = 4;
const OR_AUTO_COLLAPSE_THRESHOLD = 12;

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Heuristic tiering for pre-load FALLBACK_MODELS only; backend provides real tiers post-load.
type Tier = 1 | 2 | 3 | 4 | 5;
const clampTier = (n: number): Tier => Math.max(1, Math.min(5, n)) as Tier;

function _costBucket(out: number): Tier {
  if (out < 0.5) return 1;
  if (out < 2) return 2;
  if (out < 7) return 3;
  if (out < 25) return 4;
  return 5;
}

function tierIntelligence(opt: any): Tier {
  let tier: number = _costBucket(opt.output_cost_per_1m ?? 0);
  if (opt.reasoning) tier += 1;
  return clampTier(tier);
}

function tierSpeed(opt: any): Tier {
  let tier: number = 6 - _costBucket(opt.output_cost_per_1m ?? 0);
  if (opt.reasoning) tier -= 1;
  const lower = String(opt.label || '').toLowerCase();
  if (/\b(mini|lite|flash|haiku|nano|small|fast|turbo|micro|tiny)\b/.test(lower)) tier += 1;
  if (/\b(opus|ultra|max|xlarge|titan)\b/.test(lower)) tier -= 1;
  return clampTier(tier);
}

function tierCost(opt: any): Tier {
  return _costBucket(opt.output_cost_per_1m ?? 0);
}

/** Extract version number from a model label; clamps to <30 to skip param counts like 70B/120B. */
function modelVersion(label: string): number {
  const matches = String(label).matchAll(/(\d+(?:\.\d+)?)/g);
  let bestVersion = 0;
  for (const m of matches) {
    const v = parseFloat(m[1]);
    if (v >= 0.5 && v < 30 && v > bestVersion) bestVersion = v;
  }
  return bestVersion;
}

/** Strip versions and route suffixes so "Claude Sonnet 4.6" and 4.5 share one key. */
function modelFamilyKey(label: string): string {
  return String(label)
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\b/g, '')
    .replace(/\(api key\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sort: intelligence desc, family asc, version desc, label asc. */
function sortModelsForPicker<T extends { label: string }>(models: T[]): T[] {
  const intelOf = (opt: any): number => {
    if (Array.isArray(opt.tiers) && opt.tiers.length === 3) return opt.tiers[0];
    return tierIntelligence(opt);
  };
  return [...models].sort((a: any, b: any) => {
    const intelA = intelOf(a);
    const intelB = intelOf(b);
    if (intelA !== intelB) return intelB - intelA;
    const famA = modelFamilyKey(a.label);
    const famB = modelFamilyKey(b.label);
    if (famA !== famB) return famA.localeCompare(famB);
    const verA = modelVersion(a.label);
    const verB = modelVersion(b.label);
    if (verA !== verB) return verB - verA;
    return a.label.localeCompare(b.label);
  });
}

const ChatInput = forwardRef<ChatInputHandle, Props>(({ onSend, disabled, mode, onModeChange, model, onModelChange, provider, onProviderChange, isRunning, onStop, autoRunMode, contextEstimate, embedded, autoFocus, sessionId, queueLength = 0, thinkingLevel = 'auto', onThinkingLevelChange }, ref) => {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const generalFileInputRef = useRef<HTMLInputElement>(null);
  const dispatch = useAppDispatch();
  const elementSelection = useElementSelection();

  const fallbackOwnerIdRef = useRef(`input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const ownerId = sessionId || fallbackOwnerIdRef.current;

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const saved = _draftStore.get(ownerId);
    const editor = editorRef.current;
    if (saved && editor && !editor.textContent?.trim()) {
      editor.innerHTML = saved;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [hasContent, setHasContent] = useState(() => !!_draftStore.get(ownerId));
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const attachedSkillsRef = useRef(attachedSkills);
  attachedSkillsRef.current = attachedSkills;

  const [picker, setPicker] = useState<TriggerState>(EMPTY_TRIGGER);
  const skills = useAppSelector((state) => state.skills.items);
  const modesMap = useAppSelector((state) => state.modes.items);
  const modesArr = useMemo(() => Object.values(modesMap), [modesMap]);
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);
  const modelsLoaded = useAppSelector((state) => state.models.loaded);
  const connectionMode = useAppSelector((state) => state.settings.data.connection_mode);
  const toolItems = useAppSelector((state) => state.tools.items);


  const allModelOptions = useMemo(() => {
    if (!modelsLoaded || Object.keys(modelsByProvider).length === 0) {
      const key = connectionMode === 'openswarm-pro' ? 'OpenSwarm Pro' : 'Anthropic';
      return { flat: FALLBACK_MODELS.map(m => ({ ...m, provider: key })), grouped: { [key]: FALLBACK_MODELS } };
    }
    const flat: Array<any> = [];
    const grouped: Record<string, any[]> = {};
    for (const [prov, models] of Object.entries(modelsByProvider)) {
      const enriched = models.map((m: any) => ({
        value: m.value,
        label: m.label,
        context_window: m.context_window ?? 200_000,
        reasoning: !!m.reasoning,
        input_cost_per_1m: m.input_cost_per_1m ?? 0,
        output_cost_per_1m: m.output_cost_per_1m ?? 0,
        is_free: !!m.is_free,
        max_completion_tokens: m.max_completion_tokens ?? null,
        tiers: Array.isArray(m.tiers) && m.tiers.length === 3 ? m.tiers : undefined,
        billing_kind: m.billing_kind,
      }));
      grouped[prov] = sortModelsForPicker(enriched);
      for (const m of enriched) {
        flat.push({ ...m, provider: prov });
      }
    }
    return { flat, grouped };
  }, [modelsByProvider, modelsLoaded, connectionMode]);

  useEffect(() => {
    if (modesArr.length === 0) dispatch(fetchModes());
  }, [dispatch, modesArr.length]);

  const [modelSearch, setModelSearch] = useState('');
  const modelSearchRef = useRef<HTMLInputElement | null>(null);

  const [recentModels, setRecentModels] = useState<string[]>(
    () => readLS<string[]>(LS_RECENT_MODELS, []).slice(0, RECENT_MODELS_MAX),
  );
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readLS<string[]>(LS_RECENT_SEARCHES, []));
  const pushRecentModel = useCallback((value: string) => {
    setRecentModels((prev) => {
      const next = [value, ...prev.filter((v) => v !== value)].slice(0, RECENT_MODELS_MAX);
      writeLS(LS_RECENT_MODELS, next);
      return next;
    });
  }, []);
  const pushRecentSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const next = [trimmed, ...prev.filter((s) => s !== trimmed)].slice(0, RECENT_SEARCHES_MAX);
      writeLS(LS_RECENT_SEARCHES, next);
      return next;
    });
  }, []);

  type CapFilters = { reasoning: boolean; subscription: boolean; apiKey: boolean };
  const [capFilters, setCapFilters] = useState<CapFilters>({
    reasoning: false, subscription: false, apiKey: false,
  });

  const CTX_STEPS = [0, 32_000, 128_000, 200_000, 500_000, 1_000_000];
  const CTX_LABELS = ['Any', '32K+', '128K+', '200K+', '500K+', '1M+'];
  const COST_STEPS = [Infinity, 50, 15, 5, 1, 0];
  const COST_LABELS = ['Any', '≤$50/M', '≤$15/M', '≤$5/M', '≤$1/M', 'Free only'];
  const [ctxIdx, setCtxIdx] = useState(0);
  const [costIdx, setCostIdx] = useState(0);

  const LS_FILTERS_EXPANDED = 'openswarm.picker.filtersExpanded';
  const [filtersExpanded, setFiltersExpanded] = useState<boolean>(
    () => readLS<boolean>(LS_FILTERS_EXPANDED, false),
  );
  const toggleFilters = useCallback(() => {
    setFiltersExpanded((prev) => {
      writeLS(LS_FILTERS_EXPANDED, !prev);
      return !prev;
    });
  }, []);
  const anyFilterActive = (
    capFilters.reasoning || capFilters.subscription || capFilters.apiKey
    || ctxIdx > 0 || costIdx > 0
  );

  const LS_COLLAPSED_GROUPS = 'openswarm.picker.collapsedGroups';
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    () => readLS<Record<string, boolean>>(LS_COLLAPSED_GROUPS, {}),
  );
  const toggleGroupCollapse = useCallback((prov: string, currentlyCollapsed: boolean) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [prov]: !currentlyCollapsed };
      writeLS(LS_COLLAPSED_GROUPS, next);
      return next;
    });
  }, []);

  // Keyed by model value so stale probe results don't display.
  const [probeResult, setProbeResult] = useState<{ value: string; ok: boolean; error?: string; latency_ms?: number } | null>(null);

  const filteredModelGroups = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const minCtx = CTX_STEPS[ctxIdx] || 0;
    const maxCost = COST_STEPS[costIdx];
    const anyCap = (
      capFilters.reasoning || capFilters.subscription || capFilters.apiKey
      || ctxIdx > 0 || costIdx > 0
    );
    const filterFn = (m: any): boolean => {
      if (capFilters.reasoning && !m.reasoning) return false;
      if (capFilters.subscription || capFilters.apiKey) {
        const okSub = capFilters.subscription && m.billing_kind === 'subscription';
        const okApi = capFilters.apiKey && m.billing_kind === 'api_key';
        if (!okSub && !okApi) return false;
      }
      if (minCtx > 0 && (m.context_window ?? 0) < minCtx) return false;
      // maxCost=0 ("Free only") passes subscription (free to user); paid/api_key excluded regardless of price.
      if (maxCost !== Infinity) {

        if (maxCost === 0) {
          if (m.billing_kind !== 'free' && m.billing_kind !== 'subscription') return false;
        } else {
          if (
            (m.billing_kind === 'paid' || m.billing_kind === 'api_key')
            && (m.output_cost_per_1m ?? 0) > maxCost
          ) return false;
        }
      }
      return true;
    };
    if (!q && !anyCap) return allModelOptions.grouped;
    const out: Record<string, Array<any>> = {};
    for (const [prov, models] of Object.entries(allModelOptions.grouped)) {
      const provLower = prov.toLowerCase();
      const qMatch = (m: any) =>
        !q
        || m.label.toLowerCase().includes(q)
        || m.value.toLowerCase().includes(q)
        || provLower.includes(q);
      const matches = (models as any[]).filter((m) => filterFn(m) && qMatch(m));
      if (matches.length) out[prov] = matches;
    }
    return out;
  }, [modelSearch, allModelOptions.grouped, capFilters, ctxIdx, costIdx]);

  const pickerSummary = useMemo(() => {
    let total = 0, free = 0, reasoning = 0, subscription = 0, apiKey = 0, paid = 0, longContext = 0;
    for (const ms of Object.values(filteredModelGroups)) {
      for (const m of ms as any[]) {
        total += 1;
        if (m.reasoning) reasoning += 1;
        if ((m.context_window ?? 0) >= 1_000_000) longContext += 1;
        if (m.billing_kind === 'free') free += 1;
        else if (m.billing_kind === 'subscription') subscription += 1;
        else if (m.billing_kind === 'api_key') apiKey += 1;
        else if (m.billing_kind === 'paid') paid += 1;
      }
    }
    return { total, free, reasoning, subscription, apiKey, paid, longContext };
  }, [filteredModelGroups]);

  const recentMaterialised = useMemo(() => {
    const flatByValue = new Map(allModelOptions.flat.map((m) => [m.value, m]));
    return recentModels
      .map((v) => flatByValue.get(v))
      .filter(Boolean) as typeof allModelOptions.flat;
  }, [recentModels, allModelOptions.flat]);
  const showRecents = (
    !modelSearch.trim()
    && !capFilters.reasoning && !capFilters.subscription && !capFilters.apiKey
    && ctxIdx === 0 && costIdx === 0
    && recentMaterialised.length > 0
  );

  const buildModelTooltip = useCallback((opt: any): React.ReactNode => {
    const [intel, speed, cost] = (Array.isArray(opt.tiers) && opt.tiers.length === 3)
      ? opt.tiers
      : [tierIntelligence(opt), tierSpeed(opt), tierCost(opt)];
    const billingKind: 'paid' | 'subscription' | 'free' = opt.billing_kind || (opt.is_free ? 'free' : 'paid');
    const Bars = ({ filled, palette }: { filled: number; palette: string[] }) => {
      const TOTAL_CELLS = 15;
      const filledCells = Math.round((filled / 5) * TOTAL_CELLS);
      return (
        <Box sx={{ display: 'inline-flex', gap: '1px', alignItems: 'center' }}>
          {Array.from({ length: TOTAL_CELLS }, (_, i) => {
            const on = i < filledCells;
            const colorIdx = on
              ? Math.min(palette.length - 1, Math.floor((i / Math.max(filledCells - 1, 1)) * (palette.length - 1)))
              : 0;
            return (
              <Box
                key={i}
                sx={{
                  width: 5, height: 5,
                  bgcolor: on ? palette[colorIdx] : c.border.subtle,
                  opacity: on ? 1 : 0.3,
                  transformOrigin: 'center',
                  animation: on
                    ? `pixelPop 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.018}s both`
                    : 'none',
                  '@keyframes pixelPop': {
                    '0%':   { transform: 'scale(0)', opacity: 0 },
                    '60%':  { transform: 'scale(1.2)', opacity: 1 },
                    '100%': { transform: 'scale(1)', opacity: 1 },
                  },
                }}
              />
            );
          })}
        </Box>
      );
    };
    const INTEL_PALETTE  = ['#6D5BBE', '#8870D5', '#A78BFA', '#BFA3FF', '#D5BFFF'];
    const SPEED_PALETTE  = ['#2DBFAA', '#42D6BF', '#5EEAD4', '#7FF1DF', '#A3F7E9'];
    const COST_PALETTE   = ['#C7752E', '#DD8A3D', '#F59E0B', '#FAB23C', '#FCC773'];
    const capabilities = [
      opt.reasoning && 'Reasoning',
      'Tools',
      billingKind === 'free' && 'Free tier',
      billingKind === 'subscription' && 'Subscription',
      (opt.context_window ?? 0) >= 1_000_000 && '1M+ context',
    ].filter(Boolean).join(' · ');
    return (
      <Box sx={{ fontSize: '0.74rem', lineHeight: 1.55, minWidth: 256 }}>
        <Box sx={{
          fontWeight: 600, fontSize: '0.85rem', mb: 0.85,
          color: c.text.primary,
          letterSpacing: '-0.01em',
          pb: 0.6,
          borderBottom: `1px solid ${c.border.subtle}`,
        }}>
          {opt.label}
        </Box>
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 1.75, rowGap: 0.5,
          alignItems: 'center',
          color: c.text.muted,
        }}>
          <span>Intelligence</span><Bars filled={intel} palette={INTEL_PALETTE} />
          <span>Speed</span><Bars filled={speed} palette={SPEED_PALETTE} />
          {billingKind === 'subscription' ? null : (
            <>
              <span>Cost</span>
              {billingKind === 'free'
                ? <Box component="span" sx={{ color: '#10b981', fontWeight: 600 }}>Free</Box>
                : <Bars filled={cost} palette={COST_PALETTE} />}
            </>
          )}
          <span>Context</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: c.text.secondary }}>
            {(opt.context_window ?? 0).toLocaleString()}
          </span>
          {billingKind === 'paid' && (opt.input_cost_per_1m || opt.output_cost_per_1m) ? (
            <>
              <span>Pricing</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: c.text.secondary }}>
                ${opt.input_cost_per_1m?.toFixed(2)}/M in · ${opt.output_cost_per_1m?.toFixed(2)}/M out
              </span>
            </>
          ) : null}
          {capabilities && (
            <>
              <span>Capabilities</span>
              <span style={{ color: c.text.secondary }}>{capabilities}</span>
            </>
          )}
        </Box>
      </Box>
    );
  }, [c]);

  const tooltipSlotProps = useMemo(() => ({
    tooltip: {
      sx: {
        bgcolor: c.bg.elevated,
        color: c.text.primary,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: `${c.radius.md}px`,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.32)',
        padding: '12px 14px',
        maxWidth: 340,
        fontSize: '0.78rem',
        fontFamily: c.font.sans,
      },
    },
    arrow: { sx: { color: c.bg.elevated, '&:before': { border: `1px solid ${c.border.subtle}` } } },
  }), [c]);

  const [images, setImages] = useState<AttachedImage[]>([]);
  // Ref so unmount cleanup revokes the latest blob: preview URLs.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => {
    for (const img of imagesRef.current) {
      if (img.preview?.startsWith('blob:')) {
        try { URL.revokeObjectURL(img.preview); } catch {}
      }
    }
  }, []);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [contextPaths, setContextPaths] = useState<ContextPath[]>([]);
  const [forcedTools, setForcedTools] = useState<ForcedToolGroup[]>([]);
  const [copiedPathIdx, setCopiedPathIdx] = useState<number | null>(null);

  useImperativeHandle(ref, () => ({
    getConfig: () => {
      const editor = editorRef.current;
      const prompt = editor ? serializeEditorContent(editor, attachedSkillsRef.current).trim() : '';
      return { prompt, contextPaths, forcedTools };
    },
    setContent: (prompt: string, newContextPaths?: ContextPath[], newForcedTools?: ForcedToolGroup[]) => {
      const editor = editorRef.current;
      if (editor) {
        editor.textContent = prompt;
        setHasContent(!!prompt);
      }
      if (newContextPaths) setContextPaths(newContextPaths);
      if (newForcedTools) setForcedTools(newForcedTools);
    },
  }), [contextPaths, forcedTools]);

  const [modeAnchor, setModeAnchor] = useState<HTMLElement | null>(null);
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
  const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (modelAnchor) {
      const t = setTimeout(() => modelSearchRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    setModelSearch('');
  }, [modelAnchor]);

  // Debounced 1-token probe surfaces 401/402/etc before send.
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/agents/probe-model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        if (cancelled) return;
        const data = await res.json();
        setProbeResult({ value: model, ok: !!data.ok, error: data.error, latency_ms: data.latency_ms });
      } catch {}
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [model]);

  const currentMode = modesMap[mode];
  const FALLBACK_MODE = { ...FALLBACK_MODE_BASE, color: c.accent.primary };
  const modeConf = currentMode
    ? { label: currentMode.name, icon: ICON_MAP[currentMode.icon] || ICON_MAP.smart_toy, color: currentMode.color }
    : FALLBACK_MODE;

  const updateHasContent = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    const hasPills = editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null;
    setHasContent(text.trim().length > 0 || hasPills);
  }, []);

  const syncAttachedSkills = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const pillIds = new Set(
      Array.from(editor.querySelectorAll(`[${SKILL_PILL_ATTR}]`))
        .map((el) => el.getAttribute(SKILL_PILL_ATTR))
        .filter(Boolean) as string[],
    );
    setAttachedSkills((prev) => {
      const prevKeys = Object.keys(prev);
      if (prevKeys.length === pillIds.size && prevKeys.every((k) => pillIds.has(k))) return prev;
      const next: Record<string, AttachedSkill> = {};
      for (const [id, skill] of Object.entries(prev)) {
        if (pillIds.has(id)) next[id] = skill;
      }
      return next;
    });
  }, []);

  const removeSkillPill = useCallback((skillId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const pill = editor.querySelector(`[${SKILL_PILL_ATTR}="${skillId}"]`);
    if (pill) pill.remove();
    setAttachedSkills((prev) => {
      const { [skillId]: _, ...rest } = prev;
      return rest;
    });
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    const hasPills = editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null;
    setHasContent(text.trim().length > 0 || hasPills);
    editor.focus();
  }, []);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    // Preview via blob: URL; base64 only materializes at send (saves ~2.7MB JS heap per attachment).
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const previewUrl = URL.createObjectURL(file);
      setImages((prev) => [
        ...prev,
        { data: '', media_type: file.type, preview: previewUrl, _file: file } as AttachedImage,
      ]);
    });
  }, []);

  const uploadAndAttachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      const resp = await fetch(`${API_BASE}/settings/upload-files`, {
        method: 'POST',
        body: formData,
      });
      if (!resp.ok) throw new Error('Upload failed');
      const data = await resp.json();
      const newPaths: ContextPath[] = (data.files || []).map((f: { path: string }) => ({
        path: f.path,
        type: 'file' as const,
      }));
      setContextPaths((prev) => [...prev, ...newPaths]);
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setIsUploading(false);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    const serialized = serializeEditorContent(editor, attachedSkillsRef.current);
    let trimmed = serialized.trim();
    if (!trimmed) return;

    onboardingBus.emit('chat:message_sent');
    if (window.location.hash.includes('/apps/')) {
      onboardingBus.emit('app:generation_started');
    }

    if (sessionId && trimmed.startsWith('/')) {
      const cmd = trimmed.split(/\s+/)[0].toLowerCase();
      const handled = await handleSlashCommand(cmd, sessionId);
      if (handled) {
        editor.innerHTML = '';
        _draftStore.delete(ownerId);
        setHasContent(false);
        return;
      }
    }

    const selectedEls = elementSelection?.elementsByOwner?.[ownerId] ?? [];
    let allImages: Array<{ data: string; media_type: string }> = [];
    if (images.length > 0) {
      allImages = await Promise.all(images.map(async (img) => {
        if (img.data) return { data: img.data, media_type: img.media_type };
        if (img._file) {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const r = reader.result as string;
              resolve(r.split(',')[1] ?? '');
            };
            reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
            reader.readAsDataURL(img._file!);
          });
          return { data: base64, media_type: img.media_type };
        }
        return { data: '', media_type: img.media_type };
      }));
      allImages = allImages.filter((i) => i.data);
    }

    if (selectedEls.length > 0) {
      const lines: string[] = ['\n\n---\nSelected UI Elements:\n'];
      for (let i = 0; i < selectedEls.length; i++) {
        const el = selectedEls[i];

        if (el.semanticType === 'browser-card' && el.semanticData?.selectId) {
          const wv = getWebview(el.semanticData.selectId as string);
          const url = wv ? (el.semanticData.url || wv.getURL()) : (el.semanticData.url || '');
          const title = wv ? (el.semanticData.name || wv.getTitle()) : (el.semanticLabel || '');
          lines.push(`${i + 1}. [Browser Card] ${title}`);
          lines.push(`   browser_id: ${el.semanticData.selectId}`);
          if (url) lines.push(`   URL: ${url}`);
          lines.push(`   (Use BrowserAgent with this browser_id to interact with it, or CreateBrowserAgent for a new browser)`);
        } else if (el.semanticType && el.semanticData) {
          const typeLabel = {
            'agent-card': 'Agent Card',
            'message': 'Message',
            'tool-call': 'Tool Call',
            'tool-group': 'Tool Group',
            'view-card': 'App Card',
            'browser-card': 'Browser Card',
            'dom-element': 'Element',
          }[el.semanticType] || el.semanticType;
          lines.push(`${i + 1}. [${typeLabel}] ${el.semanticLabel || ''}`);
          const { selectId, ...rest } = el.semanticData;
          if (selectId) lines.push(`   ID: ${selectId}`);
          const metaStr = Object.entries(rest)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(', ');
          if (metaStr) lines.push(`   ${metaStr}`);
          if (el.semanticType === 'agent-card' && selectId) {
            lines.push(`   (Use InvokeAgent with session_id "${selectId}" to query this agent with full conversation context)`);
          }
        } else {
          const styleStr = Object.entries(el.computedStyles)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ');
          lines.push(`${i + 1}. \`${el.selectorPath}\` (${el.tagName.toLowerCase()})`);
          lines.push(`   Selector: ${el.selectorPath}`);
          lines.push(`   HTML: ${el.outerHTML.length > 500 ? el.outerHTML.slice(0, 500) + '...' : el.outerHTML}`);
          if (styleStr) lines.push(`   Key styles: ${styleStr}`);
        }
        lines.push('');

        if (el.screenshot) {
          const base64 = el.screenshot.replace(/^data:image\/\w+;base64,/, '');
          allImages.push({ data: base64, media_type: 'image/png' });
        }
      }
      trimmed += lines.join('\n');
    }

    const sendImages = allImages.length > 0 ? allImages : undefined;
    const allForcedToolNames = forcedTools.flatMap((ft) => ft.tools);
    const currentSkills = Object.values(attachedSkillsRef.current);
    const sendSkills = currentSkills.length > 0
      ? currentSkills.map((s) => ({ id: s.id, name: s.name, content: s.content }))
      : undefined;
    const browserIds = selectedEls
      .filter((el) => el.semanticType === 'browser-card' && el.semanticData?.selectId)
      .map((el) => el.semanticData!.selectId as string);
    onSend(
      trimmed,
      sendImages,
      contextPaths.length > 0 ? contextPaths : undefined,
      allForcedToolNames.length > 0 ? allForcedToolNames : undefined,
      sendSkills,
      browserIds.length > 0 ? browserIds : undefined,
    );
    editor.innerHTML = '';
    _draftStore.delete(ownerId);
    for (const img of images) {
      if (img.preview?.startsWith('blob:')) {
        try { URL.revokeObjectURL(img.preview); } catch {}
      }
    }
    setImages([]);
    setContextPaths([]);
    setForcedTools([]);
    setAttachedSkills({});
    setHasContent(false);
    elementSelection?.clearOwnerElements(ownerId);
  }, [disabled, images, contextPaths, forcedTools, onSend, elementSelection, ownerId]);

  const detectTrigger = useCallback(() => {
    const result = detectEditorTrigger();
    if (result) {
      setPicker(result);
    } else {
      // Bailout when already hidden; otherwise spreading a new object re-renders all of ChatInput on every keystroke (~199ms input delay).
      setPicker((p) => p.visible ? { ...p, visible: false } : p);
    }
  }, []);

  // Set by handlePaste before the synthetic input fires so handleInput skips post-input scans paste can't invalidate.
  const justPastedRef = useRef(false);

  const handleInput = useCallback(() => {
    if (justPastedRef.current) {
      justPastedRef.current = false;
      setHasContent(true);
      scheduleDraftSave(ownerId, () => editorRef.current?.innerHTML ?? '');
      return;
    }
    updateHasContent();
    detectTrigger();
    syncAttachedSkills();
    scheduleDraftSave(ownerId, () => editorRef.current?.innerHTML ?? '');
  }, [updateHasContent, detectTrigger, syncAttachedSkills, ownerId]);

  const handleEditorClick = useCallback(() => {
    detectTrigger();
  }, [detectTrigger]);

  const handlePickerSelect = (item: CommandPickerItem) => {
    setPicker((p) => ({ ...p, visible: false }));
    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();

    const { triggerNode, triggerOffset, filter } = picker;
    if (triggerNode && triggerNode.parentNode && editor.contains(triggerNode)) {
      const endOffset = Math.min(triggerOffset + 1 + filter.length, triggerNode.length);
      const range = document.createRange();
      range.setStart(triggerNode, triggerOffset);
      range.setEnd(triggerNode, endOffset);
      range.deleteContents();
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }

    if (item.type === 'skill') {
      const skill = skills[item.id];
      if (!skill) return;
      if (editor.querySelector(`[${SKILL_PILL_ATTR}="${skill.id}"]`)) return;

      const pill = createSkillPillElement(
        { id: skill.id, name: skill.name, content: skill.content },
        removeSkillPill,
        c.font.mono,
        c.status.error,
      );

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode(pill);
        const spacer = document.createTextNode('\u200B');
        pill.after(spacer);
        const newRange = document.createRange();
        newRange.setStartAfter(spacer);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }

      setAttachedSkills((prev) => ({
        ...prev,
        [skill.id]: { id: skill.id, name: skill.name, content: skill.content },
      }));
    } else if (item.type === 'mode') {
      onModeChange(item.id);
    } else if (item.type === 'context') {
      if (item.command === 'file') {
        generalFileInputRef.current?.click();
      } else if (item.toolNames && item.toolNames.length > 0) {
        setForcedTools((prev) => [...prev, { label: item.name, tools: item.toolNames!, icon: item.icon, iconKey: item.iconKey }]);
      } else {
        document.execCommand('insertText', false, `@${item.command} `);
      }
    }

    updateHasContent();
    setTimeout(() => editor.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (picker.visible && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (sessionId) {
        handleSlashCommand('/clear', sessionId).catch(() => {});
        dispatch(clearSessionMessages(sessionId));
      }
      const editor = editorRef.current;
      if (editor) {
        editor.innerHTML = '';
        updateHasContent();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !autoRunMode) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const copied = getClipboardCards();
    if (copied.length > 0 && elementSelection) {
      e.preventDefault();
      for (const card of copied) {
        const semanticTypeMap: Record<string, SelectedElement['semanticType']> = {
          agent: 'agent-card',
          view: 'view-card',
          browser: 'browser-card',
        };
        const semanticType = semanticTypeMap[card.type];
        if (!semanticType) continue;
        const labelMap: Record<string, string> = {
          'agent-card': 'Agent',
          'view-card': 'View',
          'browser-card': 'Browser',
        };
        const semanticLabel = (labelMap[semanticType] || semanticType) + ': ' + card.name;
        const el: SelectedElement = {
          id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          selectorPath: `[data-select-type="${semanticType}"][data-select-id="${card.id}"]`,
          tagName: 'DIV',
          className: '',
          outerHTML: '',
          computedStyles: {},
          boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          semanticType,
          semanticLabel,
          semanticData: { ...card.meta, selectId: card.id },
        };
        elementSelection.addElementForOwner(ownerId, el);
      }
      clearClipboard();
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImageFiles(imageFiles);
      return;
    }
    e.preventDefault();
    const plain = e.clipboardData.getData('text/plain');
    if (plain) {
      justPastedRef.current = true;
      document.execCommand('insertText', false, plain);
    }
  }, [addImageFiles, elementSelection, ownerId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length === 0) return;
    const allFiles = Array.from(e.dataTransfer.files);
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const otherFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0) addImageFiles(imageFiles);
    if (otherFiles.length > 0) uploadAndAttachFiles(otherFiles);
  }, [addImageFiles, uploadAndAttachFiles]);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => {
      const removed = prev[idx];
      if (removed?.preview?.startsWith('blob:')) {
        try { URL.revokeObjectURL(removed.preview); } catch {}
      }
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const menuPaperProps = {
    sx: {
      bgcolor: c.bg.surface,
      border: `1px solid ${c.border.subtle}`,
      borderRadius: '10px',
      minWidth: 180,
      maxWidth: 380,
      maxHeight: 400,
      boxShadow: c.shadow.lg,
      '& .MuiMenuItem-root': {
        fontSize: '0.8rem',
        color: c.text.secondary,
        py: 0.75,
        px: 1.5,
        '&:hover': { bgcolor: c.bg.secondary },
      },
    },
  };

  const selectedElements = elementSelection?.elementsByOwner?.[ownerId] ?? [];
  const hasAttachments = images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0 || selectedElements.length > 0;

  return (
    <Box
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        position: 'relative',
        ...(embedded
          ? {}
          : {
              mx: 1.5,
              mb: 1.5,
              borderRadius: '16px',
              border: isDragOver ? `1px solid ${c.accent.primary}` : `1px solid ${c.border.subtle}`,
              bgcolor: c.bg.surface,
              boxShadow: c.shadow.md,
              transition: 'border-color 0.15s',
            }),
      }}
    >
      {isDragOver && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(174,86,48,0.04)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            pointerEvents: 'none',
          }}
        >
          <AttachFileIcon sx={{ fontSize: 16, color: c.accent.primary, mr: 0.5 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>
            Drop files here
          </Typography>
        </Box>
      )}

      {isUploading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(174,86,48,0.04)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            pointerEvents: 'none',
          }}
        >
          <CircularProgress size={14} sx={{ color: c.accent.primary, mr: 1 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>
            Attaching files…
          </Typography>
        </Box>
      )}

      <CommandPicker
        trigger={picker.trigger}
        filter={picker.filter}
        onSelect={handlePickerSelect}
        onClose={() => setPicker((p) => ({ ...p, visible: false }))}
        visible={picker.visible}
      />

      {images.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            gap: 0.75,
            px: 1.5,
            pt: 1,
            pb: 0.5,
            overflowX: 'auto',
            '&::-webkit-scrollbar': { height: 4 },
            '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          }}
        >
          {images.map((img, idx) => (
            <Box
              key={idx}
              sx={{
                position: 'relative',
                width: 56,
                height: 56,
                flexShrink: 0,
                borderRadius: '8px',
                overflow: 'hidden',
                border: `1px solid ${c.border.subtle}`,
                cursor: 'pointer',
                transition: 'opacity 0.15s, transform 0.15s',
                '&:hover': { opacity: 0.85, transform: 'scale(1.04)' },
              }}
              onClick={() => setLightboxSrc(img.preview)}
            >
              <img
                src={img.preview}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                sx={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  width: 18,
                  height: 18,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  color: c.text.tertiary,
                  '&:hover': { bgcolor: c.bg.secondary, color: c.text.primary },
                }}
              >
                <CloseIcon sx={{ fontSize: 10 }} />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}

      {contextPaths.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: images.length > 0 ? 0.25 : 1, pb: 0 }}>
          {contextPaths.map((cp, idx) => {
            const isAppWorkspace = /\/outputs_workspace\/ws-[^/]+\/?$/.test(cp.path);
            const label = isAppWorkspace
              ? 'App files'
              : cp.path.split('/').filter(Boolean).slice(-2).join('/');
            return (
              <Tooltip
                key={`${cp.path}-${idx}`}
                title={copiedPathIdx === idx ? 'Copied!' : cp.path}
                arrow
                placement="top"
                slotProps={{
                  tooltip: {
                    sx: {
                      fontFamily: c.font.mono,
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              >
                <Chip
                  icon={
                    cp.type === 'directory'
                      ? <FolderOpenIcon sx={{ fontSize: 14 }} />
                      : <InsertDriveFileOutlinedIcon sx={{ fontSize: 14 }} />
                  }
                  label={label}
                  size="small"
                  onClick={() => {
                    navigator.clipboard.writeText(cp.path);
                    setCopiedPathIdx(idx);
                    setTimeout(() => setCopiedPathIdx((cur) => cur === idx ? null : cur), 1200);
                  }}
                  onDelete={() => setContextPaths((prev) => prev.filter((_, i) => i !== idx))}
                  sx={{
                    bgcolor: `${c.accent.primary}12`,
                    color: c.accent.primary,
                    fontSize: '0.72rem',
                    fontFamily: c.font.mono,
                    height: 26,
                    maxWidth: 220,
                    cursor: 'pointer',
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    '& .MuiChip-deleteIcon': {
                      color: c.accent.primary,
                      fontSize: 16,
                      '&:hover': { color: c.status.error },
                    },
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}

      {forcedTools.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (images.length > 0 || contextPaths.length > 0) ? 0.25 : 1, pb: 0 }}>
          {forcedTools.map((ft, idx) => (
            <Chip
              key={`ft-${ft.label}-${idx}`}
              icon={<>{ft.icon || getToolGroupIcon(ft.iconKey || ft.label, 14)}</>}
              label={`@${ft.label.toLowerCase()}`}
              size="small"
              onDelete={() => setForcedTools((prev) => prev.filter((_, i) => i !== idx))}
              sx={{
                bgcolor: `${c.status.info}15`,
                color: c.status.info,
                fontSize: '0.72rem',
                fontFamily: c.font.mono,
                height: 26,
                maxWidth: 220,
                '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                '& .MuiChip-deleteIcon': {
                  color: c.status.info,
                  fontSize: 16,
                  '&:hover': { color: c.status.error },
                },
              }}
            />
          ))}
        </Box>
      )}

      {selectedElements.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0) ? 0.25 : 1, pb: 0 }}>
          {selectedElements.map((el) => {
            const chipLabel = el.semanticLabel
              ? el.semanticLabel
              : el.className
                ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}`
                : el.tagName.toLowerCase();
            const tooltipText = el.semanticType
              ? `${el.semanticType}: ${el.semanticLabel || el.selectorPath}`
              : el.selectorPath;
            return (
              <Tooltip
                key={el.id}
                title={tooltipText}
                arrow
                placement="top"
                slotProps={{
                  tooltip: {
                    sx: {
                      fontFamily: c.font.mono,
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              >
                <Chip
                  icon={<AdsClickIcon sx={{ fontSize: 14 }} />}
                  label={chipLabel}
                  size="small"
                  onDelete={() => elementSelection?.removeOwnerElement(ownerId, el.id)}
                  sx={{
                    bgcolor: 'rgba(59, 130, 246, 0.1)',
                    color: '#3b82f6',
                    fontSize: '0.72rem',
                    fontFamily: c.font.mono,
                    height: 26,
                    maxWidth: 220,
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    '& .MuiChip-deleteIcon': {
                      color: '#3b82f6',
                      fontSize: 16,
                      '&:hover': { color: c.status.error },
                    },
                    '& .MuiChip-icon': {
                      color: '#3b82f6',
                    },
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}

      <Box sx={{ px: 1.5, pt: hasAttachments ? 0.5 : 1.25, pb: 0.25, position: 'relative' }}>
        <div
          ref={editorRef}
          data-onboarding="chat-input"
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck
          autoCorrect="on"
          autoCapitalize="sentences"
          onInput={handleInput}
          onClick={handleEditorClick}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          style={{
            width: '100%',
            minHeight: '1.5em',
            maxHeight: 220,
            overflowY: 'auto',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: c.text.primary,
            fontSize: '0.95rem',
            lineHeight: '1.55',
            fontFamily: 'inherit',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        />
        {!hasContent && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              padding: `${hasAttachments ? 4 : 10}px 12px`,
              color: c.text.tertiary,
              fontSize: '0.95rem',
              lineHeight: '1.5',
              fontFamily: 'inherit',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          >
            {disabled ? 'Agent is working...' : autoRunMode ? 'Describe what data to generate…' : isRunning ? (queueLength > 0 ? `${queueLength} queued, type another or wait…` : 'Agent is working, messages will queue…') : `${modeConf.label}, @ for context, / for commands`}
          </div>
        )}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 1,
          pb: 0.75,
          pt: 0,
        }}
      >
        <Box
          onClick={(e) => setModeAnchor(e.currentTarget)}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            py: 0.375,
            borderRadius: '999px',
            cursor: 'pointer',
            userSelect: 'none',
            color: modeConf.color,
            bgcolor: `${modeConf.color}14`,
            '&:hover': { bgcolor: `${modeConf.color}22` },
            transition: 'background 0.15s',
          }}
        >
          {modeConf.icon}
          <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: 'inherit', lineHeight: 1 }}>
            {modeConf.label}
          </Typography>
          <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
        </Box>

        <Menu
          anchorEl={modeAnchor}
          open={Boolean(modeAnchor)}
          onClose={() => setModeAnchor(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: menuPaperProps }}
          autoFocus
          MenuListProps={{ autoFocusItem: true, disablePadding: false }}
        >
          {modesArr.map((m) => {
            const icon = ICON_MAP[m.icon] || ICON_MAP.smart_toy;
            return (
              <MenuItem
                key={m.id}
                selected={mode === m.id}
                onClick={() => {
                  onModeChange(m.id);
                  setModeAnchor(null);
                }}
              >
                <ListItemIcon sx={{ color: m.color, minWidth: 28 }}>
                  {icon}
                </ListItemIcon>
                <ListItemText
                  primary={m.name}
                  slotProps={{ primary: { sx: { fontSize: '0.8rem', color: mode === m.id ? m.color : c.text.secondary } } }}
                />
              </MenuItem>
            );
          })}
        </Menu>

        <Box
          onClick={(e) => setModelAnchor(e.currentTarget)}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.75,
            py: 0.25,
            borderRadius: '6px',
            cursor: 'pointer',
            userSelect: 'none',
            color: c.text.muted,
            '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
            transition: 'background 0.15s',
          }}
        >
          <Typography sx={{ fontSize: '0.82rem', fontWeight: 500, color: 'inherit', lineHeight: 1 }}>
            {(() => { const m = allModelOptions.flat.find((m) => m.value === model); return m ? m.label : model; })()}
          </Typography>
          <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
        </Box>

        <Menu
          anchorEl={modelAnchor}
          open={Boolean(modelAnchor)}
          onClose={() => setModelAnchor(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: menuPaperProps }}
          autoFocus={false}
          MenuListProps={{ autoFocusItem: false }}
        >
          {/* Sticky header stops click+key so Menu doesn't typeahead while user types. */}
          <Box
            onKeyDown={(e) => {
              if (e.key !== 'Escape') e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            sx={{
              position: 'sticky', top: 0, zIndex: 2,
              bgcolor: c.bg.surface,
              borderBottom: `1px solid ${c.border.subtle}`,
              display: 'flex', flexDirection: 'column',
              outline: 'none',
              '&:focus, &:focus-within': { outline: 'none' },
            }}
          >
            <Box sx={{
              px: 1.25, height: 36,
              display: 'flex', alignItems: 'center', gap: 0.75,
              flexShrink: 0,
            }}>
              <SearchIcon sx={{ fontSize: 16, color: c.text.ghost }} />
              <InputBase
                inputRef={modelSearchRef}
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && modelSearch.trim()) {
                    pushRecentSearch(modelSearch);
                  }
                }}
                placeholder="Search models…"
                fullWidth
                sx={{
                  fontSize: '0.85rem',
                  color: c.text.primary,
                  '& input': { padding: 0 },
                  '& input::placeholder': { color: c.text.ghost, opacity: 1 },
                }}
              />
              <Tooltip
                title={anyFilterActive
                  ? `${[capFilters.reasoning, capFilters.subscription, capFilters.apiKey, ctxIdx > 0, costIdx > 0].filter(Boolean).length} active filter${[capFilters.reasoning, capFilters.subscription, capFilters.apiKey, ctxIdx > 0, costIdx > 0].filter(Boolean).length === 1 ? '' : 's'}`
                  : (filtersExpanded ? 'Hide filters' : 'Show filters')}
                placement="bottom"
                enterDelay={400}
                slotProps={tooltipSlotProps}
              >
                <Box
                  onClick={toggleFilters}
                  sx={{
                    cursor: 'pointer', userSelect: 'none', flexShrink: 0,
                    position: 'relative',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 24,
                    color: anyFilterActive ? c.accent.primary : c.text.tertiary,
                    borderRadius: '4px',
                    '&:hover': {
                      bgcolor: c.bg.elevated,
                      color: anyFilterActive ? c.accent.primary : c.text.muted,
                    },
                    transition: 'all 0.12s',
                  }}
                >
                  <TuneOutlinedIcon sx={{
                    fontSize: 16,
                    transform: filtersExpanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.18s',
                  }} />
                  {anyFilterActive && (
                    <Box sx={{
                      position: 'absolute',
                      top: 3, right: 3,
                      width: 5, height: 5,
                      borderRadius: '50%',
                      bgcolor: c.accent.primary,
                      boxShadow: `0 0 0 1.5px ${c.bg.surface}`,
                    }} />
                  )}
                </Box>
              </Tooltip>
            </Box>
            <Collapse in={filtersExpanded} timeout={180} unmountOnExit>
            <Box sx={{
              px: 1.25, height: 28,
              display: 'flex', alignItems: 'center', gap: 0.5,
              flexShrink: 0,
              overflowX: 'auto',
              scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
            }}>
              {([
                { key: 'reasoning', label: 'Reasoning' },
                { key: 'subscription', label: 'Subscription' },
                { key: 'apiKey', label: 'API key' },
              ] as const).map(({ key, label }) => {
                const active = capFilters[key];
                return (
                  <Box
                    key={key}
                    onClick={() => setCapFilters((prev) => ({ ...prev, [key]: !prev[key] }))}
                    sx={{
                      cursor: 'pointer', userSelect: 'none',
                      px: 0.85, height: 20,
                      display: 'inline-flex', alignItems: 'center',
                      fontSize: '0.66rem', fontWeight: 600,
                      letterSpacing: '0.04em',
                      borderRadius: '4px',
                      border: `1px solid ${active ? c.accent.primary : c.border.subtle}`,
                      bgcolor: active ? `${c.accent.primary}1a` : 'transparent',
                      color: active ? c.accent.primary : c.text.tertiary,
                      whiteSpace: 'nowrap',
                      transition: 'all 0.12s',
                      '&:hover': { borderColor: c.accent.primary, color: active ? c.accent.primary : c.text.muted },
                    }}
                  >
                    {label}
                  </Box>
                );
              })}
              {anyFilterActive && (
                <Box
                  onClick={() => {
                    setCapFilters({ reasoning: false, subscription: false, apiKey: false });
                    setCtxIdx(0); setCostIdx(0);
                  }}
                  sx={{
                    cursor: 'pointer', userSelect: 'none',
                    fontSize: '0.66rem', fontWeight: 500,
                    color: c.text.ghost,
                    ml: 0.5, px: 0.5,
                    '&:hover': { color: c.text.muted },
                  }}
                >
                  Reset
                </Box>
              )}
            </Box>
            <Box sx={{
              px: 1.5, py: 0.5,
              display: 'flex', flexDirection: 'column', gap: 0.25,
              flexShrink: 0,
            }}>
              {([
                { label: 'Min context', idx: ctxIdx, set: setCtxIdx, max: CTX_STEPS.length - 1, valueLabel: CTX_LABELS[ctxIdx] },
                { label: 'Max cost',    idx: costIdx, set: setCostIdx, max: COST_STEPS.length - 1, valueLabel: COST_LABELS[costIdx] },
              ] as const).map((row, i) => (
                <Box key={i} sx={{
                  display: 'grid', gridTemplateColumns: '78px 1fr 60px',
                  alignItems: 'center', gap: 0.75,
                  height: 22,
                }}>
                  <Box sx={{
                    fontSize: '0.65rem', fontWeight: 500,
                    color: c.text.tertiary,
                    letterSpacing: '0.02em',
                  }}>
                    {row.label}
                  </Box>
                  <Slider
                    size="small"
                    value={row.idx}
                    onChange={(_, v) => row.set(v as number)}
                    step={1}
                    min={0}
                    max={row.max}
                    marks
                    sx={{
                      color: c.accent.primary,
                      height: 3,
                      padding: '8px 0',
                      '& .MuiSlider-thumb': {
                        width: 10, height: 10,
                        '&:before': { boxShadow: 'none' },
                        '&:hover, &.Mui-focusVisible': { boxShadow: `0 0 0 6px ${c.accent.primary}26` },
                      },
                      '& .MuiSlider-rail': {
                        opacity: 0.35, color: c.border.subtle,
                      },
                      '& .MuiSlider-mark': {
                        width: 2, height: 2, borderRadius: '50%',
                        bgcolor: c.text.ghost, opacity: 0.6,
                      },
                      '& .MuiSlider-markActive': { opacity: 0 },
                    }}
                  />
                  <Box sx={{
                    fontSize: '0.65rem', fontWeight: 600,
                    color: row.idx > 0 ? c.accent.primary : c.text.ghost,
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'right',
                  }}>
                    {row.valueLabel}
                  </Box>
                </Box>
              ))}
            </Box>
            </Collapse>
          </Box>

          {probeResult && probeResult.value === model && !probeResult.ok && (
            <Tooltip title={probeResult.error || 'health check failed'} placement="bottom-start" enterDelay={400}>
              <Box
                onClick={(e) => e.stopPropagation()}
                sx={{
                  mx: 1, my: 0.5,
                  px: 1, height: 26,
                  display: 'flex', alignItems: 'center', gap: 0.5,
                  borderRadius: '6px',
                  bgcolor: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.18)',
                  color: '#ef4444',
                  fontSize: '0.7rem',
                  flexShrink: 0,
                  overflow: 'hidden',
                }}
              >
                <Box component="span" sx={{ fontWeight: 700, flexShrink: 0 }}>Heads up</Box>
                <Box component="span" sx={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  opacity: 0.85,
                }}>
                  · {probeResult.error || 'this model failed its health check'}
                </Box>
              </Box>
            </Tooltip>
          )}

          {showRecents && (() => {
            const recentKey = 'Recent';
            const recentCollapsed = !!collapsedGroups[recentKey];
            return (
            <>
              <MenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  toggleGroupCollapse(recentKey, recentCollapsed);
                }}
                sx={{
                  opacity: '1 !important',
                  py: 0.75, px: 1.5, minHeight: 'auto',
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%' }}>
                  <KeyboardArrowRightIcon
                    sx={{
                      fontSize: 14, color: c.text.tertiary,
                      transform: recentCollapsed ? 'none' : 'rotate(90deg)',
                      transition: 'transform 0.15s',
                    }}
                  />
                  <AccessTimeIcon sx={{ fontSize: 12, color: c.text.tertiary }} />
                  <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: c.text.tertiary, flex: 1 }}>
                    Recent
                  </Typography>
                  <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, fontWeight: 500 }}>
                    {recentMaterialised.length}
                  </Typography>
                </Box>
              </MenuItem>
              <Collapse in={!recentCollapsed} timeout={180} unmountOnExit>
                {recentMaterialised.map((opt: any) => (
                  <Tooltip
                    key={`recent-${opt.value}`}
                    title={buildModelTooltip(opt)}
                    placement="right"
                    enterDelay={300}
                    slotProps={tooltipSlotProps}
                  >
                    <MenuItem
                      selected={model === opt.value}
                      onClick={() => {
                        onModelChange(opt.value);
                        pushRecentModel(opt.value);
                        setModelAnchor(null);
                      }}
                    >
                      <ListItemText
                        primary={opt.label}
                        slotProps={{ primary: { sx: { fontSize: '0.8rem', color: model === opt.value ? c.text.primary : c.text.muted } } }}
                      />
                    </MenuItem>
                  </Tooltip>
                ))}
              </Collapse>
            </>
            );
          })()}

          {Object.keys(filteredModelGroups).length === 0 && (
            <Box
              sx={{
                px: 2, py: 1.5,
                fontSize: '0.8rem',
                color: c.text.ghost,
                textAlign: 'center',
                fontStyle: 'italic',
              }}
            >
              {modelSearch.trim() ? (
                <>No models match "{modelSearch.trim()}".{anyFilterActive && (<><br/><Box component="span" sx={{ fontSize: '0.7rem' }}>Try clearing the filters above.</Box></>)}</>
              ) : (
                <>No models match the current filters.</>
              )}
            </Box>
          )}

          {Object.entries(filteredModelGroups).map(([prov, models]) => {
            const isOpenSwarmPro = prov === 'OpenSwarm Pro';
            const isOR = prov.startsWith('OpenRouter');
            const ms = models as any[];
            // OR vendor groups with >12 entries auto-collapse on first open; search disables this.
            const collapsible = true;
            const searchActive = modelSearch.trim().length > 0;
            const userToggle = collapsedGroups[prov];
            const autoCollapse = isOR && !searchActive && ms.length > OR_AUTO_COLLAPSE_THRESHOLD;
            const collapsed = userToggle !== undefined ? userToggle : autoCollapse;
            const brandKey = (isOR ? 'openrouter' : prov.toLowerCase());
            const brandColor = PROVIDER_COLORS[brandKey] ?? c.text.tertiary;
            const OPENSWARM_GRADIENT =
              'linear-gradient(135deg, #8FB3FF 0%, #E56BC4 45%, #FFA85C 100%)';

            const highlightMatch = (text: string): React.ReactNode => {
              const q = modelSearch.trim();
              if (!q) return text;
              const idx = text.toLowerCase().indexOf(q.toLowerCase());
              if (idx < 0) return text;
              return (
                <>
                  {text.slice(0, idx)}
                  <Box component="span" sx={{ fontWeight: 700, color: c.text.primary }}>
                    {text.slice(idx, idx + q.length)}
                  </Box>
                  {text.slice(idx + q.length)}
                </>
              );
            };

            return [
              <MenuItem
                key={`header-${prov}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleGroupCollapse(prov, collapsed);
                }}
                sx={{
                  opacity: '1 !important',
                  py: 0.75, px: 1.5, minHeight: 'auto',
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%' }}>
                  <KeyboardArrowRightIcon
                    sx={{
                      fontSize: 14,
                      color: c.text.tertiary,
                      transform: collapsed ? 'none' : 'rotate(90deg)',
                      transition: 'transform 0.15s',
                    }}
                  />
                  <Box sx={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: isOpenSwarmPro ? OPENSWARM_GRADIENT : brandColor,
                    boxShadow: isOpenSwarmPro
                      ? '0 0 8px rgba(229, 107, 196, 0.6)'
                      : `0 0 6px ${brandColor}80`,
                    flexShrink: 0,
                  }} />
                  <Typography sx={{
                    fontSize: '0.7rem', fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    flex: 1,
                    ...(isOpenSwarmPro
                      ? {
                          background: OPENSWARM_GRADIENT,
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          backgroundClip: 'text',
                        }
                      : { color: brandColor }),
                  }}>
                    {prov}
                  </Typography>
                  <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, fontWeight: 500 }}>
                    {ms.length}
                  </Typography>
                </Box>
              </MenuItem>,
              <Collapse
                key={`coll-${prov}`}
                in={!collapsed}
                timeout={180}
                unmountOnExit
              >
                {models.map((opt: any) => {
                    let displayLabel = opt.label;
                    if (isOR && displayLabel.includes(': ')) {
                      const groupVendor = prov.replace(/^OpenRouter\s*[·•]\s*/i, '').toLowerCase();
                      const colonIdx = displayLabel.indexOf(': ');
                      const labelPrefix = displayLabel.slice(0, colonIdx).toLowerCase();
                      if (labelPrefix === groupVendor) {
                        displayLabel = displayLabel.slice(colonIdx + 2);
                      }
                    }
                    return (
                      <Tooltip
                        key={opt.value}
                        title={buildModelTooltip(opt)}
                        placement="right"
                        enterDelay={300}
                        slotProps={tooltipSlotProps}
                      >
                        <MenuItem
                          selected={model === opt.value}
                          onClick={() => {
                            onModelChange(opt.value);
                            pushRecentModel(opt.value);
                            if (modelSearch.trim()) pushRecentSearch(modelSearch);
                            if (onProviderChange) {
                              const provLower = prov.toLowerCase();
                              const providerMap: Record<string, string> = {
                                anthropic: 'anthropic',
                                'openswarm pro': 'anthropic',
                                openai: 'openai',
                                google: 'gemini',
                              };
                              onProviderChange(providerMap[provLower] || (isOR ? 'openrouter' : provLower));
                            }
                            setModelAnchor(null);
                          }}
                        >
                          <ListItemText
                            primary={highlightMatch(displayLabel)}
                            slotProps={{ primary: { sx: { fontSize: '0.8rem', color: model === opt.value ? c.text.primary : c.text.muted } } }}
                          />
                        </MenuItem>
                      </Tooltip>
                    );
                  })}
              </Collapse>,
            ];
          }).flat()}

          <Box
            onClick={(e) => e.stopPropagation()}
            sx={{
              position: 'sticky', bottom: 0,
              bgcolor: c.bg.surface,
              borderTop: `1px solid ${c.border.subtle}`,
              px: 1.25, py: 0.5,
              fontSize: '0.65rem', color: c.text.ghost,
              display: 'flex', justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <Box component="span" sx={{ flexShrink: 0, pointerEvents: 'none' }}>
              Type to search, Esc to close
            </Box>
            {(() => {
              const breakdown: Array<[string, number]> = ([
                ['Free',          pickerSummary.free],
                ['Subscription',  pickerSummary.subscription],
                ['API key',       pickerSummary.apiKey],
                ['Pay-per-use',   pickerSummary.paid],
                ['Reasoning',     pickerSummary.reasoning],
                ['1M+ context',   pickerSummary.longContext],
              ] as Array<[string, number]>).filter(([, n]) => n > 0);
              const breakdownTooltip = breakdown.length > 0 ? (
                <Box sx={{ fontSize: '0.74rem', lineHeight: 1.6, minWidth: 180 }}>
                  <Box sx={{
                    fontWeight: 600, fontSize: '0.78rem',
                    color: c.text.primary,
                    pb: 0.6, mb: 0.6,
                    borderBottom: `1px solid ${c.border.subtle}`,
                  }}>
                    {pickerSummary.total} model{pickerSummary.total === 1 ? '' : 's'} available
                  </Box>
                  <Box sx={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    columnGap: 1.5, rowGap: 0.3,
                    color: c.text.muted,
                  }}>
                    {breakdown.map(([label, n]) => (
                      <React.Fragment key={label}>
                        <span>{label}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: c.text.secondary }}>{n}</span>
                      </React.Fragment>
                    ))}
                  </Box>
                </Box>
              ) : null;
              return (
                <Tooltip
                  title={breakdownTooltip || ''}
                  placement="top-end"
                  enterDelay={300}
                  slotProps={tooltipSlotProps}
                  disableHoverListener={!breakdownTooltip}
                >
                  <Box component="span" sx={{
                    cursor: breakdownTooltip ? 'help' : 'default',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}>
                    {pickerSummary.total} model{pickerSummary.total === 1 ? '' : 's'}
                  </Box>
                </Tooltip>
              );
            })()}
          </Box>
        </Menu>

        {(() => {
          const currentModel = allModelOptions.flat.find((m: any) => m.value === model) as any;
          if (!currentModel?.reasoning || !onThinkingLevelChange) return null;
          const levels: Array<{ value: 'off' | 'low' | 'medium' | 'high' | 'auto'; label: string; desc: string }> = [
            { value: 'auto', label: 'Auto', desc: 'Model decides (recommended)' },
            { value: 'off', label: 'Off', desc: 'No thinking (fastest)' },
            { value: 'low', label: 'Low', desc: 'Minimal thinking' },
            { value: 'medium', label: 'Medium', desc: 'Balanced' },
            { value: 'high', label: 'High', desc: 'Extensive thinking (slowest)' },
          ];
          const current = levels.find((l) => l.value === thinkingLevel) || levels[0];
          return (
            <>
              <Box
                onClick={(e) => setThinkingAnchor(e.currentTarget)}
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.25,
                  px: 0.75, py: 0.25, borderRadius: '6px', cursor: 'pointer', userSelect: 'none',
                  color: c.text.muted,
                  '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
                  transition: 'background 0.15s',
                }}
              >
                <PsychologyOutlinedIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                <Typography sx={{ fontSize: '0.8rem', fontWeight: 500, color: 'inherit', lineHeight: 1 }}>
                  {current.label}
                </Typography>
                <KeyboardArrowDownIcon sx={{ fontSize: 15, color: 'inherit', opacity: 0.7 }} />
              </Box>
              <Menu
                anchorEl={thinkingAnchor}
                open={Boolean(thinkingAnchor)}
                onClose={() => setThinkingAnchor(null)}
                anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
                transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                slotProps={{ paper: menuPaperProps }}
                autoFocus
                MenuListProps={{ autoFocusItem: true }}
              >
                <MenuItem disabled sx={{ opacity: '1 !important', py: 0.5, px: 1.5, minHeight: 'auto', pointerEvents: 'none' }}>
                  <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: c.text.tertiary }}>
                    Thinking Level
                  </Typography>
                </MenuItem>
                {/* Gemini 3 preview rejects "thought signature" on tool-call turns when thinking is on; warn search users. */}
                {(() => {
                  const isGemini3 = typeof model === 'string' && (model.includes('gemini-3') || (allModelOptions.flat.find((m: any) => m.value === model)?.label || '').toLowerCase().includes('gemini 3'));
                  if (!isGemini3 || thinkingLevel === 'off') return null;
                  return (
                    <MenuItem disabled sx={{ opacity: '1 !important', py: 0.6, px: 1.5, minHeight: 'auto', pointerEvents: 'none', mx: 0.5, my: 0.25, borderRadius: 1, bgcolor: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.18)' }}>
                      <Typography sx={{ fontSize: '0.66rem', color: c.text.muted, lineHeight: 1.4, whiteSpace: 'normal', maxWidth: 240 }}>
                        Web search breaks on Gemini 3 preview while thinking is on. Set to <strong>Off</strong> if you need search.
                      </Typography>
                    </MenuItem>
                  );
                })()}
                {levels.map((lvl) => (
                  <MenuItem
                    key={lvl.value}
                    selected={thinkingLevel === lvl.value}
                    onClick={() => { onThinkingLevelChange(lvl.value); setThinkingAnchor(null); }}
                    sx={{ py: 0.6 }}
                  >
                    <Box>
                      <Typography sx={{ fontSize: '0.8rem', color: thinkingLevel === lvl.value ? c.text.primary : c.text.muted }}>
                        {lvl.label}
                      </Typography>
                      <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, mt: 0.1 }}>
                        {lvl.desc}
                      </Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Menu>
            </>
          );
        })()}

        <Box sx={{ flex: 1 }} />

        {contextEstimate && (
          <ContextRing
            used={contextEstimate.used}
            limit={contextEstimate.limit}
            accentColor={c.accent.primary}
            trackColor={c.border.subtle}
          />
        )}

        {elementSelection && !autoRunMode && (() => {
          const isMySelectMode = elementSelection.selectMode && elementSelection.activeOwnerId === ownerId;
          return (
            <Tooltip title={isMySelectMode ? 'Exit select mode' : 'Select UI element'}>
              <IconButton
                size="small"
                onMouseDown={(e) => e.preventDefault()}
                data-onboarding="element-selection-toggle"
                onClick={() => {
                  if (isMySelectMode) {
                    elementSelection.setSelectMode(false);
                  } else {
                    if (elementSelection.activeOwnerId !== ownerId) {
                      elementSelection.clearOwnerElements(ownerId);
                    }
                    elementSelection.setActiveOwnerId(ownerId);
                    if (sessionId) {
                      elementSelection.setExcludeSelectId(sessionId);
                    } else {
                      elementSelection.setExcludeSelectId(null);
                    }
                    elementSelection.setSelectMode(true);
                  }
                }}
                sx={{
                  p: 0.5,
                  ...(isMySelectMode
                    ? {
                        bgcolor: '#3b82f6',
                        color: '#fff',
                        '&:hover': { bgcolor: '#2563eb' },
                        animation: 'selectBtnPulse 2s ease-in-out infinite',
                        '@keyframes selectBtnPulse': {
                          '0%, 100%': { boxShadow: '0 0 0 0 rgba(59,130,246,0.4)' },
                          '50%': { boxShadow: '0 0 0 4px rgba(59,130,246,0.1)' },
                        },
                      }
                    : {
                        color: c.text.tertiary,
                        '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
                      }),
                  transition: 'background-color 0.15s, color 0.15s',
                }}
              >
                <AdsClickIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          );
        })()}

        <input
          ref={generalFileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (!e.target.files) return;
            const all = Array.from(e.target.files);
            const imgs = all.filter((f) => f.type.startsWith('image/'));
            const rest = all.filter((f) => !f.type.startsWith('image/'));
            if (imgs.length > 0) addImageFiles(imgs);
            if (rest.length > 0) uploadAndAttachFiles(rest);
            e.target.value = '';
          }}
        />
        <Tooltip title="Attach file">
          <IconButton
            size="small"
            onClick={() => generalFileInputRef.current?.click()}
            sx={{
              color: c.text.tertiary,
              p: 0.5,
              '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
            }}
          >
            <AttachFileIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        {!autoRunMode && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {hasContent && (
              <Tooltip title={isRunning ? 'Queue message' : 'Send message'}>
                <IconButton
                  size="small"
                  onClick={handleSend}
                  disabled={disabled}
                  data-onboarding="chat-send-button"
                  sx={{
                    bgcolor: c.accent.primary,
                    color: c.text.inverse,
                    p: 0.5,
                    width: 26,
                    height: 26,
                    '&:hover': { bgcolor: c.accent.hover },
                    '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
                    transition: c.transition,
                  }}
                >
                  <ArrowUpwardIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {isRunning ? (
              <Tooltip title="Stop agent">
                <IconButton
                  size="small"
                  onClick={onStop}
                  sx={{
                    bgcolor: c.status.error,
                    color: c.text.inverse,
                    p: 0.5,
                    width: 26,
                    height: 26,
                    '&:hover': { bgcolor: c.status.error, opacity: 0.85 },
                    transition: c.transition,
                  }}
                >
                  <StopIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            ) : !hasContent ? (
              <Tooltip title="Voice input (coming soon)">
                <span>
                  <IconButton
                    size="small"
                    disabled
                    sx={{
                      color: c.text.tertiary,
                      p: 0.5,
                      '&.Mui-disabled': { color: c.text.ghost },
                    }}
                  >
                    <MicNoneOutlinedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Box>
        )}
      </Box>

      <Modal
        open={!!lightboxSrc}
        onClose={() => setLightboxSrc(null)}
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Box
          onClick={() => setLightboxSrc(null)}
          sx={{ position: 'relative', outline: 'none', maxWidth: '90vw', maxHeight: '90vh' }}
        >
          <IconButton
            onClick={() => setLightboxSrc(null)}
            sx={{
              position: 'absolute',
              top: -16,
              right: -16,
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.medium}`,
              color: c.text.secondary,
              width: 32,
              height: 32,
              zIndex: 1,
              '&:hover': { bgcolor: c.bg.secondary },
              boxShadow: c.shadow.md,
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
          <img
            src={lightboxSrc || ''}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              borderRadius: 8,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              display: 'block',
            }}
          />
        </Box>
      </Modal>

    </Box>
  );
});

ChatInput.displayName = 'ChatInput';

// Shallow memo: AgentChat re-renders from unrelated session-local state shouldn't churn ChatInput.
export default React.memo(ChatInput);
