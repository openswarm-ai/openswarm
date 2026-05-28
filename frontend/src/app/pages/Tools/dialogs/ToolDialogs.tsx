import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import LinkIcon from '@mui/icons-material/Link';
import { McpServer } from '@/shared/state/mcpRegistrySlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';
import { ToolForm } from '../toolsHelpers';
import McpConfigDialog from './McpConfigDialog';

interface ToolDialogsProps {
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  editingId: string | null;
  form: ToolForm;
  setForm: React.Dispatch<React.SetStateAction<ToolForm>>;
  onSave: () => void;

  mcpConfigOpen: boolean;
  setMcpConfigOpen: (open: boolean) => void;
  mcpConfigServer: McpServer | null;
  mcpConfigJson: string;
  setMcpConfigJson: (json: string) => void;
  mcpConfigError: string;
  setMcpConfigError: (err: string) => void;
  mcpAuthType: 'none' | 'env_vars';
  setMcpAuthType: (val: 'none' | 'env_vars') => void;
  mcpCredentials: Record<string, string>;
  setMcpCredentials: (creds: Record<string, string>) => void;
  onMcpConfigSave: () => void;

  deviceCodeDialogOpen: boolean;
  setDeviceCodeDialogOpen: (open: boolean) => void;
  deviceCodeStatus: 'loading' | 'awaiting' | 'connected' | 'error';
  deviceCodeUrl: string;
  deviceCode: string;

  credDialogOpen: boolean;
  setCredDialogOpen: (open: boolean) => void;
  credDialogIntegration: Integration | null;
  credDialogValues: Record<string, string>;
  setCredDialogValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  credDialogSaving: boolean;
  onSlackAutoConnect: () => void;
  onCredentialsSave: () => void;
}

