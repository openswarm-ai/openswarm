import React, { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { API_BASE } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const TRUSTED_API = `${API_BASE}/tools/trusted-sensitive-paths`;

// Mirrors the backend _SENSITIVE_PATH_INFO mapping. Kept here intentionally
// (rather than fetched) because the user-facing label is the only part the
// settings page renders, and a static dictionary keeps the page snappy and
// works offline. If a pattern is unknown (older backend), fall back to the
// raw pattern string.
const PATTERN_LABELS: Record<string, string> = {
  '*/.ssh': 'SSH folder (~/.ssh)',
  '*/.ssh/*': 'SSH folder (~/.ssh)',
  '*/.aws/*': 'AWS credentials (~/.aws)',
  '*/.config/gcloud/*': 'Google Cloud credentials',
  '*/.kube/*': 'Kubernetes config (~/.kube)',
  '*/.gnupg/*': 'GPG encryption keys',
  '*/.docker/config*': 'Docker credentials',
  '*/.zshrc': 'Shell startup file (.zshrc)',
  '*/.bashrc': 'Shell startup file (.bashrc)',
  '*/.bash_profile': 'Shell startup file (.bash_profile)',
  '*/.profile': 'Shell startup file (.profile)',
  '*/.zprofile': 'Shell startup file (.zprofile)',
  '*/.zshenv': 'Shell environment file (.zshenv)',
  '*/.gitconfig': 'Global Git config',
  '*/.npmrc': 'npm auth file (~/.npmrc)',
  '*/.pypirc': 'PyPI auth file (~/.pypirc)',
  '*/.netrc': 'Stored login info (~/.netrc)',
  '*/Library/Keychains/*': 'macOS Keychain',
  '/etc/*': 'System config (/etc)',
  '/private/etc/*': 'System config (/etc)',
  '/System/*': 'macOS system folder',
  '/usr/local/etc/*': 'System config (/usr/local/etc)',
  '/etc/sudoers': 'Sudo permissions (/etc/sudoers)',
  '/etc/sudoers.d/*': 'Sudo permissions (/etc/sudoers.d)',
  '/etc/passwd': 'System user list (/etc/passwd)',
  '/etc/shadow': 'System password file (/etc/shadow)',
};

export const TrustedFilePatterns: React.FC = () => {
  const c = useClaudeTokens();
  const [patterns, setPatterns] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(TRUSTED_API);
      if (!res.ok) return;
      const data = await res.json();
      setPatterns(Array.isArray(data.patterns) ? data.patterns : []);
    } catch {
      setPatterns([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const revoke = useCallback(async (pat: string) => {
    if (!patterns) return;
    const next = patterns.filter((p) => p !== pat);
    setPatterns(next);
    try {
      await fetch(TRUSTED_API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: next }),
      });
    } catch {
      // On failure, reload from server so UI matches truth.
      load();
    }
  }, [patterns, load]);

  if (patterns === null) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
        Trusted file patterns
      </Typography>
      <Typography sx={{ fontSize: '0.8rem', color: c.text.secondary, lineHeight: 1.45 }}>
        Files like SSH keys and shell startup files normally ask before each write, even when you've set Write to "always allow". Patterns you've chosen to always allow appear below. Remove one to start asking again.
      </Typography>
      {patterns.length === 0 ? (
        <Typography sx={{ fontSize: '0.78rem', color: c.text.tertiary, fontStyle: 'italic', mt: 0.5 }}>
          No trusted patterns yet. You'll see a checkbox the first time the agent tries to write a sensitive file.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', mt: 0.5 }}>
          {patterns.map((pat, idx) => (
            <Box
              key={pat}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1,
                borderTop: idx === 0 ? 'none' : `1px solid ${c.border.subtle}`,
                bgcolor: c.bg.surface,
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.82rem', color: c.text.primary, fontWeight: 500 }}>
                  {PATTERN_LABELS[pat] || pat}
                </Typography>
                <Typography sx={{ fontSize: '0.72rem', color: c.text.tertiary, fontFamily: c.font.mono, mt: 0.15 }}>
                  {pat}
                </Typography>
              </Box>
              <IconButton
                size="small"
                onClick={() => revoke(pat)}
                aria-label={`Remove ${PATTERN_LABELS[pat] || pat}`}
                sx={{ color: c.text.tertiary, '&:hover': { color: c.status.error } }}
              >
                <DeleteOutlineIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default TrustedFilePatterns;
