import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { API_BASE } from '@/shared/config';

interface ManifestContents {
  dashboard?: { id: string; name: string };
  skills: Array<{ id: string; name: string }>;
  tools: Array<{ id: string; name: string; transport?: string }>;
  apps: Array<{ id: string; name: string; has_backend?: boolean }>;
  modes: Array<{ id: string; name: string }>;
}

interface RequiredEnvEntry {
  key: string;
  component_type: string;
  component_id: string;
  component_name: string;
  description: string;
}

interface Manifest {
  bundle: { name: string; description?: string | null };
  contents: ManifestContents;
  required_env: RequiredEnvEntry[];
  warnings: { executes_code: boolean; executes_code_reasons: string[] };
}

interface Conflict {
  type: string;
  id: string;
  name: string;
}

interface PreviewResponse {
  manifest: Manifest;
  conflicts: Conflict[];
}

interface Props {
  open: boolean;
  file: File | null;
  onClose: () => void;
  onInstalled: (newDashboardId: string) => void;
}

const ImportSwarmModal: React.FC<Props> = ({ open, file, onClose, onInstalled }) => {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open || !file) return;
    setPreview(null);
    setError(null);
    setEnvValues({});
    setResolutions({});
    (async () => {
      setLoading(true);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`${API_BASE}/portable/import/preview`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: res.statusText }));
          setError(err.detail || 'Failed to parse bundle');
        } else {
          setPreview(await res.json());
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, file]);

  const handleInstall = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('env', JSON.stringify(envValues));
      form.append('conflicts', JSON.stringify(resolutions));
      const res = await fetch(`${API_BASE}/portable/import/install`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        setError(err.detail || 'Install failed');
        return;
      }
      const data = await res.json();
      onInstalled(data.dashboard_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const m = preview?.manifest;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Import .swarm bundle</DialogTitle>
      <DialogContent dividers>
        {loading && !preview && <Typography>Reading bundle...</Typography>}
        {error && (
          <Typography sx={{ color: 'error.main', mb: 2 }}>{error}</Typography>
        )}
        {m && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>
              {m.bundle.name}
            </Typography>
            {m.bundle.description && (
              <Typography sx={{ mb: 2, color: 'text.secondary' }}>
                {m.bundle.description}
              </Typography>
            )}

            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              What's inside
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              <li>1 dashboard ({m.contents.dashboard?.name})</li>
              {m.contents.apps.length > 0 && <li>{m.contents.apps.length} apps</li>}
              {m.contents.skills.length > 0 && <li>{m.contents.skills.length} skills</li>}
              {m.contents.tools.length > 0 && <li>{m.contents.tools.length} tools</li>}
              {m.contents.modes.length > 0 && <li>{m.contents.modes.length} modes</li>}
            </Box>

            {m.warnings.executes_code && (
              <Box
                sx={{
                  mt: 2,
                  p: 2,
                  border: '1px solid',
                  borderColor: 'error.main',
                  borderRadius: 1,
                  bgcolor: 'error.main',
                  color: 'error.contrastText',
                }}
              >
                <Typography sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
                  <WarningAmberIcon fontSize="small" /> This bundle runs code on your machine
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2, mt: 1 }}>
                  {m.warnings.executes_code_reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </Box>
                <Typography sx={{ mt: 1, fontSize: '0.85rem' }}>
                  Only import from sources you trust.
                </Typography>
              </Box>
            )}

            {m.required_env.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                  Required credentials
                </Typography>
                {m.required_env.map((entry) => {
                  const k = `${entry.component_id}:${entry.key}`;
                  return (
                    <TextField
                      key={k}
                      fullWidth
                      size="small"
                      label={`${entry.key} (${entry.component_name})`}
                      helperText={entry.description}
                      type="password"
                      value={envValues[k] || ''}
                      onChange={(e) =>
                        setEnvValues((prev) => ({ ...prev, [k]: e.target.value }))
                      }
                      sx={{ mb: 1.5 }}
                    />
                  );
                })}
              </>
            )}

            {preview && preview.conflicts.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                  Conflicts
                </Typography>
                {preview.conflicts.map((c) => {
                  const k = `${c.type}:${c.id}`;
                  return (
                    <Box key={k} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      <Typography sx={{ flex: 1, fontSize: '0.875rem' }}>
                        {c.type}: {c.name}
                      </Typography>
                      <Select
                        size="small"
                        value={resolutions[k] || 'replace'}
                        onChange={(e) =>
                          setResolutions((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                      >
                        <MenuItem value="replace">Replace</MenuItem>
                        <MenuItem value="rename">Rename</MenuItem>
                        <MenuItem value="skip">Skip</MenuItem>
                      </Select>
                    </Box>
                  );
                })}
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleInstall}
          disabled={loading || !preview}
        >
          Install
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ImportSwarmModal;
