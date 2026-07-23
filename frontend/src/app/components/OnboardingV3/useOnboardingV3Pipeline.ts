import { useCallback, useRef, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { setFlowActive, stageReveal } from '@/shared/state/onboardingV3Slice';
import { useThemeAccent, useThemeMode } from '@/shared/styles/ThemeContext';
import {
  fetchIdentity, runPrep, runScan, summarizeScan,
  type PrepResponse, type ProviderIdentity, type ScanResult,
} from './onboardingV3Api';
import { summarizeUsage, type ProviderUsage, type UsageProvider } from '@/shared/providerUsage';

// How long finish() will wait for prep before staging the reveal. Prep is kicked early (theme beat) so it
// has usually resolved; this only bites a user who outran it, and a brief wait for a COHERENT reveal beats
// an instant one showing a previous run's stale greeting. Capped so it's never an open-ended spinner.
const PREP_WAIT_CAP_MS = 5000;

// The curtain machinery: scan kicks off during the OAuth wait, prep during the theme beat. No agents or
// apps auto-spawn anymore, the reveal lands INSTANTLY on a clean welcome chat whose greeting + starters
// are personalized from prep, and the user picks what to run first. Every stage fails soft; nothing blocks.
export function useOnboardingV3Pipeline() {
  const dispatch = useAppDispatch();
  const { accent, gradient } = useThemeAccent();
  const { mode } = useThemeMode();
  const [identity, setIdentity] = useState<ProviderIdentity[]>([]);
  const identityRef = useRef<ProviderIdentity[]>([]);
  const scanRef = useRef<Promise<ScanResult | null> | null>(null);
  const prepRef = useRef<Promise<PrepResponse | null> | null>(null);
  // The resolved prep, readable SYNCHRONOUSLY at finish() time: lets the reveal seed with the real
  // greeting/starters the instant they're ready (the common case, prep finishes during the beats) without
  // awaiting, so the curtain never blocks behind a spinner.
  const prepReadyRef = useRef<PrepResponse | null>(null);
  const scanResultRef = useRef<ScanResult | null>(null);
  const usageSummaryRef = useRef<string>('');
  const usageReadRef = useRef<Promise<void> | null>(null);

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

  const kickPrep = useCallback((pickedApps: string[]) => {
    if (prepRef.current) return;
    const scanPromise = scanRef.current ?? Promise.resolve(null);
    const usagePromise = usageReadRef.current ?? Promise.resolve();
    prepRef.current = Promise.all([scanPromise, usagePromise])
      .then(([scan]) => runPrep(scan, pickedApps, identityRef.current, usageSummaryRef.current))
      .catch(() => null);
    // Cache the resolved prep so finish() can stage the reveal the instant it's ready, no await.
    void prepRef.current.then((prep) => { prepReadyRef.current = prep; });
  }, []);

  const finish = useCallback(async (outcome: 'done' | 'skipped') => {
    if (outcome === 'skipped') {
      dispatch(setFlowActive(false));
      dispatch(updateSettingsPatch({ onboarding_v3: 'skipped', accent_color: accent, accent_gradient: gradient, theme: mode }));
      return;
    }
    dispatch(updateSettingsPatch({ onboarding_v3: 'done', accent_color: accent, accent_gradient: gradient, theme: mode }));
    // Wait for prep (kicked early during the beats, usually already resolved) so the welcome greeting +
    // starters are coherent. A previous run's greeting persists in settings, so staging the reveal before
    // this patch landed showed a stale greeting; persist FIRST, then stage. Capped so a user who outran
    // prep waits a beat, never an open-ended spinner.
    let prep = prepReadyRef.current;
    if (!prep && prepRef.current) {
      prep = (await Promise.race([
        prepRef.current,
        new Promise<null>((res) => window.setTimeout(() => res(null), PREP_WAIT_CAP_MS)),
      ]).catch(() => null)) ?? prepReadyRef.current;
    }
    // Always patch (even to null): clears a previous run's stale greeting when this prep produced none.
    dispatch(updateSettingsPatch({
      personalized_greeting: prep?.greeting?.trim() || null,
      personalized_headline: prep?.headline?.trim() || null,
      personalized_starters: prep?.starters ?? [],
      personalized_automations: prep?.automations ?? [],
    }));
    dispatch(stageReveal({
      greeting: prep?.greeting?.trim() || null,
      starters: prep?.starters ?? [],
      scanSummary: summarizeScan(scanResultRef.current),
      autoPrompt: null,
    }));
    dispatch(setFlowActive(false));
  }, [dispatch, accent, gradient, mode]);

  return { identity, kickIdentity, kickScan, kickUsageRead, kickPrep, finish };
}
