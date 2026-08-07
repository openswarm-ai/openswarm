import React, { useEffect, useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { installCommunitySkill, CommunitySkill, InstallDisclosure } from '@/shared/state/skillRegistrySlice';

interface Props {
  skill: CommunitySkill | null;
  onClose: () => void;
  onInstalled: (name: string) => void;
}

// The Directory's community-install gate: skills.sh code is unvetted, so the + never installs blind.
// Same disclosure contract as the old CommunitySkillsDialog: files + scripts shown before anything lands.
const CommunityInstallConfirm: React.FC<Props> = ({ skill, onClose, onInstalled }) => {
  const c = useClaudeTokens();
  const [disclosure, setDisclosure] = useState<InstallDisclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    setDisclosure(null);
    setError(null);
    if (!skill) return;
    const seq = ++previewSeq.current;
    setBusy(true);
    void installCommunitySkill(skill.source, skill.skillId, false)
      .then((res) => { if (seq === previewSeq.current) setDisclosure(res.disclosure); })
      .catch((e: unknown) => { if (seq === previewSeq.current) setError(e instanceof Error ? e.message : 'Could not load skill'); })
      .finally(() => { if (seq === previewSeq.current) setBusy(false); });
  }, [skill]);

  const confirmInstall = async () => {
    if (!skill) return;
    setBusy(true);
    setError(null);
    try {
      await installCommunitySkill(skill.source, skill.skillId, true);
      onInstalled(disclosure?.name || skill.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Install failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!skill} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: '14px', border: `1px solid ${c.border.subtle}` } }}>
      <DialogTitle sx={{ color: c.text.primary, fontSize: '1.0625rem', fontWeight: 700, pb: 0.5 }}>
        Install community skill
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 180 }}>
        {error && <Alert severity="error" sx={{ fontSize: '0.8125rem' }}>{error}</Alert>}
        {busy && !disclosure && <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={22} /></Box>}
        {disclosure && (
          <>
            <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>{disclosure.name}</Typography>
            {disclosure.description && (
              <Typography sx={{ fontSize: '0.8125rem', color: c.text.secondary }}>{disclosure.description}</Typography>
            )}
            <Box
              component="a" href={disclosure.repo_url} target="_blank" rel="noreferrer"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: '0.75rem', color: c.accent.primary, textDecoration: 'none', fontFamily: c.font.mono }}>
              {skill?.source} <OpenInNewIcon sx={{ fontSize: 13 }} />
            </Box>

            <Alert severity="info" icon={<WarningAmberIcon fontSize="small" />} sx={{ fontSize: '0.75rem', py: 0 }}>
              This is an unvetted community skill. Its SKILL.md becomes instructions your agent will follow, and it can use your agent's tools (files, browser, settings). Only install from a source you trust, read it below first.
            </Alert>

            {disclosure.secret_findings.length > 0 && (
              <Alert severity="error" icon={<WarningAmberIcon fontSize="small" />} sx={{ fontSize: '0.75rem', py: 0 }}>
                {disclosure.secret_findings.length} file{disclosure.secret_findings.length === 1 ? '' : 's'} contain secret-shaped text ({disclosure.secret_findings.slice(0, 3).join(', ')}{disclosure.secret_findings.length > 3 ? '…' : ''}). A trustworthy skill shouldn't ship credentials; treat this as a red flag.
              </Alert>
            )}

            {disclosure.has_scripts && (
              <Alert severity="warning" icon={<WarningAmberIcon fontSize="small" />} sx={{ fontSize: '0.75rem', py: 0 }}>
                Includes {disclosure.scripts.length} script file{disclosure.scripts.length === 1 ? '' : 's'} that can run code when an agent uses this skill. Installing only writes the files; nothing runs until an agent does, and that still goes through normal command approval.
              </Alert>
            )}

            <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary, mt: 0.5 }}>
              {disclosure.files.length} file{disclosure.files.length === 1 ? '' : 's'} will be installed:
            </Typography>
            <Box sx={{ maxHeight: 120, overflow: 'auto', border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.sm}px`, p: 1 }}>
              {disclosure.files.map((f) => (
                <Typography key={f} sx={{ fontSize: '0.75rem', fontFamily: c.font.mono, color: disclosure.scripts.includes(f) ? c.status.warning : c.text.secondary }}>
                  {disclosure.scripts.includes(f) ? '⚙ ' : ''}{f}
                </Typography>
              ))}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ textTransform: 'none', color: c.text.tertiary }}>Cancel</Button>
        {disclosure && (
          <Button onClick={() => { void confirmInstall(); }} disabled={busy} variant="contained"
            sx={{ textTransform: 'none', bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed } }}>
            {busy ? 'Installing…' : 'Install skill'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default CommunityInstallConfirm;
