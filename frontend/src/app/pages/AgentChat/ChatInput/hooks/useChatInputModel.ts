import { useMemo } from 'react';
import { useAppSelector } from '@/shared/hooks';
import { sortModelsForPicker } from '../model-picker/modelPicker';

const FALLBACK_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet 4.6', context_window: 1_000_000, reasoning: true },
  { value: 'opus', label: 'Claude Opus 4.6', context_window: 1_000_000, reasoning: true },
  { value: 'haiku', label: 'Claude Haiku 4.5', context_window: 200_000, reasoning: true },
];

export function useChatInputModel(model: string) {
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);
  const modelsLoaded = useAppSelector((state) => state.models.loaded);
  const connectionMode = useAppSelector((state) => state.settings.data.connection_mode);

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

  const currentModelCtx = useMemo(() => {
    const m = allModelOptions.flat.find((x: any) => x.value === model) as any;
    return (m?.context_window as number) || 200_000;
  }, [allModelOptions.flat, model]);

  const currentModelApi = useMemo<string>(() => {
    const m = allModelOptions.flat.find((x: any) => x.value === model) as any;
    return ((m?.api as string) || 'anthropic').toLowerCase();
  }, [allModelOptions.flat, model]);

  // Mirrors backend agent_manager._resolve_attachments support matrix.
  // PDFs: Anthropic, Gemini, OpenRouter (file-parser plugin), and
  // OpenAI direct on GPT-5.x non-Codex (anthropic_proxy bypasses
  // 9router and POSTs to api.openai.com via anthropic_to_openai.py).
  // Images: every provider via 9router image_url translation.
  const isCodexModel = typeof model === 'string' && (model.toLowerCase().includes('codex') || model.toLowerCase().startsWith('cx/'));
  const pdfSupported = (
    ['anthropic', 'gemini', 'gemini-cli', 'openrouter'].includes(currentModelApi) ||
    (currentModelApi === 'openai' && !isCodexModel)
  );
  const imageSupported = ['anthropic', 'gemini', 'gemini-cli', 'openai', 'openrouter'].includes(currentModelApi);

  return { allModelOptions, currentModelCtx, currentModelApi, pdfSupported, imageSupported };
}
