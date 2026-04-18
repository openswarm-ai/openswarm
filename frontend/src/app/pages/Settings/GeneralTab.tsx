import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import LanguageIcon from '@mui/icons-material/Language';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { RESET_SYSTEM_PROMPT } from '@/shared/backend-bridge/apps/settings';
import { DEFAULT_SYSTEM_PROMPT } from '@/shared/state/settingsSlice';
import InterfaceSection from './InterfaceSection';
import AboutSection from './AboutSection';
import type { UseSettingsReturn } from './hooks/useSettings';

const GeneralTab: React.FC<{ s: UseSettingsReturn }> = ({ s }) => {
  const { form, setForm, c, dispatch, modesList, browseFolder,
          fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, inlineRowLastSx, labelSx, descSx } = s;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
      <Typography sx={sectionSx}>Agent Defaults</Typography>
      <Box sx={rowSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
          <Typography sx={labelSx}>System prompt</Typography>
          {form.default_system_prompt !== DEFAULT_SYSTEM_PROMPT && (
            <Button
              size="small"
              startIcon={<RestartAltIcon sx={{ fontSize: 14 }} />}
              onClick={async () => {
                await dispatch(RESET_SYSTEM_PROMPT());
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
            onClick={browseFolder}
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
      <InterfaceSection s={s} />
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
      <AboutSection s={s} />
    </Box>
  );
};

export default GeneralTab;
