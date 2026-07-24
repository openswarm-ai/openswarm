import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import LinkIcon from '@mui/icons-material/Link';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RefreshIcon from '@mui/icons-material/Refresh';
import { API_BASE } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';

type Status = 'unknown' | 'connected' | 'disconnected';
const POLL_MS = 5000;
const MAX_POLLS = 24;

// Bare allowlist domain from the login URL (x.com, reddit.com, tiktok.com); www. is stripped so it matches the cookie bridge's allowlist.
function sessionDomain(loginUrl: string | undefined): string {
  if (!loginUrl) return '';
  try {
    return new URL(loginUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

interface Props {
  ig: Integration;
  isDisabled: boolean;
}

// "Sign in" affordance for the session-borrow MCPs (reddit/x/tiktok): opens the site's login in a
// browser card (via the app-wide anchor handler) and shows a live signed-in indicator driven by the
// cookie bridge. The sign-in is a real <a href>, so AppShell's document click handler navigates to a
// dashboard and opens the card, no duplicated open logic here.
const BrowserLoginConnect: React.FC<Props> = ({ ig, isDisabled }) => {
  const c = useClaudeTokens();
  const [status, setStatus] = useState<Status>('unknown');
  const domain = sessionDomain(ig.loginUrl);
  const alive = useRef(true);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async (): Promise<boolean> => {
    if (!domain) return false;
    try {
      // t= busts the renderer's 1s GET cache so the signed-in state is always live, not a stale hit.
      const res = await fetch(`${API_BASE}/browser-session/status?domain=${encodeURIComponent(domain)}&t=${Date.now()}`);
      const data = await res.json();
      const connected = !!data.connected;
      if (alive.current) setStatus(connected ? 'connected' : 'disconnected');
      return connected;
    } catch {
      if (alive.current) setStatus('disconnected');
      return false;
    }
  }, [domain]);

  useEffect(() => {
    alive.current = true;
    let n = 0;
    const stop = () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
    check();
    poll.current = setInterval(async () => {
      n += 1;
      const connected = await check();
      if (connected || n >= MAX_POLLS) stop();
    }, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [check]);

  if (isDisabled || !domain) return null;

  if (status === 'connected') {
    return (
      <Tooltip title="Re-check sign-in">
        <Chip
          icon={<CheckCircleIcon sx={{ fontSize: 12 }} />}
          label="Signed in"
          size="small"
          onClick={(e) => { e.stopPropagation(); check(); }}
          sx={{ bgcolor: c.status.successBg, color: c.status.success, fontSize: '0.6875rem', height: 22, '& .MuiChip-icon': { color: c.status.success }, flexShrink: 0 }}
        />
      </Tooltip>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      <Tooltip title={ig.connectInstructions || ''}>
        <Button
          component="a"
          href={ig.loginUrl}
          size="small"
          variant="outlined"
          startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
          sx={{ borderColor: `${ig.color}40`, color: ig.color, '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}10` }, textTransform: 'none', fontSize: '0.75rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
        >
          {ig.connectLabel || 'Sign in'}
        </Button>
      </Tooltip>
      <Tooltip title="Re-check sign-in">
        <IconButton size="small" onClick={(e) => { e.stopPropagation(); check(); }} sx={{ color: c.text.ghost }}>
          <RefreshIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default BrowserLoginConnect;
