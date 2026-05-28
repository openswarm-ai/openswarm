import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { AppSettings, CustomProvider } from '@/shared/state/settingsSlice';
import type { SettingsStyles } from '../settingsStyles';

const CustomProvidersEditor: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  showApiKey: boolean;
  setShowApiKey: (v: boolean) => void;
  styles: SettingsStyles;
}> = ({ form, setForm, showApiKey, setShowApiKey, styles }) => {
  const c = useClaudeTokens();
  const { fieldSx, descSx, labelSx } = styles;
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.25 }}>
        <Typography sx={labelSx}>Custom Providers</Typography>
        {(() => {
          const list = form.custom_providers || [];
          if (list.length === 0) return null;
          const readyCount = list.filter(cp => {
            const filled = (cp.models || []).filter(m => (m.value || '').trim()).length;
            return !!cp.name?.trim() && !!cp.base_url?.trim() && !!cp.api_key?.trim() && filled > 0;
          }).length;
          const allReady = readyCount === list.length;
          return (
            <Typography sx={{
              fontSize: '0.6rem',
              fontWeight: 600,
              color: allReady ? c.status.success : c.status.warning,
              bgcolor: allReady ? `${c.status.success}15` : `${c.status.warning}1F`,
              px: 0.75, py: 0.15, borderRadius: '3px',
            }}>
              {readyCount} OF {list.length} READY
            </Typography>
          );
        })()}
      </Box>
      <Typography sx={{ ...descSx, mb: 1.25 }}>
        Add OpenAI-compatible endpoints (Ollama Cloud, Together, Groq, local Ollama, anything that speaks /v1/chat/completions).
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {(form.custom_providers || []).map((cp, idx) => {
          const list = form.custom_providers || [];
          const updateProvider = (patch: Partial<CustomProvider>) => {
            const next = list.map((x, i) => (i === idx ? { ...x, ...patch } : x));
            setForm({ ...form, custom_providers: next });
          };
          const removeProvider = () => {
            const next = list.filter((_, i) => i !== idx);
            setForm({ ...form, custom_providers: next });
          };
          const addModel = () => {
            const nextModels = [...(cp.models || []), { value: '', label: '' }];
            updateProvider({ models: nextModels });
          };
          const updateModel = (mIdx: number, value: string) => {
            const nextModels = (cp.models || []).map((m, i) =>
              i === mIdx ? { ...m, value, label: value } : m
            );
            updateProvider({ models: nextModels });
          };
          const removeModel = (mIdx: number) => {
            const nextModels = (cp.models || []).filter((_, i) => i !== mIdx);
            updateProvider({ models: nextModels });
          };
          const filledModelCount = (cp.models || []).filter(m => (m.value || '').trim()).length;
          const nameMissing = !cp.name?.trim();
          const urlMissing = !cp.base_url?.trim();
          const modelsMissing = filledModelCount === 0;
          // api_key is optional (local LM Studio/Ollama/llama.cpp/vLLM run without auth); hosted providers need a real key.
          const isReady = !nameMissing && !urlMissing && !modelsMissing;
          const dupeNameWithEarlier = list.findIndex((other, i) =>
            i < idx && (other.name || '').trim().toLowerCase() === (cp.name || '').trim().toLowerCase() && (cp.name || '').trim() !== ''
          ) !== -1;
          const missingLabels: string[] = [];
          if (nameMissing) missingLabels.push('name');
          if (urlMissing) missingLabels.push('base URL');
          if (modelsMissing) missingLabels.push('a model');

          return (
            <Box
              key={idx}
              sx={{
                p: 1.5,
                borderRadius: `${c.radius.md}px`,
                border: `1px solid ${isReady ? c.status.success + '30' : c.status.warning + '40'}`,
                bgcolor: isReady ? `${c.status.success}04` : `${c.status.warning}06`,
                transition: 'all 0.2s ease',
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: -0.25 }}>
                <Typography sx={{
                  fontSize: '0.62rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase' as const,
                  color: isReady ? c.status.success : c.status.warning,
                  bgcolor: isReady ? `${c.status.success}15` : `${c.status.warning}1F`,
                  px: 0.75,
                  py: 0.2,
                  borderRadius: '3px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                }}>
                  <Box component="span" sx={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    bgcolor: isReady ? c.status.success : c.status.warning,
                  }} />
                  {isReady ? 'Ready' : `Incomplete, add ${missingLabels.join(', ')}`}
                </Typography>
                <IconButton
                  onClick={removeProvider}
                  size="small"
                  title="Remove provider"
                  sx={{
                    color: c.text.tertiary,
                    '&:hover': { color: c.status.error, bgcolor: `${c.status.error}10` },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                <TextField
                  value={cp.name || ''}
                  onChange={(e) => updateProvider({ name: e.target.value })}
                  size="small"
                  fullWidth
                  placeholder="e.g. Ollama Cloud"
                  label="Name"
                  required
                  error={dupeNameWithEarlier}
                  helperText={dupeNameWithEarlier ? 'Name must be unique' : undefined}
                  InputLabelProps={{ shrink: true, sx: { fontSize: '0.72rem', color: c.text.tertiary } }}
                  sx={fieldSx}
                />
                <TextField
                  value={cp.base_url || ''}
                  onChange={(e) => updateProvider({ base_url: e.target.value })}
                  size="small"
                  fullWidth
                  placeholder="https://ollama.com/v1"
                  label="Base URL"
                  required
                  InputLabelProps={{ shrink: true, sx: { fontSize: '0.72rem', color: c.text.tertiary } }}
                  sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
                />
                <TextField
                  type={showApiKey ? 'text' : 'password'}
                  value={cp.api_key || ''}
                  onChange={(e) => updateProvider({ api_key: e.target.value })}
                  size="small"
                  fullWidth
                  placeholder="Leave blank for local servers (LM Studio, Ollama, ...)"
                  label="API Key (optional)"
                  InputLabelProps={{ shrink: true, sx: { fontSize: '0.72rem', color: c.text.tertiary } }}
                  sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small" sx={{ color: c.text.tertiary }}>
                          {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 0.25 }}>
                <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                  Models
                </Typography>
                {((cp.models || []).length === 0) ? (
                  <Typography sx={{ fontSize: '0.7rem', color: c.text.muted, fontStyle: 'italic', px: 0.5 }}>
                    No models yet, add the model IDs this endpoint serves.
                  </Typography>
                ) : (
                  (cp.models || []).map((m, mIdx) => (
                    <Box key={mIdx} sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                      <TextField
                        value={m.value || ''}
                        onChange={(e) => updateModel(mIdx, e.target.value)}
                        size="small"
                        fullWidth
                        placeholder="e.g. gpt-oss:120b"
                        sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono, fontSize: '0.78rem' } }}
                      />
                      <IconButton
                        onClick={() => removeModel(mIdx)}
                        size="small"
                        title="Remove model"
                        sx={{
                          color: c.text.tertiary,
                          '&:hover': { color: c.status.error, bgcolor: `${c.status.error}10` },
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  ))
                )}
                <Button
                  onClick={addModel}
                  size="small"
                  sx={{
                    alignSelf: 'flex-start',
                    mt: 0.25,
                    textTransform: 'none',
                    color: c.accent.primary,
                    fontSize: '0.72rem',
                    minWidth: 'auto',
                    px: 0.75,
                    py: 0.25,
                    '&:hover': { bgcolor: `${c.accent.primary}10` },
                  }}
                >
                  + Add model
                </Button>
              </Box>
            </Box>
          );
        })}

        <Button
          onClick={() => {
            const next: CustomProvider[] = [
              ...(form.custom_providers || []),
              { name: '', base_url: '', api_key: '', models: [{ value: '', label: '' }] },
            ];
            setForm({ ...form, custom_providers: next });
          }}
          variant="outlined"
          size="small"
          sx={{
            alignSelf: 'flex-start',
            textTransform: 'none',
            color: c.text.primary,
            borderColor: c.border.medium,
            borderStyle: 'dashed',
            fontSize: '0.78rem',
            px: 1.5,
            py: 0.6,
            '&:hover': { borderColor: c.accent.primary, bgcolor: `${c.accent.primary}08` },
            transition: 'all 0.2s ease',
          }}
        >
          + Add Custom Provider
        </Button>
      </Box>
    </Box>
  );
};

export default CustomProvidersEditor;
