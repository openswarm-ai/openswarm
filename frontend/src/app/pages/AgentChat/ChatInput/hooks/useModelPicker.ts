import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { API_BASE } from '@/shared/config';
import {
  LS_RECENT_MODELS,
  LS_RECENT_SEARCHES,
  RECENT_MODELS_MAX,
  RECENT_SEARCHES_MAX,
  LS_FILTERS_EXPANDED,
  LS_COLLAPSED_GROUPS,
  CTX_STEPS,
  COST_STEPS,
  readLS,
  writeLS,
} from '../model-picker/modelPicker';

type CapFilters = { reasoning: boolean; subscription: boolean; apiKey: boolean };

interface AllModelOptions {
  flat: Array<any>;
  grouped: Record<string, any[]>;
}

export function useModelPicker(
  allModelOptions: AllModelOptions,
  model: string,
  modelAnchor: HTMLElement | null,
) {
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

  const [capFilters, setCapFilters] = useState<CapFilters>({
    reasoning: false, subscription: false, apiKey: false,
  });

  const [ctxIdx, setCtxIdx] = useState(0);
  const [costIdx, setCostIdx] = useState(0);

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

  return {
    modelSearch, setModelSearch, modelSearchRef,
    recentModels, recentSearches,
    pushRecentModel, pushRecentSearch,
    capFilters, setCapFilters,
    ctxIdx, setCtxIdx, costIdx, setCostIdx,
    filtersExpanded, toggleFilters, anyFilterActive,
    collapsedGroups, toggleGroupCollapse,
    probeResult,
    filteredModelGroups, pickerSummary,
    recentMaterialised, showRecents,
  };
}

export type ModelPickerState = ReturnType<typeof useModelPicker>;
