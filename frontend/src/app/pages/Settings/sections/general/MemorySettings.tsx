import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Switch from '@mui/material/Switch';
import IconButton from '@mui/material/IconButton';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { AppSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';

interface MemoryFact {
  id: string;
  text: string;
  source: string;
  updated_at: string;
}

/** What agents know about you: every fact visible, editable, deletable; nothing hidden. */
const MemorySettings: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const { inlineRowSx, labelSx, descSx } = styles;
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const refresh = async (): Promise<void> => {
    try {
      // no-store: Chromium happily serves a cached list, which hides facts the distiller just added.
      const res = await fetch(`${API_BASE}/memory`, { cache: 'no-store' });
      if (res.ok) setFacts(((await res.json()) as { facts: MemoryFact[] }).facts);
    } catch { /* backend down reads as an empty list, never a crash */ }
  };
  useEffect(() => { void refresh(); }, []);

  const add = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await fetch(`${API_BASE}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    void refresh();
  };

  const saveEdit = async (): Promise<void> => {
    if (!editingId) return;
    const text = editText.trim();
    setEditingId(null);
    if (!text) return;
    await fetch(`${API_BASE}/memory/${editingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    void refresh();
  };

  const remove = async (id: string): Promise<void> => {
    await fetch(`${API_BASE}/memory/${id}`, { method: 'DELETE' });
    void refresh();
  };

  const inputSx = {
    width: '100%',
    px: 1.25,
    py: 0.7,
    borderRadius: '8px',
    border: `1px solid ${c.border.subtle}`,
    background: c.bg.surface,
    color: c.text.primary,
    fontSize: '0.8438rem',
    fontFamily: 'inherit',
    outline: 'none',
    '&:focus': { borderColor: c.accent.primary },
  } as const;

  return (
    <>
      <Box sx={inlineRowSx} {...settingSelectAttrs('memory_enabled', 'Memory', 'Interface', 'Whether agents see your saved facts.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Memory</Typography>
          <Typography sx={descSx}>Agents remember these facts in every chat. Off means none of them reach any model.</Typography>
        </Box>
        <Switch size="small" checked={form.memory_enabled !== false} onChange={(e) => setForm({ ...form, memory_enabled: e.target.checked })} />
      </Box>

      <Box sx={{ ...inlineRowSx, alignItems: 'flex-start', flexDirection: 'column', gap: 1.25 }}>
        <Box>
          <Typography sx={labelSx}>What agents know about you</Typography>
          <Typography sx={descSx}>Add facts yourself, fix wrong ones, delete anything. This list is the whole memory; there is nothing hidden behind it.</Typography>
        </Box>
        <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          {facts.length === 0 && (
            <Typography sx={{ color: c.text.ghost, fontSize: '0.8125rem', py: 0.5 }}>Nothing saved yet.</Typography>
          )}
          {facts.map((fact) => (
            <Box key={fact.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.4, borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' }, '&:hover .osw-mem-del': { opacity: 1 } }}>
              {editingId === fact.id ? (
                <Box
                  component="input"
                  autoFocus
                  value={editText}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditText(e.target.value)}
                  onBlur={() => void saveEdit()}
                  onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') void saveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                  sx={inputSx}
                />
              ) : (
                <Typography
                  onClick={() => { setEditingId(fact.id); setEditText(fact.text); }}
                  sx={{ flex: 1, color: c.text.primary, fontSize: '0.8438rem', cursor: 'text', py: 0.3 }}
                >
                  {fact.text}
                </Typography>
              )}
              {fact.source === 'distilled' && (
                <Typography sx={{ color: c.text.ghost, fontSize: '0.6875rem', flexShrink: 0 }}>learned</Typography>
              )}
              <IconButton className="osw-mem-del" size="small" onClick={() => void remove(fact.id)} sx={{ opacity: 0, transition: 'opacity 0.12s', color: c.text.ghost, '&:hover': { color: c.status.error } }}>
                <DeleteOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Box>
          ))}
          <Box
            component="input"
            value={draft}
            placeholder="Add a fact agents should always know (Enter to save)"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') void add(); }}
            sx={{ ...inputSx, mt: 1 }}
          />
        </Box>
      </Box>
    </>
  );
};

export default MemorySettings;
