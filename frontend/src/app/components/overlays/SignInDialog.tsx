// Optional sign-in dialog opened from Settings; Google OAuth handoff or email magic-link (6-digit code).

import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Modal,
  Button,
  TextField,
  CircularProgress,
  IconButton,
  Link,
} from '@mui/material';
import GoogleIcon from '@mui/icons-material/Google';
import EmailIcon from '@mui/icons-material/Email';
import CloseIcon from '@mui/icons-material/Close';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { activateSignin, fetchSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { OPENSWARM_DEFAULT_PROXY_URL } from '@/shared/config';
import { report } from '@/shared/serviceClient';

type Stage = 'choose' | 'email_form' | 'code_form';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignInDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const tokens = useClaudeTokens();
  const dispatch = useAppDispatch();
  const proxyUrl = useAppSelector(
    (s) => s.settings.data.openswarm_proxy_url || OPENSWARM_DEFAULT_PROXY_URL,
  );
  const installId = useAppSelector((s) => s.settings.data.installation_id ?? '');

  const [stage, setStage] = useState<Stage>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Google's handoff page POSTs the bearer to the local backend out-of-band; poll so the dialog notices.
  useEffect(() => {
    const id = setInterval(() => { dispatch(fetchSettings()); }, 2000);
    return () => clearInterval(id);
  }, [dispatch]);

  const cloudBase = proxyUrl.replace(/\/$/, '');

  const onGoogle = () => {
    report('signin', 'google_clicked');
    const localPort = (window as any).__OPENSWARM_PORT__ || 8324;
    const params = new URLSearchParams({
      install_id: installId,
      local_port: String(localPort),
    });
    const startUrl = `${cloudBase}/api/auth/google/start?${params.toString()}`;
    const api = (window as any).openswarm;
    if (api?.openExternal) {
      api.openExternal(startUrl);
    } else {
      window.open(startUrl, '_blank');
    }
  };

  const onSubmitEmail = async () => {
    setErrMsg(null);
    if (!EMAIL_REGEX.test(email.trim())) {
      setErrMsg('Enter a valid email address.');
      return;
    }
    setBusy(true);

    // 404/"Failed to fetch" = cloud build lacks magic-link routes; surface a friendly hint.
    const EMAIL_UNAVAILABLE_MSG =
      "Email sign-in isn't available on this build yet. Please use Continue with Google for now, or update OpenSwarm.";

    try {
      report('signin', 'email_start_submitted');
      let startRes: Response;
      try {
        startRes = await fetch(`${cloudBase}/api/auth/email/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
        });
      } catch (err) {
        report('signin', 'email_endpoint_unreachable', { phase: 'start', err: String(err) });
        setErrMsg(EMAIL_UNAVAILABLE_MSG);
        return;
      }
      if (startRes.status === 404) {
        report('signin', 'email_endpoint_not_deployed');
        setErrMsg(EMAIL_UNAVAILABLE_MSG);
        return;
      }
      if (!startRes.ok) {
        const text = await startRes.text().catch(() => '');
        report('signin', 'email_start_failed', { status: startRes.status });
        setErrMsg(text || "Couldn't send the code. Try again.");
        return;
      }
      setStage('code_form');
    } finally {
      setBusy(false);
    }
  };

  const onSubmitCode = async () => {
    setErrMsg(null);
    if (!/^\d{6}$/.test(code)) {
      setErrMsg('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      report('signin', 'email_verify_submitted');
      const localPort = (window as any).__OPENSWARM_PORT__ || 8324;
      const res = await fetch(`${cloudBase}/api/auth/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code,
          install_id: installId,
          local_port: localPort,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { bearer?: string; user_id?: string; user_email?: string };
      if (!data.bearer) throw new Error('Server did not return a bearer.');
      // Hand bearer to local backend like Google's handoff page; the settings refetch flips the account card, which unmounts us.
      await dispatch(
        activateSignin({
          token: data.bearer,
          email: data.user_email,
          signin_method: 'email',
        }),
      ).unwrap();
    } catch (err) {
      setErrMsg((err as Error).message || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const onResendCode = async () => {
    setStage('email_form');
    setCode('');
    setErrMsg(null);
  };

  return (
    <Modal
      open
      onClose={onClose}
      hideBackdrop={false}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      slotProps={{ backdrop: { sx: { backgroundColor: 'rgba(0,0,0,0.55)' } } }}
    >
      <Box
        sx={{
          position: 'relative',
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
        <IconButton
          size="small"
          onClick={onClose}
          aria-label="Close"
          sx={{ position: 'absolute', top: 10, right: 10, color: tokens.text.tertiary }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
        {stage === 'code_form' ? (
          <>
            <Typography
              variant="h5"
              sx={{ fontFamily: '"Charter", Georgia, serif', fontWeight: 500, mb: 1 }}
            >
              Check your inbox
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: tokens.text.muted, mb: 3, lineHeight: 1.5 }}
            >
              We emailed a 6-digit code to{' '}
              <Box component="span" sx={{ color: tokens.text.primary, fontWeight: 500 }}>
                {email}
              </Box>
              .
            </Typography>
            <TextField
              fullWidth
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputProps={{
                inputMode: 'numeric',
                maxLength: 6,
                style: {
                  textAlign: 'center',
                  letterSpacing: '0.4em',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 22,
                  fontWeight: 600,
                },
              }}
              placeholder="••••••"
              disabled={busy}
              sx={{ mb: 2 }}
            />
            {errMsg && (
              <Typography
                sx={{ color: tokens.status.error, fontSize: 13, mb: 1.5 }}
              >
                {errMsg}
              </Typography>
            )}
            <Button
              fullWidth
              variant="contained"
              size="large"
              onClick={onSubmitCode}
              disabled={busy || code.length !== 6}
              sx={{
                py: 1.4,
                backgroundColor: tokens.accent.primary,
                color: '#fff',
                textTransform: 'none',
                fontSize: 15,
                fontWeight: 600,
                '&:hover': { backgroundColor: tokens.accent.primary, opacity: 0.9 },
              }}
            >
              {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : 'Verify →'}
            </Button>
            <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', gap: 2 }}>
              <Link
                component="button"
                onClick={onResendCode}
                sx={{ fontSize: 12, color: tokens.text.muted, textDecoration: 'none' }}
              >
                Resend code
              </Link>
              <Link
                component="button"
                onClick={() => {
                  setStage('choose');
                  setEmail('');
                  setCode('');
                  setErrMsg(null);
                }}
                sx={{ fontSize: 12, color: tokens.text.muted, textDecoration: 'none' }}
              >
                Use a different email
              </Link>
            </Box>
          </>
        ) : (
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
              Sign in lets us sync your settings and back up your data.
            </Typography>

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

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                my: 2.5,
                color: tokens.text.muted,
                fontSize: 12,
              }}
            >
              <Box sx={{ flex: 1, height: 1, bgcolor: tokens.border.subtle }} />
              or
              <Box sx={{ flex: 1, height: 1, bgcolor: tokens.border.subtle }} />
            </Box>

            {stage === 'choose' ? (
              <Button
                fullWidth
                variant="outlined"
                size="large"
                startIcon={<EmailIcon />}
                onClick={() => setStage('email_form')}
                sx={{
                  py: 1.4,
                  borderColor: tokens.border.medium,
                  color: tokens.text.primary,
                  textTransform: 'none',
                  fontSize: 15,
                  fontWeight: 500,
                  '&:hover': { borderColor: tokens.text.primary },
                }}
              >
                Continue with email
              </Button>
            ) : (
              <Box sx={{ textAlign: 'left' }}>
                <TextField
                  fullWidth
                  autoFocus
                  type="email"
                  label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) onSubmitEmail();
                  }}
                  disabled={busy}
                  helperText="We'll email you a 6-digit code to sign in."
                  sx={{ mb: 1.5 }}
                  size="small"
                />
                {errMsg && (
                  <Typography
                    sx={{ color: tokens.status.error, fontSize: 13, mb: 1.2 }}
                  >
                    {errMsg}
                  </Typography>
                )}
                <Button
                  fullWidth
                  variant="contained"
                  size="large"
                  onClick={onSubmitEmail}
                  disabled={busy}
                  sx={{
                    py: 1.3,
                    backgroundColor: tokens.accent.primary,
                    color: '#fff',
                    textTransform: 'none',
                    fontSize: 14.5,
                    fontWeight: 600,
                    '&:hover': { backgroundColor: tokens.accent.primary, opacity: 0.9 },
                  }}
                >
                  {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : 'Send code →'}
                </Button>
                <Box sx={{ mt: 1.5, textAlign: 'center' }}>
                  <Link
                    component="button"
                    onClick={() => {
                      setStage('choose');
                      setErrMsg(null);
                    }}
                    sx={{ fontSize: 12, color: tokens.text.muted, textDecoration: 'none' }}
                  >
                    ← Back
                  </Link>
                </Box>
              </Box>
            )}
          </>
        )}
      </Box>
    </Modal>
  );
}
