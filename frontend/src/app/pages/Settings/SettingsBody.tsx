import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchModels } from '@/shared/state/modelsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import DirectoryBrowser from '@/app/components/editor/DirectoryBrowser';
import { CommandsContent } from '@/app/pages/Commands/Commands';
import AccountCard from './sections/subscription/AccountCard';
import GeneralAgentDefaults from './sections/general/GeneralAgentDefaults';
import GeneralInterface from './sections/general/GeneralInterface';
import DictationSettings from './sections/general/DictationSettings';
import MemorySettings from './sections/general/MemorySettings';
import CanvasSettings from './sections/general/CanvasSettings';
import AgentBehaviorSettings from './sections/general/AgentBehaviorSettings';
import GeneralAdvanced from './sections/general/GeneralAdvanced';
import DataPrivacySection from './sections/general/DataPrivacySection';
import ModelsTab from './sections/models/ModelsTab';
import UsageStats from './sections/usage/UsageStats';
import SettingsRail, { railLabelFor } from './sections/SettingsRail';
import { makeSettingsStyles } from './sections/settingsStyles';
import { useSettingsForm } from './useSettingsForm';
import { clearSettingsRequestedTab } from '@/shared/state/dashboardLayoutSlice';
import NotificationsSection from './sections/general/NotificationsSection';
import { openMarketplace } from '@/app/pages/Directory/openMarketplace';
import { PROVIDER_COLORS, OPENSWARM_GRADIENT, useModelOptions } from './settingsModelOptions';

// Module-scope: remember the last open tab across closes (System Settings style).
let lastOpenTab: string | null = null;

const TAB_VALUES = ['account', 'general', 'appearance', 'dictation', 'memory', 'canvas', 'agents', 'notifications', 'privacy', 'advanced', 'models', 'commands', 'usage'] as const;
type SettingsTab = typeof TAB_VALUES[number];
const isValidTab = (t: string | null | undefined): t is SettingsTab =>
  !!t && (TAB_VALUES as readonly string[]).includes(t);

interface SettingsBodyProps {
  /** The host is showing this body; gates the fetches, the live theme apply and the debounced save. */
  active: boolean;
  onRequestClose: () => void;
}

// The settings UI itself: rail + section. Hosted by the modal (Settings.tsx) and by the on-canvas window (SettingsAppCard) with no forked copy between them.
const SettingsBody: React.FC<SettingsBodyProps> = ({ active, onRequestClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const modes = useAppSelector((s) => s.modes.items);
  const modesList = useMemo(() => Object.values(modes), [modes]);
  const modelOptions = useModelOptions();
  const { form, setForm, saveError, dismissSaveError, flushPendingSave } = useSettingsForm(active);
  const requestedTab = useAppSelector((s) => s.dashboardLayout.settingsRequestedTab);

  const [activeTab, setActiveTab] = useState<SettingsTab>(isValidTab(lastOpenTab) ? lastOpenTab : 'general');
  const [showApiKey, setShowApiKey] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    if (active) dispatch(fetchModels());
  }, [active, dispatch]);

  // Switch to the requested tab (e.g. from the "Configure models" banner link), then clear the transient.
  useEffect(() => {
    if (!requestedTab) return;
    // Skills/Tools management moved to the Marketplace; forward any straggler deep-links there.
    if (requestedTab === 'skills' || requestedTab === 'tools') {
      openMarketplace(requestedTab === 'skills' ? 'my-skills' : 'my-connectors');
    } else if (isValidTab(requestedTab)) {
      setActiveTab(requestedTab);
    }
    dispatch(clearSettingsRequestedTab());
  }, [requestedTab, dispatch]);

  useEffect(() => {
    lastOpenTab = activeTab;
  }, [activeTab]);

  const handleRequestClose = (): void => {
    flushPendingSave();
    onRequestClose();
  };

  const styles = makeSettingsStyles(c);

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden', bgcolor: c.bg.surface, pt: 1.5 }}>
      <SettingsRail activeTab={activeTab} onTabChange={(v) => setActiveTab(v as SettingsTab)} />

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, pt: 0.5, pb: 0.75, flexShrink: 0 }}>
        <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
          {railLabelFor(activeTab)}
        </Typography>
        <IconButton onClick={handleRequestClose} size="small" data-onboarding="settings-close-button" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
          <X size={18} />
        </IconButton>
      </Box>

      <Box sx={{
        px: 3,
        py: 0,
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}>
      {activeTab === 'account' ? (
        <Box sx={{ pt: 1.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <AccountCard />
        </Box>
      ) : activeTab === 'general' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <GeneralAgentDefaults
            form={form}
            setForm={setForm}
            styles={styles}
            setBrowseOpen={setBrowseOpen}
            modelOptions={modelOptions}
            modesList={modesList}
            providerColors={PROVIDER_COLORS}
            openswarmGradient={OPENSWARM_GRADIENT}
          />
        </Box>
      ) : activeTab === 'appearance' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <GeneralInterface form={form} setForm={setForm} styles={styles} />
        </Box>
      ) : activeTab === 'dictation' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <DictationSettings form={form} setForm={setForm} styles={styles} />
        </Box>
      ) : activeTab === 'memory' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <MemorySettings form={form} setForm={setForm} styles={styles} />
        </Box>
      ) : activeTab === 'canvas' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <CanvasSettings form={form} setForm={setForm} styles={styles} />
        </Box>
      ) : activeTab === 'agents' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <AgentBehaviorSettings form={form} setForm={setForm} styles={styles} />
        </Box>
      ) : activeTab === 'privacy' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <DataPrivacySection form={form} setForm={setForm} styles={styles} />
        </Box>
      ) : activeTab === 'advanced' ? (
        <Box sx={{ pt: 0.5, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
          <GeneralAdvanced form={form} setForm={setForm} styles={styles} />
        </Box>
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
      ) : activeTab === 'notifications' ? (
      <Box sx={{ pt: 2, pb: 2, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <NotificationsSection form={form} setForm={setForm} />
      </Box>
      ) : (
      <Box sx={{ pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <CommandsContent />
      </Box>
      )}
      </Box>
      </Box>

      <DirectoryBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(item) => setForm({ ...form, default_folder: item.path })}
        initialPath={form.default_folder ?? ''}
      />

      <Snackbar
        open={saveError}
        autoHideDuration={4000}
        onClose={dismissSaveError}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={dismissSaveError} severity="error" sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.status.error}` }}>
          Couldn't save that change. Try again in a moment.
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default SettingsBody;
