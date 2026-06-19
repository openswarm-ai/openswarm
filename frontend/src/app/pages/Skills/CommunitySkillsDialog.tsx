import React, { useEffect, useRef, useState, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  searchCommunitySkills,
  installCommunitySkill,
  CommunitySkill,
  InstallDisclosure,
} from '@/shared/state/skillRegistrySlice';

interface Props {
  open: boolean;
  onClose: () => void;
  onInstalled: (name: string) => void;
}

// The skills.sh wild registry is unvetted community code (skills can ship
// scripts). So this dialog never installs blind: picking a skill fetches a
// disclosure (files + scripts) the user confirms before anything lands on disk.
const CommunitySkillsDialog: React.FC<Props> = ({ open, onClose, onInstalled }) => {
  const c = useClaudeTokens();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CommunitySkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CommunitySkill | null>(null);
  const [disclosure, setDisclosure] = useState<InstallDisclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request tokens: a slow response from an earlier search/preview
  // must not overwrite the state a newer one already set (out-of-order network).
  const searchSeq = useRef(0);
  const previewSeq = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await searchCommunitySkills(q);
      if (seq !== searchSeq.current) return;
      setResults(res);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setError(e instanceof Error ? e.message : 'Search failed');
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query.trim()), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, runSearch]);

  useEffect(() => {
    if (!open) {
      setQuery(''); setResults([]); setSelected(null); setDisclosure(null); setError(null);
    }
  }, [open]);

  const preview = async (skill: CommunitySkill) => {
    const seq = ++previewSeq.current;
    setSelected(skill);
    setDisclosure(null);
    setBusy(true);
    setError(null);
    try {
      const res = await installCommunitySkill(skill.source, skill.skillId, false);
      if (seq !== previewSeq.current) return;
      setDisclosure(res.disclosure);
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setError(e instanceof Error ? e.message : 'Could not load skill');
      setSelected(null);
    } finally {
      if (seq === previewSeq.current) setBusy(false);
    }
  };

  const confirmInstall = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await installCommunitySkill(selected.source, selected.skillId, true);
      onInstalled(disclosure?.name || selected.name);
      setSelected(null);
      setDisclosure(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Install failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { bgcolor: c.bg.secondary, borderRadius: `${c.radius.md}px` } }}>
      <DialogTitle sx={{ color: c.text.primary, fontSize: '1rem', fontWeight: 700, pb: 0.5 }}>
        Browse community skills
        <Typography sx={{ fontSize: '0.78rem', color: c.text.tertiary, fontWeight: 400 }}>
          From the skills.sh registry. Community-published and unvetted; you'll see exactly what installs before it lands.
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 360 }}>
        {error && <Alert severity="error" sx={{ fontSize: '0.8rem' }}>{error}</Alert>}

        {!selected && (
          <>
            <TextField
              autoFocus
              placeholder="Search skills.sh (e.g. pdf, slides, video)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              size="small"
              InputProps={{ startAdornment: (<InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: c.text.tertiary }} /></InputAdornment>) }}
            />
            {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={22} /></Box>}
            {!loading && results.length === 0 && (
              <Typography sx={{ fontSize: '0.82rem', color: c.text.tertiary, textAlign: 'center', py: 3 }}>
                {query.trim() ? 'No matching skills.' : 'Type to search the community registry.'}
              </Typography>
            )}
            {!loading && results.map((s) => (
              <Box key={`${s.source}/${s.skillId}`}
                onClick={() => preview(s)}
                sx={{
                  px: 1.5, py: 1, borderRadius: `${c.radius.sm}px`, cursor: 'pointer',
                  border: `1px solid ${c.border.subtle}`,
                  '&:hover': { borderColor: c.accent.primary, bgcolor: `${c.accent.primary}08` },
                }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
                  <Typography sx={{ fontSize: '0.86rem', fontWeight: 600, color: c.text.primary }}>{s.name}</Typography>
                  <Chip label={`${s.installs.toLocaleString()} installs`} size="small"
                    sx={{ height: 18, fontSize: '0.66rem', bgcolor: c.bg.elevated, color: c.text.tertiary }} />
                </Box>
                <Typography sx={{ fontSize: '0.74rem', color: c.text.tertiary, fontFamily: c.font.mono }}>{s.source}</Typography>
              </Box>
            ))}
          </>
        )}

        {selected && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Button onClick={() => { previewSeq.current++; setSelected(null); setDisclosure(null); }} size="small"
              sx={{ alignSelf: 'flex-start', textTransform: 'none', color: c.text.tertiary, fontSize: '0.78rem' }}>
              ← Back to results
            </Button>
            {busy && !disclosure && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={22} /></Box>}
            {disclosure && (
              <>
                <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, color: c.text.primary }}>{disclosure.name}</Typography>
                {disclosure.description && (
                  <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary }}>{disclosure.description}</Typography>
                )}
                <Box
                  component="a" href={disclosure.repo_url} target="_blank" rel="noreferrer"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: '0.76rem', color: c.accent.primary, textDecoration: 'none', fontFamily: c.font.mono }}>
                  {selected.source} <OpenInNewIcon sx={{ fontSize: 13 }} />
                </Box>

                {disclosure.has_scripts && (
                  <Alert severity="warning" icon={<WarningAmberIcon fontSize="small" />} sx={{ fontSize: '0.78rem', py: 0 }}>
                    Includes {disclosure.scripts.length} script file{disclosure.scripts.length === 1 ? '' : 's'} that can run code when an agent uses this skill. Installing only writes the files; nothing runs until an agent does, and that still goes through normal command approval.
                  </Alert>
                )}

                <Typography sx={{ fontSize: '0.72rem', color: c.text.tertiary, mt: 0.5 }}>
                  {disclosure.files.length} file{disclosure.files.length === 1 ? '' : 's'} will be installed:
                </Typography>
                <Box sx={{ maxHeight: 120, overflow: 'auto', border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.sm}px`, p: 1 }}>
                  {disclosure.files.map((f) => (
                    <Typography key={f} sx={{ fontSize: '0.74rem', fontFamily: c.font.mono, color: disclosure.scripts.includes(f) ? c.status.warning : c.text.secondary }}>
                      {disclosure.scripts.includes(f) ? '⚙ ' : ''}{f}
                    </Typography>
                  ))}
                </Box>
              </>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ textTransform: 'none', color: c.text.tertiary }}>Close</Button>
        {selected && disclosure && (
          <Button onClick={confirmInstall} disabled={busy} variant="contained"
            sx={{ textTransform: 'none', bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.primary } }}>
            {busy ? 'Installing…' : 'Install skill'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default CommunitySkillsDialog;
