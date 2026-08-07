import React, { useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import Link from '@mui/material/Link';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { fetchSkills } from '@/shared/state/skillsSlice';
import { API_BASE } from '@/shared/config';

interface Props {
  open: boolean;
  onClose: () => void;
  onUploaded?: (name: string) => void;
}

// claude.ai's Upload skill modal, phrasing kept identical: a drop zone plus the two file rules.
const UploadSkillDialog: React.FC<Props> = ({ open, onClose, onUploaded }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const res = await fetch(`${API_BASE}/skills/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content_b64: btoa(binary) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { detail?: string }).detail || `Upload failed: ${res.status}`);
        return;
      }
      await dispatch(fetchSkills());
      onUploaded?.((data as { skill?: { name?: string } }).skill?.name || file.name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void upload(file);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: '16px', border: `1px solid ${c.border.subtle}`, boxShadow: c.shadow.lg, p: 3.5 } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 2.5 }}>
        <Typography sx={{ fontSize: '1.5rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.2 }}>
          Upload skill
        </Typography>
        <IconButton size="small" onClick={onClose} sx={{ color: c.text.tertiary, mt: -0.5, mr: -1, '&:hover': { color: c.text.primary } }}>
          <CloseIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Box>

      {error && <Alert severity="error" sx={{ fontSize: '0.8125rem', mb: 1.5 }}>{error}</Alert>}

      <Box
        onClick={() => inputRef.current?.click()}
        onDragOver={(e: React.DragEvent) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e: React.DragEvent) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        sx={{
          border: `1.5px dashed ${dragOver ? c.accent.primary : c.border.medium}`,
          borderRadius: '12px', py: 6, px: 3,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5,
          cursor: 'pointer', bgcolor: dragOver ? `${c.accent.primary}08` : 'transparent',
          transition: 'border-color 0.12s, background 0.12s',
          '&:hover': { borderColor: c.border.strong },
        }}
      >
        {busy ? (
          <CircularProgress size={28} sx={{ color: c.accent.primary }} />
        ) : (
          <CreateNewFolderOutlinedIcon sx={{ fontSize: 34, color: c.text.secondary }} />
        )}
        <Typography sx={{ fontSize: '1rem', color: c.text.secondary }}>
          Drag and drop or click to upload
        </Typography>
        <Box
          component="input"
          ref={inputRef}
          type="file"
          accept=".md,.zip,.skill"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => { handleFiles(e.target.files); e.target.value = ''; }}
          sx={{ display: 'none' }}
        />
      </Box>

      <Typography sx={{ fontSize: '0.875rem', color: c.text.tertiary, mt: 2.5 }}>File requirements</Typography>
      <Box component="ul" sx={{ m: 0, mt: 0.75, pl: 2.5, color: c.text.tertiary }}>
        <Typography component="li" sx={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
          .md file must contain skill name and description formatted in YAML
        </Typography>
        <Typography component="li" sx={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
          .zip or .skill file must include a SKILL.md file
        </Typography>
      </Box>

      <Typography sx={{ fontSize: '0.875rem', mt: 2 }}>
        <Link href="https://docs.claude.com/en/docs/agents-and-tools/agent-skills" target="_blank" rel="noreferrer" sx={{ color: c.text.secondary, textDecorationColor: c.text.tertiary }}>
          Read more about creating skills
        </Link>{' '}
        <Typography component="span" sx={{ fontSize: '0.875rem', color: c.text.tertiary }}>or</Typography>{' '}
        <Link href="https://github.com/anthropics/skills" target="_blank" rel="noreferrer" sx={{ color: c.text.secondary, textDecorationColor: c.text.tertiary }}>
          see an example
        </Link>
      </Typography>
    </Dialog>
  );
};

export default UploadSkillDialog;
