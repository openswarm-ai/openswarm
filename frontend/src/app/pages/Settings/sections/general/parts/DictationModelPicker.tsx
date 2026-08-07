import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import type { VoiceModel } from '@/types/electron';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// The speech model is the biggest speed/accuracy lever dictation has, so it is a real choice rather
// than a hidden constant. Picking one that isn't downloaded yet starts the fetch and shows progress;
// dictation keeps working on whatever model is already on disk until the new one lands.
const DictationModelPicker: React.FC<{
  value: string | null;
  onChange: (id: string) => void;
}> = ({ value, onChange }) => {
  const c = useClaudeTokens();
  const [models, setModels] = useState<VoiceModel[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [pct, setPct] = useState<number>(0);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.openswarm?.voiceModels?.();
    if (!res) return;
    setModels(res.models);
    setSelected(value || res.selected);
  }, [value]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while a download is actually running, so an idle Settings tab costs nothing.
  useEffect(() => {
    if (!downloadingId) return undefined;
    let live = true;
    const tick = async (): Promise<void> => {
      const st = await window.openswarm?.voiceStatus?.();
      if (!live) return;
      if (!st) { setDownloadingId(null); return; }
      setPct(st.pct || 0);
      if (st.error) { setError(st.error); setDownloadingId(null); return; }
      if (!st.downloading) { setDownloadingId(null); void refresh(); return; }
      window.setTimeout(() => { void tick(); }, 700);
    };
    void tick();
    return () => { live = false; };
  }, [downloadingId, refresh]);

  const pick = useCallback(async (id: string): Promise<void> => {
    setSelected(id);
    setError(null);
    onChange(id);
    const res = await window.openswarm?.voiceSetModel?.(id);
    if (res && !res.ready) { setPct(0); setDownloadingId(id); }
    else void refresh();
  }, [onChange, refresh]);

  if (!models.length) return null; // web build or no bridge: nothing to choose between

  return (
    <Box>
      <Select
        value={selected}
        onChange={(e) => { void pick(String(e.target.value)); }}
        size="small"
        sx={{
          minWidth: 230,
          fontSize: '0.8125rem',
          color: c.text.primary,
          '& .MuiOutlinedInput-notchedOutline': { borderColor: c.border.subtle },
        }}
      >
        {models.map((m) => (
          <MenuItem key={m.id} value={m.id} sx={{ fontSize: '0.8125rem' }}>
            {`${m.label} — ${m.sizeMb} MB${m.installed ? '' : ' (download)'}`}
          </MenuItem>
        ))}
      </Select>
      {downloadingId && (
        <Box sx={{ mt: 1 }}>
          <LinearProgress variant="determinate" value={pct} sx={{ height: 4, borderRadius: 2 }} />
          <Typography sx={{ fontSize: '0.6875rem', color: c.text.tertiary, mt: 0.5 }}>
            {`Downloading ${downloadingId}, ${pct}%`}
          </Typography>
        </Box>
      )}
      {error && (
        <Typography sx={{ fontSize: '0.6875rem', color: c.status?.error ?? c.text.tertiary, mt: 0.5 }}>
          {`Download failed (${error}). Pick it again to retry.`}
        </Typography>
      )}
    </Box>
  );
};

export default DictationModelPicker;
