// Sign-in gate. Shown at first launch (and to existing users past their
// soft-gate grace window) before any other UI mounts. Two paths:
//
//   1. "Continue with Google" → shell.openExternal opens the cloud's
//      /api/auth/google/start in the system browser. Cloud handles the
//      Google round-trip and serves a bearer-handoff page that POSTs the
//      token directly to the local backend (same pattern as Stripe).
//
//   2. "Send magic link" → POST /api/auth/email/start to the cloud (proxied
//      through the local backend so the renderer doesn't need cloud URL).
//      User clicks link in email, cloud verifies + serves the same
//      bearer-handoff page.
//
// Either way, after the bearer lands, settings.user_id flips to non-null
// and the gate self-dismisses (driven by SignInGateLoader).

import React, { useState } from 'react';
import {
  Box,
  Typography,
  Modal,
  Button,
  TextField,
  CircularProgress,
  Divider,
  Link,
} from '@mui/material';
import GoogleIcon from '@mui/icons-material/Google';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE, OPENSWARM_DEFAULT_PROXY_URL } from '@/shared/config';
import { report } from '@/shared/serviceClient';

interface SignInGateProps {
  /** Soft gate adds a "Skip for now" link; hard gate omits it. */
  softGate: boolean;
  onSkip?: () => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignInGate({ softGate, onSkip }: SignInGateProps): JSX.Element {
  const tokens = useClaudeTokens();
  const proxyUrl = useAppSelector(
    (s) => s.settings.data.openswarm_proxy_url || OPENSWARM_DEFAULT_PROXY_URL,
  );
  const installId = useAppSelector((s) => s.settings.data.installation_id ?? '');

  const [emailMode, setEmailMode] = useState(false);
  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const onGoogle = async () => {
    report('signin', 'google_clicked');
    const startUrl =
      proxyUrl.replace(/\/$/, '') +
      '/api/auth/google/start?install_id=' +
      encodeURIComponent(installId);
    const api = (window as any).openswarm;
    if (api?.openExternal) {
      api.openExternal(startUrl);
    } else {
      window.open(startUrl, '_blank');
    }
  };

  const onSendMagicLink = async () => {
    const trimmed = email.trim();
    if (!EMAIL_REGEX.test(trimmed)) {
      setEmailErr('That doesn’t look like an email address.');
      return;
    }
    setEmailErr(null);
    setSending(true);
    report('signin', 'magic_link_requested');
    try {
      // Local backend proxies to cloud /api/auth/email/start. The local
      // proxy doesn't exist yet — we POST directly to the cloud here. If
      // your install has openswarm_proxy_url overridden (staging), it'll
      // hit the right host.
      const url = proxyUrl.replace(/\/$/, '') + '/api/auth/email/start';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, install_id: installId }),
      });
      // Cloud always returns 200 even if rate-limited (no enumeration
      // leak). We mirror that here — show success regardless. If a real
      // delivery failure is happening it's in the cloud's logs, not user-
      // visible.
      if (r.ok || r.status === 200) {
        setEmailSent(true);
        setResendCooldown(30);
        const t = setInterval(() => {
          setResendCooldown((n) => {
            if (n <= 1) {
              clearInterval(t);
              return 0;
            }
            return n - 1;
          });
        }, 1000);
      } else {
        setEmailErr('Could not send the link. Try again in a moment.');
        report('signin', 'magic_link_failed', { status: r.status });
      }
    } catch (e) {
      setEmailErr('Network error. Check your connection and try again.');
      report('signin', 'magic_link_failed', { error: String(e).slice(0, 120) });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      disableEscapeKeyDown={!softGate}
      hideBackdrop={false}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      slotProps={{ backdrop: { sx: { backgroundColor: 'rgba(0,0,0,0.55)' } } }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 440,
          mx: 2,
          backgroundColor: tokens.bg.surface,
          color: tokens.text.primary,
          border: `1px solid ${tokens.border.subtle}`,
          borderRadius: 3,
          p: 4,
          textAlign: 'center',
          outline: 'none',
        }}
      >
        {!emailSent ? (
          <>
            <Typography
              variant="h5"
              sx={{ fontFamily: '"Charter", Georgia, serif', fontWeight: 500, mb: 1 }}
            >
              Sign in to OpenSwarm
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: tokens.text.muted, mb: 3, lineHeight: 1.5 }}
            >
              Sign in lets us sync your settings, back up your data, and stay in touch about updates.
            </Typography>

            {!emailMode ? (
              <>
                <Button
                  fullWidth
                  variant="contained"
                  size="large"
                  startIcon={<GoogleIcon />}
                  onClick={onGoogle}
                  sx={{
                    py: 1.4,
                    backgroundColor: tokens.text.primary,
                    color: tokens.text.inverse,
                    textTransform: 'none',
                    fontSize: 15,
                    fontWeight: 500,
                    '&:hover': { backgroundColor: tokens.text.primary, opacity: 0.9 },
                  }}
                >
                  Continue with Google
                </Button>

                <Divider sx={{ my: 2.5, color: tokens.text.muted, fontSize: 12 }}>or</Divider>

                <Button
                  fullWidth
                  variant="outlined"
                  size="large"
                  startIcon={<EmailOutlinedIcon />}
                  onClick={() => {
                    setEmailMode(true);
                    report('signin', 'email_mode_opened');
                  }}
                  sx={{
                    py: 1.4,
                    borderColor: tokens.border.subtle,
                    color: tokens.text.primary,
                    textTransform: 'none',
                    fontSize: 15,
                    fontWeight: 500,
                    '&:hover': { borderColor: tokens.text.primary, backgroundColor: 'transparent' },
                  }}
                >
                  Continue with email
                </Button>
              </>
            ) : (
              <>
                <TextField
                  fullWidth
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailErr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !sending) onSendMagicLink();
                  }}
                  error={Boolean(emailErr)}
                  helperText={emailErr ?? ' '}
                  autoFocus
                  disabled={sending}
                  sx={{ mb: 1 }}
                />
                <Button
                  fullWidth
                  variant="contained"
                  size="large"
                  onClick={onSendMagicLink}
                  disabled={sending || !email.trim()}
                  sx={{
                    py: 1.4,
                    backgroundColor: tokens.text.primary,
                    color: tokens.text.inverse,
                    textTransform: 'none',
                    fontSize: 15,
                    fontWeight: 500,
                    '&:hover': { backgroundColor: tokens.text.primary, opacity: 0.9 },
                  }}
                >
                  {sending ? <CircularProgress size={20} sx={{ color: tokens.bg.surface }} /> : 'Send sign-in link'}
                </Button>
                <Box sx={{ mt: 1.5 }}>
                  <Link
                    component="button"
                    onClick={() => {
                      setEmailMode(false);
                      setEmail('');
                      setEmailErr(null);
                    }}
                    sx={{ fontSize: 13, color: tokens.text.muted, textDecoration: 'none' }}
                  >
                    Back
                  </Link>
                </Box>
              </>
            )}
          </>
        ) : (
          <>
            <CheckCircleIcon sx={{ fontSize: 40, color: '#22c55e', mb: 1 }} />
            <Typography
              variant="h6"
              sx={{ fontFamily: '"Charter", Georgia, serif', fontWeight: 500, mb: 1 }}
            >
              Check your inbox
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: tokens.text.muted, mb: 3, lineHeight: 1.5 }}
            >
              We sent a sign-in link to <strong style={{ color: tokens.text.primary }}>{email}</strong>. Click it within 15 minutes to finish signing in. The link will open OpenSwarm automatically.
            </Typography>
            <Button
              fullWidth
              variant="text"
              disabled={resendCooldown > 0 || sending}
              onClick={() => {
                setEmailSent(false);
                onSendMagicLink();
              }}
              sx={{ color: tokens.text.muted, textTransform: 'none', fontSize: 13 }}
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Didn't get it? Resend"}
            </Button>
          </>
        )}

        {softGate && onSkip && !emailSent && (
          <Box sx={{ mt: 3, pt: 2, borderTop: `1px solid ${tokens.border.subtle}` }}>
            <Link
              component="button"
              onClick={() => {
                report('signin', 'gate_skipped');
                onSkip();
              }}
              sx={{ fontSize: 12, color: tokens.text.muted, textDecoration: 'none' }}
            >
              Skip for now — I'll sign in later
            </Link>
          </Box>
        )}
      </Box>
    </Modal>
  );
}
