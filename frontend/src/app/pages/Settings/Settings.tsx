import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import CircularProgress from '@mui/material/CircularProgress';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch, closeSettingsModal, AppSettings } from '@/shared/state/settingsSlice';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { fetchModels } from '@/shared/state/modelsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useThemeMode, useClaudeTokens } from '@/shared/styles/ThemeContext';
import DirectoryBrowser from '@/app/components/editor/DirectoryBrowser';
import { CommandsContent } from '@/app/pages/Commands/Commands';
import GeneralTab from './sections/general/GeneralTab';
import ModelsTab from './sections/models/ModelsTab';
import UsageStats from './sections/usage/UsageStats';
import SettingsHeader from './sections/SettingsHeader';
import { makeSettingsStyles } from './sections/settingsStyles';

// Skills/Tools moved here from the old sidebar Customization section; lazy since both pull heavy deps and Settings opens nearly every session.
const SkillsTab = React.lazy(() => import('@/app/pages/Skills/Skills'));
const ToolsTab = React.lazy(() => import('@/app/pages/Tools/Tools'));

// Brand colors for provider group headers; mirrors ChatInput picker.
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
};
const OPENSWARM_GRADIENT =
  'linear-gradient(135deg, #8FB3FF 0%, #E56BC4 45%, #FFA85C 100%)';

// Module-scope: remember the last open tab across modal closes (System Settings style).
let lastOpenTab: string | null = null;

// Shown only in the brief window before the live model list loads from the backend. Keep the flagship current so the default-model dropdown isn't stale.
const DEFAULT_MODEL_FALLBACK = [
  { value: 'opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6' },
  { value: 'opus', label: 'Claude Opus 4.6' },
  { value: 'haiku', label: 'Claude Haiku 4.5' },
];