const ToolDialogs: React.FC<ToolDialogsProps> = ({
  dialogOpen, setDialogOpen, editingId, form, setForm, onSave: handleSave,
  mcpConfigOpen, setMcpConfigOpen, mcpConfigServer, mcpConfigJson, setMcpConfigJson,
  mcpConfigError, setMcpConfigError, mcpAuthType, setMcpAuthType, mcpCredentials, setMcpCredentials,
  onMcpConfigSave: handleMcpConfigSave,
  deviceCodeDialogOpen, setDeviceCodeDialogOpen, deviceCodeStatus, deviceCodeUrl, deviceCode,
  credDialogOpen, setCredDialogOpen, credDialogIntegration, credDialogValues, setCredDialogValues,
  credDialogSaving, onSlackAutoConnect: handleSlackAutoConnect, onCredentialsSave: handleCredentialsSave,
}) => {
  const c = useClaudeTokens();
  return (
    <>
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}>
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600 }}>{editingId ? 'Edit Tool' : 'New Tool'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} fullWidth size="small" sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }} />
          <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} fullWidth size="small" sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }} />
          <TextField label="Command (slash command name)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} fullWidth size="small" placeholder="e.g. my-tool" sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} disabled={!form.name} sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', borderRadius: 2 }}>{editingId ? 'Save Changes' : 'Create Tool'}</Button>
        </DialogActions>
      </Dialog>

      <McpConfigDialog
        open={mcpConfigOpen}
        onClose={() => setMcpConfigOpen(false)}
        mcpConfigServer={mcpConfigServer}
        mcpConfigJson={mcpConfigJson}
        setMcpConfigJson={setMcpConfigJson}
        mcpConfigError={mcpConfigError}
        setMcpConfigError={setMcpConfigError}
        mcpAuthType={mcpAuthType}
        setMcpAuthType={setMcpAuthType}
        mcpCredentials={mcpCredentials}
        setMcpCredentials={setMcpCredentials}
        onSave={handleMcpConfigSave}
      />

      <Dialog
        open={deviceCodeDialogOpen}
        onClose={() => { if (deviceCodeStatus !== 'loading') setDeviceCodeDialogOpen(false); }}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ width: 32, height: 32, borderRadius: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#0078D418' }}>
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M11.4 24H0V12.6L11.4 24zM24 24H12.6V12.6L24 24zM11.4 11.4H0V0l11.4 11.4zM24 11.4H12.6V0L24 11.4z" fill="#0078D4"/></svg>
          </Box>
          Connect Microsoft 365
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {deviceCodeStatus === 'loading' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 3, justifyContent: 'center' }}>
              <CircularProgress size={20} />
              <Typography sx={{ color: c.text.muted, fontSize: '0.9rem' }}>Generating login code...</Typography>
            </Box>
          )}
          {deviceCodeStatus === 'awaiting' && (
            <>
              <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.6 }}>
                Open the link below and enter the code to sign in:
              </Typography>
              <Box sx={{ bgcolor: c.bg.page, border: `1px solid ${c.border.subtle}`, borderRadius: 2, p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, alignItems: 'center' }}>
                <Typography component="a" href={deviceCodeUrl} target="_blank" rel="noopener" sx={{ color: c.status.info, fontSize: '0.9rem', fontWeight: 500 }}>
                  {deviceCodeUrl}
                </Typography>
                <Typography sx={{ fontFamily: c.font.mono, fontSize: '1.5rem', fontWeight: 700, color: c.text.primary, letterSpacing: 2 }}>
                  {deviceCode}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, justifyContent: 'center', py: 1 }}>
                <CircularProgress size={14} />
                <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem' }}>Waiting for you to sign in...</Typography>
              </Box>
            </>
          )}
          {deviceCodeStatus === 'connected' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2, justifyContent: 'center' }}>
              <CheckCircleIcon sx={{ color: c.status.success, fontSize: 20 }} />
              <Typography sx={{ color: c.status.success, fontSize: '0.9rem', fontWeight: 500 }}>Connected successfully!</Typography>
            </Box>
          )}
          {deviceCodeStatus === 'error' && (
            <Typography sx={{ color: c.status.error, fontSize: '0.85rem', py: 2, textAlign: 'center' }}>
              Login failed. Please try again.
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeviceCodeDialogOpen(false)} sx={{ color: c.text.muted, textTransform: 'none' }}>
            {deviceCodeStatus === 'connected' ? 'Done' : 'Cancel'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={credDialogOpen}
        onClose={() => setCredDialogOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {credDialogIntegration && (
            <Box sx={{
              width: 32, height: 32, borderRadius: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center',
              bgcolor: `${credDialogIntegration.color}18`, fontSize: '1rem', fontWeight: 700, color: credDialogIntegration.color,
            }}>
              {credDialogIntegration.icon}
            </Box>
          )}
          {credDialogIntegration?.connectLabel || 'Connect'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {credDialogIntegration?.id === 'slack' ? (
            <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.5, bgcolor: c.bg.secondary, px: 2, py: 1.5, borderRadius: 2, border: `1px solid ${c.border.subtle}` }}>
              Click <strong>Sign in with Slack</strong> below; a Slack window will open. Sign in normally and the window will close automatically once you reach your workspace.
            </Typography>
          ) : (
            <>
              {credDialogIntegration?.connectInstructions && (
                <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.5, bgcolor: c.bg.secondary, px: 2, py: 1.5, borderRadius: 2, border: `1px solid ${c.border.subtle}` }}>
                  {credDialogIntegration.connectInstructions}
                </Typography>
              )}
              {(credDialogIntegration?.credentialFields || []).map((field) => (
                <TextField
                  key={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  value={credDialogValues[field.key] || ''}
                  onChange={(e) => setCredDialogValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  fullWidth
                  size="small"
                  helperText={field.helpText}
                  sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page, fontFamily: c.font.mono, fontSize: '0.85rem' } }}
                />
              ))}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCredDialogOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={credDialogIntegration?.id === 'slack' ? handleSlackAutoConnect : handleCredentialsSave}
            disabled={credDialogSaving || (credDialogIntegration?.id !== 'slack' && (credDialogIntegration?.credentialFields || []).some((f) => !credDialogValues[f.key]?.trim()))}
            startIcon={credDialogSaving ? <CircularProgress size={14} /> : <LinkIcon sx={{ fontSize: 14 }} />}
            sx={{ bgcolor: credDialogIntegration?.color || c.accent.primary, '&:hover': { bgcolor: credDialogIntegration?.color || c.accent.pressed, filter: 'brightness(0.9)' }, textTransform: 'none', borderRadius: 2 }}
          >
            {credDialogIntegration?.id === 'slack' ? (credDialogSaving ? 'Waiting for sign-in…' : 'Sign in with Slack') : 'Connect'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default ToolDialogs;
