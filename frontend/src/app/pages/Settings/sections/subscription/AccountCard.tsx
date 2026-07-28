import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { signOut } from '@/shared/state/settingsSlice';
import { OPENSWARM_DEFAULT_PROXY_URL } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import SignInDialog from '@/app/components/overlays/SignInDialog';

/** Account card at top of General tab; three states: signed in, paid-but-unlinked, or not signed in. */
// Mirrors rowSx from settingsStyles. Duplicated rather than imported because AccountCard renders
// without the styles prop its neighbours receive; if that ever changes, take the shared one.
const accountRowSx = (c: ReturnType<typeof useClaudeTokens>) => ({
  py: 2,
  borderBottom: `1px solid ${c.border.subtle}`,
});

const AccountCard: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Narrow primitive selectors so unrelated settings edits (theme, etc.) don't re-render this card.
  const userEmail = useAppSelector((s) => s.settings.data.user_email ?? null);
  const userId = useAppSelector((s) => s.settings.data.user_id ?? null);
  const signinMethod = useAppSelector((s) => s.settings.data.signin_method ?? null);
  const hasBearer = useAppSelector((s) => Boolean(s.settings.data.openswarm_bearer_token));
  const installId = useAppSelector((s) => s.settings.data.installation_id ?? '');
  const proxyUrl = useAppSelector((s) => s.settings.data.openswarm_proxy_url || OPENSWARM_DEFAULT_PROXY_URL);
  const [signingOut, setSigningOut] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);

  const methodLabel = (() => {
    switch (signinMethod) {
      case 'google': return 'Signed in with Google';
      case 'email': return 'Signed in with email';
      case 'stripe': return 'Signed in via Stripe checkout';
      default: return null;
    }
  })();

  const onSignOut = async () => {
    setSigningOut(true);
    try {
      await dispatch(signOut()).unwrap();
    } catch (e) {
      console.error('Sign out failed:', e);
    } finally {
      setSigningOut(false);
    }
  };

  const onSignIn = () => {
    // Pass local_port so the bearer-handoff page POSTs to the right backend (Electron binds in 8324..8424).
    const localPort = (window as any).__OPENSWARM_PORT__ || 8324;
    const params = new URLSearchParams({
      install_id: installId,
      local_port: String(localPort),
    });
    const startUrl = proxyUrl.replace(/\/$/, '') + '/api/auth/google/start?' + params.toString();
    const api = (window as any).openswarm;
    if (api?.openExternal) api.openExternal(startUrl);
    else window.open(startUrl, '_blank');
  };

  // Not signed in at all (no bearer, no user_id); optional, sign-in just adds sync + backup.
  // Account used to be a bordered white card sitting directly above flat divider rows, so one page
  // carried two different ideas of what a settings row is. It reads as a flat row like everything
  // around it now; the sx mirrors rowSx from settingsStyles, which this file cannot import because
  // it is rendered without the styles prop.
  if (!userId && !hasBearer) {
    return (
      <Box sx={accountRowSx(c)}>
        <Typography sx={{ fontSize: c.font.size.base, color: c.text.primary, mb: 0.5 }}>Not signed in</Typography>
        <Typography sx={{ fontSize: c.font.size.xs, color: c.text.muted, mb: 1.25 }}>
          Sign in to sync settings across devices and back up your data.
        </Typography>
        <Button
          variant="outlined"
          size="small"
          onClick={() => setSignInOpen(true)}
          sx={{
            textTransform: 'none',
            fontSize: c.font.size.sm,
            borderColor: c.border.medium,
            color: c.text.primary,
            '&:hover': { borderColor: c.accent.primary, color: c.accent.primary, bgcolor: 'transparent' },
          }}
        >
          Sign in to OpenSwarm
        </Button>
        {/* Dialog unmounts on its own once sign-in lands and this branch flips to signed-in. */}
        {signInOpen && <SignInDialog onClose={() => setSignInOpen(false)} />}
      </Box>
    );
  }

  return (
    <Box sx={accountRowSx(c)}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: c.font.size.base, fontWeight: 600, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {userEmail || 'Signed in'}
          </Typography>
          {methodLabel && (
            <Typography sx={{ fontSize: c.font.size.xs, color: c.text.muted, mt: 0.25 }}>{methodLabel}</Typography>
          )}
          {!userId && hasBearer && (
            <Typography sx={{ fontSize: c.font.size.xs, color: c.text.muted, mt: 0.25 }}>
              Subscription connected. Sign in to also link this device to your account.
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {!userId && hasBearer && (
            <Button
              variant="outlined"
              size="small"
              onClick={onSignIn}
              sx={{
                textTransform: 'none',
                fontSize: c.font.size.xs,
                borderColor: c.border.medium,
                color: c.text.primary,
                '&:hover': { borderColor: c.accent.primary, color: c.accent.primary, bgcolor: 'transparent' },
              }}
            >
              Link account
            </Button>
          )}
          <Button
            variant="text"
            size="small"
            onClick={onSignOut}
            disabled={signingOut}
            sx={{
              textTransform: 'none',
              fontSize: c.font.size.xs,
              color: c.text.muted,
              '&:hover': { color: c.status.error, bgcolor: 'transparent' },
            }}
          >
            {signingOut ? <CircularProgress size={14} sx={{ color: c.text.muted }} /> : 'Sign out'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
};

export default AccountCard;
