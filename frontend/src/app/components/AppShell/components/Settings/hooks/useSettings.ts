import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { UPDATE_SETTINGS, AppSettings } from '@/shared/backend-bridge/apps/settings';
import { closeSettingsModal } from '@/shared/state/settingsSlice';
import { SUBSCRIPTIONS_STATUS } from '@/shared/backend-bridge/apps/subscriptions';
import { setChecking, setUpdateError } from '@/shared/state/updateSlice';
import { LIST_MODES } from '@/shared/state/modesSlice';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';

export function useSettings() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.settings.modalOpen);
  const settings = useAppSelector((s) => s.settings.data);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const modes = useAppSelector((s) => s.modes.items);
  const { setMode: setThemeMode } = useThemeMode();
  const modesList = useMemo(() => Object.values(modes), [modes]);
  const updateStatus = useAppSelector((s) => s.update.status);
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const downloadPercent = useAppSelector((s) => s.update.downloadPercent);
  const updateError = useAppSelector((s) => s.update.error);
  const [activeTab, setActiveTab] = useState<'general' | 'models' | 'usage' | 'commands'>('general');
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [showApiKey, setShowApiKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showApiHelp, setShowApiHelp] = useState(false);
  useEffect(() => { dispatch(LIST_MODES()); }, [dispatch]);
  useEffect(() => { if (open) setActiveTab('general'); }, [open]);
  useEffect(() => { if (loaded) setForm({ ...settings }); }, [loaded, settings]);
  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings);
  const handleSave = async () => {
    await dispatch(UPDATE_SETTINGS(form));
    if (form.theme !== settings.theme) setThemeMode(form.theme);
    dispatch(SUBSCRIPTIONS_STATUS());
    setSaved(true);
  };
  const handleRequestClose = useCallback(() => {
    if (hasChanges) setConfirmDiscard(true);
    else dispatch(closeSettingsModal());
  }, [hasChanges, dispatch]);
  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscard(false);
    setForm({ ...settings });
    dispatch(closeSettingsModal());
  }, [settings, dispatch]);
  const handleSaveAndClose = useCallback(async () => {
    await dispatch(UPDATE_SETTINGS(form));
    if (form.theme !== settings.theme) setThemeMode(form.theme);
    dispatch(SUBSCRIPTIONS_STATUS());
    setSaved(true);
    setConfirmDiscard(false);
    dispatch(closeSettingsModal());
  }, [dispatch, form, settings, setThemeMode]);
  const handleCheckForUpdates = async () => {
    dispatch(setChecking());
    const timeout = setTimeout(() => {
      dispatch(setUpdateError('Update check timed out. Please try again.'));
    }, 15000);
    try { await (window as any).openswarm?.checkForUpdates(); }
    catch {} finally { clearTimeout(timeout); }
  };
  const handleDownloadUpdate = async () => {
    try { await (window as any).openswarm?.downloadUpdate(); } catch {}
  };
  const handleInstallUpdate = () => { (window as any).openswarm?.installUpdate(); };
  const browseFolder = async () => {
    const result = await (window as any).openswarm?.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: form.default_folder || undefined,
    });
    if (result && !result.canceled && result.filePaths?.length > 0) {
      setForm({ ...form, default_folder: result.filePaths[0] });
    }
  };
  const fieldSx = { '& .MuiOutlinedInput-root': { fontSize: '0.85rem' } };
  const sectionSx = { fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: c.text.tertiary, mb: 0.5, mt: 0.5 };
  const rowSx = { py: 2, borderBottom: `1px solid ${c.border.subtle}` };
  const rowLastSx = { py: 2 };
  const inlineRowSx = { ...rowSx, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
  const inlineRowLastSx = { ...rowLastSx, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
  const labelSx = { color: c.text.primary, fontWeight: 500, fontSize: '0.875rem', lineHeight: 1.4 };
  const descSx = { color: c.text.tertiary, fontSize: '0.75rem', lineHeight: 1.4 };
  return {
    c, dispatch, open, settings, modesList,
    activeTab, setActiveTab, form, setForm,
    showApiKey, setShowApiKey, browseFolder,
    saved, setSaved, recordingShortcut, setRecordingShortcut,
    confirmDiscard, setConfirmDiscard, showApiHelp, setShowApiHelp,
    hasChanges, handleSave, handleRequestClose, handleConfirmDiscard,
    handleSaveAndClose, handleCheckForUpdates, handleDownloadUpdate, handleInstallUpdate,
    updateStatus, appVersion, availableVersion, downloadPercent, updateError,
    fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, inlineRowLastSx, labelSx, descSx,
  };
}

export type UseSettingsReturn = ReturnType<typeof useSettings>;
