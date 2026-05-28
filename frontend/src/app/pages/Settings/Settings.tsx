import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettings, closeSettingsModal, setDraft, clearDraft, AppSettings } from '@/shared/state/settingsSlice';
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
import SettingsFooter from './sections/SettingsFooter';
import ConfirmDiscardDialog from './sections/ConfirmDiscardDialog';
import { makeSettingsStyles } from './sections/settingsStyles';

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

const DEFAULT_MODEL_FALLBACK = [
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
    return { grouped, flat };
  }, [modelsByProvider, modelsLoaded, settings.connection_mode]);

  const initialTab = useAppSelector((s) => s.settings.initialTab);
  // In-flight edits persisted to Redux so they survive modal close; cleared on save or explicit Discard.
  const draft = useAppSelector((s) => s.settings.draft);
  const draftTab = useAppSelector((s) => s.settings.draftTab);
  const TAB_VALUES = ['general', 'models', 'usage', 'commands'] as const;
  type SettingsTab = typeof TAB_VALUES[number];
  const isValidTab = (t: string | null | undefined): t is SettingsTab =>
    !!t && (TAB_VALUES as readonly string[]).includes(t);
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isValidTab(draftTab) ? draftTab : 'general',
  );
  const [form, setForm] = useState<AppSettings>({ ...settings, ...(draft || {}) });

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
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    if (open) dispatch(fetchModels());
  }, [open, dispatch]);

  useEffect(() => {
    // On open, restore the last tab from draft; explicit initialTab is handled by the effect above.
    if (open && !initialTab) {
      setActiveTab(isValidTab(draftTab) ? draftTab : 'general');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  // Sync form on modal open + first load only; including `settings` in deps wipes in-flight edits on background fetches (issue #25).
  useEffect(() => {
    if (open && loaded) {
      setForm({ ...settings, ...(draft || {}) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  // Persist in-flight edits to Redux; compares to `settings` so a clean reopen doesn't keep a phantom draft.
  useEffect(() => {
    if (!open || !loaded) return;
    const dirty = JSON.stringify(form) !== JSON.stringify(settings);
    if (dirty) {
      dispatch(setDraft({ form, tab: activeTab }));
    } else if (draft !== null) {
      dispatch(clearDraft());
    }
  }, [form, activeTab, open, loaded, settings, draft, dispatch]);

  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings);

  const handleSave = async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) {
      setThemeMode(form.theme);
    }
    dispatch(fetchModels());
    setSaved(true);
  };

  // Non-destructive close; draft persists in Redux. Explicit discard lives on its own button.
  const handleRequestClose = useCallback(() => {
    dispatch(closeSettingsModal());
    onboardingBus.emit('settings:closed');
  }, [dispatch]);

  // Explicit discard wipes the draft so form snaps back to saved settings; modal stays open for verification.
  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscard(false);
    setForm({ ...settings });
    dispatch(clearDraft());
  }, [settings, dispatch]);

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
      ) : (
      <Box sx={{ pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <CommandsContent />
      </Box>
      )}
      </DialogContent>

      {(activeTab === 'general' || activeTab === 'models') && (
      <SettingsFooter
        hasChanges={hasChanges}
        onDiscard={() => setConfirmDiscard(true)}
        onClose={handleRequestClose}
        onSave={handleSave}
      />
      )}

      <DirectoryBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(item) => setForm({ ...form, default_folder: item.path })}
        initialPath={form.default_folder ?? ''}
      />

      <Snackbar
        open={saved}
        autoHideDuration={3000}
        onClose={() => setSaved(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSaved(false)} severity="success" sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.status.success}` }}>
          Settings saved
        </Alert>
      </Snackbar>
    </Dialog>

    <ConfirmDiscardDialog
      open={confirmDiscard}
      onCancel={() => setConfirmDiscard(false)}
      onConfirm={handleConfirmDiscard}
    />
    </>
  );
};

export default Settings;
