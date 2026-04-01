import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import LanguageIcon from '@mui/icons-material/Language';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DownloadIcon from '@mui/icons-material/Download';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Collapse from '@mui/material/Collapse';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettings, closeSettingsModal, resetSystemPrompt, AppSettings, DEFAULT_SYSTEM_PROMPT } from '@/shared/state/settingsSlice';
import { setChecking, setUpdateError } from '@/shared/state/updateSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useClaudeTokens, useTheme, useThemeMode, scaleRadii } from '@/shared/styles/ThemeContext';
import { THEMES, ThemeName } from '@/shared/styles/claudeTokens';
import DirectoryBrowser from '@/app/components/DirectoryBrowser';
import { CommandsContent } from '@/app/pages/Commands/Commands';

const API_KEY_STEPS = [
  {
    title: 'Open the Anthropic Console',
    detail: 'Visit console.anthropic.com — create a free account if you don\'t have one yet.',
    link: 'https://console.anthropic.com',
  },
  {
    title: 'Navigate to API Keys',
    detail: 'In the dashboard, click "Settings" in the left sidebar, then select "API Keys".',
  },
  {
    title: 'Create a new key',
    detail: 'Click the "Create Key" button. Name it anything you like (e.g. "OpenSwarm").',
  },
  {
    title: 'Copy your key',
    detail: 'Click the copy icon next to your new key. It will start with sk-ant-api03-…',
  },
  {
    title: 'Paste it above & save',
    detail: 'Paste the key into the field above, then hit Save. You\'re all set!',
  },
];

