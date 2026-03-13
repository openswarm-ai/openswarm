import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
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
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
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
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettings, closeSettingsModal, AppSettings } from '@/shared/state/settingsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';
import DirectoryBrowser from '@/app/components/DirectoryBrowser';

const Settings: React.FC = () => {
  const open = useAppSelector((s) => s.settings.modalOpen);
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const modes = useAppSelector((s) => s.modes.items);
  const { setMode: setThemeMode } = useThemeMode();

  const modesList = useMemo(() => Object.values(modes), [modes]);

  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [showApiKey, setShowApiKey] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
  }, [dispatch]);

  useEffect(() => {
    if (loaded) {
      setForm({ ...settings });
    }
  }, [loaded, settings]);

  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings);

  const handleSave = async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) {
      setThemeMode(form.theme);
    }
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
    dispatch(closeSettingsModal());
  }, [settings, dispatch]);

  const handleSaveAndClose = useCallback(async () => {
    await dispatch(updateSettings(form));
    if (form.theme !== settings.theme) {
      setThemeMode(form.theme);
    }
    setSaved(true);
    setConfirmDiscard(false);
    dispatch(closeSettingsModal());
  }, [dispatch, form, settings, setThemeMode]);

  const fieldSx = {
    '& .MuiOutlinedInput-root': {
      bgcolor: c.bg.page,
      fontSize: '0.85rem',
    },
  };

  return (
    <>
    <Dialog
      open={open}
      onClose={handleRequestClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 800,
          maxHeight: '85vh',
          bgcolor: c.bg.page,
          borderRadius: 4,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.lg,
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${c.border.subtle}`,
          px: 3,
          py: 2,
        }}
      >
        <Box>
          <Typography variant="h6" sx={{ color: c.text.primary, fontWeight: 700 }}>
            Settings
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem' }}>
            Global defaults and application configuration.
          </Typography>
        </Box>
        <IconButton onClick={handleRequestClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
          <CloseIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{
        p: 3,
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 640, mx: 'auto', pt: 1 }}>
        {/* Default System Prompt */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Default System Prompt
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            A global system prompt prepended to every agent session, before any mode-specific instructions.
          </Typography>
          <TextField
            value={form.default_system_prompt ?? ''}
            onChange={(e) => setForm({ ...form, default_system_prompt: e.target.value || null })}
            size="small"
            fullWidth
            multiline
            minRows={3}
            maxRows={10}
            placeholder="Enter a default system prompt..."
            sx={{
              ...fieldSx,
              '& .MuiOutlinedInput-root': {
                ...fieldSx['& .MuiOutlinedInput-root'],
                fontFamily: c.font.mono,
                fontSize: '0.8rem',
              },
              '& textarea': {
                '&::-webkit-scrollbar': { width: 5 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
                scrollbarWidth: 'thin',
                scrollbarColor: `${c.border.medium} transparent`,
              },
            }}
          />
        </Paper>

        {/* Default Folder */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Default Folder
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            The working directory agents start in by default. Modes can override this per-mode.
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
              startIcon={<FolderOpenIcon />}
              sx={{
                color: c.accent.primary,
                borderColor: c.border.medium,
                textTransform: 'none',
                whiteSpace: 'nowrap',
                minWidth: 'auto',
              }}
            >
              Browse
            </Button>
          </Box>
        </Paper>

        {/* Default Model */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Default Model
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            The default model for new agent sessions.
          </Typography>
          <FormControl fullWidth size="small">
            <Select
              value={form.default_model}
              onChange={(e) => setForm({ ...form, default_model: e.target.value })}
              sx={{ bgcolor: c.bg.page }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              <MenuItem value="sonnet">Sonnet 4.6</MenuItem>
              <MenuItem value="opus">Opus 4.6</MenuItem>
              <MenuItem value="haiku">Haiku 3.5</MenuItem>
            </Select>
          </FormControl>
        </Paper>

        {/* Default Mode */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Default Mode
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            The default interaction mode for new agent sessions.
          </Typography>
          <FormControl fullWidth size="small">
            <Select
              value={form.default_mode}
              onChange={(e) => setForm({ ...form, default_mode: e.target.value })}
              sx={{ bgcolor: c.bg.page }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              {modesList.map((m) => (
                <MenuItem key={m.id} value={m.id}>{m.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Paper>

        {/* Default Max Turns */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Default Max Turns
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            Maximum number of agent turns before auto-stopping. Leave empty for unlimited.
          </Typography>
          <TextField
            type="number"
            value={form.default_max_turns ?? ''}
            onChange={(e) => setForm({ ...form, default_max_turns: e.target.value ? parseInt(e.target.value) : null })}
            size="small"
            fullWidth
            placeholder="Unlimited"
            inputProps={{ min: 1 }}
            sx={fieldSx}
          />
        </Paper>

        {/* Zoom Sensitivity */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Zoom Sensitivity
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            Controls how responsive scroll-to-zoom is on the dashboard canvas. Lower values suit trackpads; higher values suit mouse wheels.
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
                '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.75rem' },
                '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
              }}
            />
          </Box>
        </Paper>

        {/* New Agent Shortcut */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            New Agent Shortcut
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            Keyboard shortcut to open the new agent input on the Dashboard.
          </Typography>
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
              gap: 1,
              px: 2,
              py: 1,
              borderRadius: `${c.radius.md}px`,
              border: `1px solid ${recordingShortcut ? c.accent.primary : c.border.medium}`,
              bgcolor: c.bg.page,
              cursor: 'pointer',
              outline: 'none',
              transition: 'border-color 0.15s',
              '&:hover': { borderColor: c.accent.primary },
            }}
          >
            <KeyboardIcon sx={{ fontSize: 18, color: recordingShortcut ? c.accent.primary : c.text.tertiary }} />
            {recordingShortcut ? (
              <Typography sx={{ fontSize: '0.85rem', color: c.accent.primary, fontWeight: 500 }}>
                Press shortcut…
              </Typography>
            ) : (
              <Typography sx={{ fontSize: '0.85rem', color: c.text.primary, fontFamily: c.font.mono, fontWeight: 500 }}>
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
        </Paper>

        {/* Theme */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Theme
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            Application color scheme.
          </Typography>
          <ToggleButtonGroup
            value={form.theme}
            exclusive
            onChange={(_, v) => { if (v) setForm({ ...form, theme: v }); }}
            size="small"
            sx={{
              '& .MuiToggleButton-root': {
                color: c.text.muted,
                borderColor: c.border.medium,
                textTransform: 'none',
                px: 2.5,
                gap: 0.75,
                '&.Mui-selected': {
                  bgcolor: `${c.accent.primary}15`,
                  color: c.accent.primary,
                  borderColor: c.accent.primary,
                  '&:hover': { bgcolor: `${c.accent.primary}20` },
                },
              },
            }}
          >
            <ToggleButton value="light">
              <LightModeIcon sx={{ fontSize: 18 }} /> Light
            </ToggleButton>
            <ToggleButton value="dark">
              <DarkModeIcon sx={{ fontSize: 18 }} /> Dark
            </ToggleButton>
          </ToggleButtonGroup>
        </Paper>

        {/* Anthropic API Key */}
        <Paper sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 3, p: 3, boxShadow: c.shadow.sm }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', mb: 0.5 }}>
            Anthropic API Key
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem', mb: 2 }}>
            Your API key for the Anthropic Claude API. Stored securely in the database.
          </Typography>
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
                    {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 18 }} /> : <VisibilityIcon sx={{ fontSize: 18 }} />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
        </Paper>

      </Box>
      </DialogContent>

      <DialogActions sx={{ borderTop: `1px solid ${c.border.subtle}`, px: 3, py: 2, justifyContent: 'flex-end' }}>
        <Button
          onClick={handleRequestClose}
          sx={{ color: c.text.muted, textTransform: 'none' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={!hasChanges}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
            textTransform: 'none',
            borderRadius: 2,
            px: 3,
          }}
        >
          Save Settings
        </Button>
      </DialogActions>

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
          Settings saved successfully
        </Alert>
      </Snackbar>
    </Dialog>

    {/* Discard changes confirmation */}
    <Dialog
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      PaperProps={{
        sx: {
          bgcolor: c.bg.surface,
          borderRadius: 3,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.lg,
          maxWidth: 400,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem', pb: 0.5 }}>
        Unsaved Changes
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ color: c.text.muted, fontSize: '0.875rem' }}>
          You have unsaved changes. Would you like to save them before closing?
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          onClick={handleConfirmDiscard}
          sx={{ color: c.status.error, textTransform: 'none' }}
        >
          Discard
        </Button>
        <Button
          onClick={() => setConfirmDiscard(false)}
          sx={{ color: c.text.muted, textTransform: 'none' }}
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
            borderRadius: 2,
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