const Settings: React.FC = () => {
  const open = useAppSelector((s) => s.settings.modalOpen);
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const modes = useAppSelector((s) => s.modes.items);
  const { setMode: setThemeMode } = useThemeMode();

  const modesList = useMemo(() => Object.values(modes), [modes]);

  // Model picker source matches the in-session ChatInput picker, so Settings reflects connected providers.
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);

  const modelOptions = useMemo(() => {
    if (!modelsLoaded || Object.keys(modelsByProvider).length === 0) {
      const key = settings.connection_mode === 'openswarm-pro' ? 'OpenSwarm Pro' : 'Anthropic';
      return {
        grouped: { [key]: DEFAULT_MODEL_FALLBACK },
        flat: DEFAULT_MODEL_FALLBACK.map((m) => ({ ...m, provider: key })),
      };
    }
    const grouped: Record<string, Array<{ value: string; label: string }>> = {};
    const flat: Array<{ value: string; label: string; provider: string }> = [];
    for (const [prov, models] of Object.entries(modelsByProvider)) {
      grouped[prov] = models.map((m) => ({ value: m.value, label: m.label }));
      for (const m of models) flat.push({ value: m.value, label: m.label, provider: prov });
    }
    // Guarantee the currently-selected default is always a valid option, even if the live list doesn't carry it (custom/OpenRouter value, or a stored model not in the current registry). Without this the dropdown gets an MUI "out-of-range value" warning and renders blank.
    const sel = settings.default_model;
    if (sel && !flat.some((m) => m.value === sel)) {
      const other = 'Other';
      (grouped[other] ||= []).push({ value: sel, label: sel });
      flat.push({ value: sel, label: sel, provider: other });
    }
    return { grouped, flat };
  }, [modelsByProvider, modelsLoaded, settings.connection_mode, settings.default_model]);

  const initialTab = useAppSelector((s) => s.settings.initialTab);
  const TAB_VALUES = ['general', 'models', 'skills', 'tools', 'commands', 'usage'] as const;
  type SettingsTab = typeof TAB_VALUES[number];
  const isValidTab = (t: string | null | undefined): t is SettingsTab =>
    !!t && (TAB_VALUES as readonly string[]).includes(t);
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isValidTab(lastOpenTab) ? lastOpenTab : 'general',
  );
  const [form, setForm] = useState<AppSettings>({ ...settings });

  // Re-seed form on user change; otherwise the dirty detector falsely lights up Save/Discard.
  useEffect(() => {
    setForm({ ...settings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.user_id, settings.user_email]);

  // Switch to requested tab when modal opens (e.g. from the "Configure models" banner link).
  useEffect(() => {
    if (initialTab && (TAB_VALUES as readonly string[]).includes(initialTab)) {
      setActiveTab(initialTab as SettingsTab);
    }
  }, [initialTab]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    if (open) dispatch(fetchModels());
  }, [open, dispatch]);

  useEffect(() => {
    // On open, restore the last open tab; explicit initialTab is handled by the effect above.
    if (open && !initialTab) {
      setActiveTab(isValidTab(lastOpenTab) ? lastOpenTab : 'general');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  useEffect(() => {
    lastOpenTab = activeTab;
  }, [activeTab]);

  // Sync form on modal open + first load only; including `settings` in deps wipes in-flight edits on background fetches (issue #25). baseline = the snapshot the user started editing from, so we can tell user edits apart from fields the backend changed underneath us (OAuth connects, free-trial mints).
  const baselineRef = useRef<AppSettings>(settings);
  useEffect(() => {
    if (open && loaded) {
      setForm({ ...settings });
      baselineRef.current = settings;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  // Apply-on-change (System Settings style): edits save themselves after a short debounce, so text fields settle between keystrokes and toggles feel instant.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  // Only the fields the user touched ride on top of the LATEST settings; submitting the whole stale form would clobber background updates and ping-pong with server-owned fields.
  const buildSubmit = useCallback((): { touched: string[]; patch: Partial<AppSettings> } | null => {
    const base = baselineRef.current as unknown as Record<string, unknown>;
    const f = form as unknown as Record<string, unknown>;
    const touched = Array.from(new Set([...Object.keys(base), ...Object.keys(f)]))
      .filter((k) => JSON.stringify(f[k]) !== JSON.stringify(base[k]));
    if (touched.length === 0) return null;
    // Send ONLY what the user changed; the server merges it onto fresh state, so we never re-send (and clobber) a field something else updated underneath us.
    const patch: Record<string, unknown> = {};
    for (const k of touched) patch[k] = f[k];
    return { touched, patch: patch as Partial<AppSettings> };
  }, [form]);

  // Theme is local UI state; apply it the moment the toggle flips, the debounced save persists it.
  useEffect(() => {
    if (open && loaded) setThemeMode(form.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.theme]);

  useEffect(() => {
    if (!open || !loaded) return;
    if (!buildSubmit()) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      // A save already in flight will update `settings` when it lands, re-running this effect to pick up whatever is still unsaved.
      if (inFlight.current) return;
      const payload = buildSubmit();
      if (!payload) return;
      inFlight.current = true;
      try {
        await dispatch(updateSettingsPatch(payload.patch)).unwrap();
        // Absorb the saved edits so they stop counting as touched (prevents re-save loops).
        const nextBase = { ...baselineRef.current } as Record<string, unknown>;
        for (const k of payload.touched) nextBase[k] = (form as unknown as Record<string, unknown>)[k];
        baselineRef.current = nextBase as unknown as AppSettings;
        dispatch(fetchModels());
      } catch {
        setSaveError(true);
      } finally {
        inFlight.current = false;
      }
    }, 900);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [form, open, loaded, settings, dispatch, buildSubmit]);

  // Closing flushes any edit still inside the debounce window; nothing is ever lost or asked about.
  const handleRequestClose = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const payload = loaded ? buildSubmit() : null;
    if (payload) {
      // Refetch only AFTER the patch lands, or it races the save and reads the pre-change list (stale Haiku until you reopen Settings). Not awaited, so the modal still closes instantly.
      dispatch(updateSettingsPatch(payload.patch))
        .unwrap()
        .then(() => dispatch(fetchModels()))
        .catch(() => {});
      baselineRef.current = form;
    }
    dispatch(closeSettingsModal());
    onboardingBus.emit('settings:closed');
  }, [dispatch, form, loaded, buildSubmit]);

  const styles = makeSettingsStyles(c);

  return (
    <>
    <Dialog
      open={open}
      onClose={handleRequestClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 780,
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          transition: 'none',
        },
      }}
    >
      <SettingsHeader
        activeTab={activeTab}
        onTabChange={(v) => setActiveTab(v)}
        onClose={handleRequestClose}
      />

      <DialogContent sx={{
        px: 3,
        py: 0,
        flex: 1,
        minHeight: 0,
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}>
      {activeTab === 'general' ? (
        <GeneralTab
          form={form}
          setForm={setForm}
          styles={styles}
          setBrowseOpen={setBrowseOpen}
          modelOptions={modelOptions}
          modesList={modesList}
          providerColors={PROVIDER_COLORS}
          openswarmGradient={OPENSWARM_GRADIENT}
        />
      ) : activeTab === 'models' ? (
        <ModelsTab
          form={form}
          setForm={setForm}
          showApiKey={showApiKey}
          setShowApiKey={setShowApiKey}
          styles={styles}
        />
      ) : activeTab === 'usage' ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <UsageStats />
      </Box>
      ) : activeTab === 'skills' ? (
      <Box sx={{ height: '100%', mx: -3, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <React.Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress size={24} /></Box>}>
          <SkillsTab />
        </React.Suspense>
      </Box>
      ) : activeTab === 'tools' ? (
      <Box sx={{ height: '100%', mx: -3, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <React.Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress size={24} /></Box>}>
          <ToolsTab />
        </React.Suspense>
      </Box>
      ) : (
      <Box sx={{ pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <CommandsContent />
      </Box>
      )}
      </DialogContent>

      <DirectoryBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(item) => setForm({ ...form, default_folder: item.path })}
        initialPath={form.default_folder ?? ''}
      />

      <Snackbar
        open={saveError}
        autoHideDuration={4000}
        onClose={() => setSaveError(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSaveError(false)} severity="error" sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.status.error}` }}>
          Couldn't save that change. Try again in a moment.
        </Alert>
      </Snackbar>
    </Dialog>
    </>
  );
};

export default Settings;