const Settings: React.FC = () => {
  const open = useAppSelector((s) => s.settings.modalOpen);
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const modes = useAppSelector((s) => s.modes.items);
  const { setTheme: setThemeName, setRadiusScale } = useTheme();
  const { setMode: setThemeMode } = useThemeMode();

  const modesList = useMemo(() => Object.values(modes), [modes]);

  const updateStatus = useAppSelector((s) => s.update.status);
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const downloadPercent = useAppSelector((s) => s.update.downloadPercent);
  const updateError = useAppSelector((s) => s.update.error);

  const [activeTab, setActiveTab] = useState<'general' | 'commands'>('general');
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [showApiKey, setShowApiKey] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showApiHelp, setShowApiHelp] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    if (open) setActiveTab('general');
  }, [open]);

  useEffect(() => {
    if (loaded) {
      setForm({ ...settings });
    }
  }, [loaded, settings]);

  const handleCheckForUpdates = async () => {
    dispatch(setChecking());
    const timeout = setTimeout(() => {
      dispatch(setUpdateError('Update check timed out. Please try again.'));
    }, 15000);
    try {
      await (window as any).openswarm?.checkForUpdates();
    } catch {
      /* error handled via IPC event listener */
    } finally {
      clearTimeout(timeout);
    }
  };

  const handleDownloadUpdate = async () => {
    try {
      await (window as any).openswarm?.downloadUpdate();
    } catch {
      /* error handled via IPC event listener */
    }
  };

  const handleInstallUpdate = () => {
    (window as any).openswarm?.installUpdate();
  };

  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings);

  const handleSave = async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) setThemeName(form.theme as ThemeName);
    if (form.radius_scale !== settings.radius_scale) setRadiusScale(form.radius_scale ?? 1);
    setSaved(true);
  };

  const handleRequestClose = useCallback(() => {
    if (hasChanges) {
      setConfirmDiscard(true);
    } else {
      dispatch(closeSettingsModal());
    }
  }, [hasChanges, dispatch]);

  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscard(false);
    setForm({ ...settings });
    // Revert any live previews
    setThemeName(settings.theme as ThemeName);
    setRadiusScale(settings.radius_scale ?? 1);
    dispatch(closeSettingsModal());
  }, [settings, dispatch, setThemeName, setRadiusScale]);

  const handleSaveAndClose = useCallback(async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) setThemeName(form.theme as ThemeName);
    if (form.radius_scale !== settings.radius_scale) setRadiusScale(form.radius_scale ?? 1);
    setSaved(true);
    setConfirmDiscard(false);
    dispatch(closeSettingsModal());
  }, [dispatch, form, settings, setThemeName, setRadiusScale]);

  const fieldSx = {
    '& .MuiOutlinedInput-root': {
      fontSize: '0.85rem',
    },
  };

  const sectionSx = {
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: c.text.tertiary,
    mb: 0.5,
    mt: 0.5,
  };

  const rowSx = {
    py: 2,
    borderBottom: `1px solid ${c.border.subtle}`,
  };

  const rowLastSx = {
    py: 2,
  };

  const inlineRowSx = {
    ...rowSx,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const inlineRowLastSx = {
    ...rowLastSx,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const labelSx = {
    color: c.text.primary,
    fontWeight: 500,
    fontSize: '0.875rem',
    lineHeight: 1.4,
  };

  const descSx = {
    color: c.text.tertiary,
    fontSize: '0.75rem',
    lineHeight: 1.4,
  };

  return (
    <>
    <Dialog
      open={open}
      onClose={handleRequestClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 780,
          maxHeight: '85vh',
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
        },
      }}
    >
      <DialogTitle
        sx={{
          px: 3,
          py: 0,
          borderBottom: `1px solid ${c.border.subtle}`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pt: 1.5, pb: 0.5 }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
            Settings
          </Typography>
          <IconButton onClick={handleRequestClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
        <Tabs
          value={activeTab}
          onChange={(_, v) => setActiveTab(v)}
          sx={{
            minHeight: 36,
            '& .MuiTab-root': {
              minHeight: 36,
              textTransform: 'none',
              fontSize: '0.85rem',
              fontWeight: 500,
              color: c.text.muted,
              px: 1.5,
              '&.Mui-selected': { color: c.accent.primary, fontWeight: 600 },
            },
            '& .MuiTabs-indicator': { backgroundColor: c.accent.primary, height: 2 },
          }}
        >
          <Tab label="General" value="general" disableRipple />
          <Tab label="Commands" value="commands" disableRipple />
        </Tabs>
      </DialogTitle>

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
      <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1 }}>

        {/* ── Agent Defaults ── */}
        <Typography sx={sectionSx}>Agent Defaults</Typography>

        <Box sx={rowSx}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography sx={labelSx}>System prompt</Typography>
            {form.default_system_prompt !== DEFAULT_SYSTEM_PROMPT && (
              <Button
                size="small"
                startIcon={<RestartAltIcon sx={{ fontSize: 14 }} />}
                onClick={async () => {
                  await dispatch(resetSystemPrompt());
                  setForm((prev) => ({ ...prev, default_system_prompt: DEFAULT_SYSTEM_PROMPT }));
                }}
                sx={{
                  color: c.accent.primary,
                  textTransform: 'none',
                  fontSize: '0.75rem',
                  py: 0.25,
                  '&:hover': { bgcolor: `${c.accent.primary}10` },
                }}
              >
                Reset to default
              </Button>
            )}
          </Box>
          <Typography sx={{ ...descSx, mb: 1.5 }}>
            Prepended to every agent session before mode-specific instructions. Modes can override with their own.
          </Typography>
          <TextField
            value={form.default_system_prompt ?? DEFAULT_SYSTEM_PROMPT}
            onChange={(e) => setForm({ ...form, default_system_prompt: e.target.value || null })}
            multiline
            minRows={3}
            maxRows={8}
            fullWidth
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                fontFamily: c.font.mono,
                fontSize: '0.8rem',
                lineHeight: 1.6,
                color: c.text.secondary,
              },
            }}
          />
        </Box>

        <Box sx={rowSx}>
          <Typography sx={labelSx}>Working directory</Typography>
          <Typography sx={{ ...descSx, mb: 1.5 }}>
            Default folder agents start in. Modes can override per-mode.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              value={form.default_folder ?? ''}
              onChange={(e) => setForm({ ...form, default_folder: e.target.value || null })}
              size="small"
              fullWidth
              placeholder="Not set (uses project root)"
              sx={{
                ...fieldSx,
                '& .MuiOutlinedInput-root': {
                  ...fieldSx['& .MuiOutlinedInput-root'],
                  fontFamily: c.font.mono,
                },
              }}
            />
            <Button
              variant="outlined"
              onClick={() => setBrowseOpen(true)}
              startIcon={<FolderOpenIcon sx={{ fontSize: 16 }} />}
              sx={{
                color: c.text.tertiary,
                borderColor: c.border.medium,
                textTransform: 'none',
                whiteSpace: 'nowrap',
                minWidth: 'auto',
                fontSize: '0.8rem',
                '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
              }}
            >
              Browse
            </Button>
          </Box>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Model</Typography>
            <Typography sx={descSx}>Default model for new sessions.</Typography>
          </Box>
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <Select
              value={form.default_model}
              onChange={(e) => setForm({ ...form, default_model: e.target.value })}
              sx={{ fontSize: '0.85rem' }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              <MenuItem value="sonnet">Sonnet 4.6</MenuItem>
              <MenuItem value="opus">Opus 4.6</MenuItem>
              <MenuItem value="haiku">Haiku 3.5</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Mode</Typography>
            <Typography sx={descSx}>Default interaction mode for new sessions.</Typography>
          </Box>
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <Select
              value={form.default_mode}
              onChange={(e) => setForm({ ...form, default_mode: e.target.value })}
              sx={{ fontSize: '0.85rem' }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              {modesList.map((m) => (
                <MenuItem key={m.id} value={m.id}>{m.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box sx={inlineRowLastSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Max turns</Typography>
            <Typography sx={descSx}>Auto-stop after this many turns. Empty = unlimited.</Typography>
          </Box>
          <TextField
            type="number"
            value={form.default_max_turns ?? ''}
            onChange={(e) => setForm({ ...form, default_max_turns: e.target.value ? parseInt(e.target.value) : null })}
            size="small"
            placeholder="∞"
            inputProps={{ min: 1 }}
            sx={{ ...fieldSx, width: 100 }}
          />
        </Box>

        {/* ── Interface ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>Interface</Typography>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Theme</Typography>
            <Typography sx={descSx}>Application color scheme.</Typography>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mt: 0.5 }}>
            {(Object.entries(THEMES) as [ThemeName, typeof THEMES[ThemeName]][]).map(([key, meta]) => {
              const selected = form.theme === key;
              return (
                <Box
                  key={key}
                  onClick={() => setForm({ ...form, theme: key })}
                  sx={{
                    cursor: 'pointer',
                    borderRadius: `${c.radius.md}px`,
                    border: selected
                      ? `1.5px solid ${c.accent.primary}`
                      : `1px solid ${c.border.medium}`,
                    overflow: 'hidden',
                    transition: c.transition,
                    boxShadow: selected ? `0 0 0 3px ${c.accent.primary}28` : 'none',
                    '&:hover': { borderColor: selected ? c.accent.primary : c.border.strong },
                  }}
                >
                  <Box sx={{
                    height: 38,
                    background: meta.preview.bg,
                    display: 'flex',
                    alignItems: 'center',
                    px: 1,
                    gap: 0.75,
                  }}>
                    <Box sx={{ width: 14, height: 14, borderRadius: '50%', background: meta.preview.accent, flexShrink: 0 }} />
                    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <Box sx={{ height: 2.5, borderRadius: 2, background: meta.preview.surface, width: '75%', opacity: 0.85 }} />
                      <Box sx={{ height: 2.5, borderRadius: 2, background: meta.preview.surface, width: '50%', opacity: 0.5 }} />
                    </Box>
                  </Box>
                  <Box sx={{
                    px: 1, py: 0.5,
                    background: c.bg.surface,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}>
                    <Typography sx={{ fontSize: '0.7rem', fontWeight: 500, color: selected ? c.accent.primary : c.text.secondary }}>
                      {meta.label}
                    </Typography>
                    {selected && <Box sx={{ width: 5, height: 5, borderRadius: '50%', background: c.accent.primary }} />}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>

        {/* ── Rounding ── */}
        <Box sx={rowSx}>
          <Typography sx={labelSx}>Rounding</Typography>
          <Typography sx={{ ...descSx, mb: 1.5 }}>Corner radius for cards, buttons and panels.</Typography>

          {/* Live preview */}
          <Box sx={{ display: 'flex', gap: 1, mb: 2, alignItems: 'center' }}>
            {[0, 0.5, 1, 1.5, 2].map((s) => {
              const r = scaleRadii(THEMES[(form.theme in THEMES ? form.theme : 'midnight') as ThemeName]?.tokens?.radius ?? THEMES.midnight.tokens.radius, s);
              const active = Math.abs((form.radius_scale ?? 1) - s) < 0.05;
              return (
                <Box
                  key={s}
                  onClick={() => setForm({ ...form, radius_scale: s })}
                  title={['Sharp', 'Subtle', 'Default', 'Rounded', 'Pill'][Math.round(s * 2)]}
                  sx={{
                    cursor: 'pointer',
                    width: 48,
                    height: 32,
                    borderRadius: `${r.md}px`,
                    border: active
                      ? `1.5px solid ${c.accent.primary}`
                      : `1px solid ${c.border.medium}`,
                    background: active ? `${c.accent.primary}18` : c.bg.elevated,
                    transition: c.transition,
                    boxShadow: active ? `0 0 0 3px ${c.accent.primary}22` : 'none',
                    '&:hover': { borderColor: c.accent.hover },
                  }}
                />
              );
            })}
            <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, ml: 0.5 }}>
              {form.radius_scale === 0 ? 'Sharp' :
               form.radius_scale <= 0.55 ? 'Subtle' :
               form.radius_scale <= 1.05 ? 'Default' :
               form.radius_scale <= 1.55 ? 'Rounded' : 'Pill'}
            </Typography>
          </Box>

          <Box sx={{ px: 0.5 }}>
            <Slider
              value={form.radius_scale ?? 1}
              onChange={(_, v) => {
                const s = v as number;
                setForm({ ...form, radius_scale: s });
                setRadiusScale(s); // live preview
              }}
              min={0}
              max={2}
              step={0.05}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v.toFixed(2)}×`}
              marks={[
                { value: 0,   label: 'Sharp' },
                { value: 0.5, label: 'Subtle' },
                { value: 1,   label: 'Default' },
                { value: 1.5, label: 'Rounded' },
                { value: 2,   label: 'Pill' },
              ]}
              sx={{
                color: c.accent.primary,
                '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.7rem' },
                '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
              }}
            />
          </Box>
        </Box>

        <Box sx={rowSx}>
          <Typography sx={labelSx}>Zoom sensitivity</Typography>
          <Typography sx={{ ...descSx, mb: 1 }}>
            Scroll-to-zoom responsiveness. Lower for trackpads, higher for mouse wheels.
          </Typography>
          <Box sx={{ px: 1 }}>
            <Slider
              value={form.zoom_sensitivity}
              onChange={(_, v) => setForm({ ...form, zoom_sensitivity: v as number })}
              min={1}
              max={100}
              step={1}
              valueLabelDisplay="auto"
              marks={[
                { value: 1, label: 'Low' },
                { value: 50, label: 'Default' },
                { value: 100, label: 'High' },
              ]}
              sx={{
                color: c.accent.primary,
                '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.7rem' },
                '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
              }}
            />
          </Box>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>New agent shortcut</Typography>
            <Typography sx={descSx}>Keyboard shortcut to create an agent.</Typography>
          </Box>
          <Box
            tabIndex={0}
            onKeyDown={(e) => {
              if (!recordingShortcut) return;
              if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
              e.preventDefault();
              const parts: string[] = [];
              if (e.metaKey) parts.push('Meta');
              if (e.ctrlKey) parts.push('Ctrl');
              if (e.altKey) parts.push('Alt');
              if (e.shiftKey) parts.push('Shift');
              parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
              setForm({ ...form, new_agent_shortcut: parts.join('+') });
              setRecordingShortcut(false);
            }}
            onBlur={() => setRecordingShortcut(false)}
            onClick={() => setRecordingShortcut(true)}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: 0.75,
              borderRadius: `${c.radius.sm}px`,
              border: `1px solid ${recordingShortcut ? c.accent.primary : c.border.medium}`,
              cursor: 'pointer',
              outline: 'none',
              transition: 'border-color 0.15s',
              '&:hover': { borderColor: c.accent.primary },
            }}
          >
            <KeyboardIcon sx={{ fontSize: 16, color: recordingShortcut ? c.accent.primary : c.text.tertiary }} />
            {recordingShortcut ? (
              <Typography sx={{ fontSize: '0.8rem', color: c.accent.primary, fontWeight: 500 }}>
                Press shortcut…
              </Typography>
            ) : (
              <Typography sx={{ fontSize: '0.8rem', color: c.text.primary, fontFamily: c.font.mono, fontWeight: 500 }}>
                {form.new_agent_shortcut
                  .split('+')
                  .map((p) => {
                    if (p === 'Meta') return '⌘';
                    if (p === 'Ctrl') return 'Ctrl';
                    if (p === 'Alt') return '⌥';
                    if (p === 'Shift') return '⇧';
                    return p.toUpperCase();
                  })
                  .join(' + ')}
              </Typography>
            )}
          </Box>
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Auto-enable element selection</Typography>
            <Typography sx={descSx}>Automatically enter element selection mode when creating a new agent.</Typography>
          </Box>
          <Switch
            checked={form.auto_select_mode_on_new_agent}
            onChange={(e) => setForm({ ...form, auto_select_mode_on_new_agent: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        <Box sx={inlineRowSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Default agent spawn state in dashboard</Typography>
            <Typography sx={descSx}>When enabled, new agents spawn expanded instead of collapsed.</Typography>
          </Box>
          <Switch
            checked={form.expand_new_chats_in_dashboard}
            onChange={(e) => setForm({ ...form, expand_new_chats_in_dashboard: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        <Box sx={inlineRowLastSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Auto-reveal sub-agents on dashboard</Typography>
            <Typography sx={descSx}>Automatically show sub-agent cards (from CreateAgent / InvokeAgent) tethered to their parent on the dashboard.</Typography>
          </Box>
          <Switch
            checked={form.auto_reveal_sub_agents}
            onChange={(e) => setForm({ ...form, auto_reveal_sub_agents: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        {/* ── Browser ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>Browser</Typography>

        <Box sx={rowLastSx}>
          <Typography sx={labelSx}>Default homepage</Typography>
          <Typography sx={{ ...descSx, mb: 1.5 }}>
            URL loaded when opening a new browser card on the dashboard.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <LanguageIcon sx={{ fontSize: 18, color: c.text.tertiary, flexShrink: 0 }} />
            <TextField
              value={form.browser_homepage}
              onChange={(e) => setForm({ ...form, browser_homepage: e.target.value })}
              size="small"
              fullWidth
              placeholder="https://www.google.com"
              sx={{
                ...fieldSx,
                '& .MuiOutlinedInput-root': {
                  ...fieldSx['& .MuiOutlinedInput-root'],
                  fontFamily: c.font.mono,
                },
              }}
            />
          </Box>
        </Box>

        {/* ── API ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>API</Typography>

        <Box sx={rowLastSx}>
          <Typography sx={labelSx}>Anthropic API key</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Typography sx={descSx}>
              Stored securely in the local database.
            </Typography>
            <Typography
              component="span"
              onClick={() => setShowApiHelp((v) => !v)}
              sx={{
                color: c.accent.primary,
                fontSize: '0.75rem',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.4,
                whiteSpace: 'nowrap',
                userSelect: 'none',
                '&:hover': { textDecoration: 'underline' },
              }}
            >
              {showApiHelp ? 'Hide guide' : 'How do I get a key?'}
            </Typography>
          </Box>

          <Collapse in={showApiHelp} timeout={250}>
            <Box sx={{
              mb: 1.5,
              p: 2,
              borderRadius: `${c.radius.md}px`,
              bgcolor: `${c.accent.primary}08`,
              border: `1px solid ${c.accent.primary}20`,
            }}>
              {API_KEY_STEPS.map((step, i) => (
                <Box key={i} sx={{ display: 'flex', gap: 1.5, mb: i < API_KEY_STEPS.length - 1 ? 1.5 : 0 }}>
                  <Box sx={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    bgcolor: `${c.accent.primary}15`,
                    color: c.accent.primary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    flexShrink: 0,
                    mt: 0.1,
                  }}>
                    {i + 1}
                  </Box>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500, lineHeight: 1.4 }}>
                      {step.title}
                      {step.link && (
                        <Typography
                          component="a"
                          href={step.link}
                          sx={{
                            color: c.accent.primary,
                            fontSize: '0.75rem',
                            ml: 0.75,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 0.3,
                            verticalAlign: 'middle',
                            textDecoration: 'none',
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          Open
                          <OpenInNewIcon sx={{ fontSize: 12 }} />
                        </Typography>
                      )}
                    </Typography>
                    <Typography sx={{ color: c.text.muted, fontSize: '0.75rem', lineHeight: 1.4 }}>
                      {step.detail}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          </Collapse>

          <TextField
            type={showApiKey ? 'text' : 'password'}
            value={form.anthropic_api_key ?? ''}
            onChange={(e) => setForm({ ...form, anthropic_api_key: e.target.value || null })}
            size="small"
            fullWidth
            placeholder="sk-ant-..."
            sx={{
              ...fieldSx,
              '& .MuiOutlinedInput-root': {
                ...fieldSx['& .MuiOutlinedInput-root'],
                fontFamily: c.font.mono,
              },
            }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowApiKey(!showApiKey)}
                    edge="end"
                    size="small"
                    sx={{ color: c.text.tertiary }}
                  >
                    {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
        </Box>

        {/* ── Advanced ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>Advanced</Typography>

        <Box sx={inlineRowLastSx}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Developer mode</Typography>
            <Typography sx={descSx}>Show transport details, environment variables, raw configs, and other technical metadata throughout the app.</Typography>
          </Box>
          <Switch
            checked={form.dev_mode}
            onChange={(e) => setForm({ ...form, dev_mode: e.target.checked })}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>

        {/* ── About ── */}
        <Typography sx={{ ...sectionSx, mt: 3 }}>About</Typography>

        <Box sx={rowSx}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box>
              <Typography sx={labelSx}>Version</Typography>
              <Typography sx={{ ...descSx, fontFamily: c.font.mono }}>
                {appVersion ?? '—'}
              </Typography>
            </Box>
          </Box>
        </Box>

        <Box sx={rowLastSx}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: updateStatus === 'downloading' ? 1 : 0 }}>
            <Box>
              <Typography sx={labelSx}>Software update</Typography>
              <Typography sx={descSx}>
                {updateStatus === 'checking' && 'Checking for updates…'}
                {updateStatus === 'not-available' && 'You\'re on the latest version.'}
                {updateStatus === 'available' && `Version ${availableVersion} is available.`}
                {updateStatus === 'downloading' && `Downloading update… ${Math.round(downloadPercent)}%`}
                {updateStatus === 'downloaded' && `Version ${availableVersion} is ready to install.`}
                {updateStatus === 'error' && (updateError || 'Update check failed.')}
                {updateStatus === 'idle' && 'Check for new versions of OpenSwarm.'}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, ml: 2 }}>
              {updateStatus === 'checking' && (
                <CircularProgress size={18} sx={{ color: c.text.tertiary }} />
              )}
              {updateStatus === 'not-available' && (
                <CheckCircleOutlineIcon sx={{ fontSize: 18, color: c.status.success }} />
              )}
              {updateStatus === 'error' && (
                <ErrorOutlineIcon sx={{ fontSize: 18, color: c.status.error }} />
              )}
              {(updateStatus === 'idle' || updateStatus === 'not-available' || updateStatus === 'error') && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleCheckForUpdates}
                  disabled={updateStatus === 'checking'}
                  startIcon={<SystemUpdateAltIcon sx={{ fontSize: 15 }} />}
                  sx={{
                    color: c.text.secondary,
                    borderColor: c.border.medium,
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    whiteSpace: 'nowrap',
                    '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
                  }}
                >
                  Check for Updates
                </Button>
              )}
              {updateStatus === 'available' && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleDownloadUpdate}
                  startIcon={<DownloadIcon sx={{ fontSize: 15 }} />}
                  sx={{
                    color: c.accent.primary,
                    borderColor: c.accent.primary,
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    whiteSpace: 'nowrap',
                    '&:hover': { bgcolor: `${c.accent.primary}10` },
                  }}
                >
                  Download
                </Button>
              )}
              {updateStatus === 'downloaded' && (
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleInstallUpdate}
                  startIcon={<RestartAltIcon sx={{ fontSize: 15 }} />}
                  sx={{
                    bgcolor: c.accent.primary,
                    '&:hover': { bgcolor: c.accent.pressed },
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    whiteSpace: 'nowrap',
                    borderRadius: 1.5,
                  }}
                >
                  Restart &amp; Update
                </Button>
              )}
            </Box>
          </Box>
          {updateStatus === 'downloading' && (
            <LinearProgress
              variant="determinate"
              value={downloadPercent}
              sx={{
                height: 3,
                borderRadius: 2,
                bgcolor: `${c.accent.primary}20`,
                '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary, borderRadius: 2 },
              }}
            />
          )}
        </Box>

      </Box>
      ) : (
      <Box sx={{ pt: 2.5, pb: 1 }}>
        <CommandsContent />
      </Box>
      )}
      </DialogContent>

      {activeTab === 'general' && (
      <DialogActions sx={{ borderTop: `1px solid ${c.border.subtle}`, px: 3, py: 1.5, justifyContent: 'flex-end' }}>
        <Button
          onClick={handleRequestClose}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon sx={{ fontSize: 16 }} />}
          onClick={handleSave}
          disabled={!hasChanges}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
            textTransform: 'none',
            borderRadius: 1.5,
            px: 2.5,
            fontSize: '0.85rem',
          }}
        >
          Save
        </Button>
      </DialogActions>
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

    <Dialog
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      PaperProps={{
        sx: {
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          maxWidth: 380,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', pb: 0.5, px: 3, pt: 2.5 }}>
        Unsaved changes
      </DialogTitle>
      <DialogContent sx={{ px: 3 }}>
        <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>
          You have unsaved changes. Would you like to save them before closing?
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          onClick={handleConfirmDiscard}
          sx={{ color: c.status.error, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Discard
        </Button>
        <Button
          onClick={() => setConfirmDiscard(false)}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSaveAndClose}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            textTransform: 'none',
            borderRadius: 1.5,
            fontSize: '0.85rem',
          }}
        >
          Save & Close
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
};

export default Settings;
