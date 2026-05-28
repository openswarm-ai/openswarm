import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useAppDispatch } from '@/shared/hooks';
import { resetSystemPrompt, AppSettings, DEFAULT_SYSTEM_PROMPT } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SettingsStyles } from '../settingsStyles';

type ModelOption = { value: string; label: string };

const GeneralAgentDefaults: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
  setBrowseOpen: (v: boolean) => void;
  modelOptions: { grouped: Record<string, ModelOption[]>; flat: Array<ModelOption & { provider: string }> };
  modesList: Array<{ id: string; name: string }>;
  providerColors: Record<string, string>;
  openswarmGradient: string;
}> = ({ form, setForm, styles, setBrowseOpen, modelOptions, modesList, providerColors, openswarmGradient }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { fieldSx, sectionSx, rowSx, inlineRowSx, inlineRowLastSx, labelSx, descSx } = styles;

  return (
    <>
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
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <Select
            value={form.default_model}
            onChange={(e) => setForm({ ...form, default_model: e.target.value })}
            sx={{ fontSize: '0.85rem' }}
            MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            renderValue={(val) => {
              const m = modelOptions.flat.find((x) => x.value === val);
              if (!m) return String(val);
              return (
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <span>{m.label}</span>
                  <Typography component="span" sx={{ fontSize: '0.65rem', color: c.text.ghost }}>
                    · {m.provider}
                  </Typography>
                </Box>
              );
            }}
          >
            {Object.entries(modelOptions.grouped).flatMap(([prov, models]) => {
              const isOpenSwarmPro = prov === 'OpenSwarm Pro';
              const brandColor = providerColors[prov.toLowerCase()] ?? c.text.tertiary;
              return [
                <ListSubheader
                  key={`header-${prov}`}
                  sx={{
                    bgcolor: c.bg.surface,
                    lineHeight: '1.8em',
                    px: 1.5,
                    py: 0.4,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box
                      sx={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: isOpenSwarmPro ? openswarmGradient : brandColor,
                        boxShadow: isOpenSwarmPro
                          ? '0 0 8px rgba(229, 107, 196, 0.6)'
                          : `0 0 6px ${brandColor}80`,
                      }}
                    />
                    <Typography
                      sx={{
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        ...(isOpenSwarmPro
                          ? {
                              background: openswarmGradient,
                              WebkitBackgroundClip: 'text',
                              WebkitTextFillColor: 'transparent',
                              backgroundClip: 'text',
                            }
                          : { color: brandColor }),
                      }}
                    >
                      {prov}
                    </Typography>
                  </Box>
                </ListSubheader>,
                ...models.map((m) => (
                  <MenuItem key={m.value} value={m.value} sx={{ fontSize: '0.85rem', pl: 3 }}>
                    {m.label}
                  </MenuItem>
                )),
              ];
            })}
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

      <Box sx={inlineRowSx}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Thinking</Typography>
          <Typography sx={descSx}>Default thinking level for reasoning-capable models.</Typography>
        </Box>
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <Select
            value={form.default_thinking_level}
            onChange={(e) => setForm({ ...form, default_thinking_level: e.target.value as AppSettings['default_thinking_level'] })}
            sx={{ fontSize: '0.85rem' }}
            MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
          >
            <MenuItem value="auto">Auto</MenuItem>
            <MenuItem value="off">Off</MenuItem>
            <MenuItem value="low">Low</MenuItem>
            <MenuItem value="medium">Medium</MenuItem>
            <MenuItem value="high">High</MenuItem>
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
    </>
  );
};

export default GeneralAgentDefaults;
