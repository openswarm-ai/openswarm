import { useCallback, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch, type PersonalizedAutomation } from '@/shared/state/settingsSlice';
import { createDraftSession, launchAndSendFirstMessage, type AgentConfig } from '@/shared/state/agentsSlice';
import { createWorkflow } from '@/shared/state/workflowsSlice';
import { hasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { getLastDashboardId } from '@/shared/lastDashboardId';
import { setFlowActive, stageReveal, addPreppedJob } from '@/shared/state/onboardingV3Slice';
import { useThemeAccent, useThemeMode } from '@/shared/styles/ThemeContext';
import {
  fetchIdentity, runPrep, runScan, summarizeScan,
  type PrepResponse, type ProviderIdentity, type ScanResult,
} from './onboardingV3Api';
import { summarizeUsage, type ProviderUsage, type UsageProvider } from '@/shared/providerUsage';
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

// Turn an automation's cadence into a real schedule (9am local): daily = every day, weekday = Mon-Fri,
// weekly = Mondays. The first run is always in the future, so the keep/discard toast can cancel it first.
function cadenceToSchedule(cadence: string): Record<string, unknown> {
  const base = { enabled: true, repeat_every: 1, hour: 9, minute: 0, timezone: 'local', ends_at: null, max_runs: null, runs_count: 0 };
  if (cadence === 'daily') return { ...base, repeat_unit: 'day', on_days: [] };
  if (cadence === 'weekday') return { ...base, repeat_unit: 'week', on_days: [1, 2, 3, 4, 5] };
  return { ...base, repeat_unit: 'week', on_days: [1] };
}

// Used when prep's aux dropped the automations field, so the reveal always demonstrates automation.
// A useful digest (not a cleanup chore, which the value bar bans).
const SCHEDULE_FALLBACK: PersonalizedAutomation = {
  title: 'Weekly Roundup',
  prompt: 'Search the web for the most notable new tools, articles, and releases from this past week in technology and design, and write a short, skimmable roundup to a dated file at Documents/weekly_roundup_<date>.md. Do it in one pass with no questions.',
  cadence: 'weekly',
};

// The curtain machinery: scan kicks off during the OAuth wait, prep during the theme beat, and the moment prep resolves the audit AND the app build launch as REAL background agents, so the curtain lifts on work already in motion. Every stage fails soft; the flow never blocks on any of it.
export function useOnboardingV3Pipeline() {
  const dispatch = useAppDispatch();
  const { accent, gradient } = useThemeAccent();
  const { mode } = useThemeMode();
  const [identity, setIdentity] = useState<ProviderIdentity[]>([]);
  const identityRef = useRef<ProviderIdentity[]>([]);
  const scanRef = useRef<Promise<ScanResult | null> | null>(null);
  const prepRef = useRef<Promise<PrepResponse | null> | null>(null);
  // The resolved prep, readable SYNCHRONOUSLY at finish() time: lets the reveal seed with the real
  // jobs/greeting the instant they're ready (the common case, prep finishes during the beats) without
  // awaiting, so the curtain never blocks behind a spinner.
  const prepReadyRef = useRef<PrepResponse | null>(null);
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

  // Read what the user works on, silently and with no card: main opens the provider site offscreen on the browser partition and runs its own harvest script (see electron/usageHarvest.js). Fail-open: no session in the partition, off-Electron, or an error => empty summary, prep falls back to scan + identity.
  const kickUsageRead = useCallback((provider: string, consented: boolean) => {
    if (usageReadRef.current || !consented) return;
    const geminiIds = provider === 'antigravity' || provider === 'gemini-cli' || provider === 'gemini';
    const key: UsageProvider | null = provider === 'codex' ? 'codex' : provider === 'claude' ? 'claude' : geminiIds ? 'gemini' : null;
    if (!key) return;
    usageReadRef.current = (async () => {
      try {
        const harvestUsage = window.openswarm?.harvestUsage;
        if (typeof harvestUsage !== 'function') return;
        const raw = (await harvestUsage(key)) as ProviderUsage | null;
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
  const launchJob = useCallback((title: string, prompt: string, kind: 'audit' | 'app' | 'research', reason: string) => {
    const { model: liveModel } = launchCtxRef.current;
    const dashboardId = getLastDashboardId() ?? undefined;
    // The audit reads the user's REAL files unattended, so it runs read-only (Edit/Bash blocked); the
    // app build writes into its own fresh workspace, so it keeps full tools.
    const config: AgentConfig = { name: title, model: liveModel, mode: 'agent', dashboard_id: dashboardId, read_only: kind === 'audit' };
    const draftId = dispatch(createDraftSession({ mode: 'agent', model: liveModel, dashboardId: dashboardId ?? '', setActive: false })).payload.draftId;
    // expand: false keeps the reveal's left stack as compact cards instead of overlapping transcripts.
    void dispatch(launchAndSendFirstMessage({ draftId, config, prompt, mode: 'agent', model: liveModel, expand: false }))
      .then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          dispatch(addPreppedJob({ sessionId: action.payload.session.id, title, kind, reason }));
        }
      })
      .catch(() => {});
  }, [dispatch]);

  // Set up ONE real scheduled task from the automations, so the reveal shows OpenSwarm having already
  // automated something for the user, not just run one-off jobs. It's a real workflow on a real schedule
  // (first run in the future); the keep/discard toast can delete it. Rides the cheap model like the jobs.
  const createScheduledJob = useCallback((auto: PersonalizedAutomation) => {
    const { model: liveModel } = launchCtxRef.current;
    const dashboardId = getLastDashboardId() ?? undefined;
    void dispatch(createWorkflow({
      title: auto.title,
      description: 'Set up for you during onboarding.',
      steps: [{ id: `step-${Date.now().toString(36)}`, text: auto.prompt, enabled: true }],
      schedule: cadenceToSchedule(auto.cadence) as never,
      dashboard_id: dashboardId,
      model: liveModel,
    })).unwrap()
      .then((wf) => {
        dispatch(addPreppedJob({ sessionId: '', workflowId: wf.id, title: auto.title, kind: 'schedule', reason: `runs ${auto.cadence} on its own` }));
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
      prepReadyRef.current = prep;
      if (launchedRef.current || !prep || !prep.greeting || !launchCtxRef.current.connected) return;
      launchedRef.current = true;
      if (prep.starters.length > 0) launchJob(prep.starters[0].title, prep.starters[0].prompt, 'audit', prep.starters[0].reason ?? '');
      if (prep.app_title && prep.app_prompt) launchJob(prep.app_title, prep.app_prompt, 'app', prep.app_reason ?? '');
      // The "looked into this for you" card: a real live web-research task on the one thing this user
      // keeps asking about, so the reveal shows OpenSwarm going and finding it, not just planning.
      if (prep.research_title && prep.research_prompt) launchJob(prep.research_title, prep.research_prompt, 'research', prep.research_reason ?? '');
      // The scheduled task is a first-class part of the reveal (the "it automates for me" capability), so
      // guarantee one: use the model's automation when it emitted one (it sometimes drops the last JSON
      // field), else fall back to a safe, universally-useful weekly Downloads sweep.
      createScheduledJob(prep.automations[0] ?? SCHEDULE_FALLBACK);
    });
  }, [launchJob, createScheduledJob]);

  const finish = useCallback(async (outcome: 'done' | 'skipped') => {
    if (outcome === 'skipped') {
      dispatch(setFlowActive(false));
      dispatch(updateSettingsPatch({ onboarding_v3: 'skipped', accent_color: accent, accent_gradient: gradient, theme: mode }));
      return;
    }
    // NEVER block the curtain behind a spinner. The connect head-start means prep has usually resolved
    // during the beats, so seed with the real jobs/greeting synchronously; if a fast user beat prep to
    // this point, seed with what we have and let the late-jobs effect + the async patch below fill in.
    // The whole point of gating on connect is this head start, so the reveal must show it in motion.
    const ready = prepReadyRef.current;
    dispatch(updateSettingsPatch({ onboarding_v3: 'done', accent_color: accent, accent_gradient: gradient, theme: mode }));
    dispatch(stageReveal({
      greeting: ready?.greeting?.trim() || null,
      starters: ready?.starters ?? [],
      scanSummary: summarizeScan(scanResultRef.current),
      autoPrompt: null,
    }));
    dispatch(setFlowActive(false));
    // Personalized fields land the instant prep resolves (often already have): the welcome greeting
    // waits for personalized_greeting then streams it in, and the starter chips read it live.
    void (prepRef.current ?? Promise.resolve(null)).then((prep) => {
      if (!prep) return;
      dispatch(updateSettingsPatch({
        personalized_greeting: prep.greeting?.trim() || null,
        personalized_starters: prep.starters ?? [],
        personalized_automations: prep.automations ?? [],
      }));
    });
  }, [dispatch, accent, gradient, mode]);

  return { identity, kickIdentity, kickScan, kickUsageRead, kickPrep, finish };
}
