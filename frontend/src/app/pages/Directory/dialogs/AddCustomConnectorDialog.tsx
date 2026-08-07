import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import Link from '@mui/material/Link';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { createTool, discoverTools } from '@/shared/state/toolsSlice';

interface Props {
  open: boolean;
  onClose: () => void;
  /** "get started with pre-built ones" jumps into the Directory's Connectors tab. */
  onBrowsePrebuilt?: () => void;
  onAdded?: (message: string, severity: 'success' | 'error') => void;
}

const fieldSx = (c: ReturnType<typeof useClaudeTokens>) => ({
  '& .MuiOutlinedInput-root': {
    bgcolor: c.bg.surface, borderRadius: `${c.radius.md}px`, fontSize: '0.9375rem',
    '& input': { py: 1.3 },
    '& fieldset': { borderColor: c.border.medium },
    '&:hover fieldset': { borderColor: c.border.strong },
    '&.Mui-focused fieldset': { borderColor: c.border.strong, borderWidth: 1 },
  },
});

// claude.ai's Add custom connector modal, phrasing kept identical; Add wires a remote http MCP tool
// and runs discovery immediately.
const AddCustomConnectorDialog: React.FC<Props> = ({ open, onClose, onBrowsePrebuilt, onAdded }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(''); setUrl(''); setClientId(''); setClientSecret(''); setAdvancedOpen(false); };

  const handleAdd = async () => {
    setBusy(true);
    try {
      const credentials: Record<string, string> = {};
      if (clientId.trim()) credentials.oauth_client_id = clientId.trim();
      if (clientSecret.trim()) credentials.oauth_client_secret = clientSecret.trim();
      const result = await dispatch(createTool({
        name: name.trim(),
        description: '',
        command: '',
        mcp_config: { type: 'http', url: url.trim() },
        credentials,
        auth_type: 'none',
        auth_status: 'configured',
      }));
      if (!createTool.fulfilled.match(result)) {
        onAdded?.(`Could not add ${name.trim()}`, 'error');
        return;
      }
      const discovered = await dispatch(discoverTools(result.payload.id));
      if (discoverTools.fulfilled.match(discovered)) {
        onAdded?.(`${name.trim()} connected, tools discovered`, 'success');
      } else {
        const detail = (discovered as { error?: { message?: string } }).error?.message || 'discovery failed';
        onAdded?.(`${name.trim()}: ${detail}`, 'error');
      }
      reset();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: '16px', border: `1px solid ${c.border.subtle}`, boxShadow: c.shadow.lg, p: 3.5 } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Typography sx={{ fontSize: '1.5rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.2 }}>
          Add custom connector
        </Typography>
        <IconButton size="small" onClick={onClose} sx={{ color: c.text.tertiary, mt: -0.5, mr: -1, '&:hover': { color: c.text.primary } }}>
          <CloseIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Box>

      <Typography sx={{ fontSize: '0.9375rem', color: c.text.secondary, mt: 1, lineHeight: 1.55 }}>
        Connect Claude to your data and tools.{' '}
        <Link href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer" sx={{ color: c.text.secondary, textDecorationColor: c.text.tertiary }}>
          Learn more about connectors
        </Link>{' '}
        or get started with{' '}
        <Link component="button" type="button" onClick={() => { onClose(); onBrowsePrebuilt?.(); }} sx={{ color: c.text.secondary, textDecorationColor: c.text.tertiary, verticalAlign: 'baseline' }}>
          pre-built ones
        </Link>.
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 2.5 }}>
        <TextField placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth sx={fieldSx(c)} />
        <TextField placeholder="Remote MCP server URL" value={url} onChange={(e) => setUrl(e.target.value)} fullWidth sx={fieldSx(c)} />
      </Box>

      <Box
        role="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 2.5, cursor: 'pointer', userSelect: 'none', width: 'fit-content' }}
      >
        {advancedOpen ? <KeyboardArrowUpIcon sx={{ fontSize: 18, color: c.text.secondary }} /> : <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.secondary }} />}
        <Typography sx={{ fontSize: '0.9375rem', fontWeight: 600, color: c.text.primary }}>Advanced settings</Typography>
      </Box>
      <Collapse in={advancedOpen}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1.5 }}>
          <TextField placeholder="OAuth Client ID (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)} fullWidth sx={fieldSx(c)} />
          <TextField placeholder="OAuth Client Secret (optional)" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} fullWidth sx={fieldSx(c)} />
        </Box>
      </Collapse>

      <Typography sx={{ fontSize: '0.875rem', color: c.text.tertiary, mt: 2.5, lineHeight: 1.55 }}>
        Only use connectors from developers you trust. Anthropic does not control which tools developers make available and cannot verify that they will work as intended or that they won't change.
      </Typography>

      <Typography sx={{ fontSize: '0.875rem', color: c.text.tertiary, mt: 1.5 }}>
        Building an MCP server?{' '}
        <Link href="https://github.com/modelcontextprotocol/modelcontextprotocol/issues" target="_blank" rel="noreferrer" sx={{ color: c.text.secondary, textDecorationColor: c.text.tertiary }}>
          Report issues and subscribe to updates here
        </Link>
      </Typography>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button
          onClick={onClose}
          sx={{
            textTransform: 'none', fontWeight: 600, fontSize: '0.9375rem', px: 2.25, py: 0.75,
            color: c.text.primary, border: `1px solid ${c.border.medium}`, borderRadius: `${c.radius.md}px`,
            '&:hover': { bgcolor: c.bg.secondary, borderColor: c.border.strong },
          }}
        >
          Cancel
        </Button>
        <Button
          onClick={() => { void handleAdd(); }}
          disabled={!name.trim() || !url.trim() || busy}
          sx={{
            textTransform: 'none', fontWeight: 600, fontSize: '0.9375rem', px: 2.5, py: 0.75,
            color: c.bg.surface, bgcolor: c.text.primary, borderRadius: `${c.radius.md}px`,
            '&:hover': { bgcolor: c.text.secondary },
            '&.Mui-disabled': { bgcolor: c.border.medium, color: c.bg.surface },
          }}
        >
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </Box>
    </Dialog>
  );
};

export default AddCustomConnectorDialog;
