import { useCallback, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { createDraftSession, launchAndSendFirstMessage, type AgentConfig } from '@/shared/state/agentsSlice';
import { hasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { getLastDashboardId } from '@/shared/lastDashboardId';
import { setFlowActive, stageReveal, addPreppedJob } from '@/shared/state/onboardingV3Slice';
import { useThemeAccent, useThemeMode } from '@/shared/styles/ThemeContext';
import {
  fetchIdentity, runPrep, runScan, summarizeScan,
  type PrepResponse, type ProviderIdentity, type ScanResult,
} from './onboardingV3Api';
import { USAGE_READ_JS, summarizeUsage, type ProviderUsage, type UsageProvider } from '@/shared/providerUsage';
import { findWebviewByDomain } from '@/shared/browserRegistry';
import type { ModelOption } from '@/shared/state/modelsSlice';

// The auto-launched onboarding jobs must ride the CHEAP tier, not the user's premium default; running two Sonnet/Opus agents unprompted on first launch would burn real quota. Pick the lowest-intelligence (cheapest) model in the default's provider group, so a Claude user's demo runs on Haiku, a ChatGPT user's on mini.
function pickCheapModel(byProvider: Record<string, ModelOption[]>, def: string): string {
  const groups = Object.values(byProvider);
  const all = groups.flat();
  if (!all.length) return def;
  const defGroup = groups.find((g) => g.some((m) => m.value === def));
  const pool = (defGroup && defGroup.length ? defGroup : all).filter((m) => Array.isArray(m.tiers));
  if (!pool.length) return def;
  return [...pool].sort((a, b) => (a.tiers![0]) - (b.tiers![0]))[0].value;
}

// The curtain machinery: scan kicks off during the OAuth wait, prep during the theme beat, and the moment prep resolves the audit AND the app build launch as REAL background agents, so the curtain lifts on work already in motion. Every stage fails soft; the flow never blocks on any of it.
export function useOnboardingV3Pipeline() {
  const dispatch = useAppDispatch();
  const { accent, gradient } = useThemeAccent();
  const { mode } = useThemeMode();
  const [identity, setIdentity] = useState<ProviderIdentity[]>([]);
  const identityRef = useRef<ProviderIdentity[]>([]);
  const scanRef = useRef<Promise<ScanResult | null> | null>(null);
  const prepRef = useRef<Promise<PrepResponse | null> | null>(null);
  const scanResultRef = useRef<ScanResult | null>(null);
  const usageSummaryRef = useRef<string>('');
  const usageReadRef = useRef<Promise<void> | null>(null);
  const connected = useAppSelector((s) => hasModelConnected(s));
  const cheapModel = useAppSelector((s) => pickCheapModel(s.models.byProvider, s.settings.data.default_model));
  const launchCtxRef = useRef({ connected: false, model: 'sonnet' });
  launchCtxRef.current = { connected, model: cheapModel };
  const launchedRef = useRef(false);

  const kickIdentity = useCallback(() => {
    fetchIdentity().then((ids) => { identityRef.current = ids; setIdentity(ids); }).catch(() => {});
  }, []);

  // Read what the user works on from an already-open, logged-in provider card (chatgpt.com / claude.ai) via the proven findWebviewByDomain + executeJavaScript path. Fail-open: no card, not logged in, or off-Electron => empty summary, prep falls back to scan + identity.
  const kickUsageRead = useCallback((provider: string, consented: boolean) => {
    if (usageReadRef.current || !consented) return;
    const key: UsageProvider | null = provider === 'codex' ? 'codex' : provider === 'claude' ? 'claude' : null;
    if (!key) return;
    usageReadRef.current = (async () => {
      try {
        const domain = key === 'codex' ? 'chatgpt.com' : 'claude.ai';
        const wv = findWebviewByDomain(domain);
        if (!wv || typeof wv.executeJavaScript !== 'function') return;
        const raw = (await wv.executeJavaScript(USAGE_READ_JS[key])) as ProviderUsage | null;
        usageSummaryRef.current = summarizeUsage(raw);
      } catch { /* fail-open */ }
    })();
  }, []);

  const kickScan = useCallback((consented: boolean) => {
    if (scanRef.current) return;
    scanRef.current = consented
      ? runScan().then((r) => { scanResultRef.current = r; return r; }).catch(() => null)
      : Promise.resolve(null);
  }, []);

  // Fire one real background agent; the session exists in redux without a card until the reveal composes the canvas.
  const launchJob = useCallback((title: string, prompt: string, kind: 'audit' | 'app', reason: string) => {
    const { model: liveModel } = launchCtxRef.current;
    const dashboardId = getLastDashboardId() ?? undefined;
    const config: AgentConfig = { name: title, model: liveModel, mode: 'agent', dashboard_id: dashboardId };
    const draftId = dispatch(createDraftSession({ mode: 'agent', model: liveModel, dashboardId: dashboardId ?? '', setActive: false })).payload.draftId;
    void dispatch(launchAndSendFirstMessage({ draftId, config, prompt, mode: 'agent', model: liveModel }))
      .then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          dispatch(addPreppedJob({ sessionId: action.payload.session.id, title, kind, reason }));
        }
      })
      .catch(() => {});
  }, [dispatch]);

  const kickPrep = useCallback((pickedApps: string[]) => {
    if (prepRef.current) return;
    const scanPromise = scanRef.current ?? Promise.resolve(null);
    const usagePromise = usageReadRef.current ?? Promise.resolve();
    prepRef.current = Promise.all([scanPromise, usagePromise])
      .then(([scan]) => runPrep(scan, pickedApps, identityRef.current, usageSummaryRef.current))
      .catch(() => null);
    // Launch the prepped work MID-FLOW (theme/card beats cover the latency): audit + app build, gated to a real connected model so the fragile free trial never carries it.
    void prepRef.current.then((prep) => {
      if (launchedRef.current || !prep || !prep.greeting || !launchCtxRef.current.connected) return;
      launchedRef.current = true;
      if (prep.starters.length > 0) launchJob(prep.starters[0].title, prep.starters[0].prompt, 'audit', prep.starters[0].reason ?? '');
      if (prep.app_title && prep.app_prompt) launchJob(prep.app_title, prep.app_prompt, 'app', prep.app_reason ?? '');
    });
  }, [launchJob]);

  const finish = useCallback(async (outcome: 'done' | 'skipped') => {
    if (outcome === 'skipped') {
      dispatch(setFlowActive(false));
      dispatch(updateSettingsPatch({ onboarding_v3: 'skipped', accent_color: accent, accent_gradient: gradient, theme: mode }));
      return;
    }
    // Cap the wait so a slow aux call degrades to generic starters instead of a hung curtain.
    const timeout = new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), 15000); });
    const prep = await Promise.race([prepRef.current ?? Promise.resolve(null), timeout]);
    const greeting = prep?.greeting?.trim() || null;
    const starters = prep?.starters ?? [];
    const automations = prep?.automations ?? [];
    // Jobs already launched mid-flow at prep-resolve; the reveal only composes the canvas.
    const autoPrompt = null;
    // Await the PATCH so personalized_greeting/starters/automations are IN settings before the reveal seeds the welcome chat; the greeting stream snapshots settings at mount.
    try {
      await dispatch(updateSettingsPatch({
        onboarding_v3: 'done',
        accent_color: accent,
        accent_gradient: gradient,
        theme: mode,
        personalized_greeting: greeting,
        personalized_starters: starters,
        personalized_automations: automations,
      })).unwrap();
    } catch {}
    dispatch(stageReveal({ greeting, starters, scanSummary: summarizeScan(scanResultRef.current), autoPrompt }));
    dispatch(setFlowActive(false));
  }, [dispatch, accent, gradient, mode]);

  return { identity, kickIdentity, kickScan, kickUsageRead, kickPrep, finish };
}
