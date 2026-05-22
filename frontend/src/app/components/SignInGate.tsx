// Mandatory sign-in gate. Two paths to identity:
//
//   1. Continue with Google → cloud OAuth handoff (existing).
//      Opens https://api.openswarm.com/api/auth/google/start in the OS
//      browser; the cloud's bearer-handoff page POSTs the bearer back to
//      this desktop's local /api/auth/signin-activate. settings.user_id
//      flips non-null and the gate self-dismisses (SignInGateLoader's
//      poll picks up the change within ~2s).
//
//   2. Email magic link. Two-stage:
//        - Stage 1: user enters their email, we POST /api/auth/email/start.
//          Cloud mints a 6-digit code, stores its hash, sends it via Resend.
//        - Stage 2: user pastes the code, we POST /api/auth/email/verify.
//          On success the cloud upserts the users row, mints a bearer with
//          source='email', returns the same handoff shape as Google, and
//          the desktop's existing signin-activate path takes it from there.
//
// No password. Each sign-in (first or returning) requires reading a fresh
// code from the inbox. Slightly more friction than a stored-password fast
// path, but it eliminates the "someone with just my email signs in as me"
// worry and means there's no credential to store, leak, or rotate.
//
// No "Skip for now" — sign-in is mandatory.

import React, { useState } from 'react';
import {
  Box,
  Typography,
  Modal,
  Button,
  TextField,
  CircularProgress,
  Link,
} from '@mui/material';
import GoogleIcon from '@mui/icons-material/Google';
import EmailIcon from '@mui/icons-material/Email';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { OPENSWARM_DEFAULT_PROXY_URL, API_BASE } from '@/shared/config';
import { report } from '@/shared/serviceClient';

type Stage = 'choose' | 'email_form' | 'code_form';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignInGate(): JSX.Element {
  const tokens = useClaudeTokens();
  const proxyUrl = useAppSelector(
    (s) => s.settings.data.openswarm_proxy_url || OPENSWARM_DEFAULT_PROXY_URL,
  );
  const installId = useAppSelector((s) => s.settings.data.installation_id ?? '');

  const [stage, setStage] = useState<Stage>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const cloudBase = proxyUrl.replace(/\/$/, '');

  const activateSignin = async (token: string, email?: string | null): Promise<void> => {
    const res = await fetch(`${API_BASE}/auth/signin-activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        email: email ?? undefined,
        signin_method: 'google',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Local activate failed (${res.status})`);
    }
  };

  const resolveInstallId = async (): Promise<string> => {
    // Normal path (Electron + authenticated settings fetch).
    if (typeof installId === 'string' && installId.length >= 8 && installId.length <= 128) {
      return installId;
    }

    // Browser-only dev fallback: fetch a minimal public install-id route.
    try {
      const r = await fetch(`${API_BASE}/settings/install-id`);
      if (r.ok) {
        const data = (await r.json()) as { install_id?: string };
        if (
          typeof data.install_id === 'string' &&
          data.install_id.length >= 8 &&
          data.install_id.length <= 128
        ) {
          return data.install_id;
        }
      }
    } catch {
      // Fall through to local temporary ID.
    }

    // Last resort: keep sign-in usable even if the backend route is unreachable.
    const key = 'openswarm_install_id_fallback';
    try {
      const existing = window.localStorage.getItem(key) || '';
      if (existing.length >= 8 && existing.length <= 128) return existing;
      const fresh =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
      window.localStorage.setItem(key, fresh);
      return fresh;
    } catch {
      return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
    }
  };

  const onGoogle = async () => {
    report('signin', 'google_clicked');
    const resolvedInstallId = await resolveInstallId();
    const localPort = (window as any).__OPENSWARM_PORT__ || 8324;
    const params = new URLSearchParams({
      install_id: resolvedInstallId,
      local_port: String(localPort),
    });
    const startUrl = `${cloudBase}/api/auth/google/start?${params.toString()}`;
    const api = (window as any).openswarm;
    if (api?.openExternal) {
      api.openExternal(startUrl);
    } else {
      const popup = window.open(startUrl, 'openswarm-google-signin', 'width=560,height=720');
      const cloudOrigin = new URL(cloudBase).origin;
      let completed = false;

      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        if (popup && !popup.closed) popup.close();
      };

      const onMessage = async (event: MessageEvent) => {
        if (event.origin !== cloudOrigin) return;
        const payload = event.data;
        const callbackData = payload?.type === 'oauth_callback' ? payload.data : payload;
        const token = callbackData?.token || callbackData?.bearer || callbackData?.access_token;
        if (!token || completed) return;
        completed = true;
        try {
          await activateSignin(token, callbackData?.email || callbackData?.user_email || null);
          cleanup();
        } catch (err) {
          setErrMsg((err as Error).message || 'Sign-in failed.');
          cleanup();
        }
      };

      window.addEventListener('message', onMessage);
      window.setTimeout(() => {
        if (!completed) cleanup();
      }, 180000);
    }
  };

  const onSubmitEmail = async () => {
    setErrMsg(null);
    if (!EMAIL_REGEX.test(email.trim())) {
      setErrMsg('Enter a valid email address.');
      return;
    }
    setBusy(true);

    // "Failed to fetch" or 404 here means the cloud build doesn't have the
    // magic-link routes yet. Surface a single friendly hint instead of the
    // raw network error.
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
      const resolvedInstallId = await resolveInstallId();
      const localPort = (window as any).__OPENSWARM_PORT__ || 8324;
      const res = await fetch(`${cloudBase}/api/auth/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code,
          install_id: resolvedInstallId,
          local_port: localPort,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { bearer?: string; user_id?: string; user_email?: string };
      if (!data.bearer) throw new Error('Server did not return a bearer.');
      // Hand the bearer to the local backend the same way Google's
      // handoff page does, so the rest of the app converges identically.
      await fetch(`${API_BASE}/auth/signin-activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: data.bearer,
          email: data.user_email,
          signin_method: 'email',
        }),
      }).then(async (activate) => {
        if (!activate.ok) {
          const text = await activate.text().catch(() => '');
          throw new Error(text || `Local activate failed (${activate.status})`);
        }
      });
      // SignInGateLoader's polling picks up the new user_id within 2s
      // and unmounts this gate. Nothing else to do.
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
      disableEscapeKeyDown
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
