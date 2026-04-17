import React, { useState, useEffect, useRef } from 'react';
import { Box, Typography, Modal, Button, CircularProgress, TextField, InputAdornment } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import { trackEvent } from '@/shared/analytics';
import PlanPicker from '@/app/components/PlanPicker';

// Email validation: format check + typo correction for common domains.
// Real ownership verification is intentionally pushed downstream (mailing list /
// CRM system handles the confirm-subscription flow).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const COMMON_DOMAIN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outloook.com': 'outlook.com',
  'iclould.com': 'icloud.com',
  'iclud.com': 'icloud.com',
  'protonmial.com': 'protonmail.com',
};

function getEmailSuggestion(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  const correction = COMMON_DOMAIN_TYPOS[domain];
  if (!correction) return null;
  return email.slice(0, at + 1) + correction;
}

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

const SUBSCRIPTION_PROVIDERS = [
  { id: 'openswarm-pro', name: 'OpenSwarm Pro', desc: 'One subscription — no setup, no Claude account needed', color: '#6366F1', preview: false, recommended: true },
  { id: 'claude', name: 'Claude', desc: 'Use your own Claude Pro/Max subscription', color: '#E8927A', preview: false },
  { id: 'gemini-cli', name: 'Gemini', desc: 'Gemini 3 Pro, 3 Flash, 2.5 Pro & Flash', color: '#4285F4', preview: false },
  { id: 'codex', name: 'ChatGPT', desc: 'GPT-5.4, GPT-5.4 Mini, GPT-5.3 Codex', color: '#74AA9C', preview: false },
];

const EDUCATION_STEPS: { title: string; body: string[] }[] = [
  {
    title: 'Launch an Agent',
    body: [
      'The core functionality of OpenSwarm revolves around Agents. Click the "+" button in your toolbar to launch a new Agent. Agents can take actions for you, work with files on your computer, and much more.',
      'Within an Agent\u2019s input, you can choose what AI model powers it, the mode it runs in, and attach context via "@" and "/" commands.',
    ],
  },
  {
    title: 'Connect your actions',
    body: [
      'Actions are how your Agents interact with the outside world \u2014 Gmail, Google Calendar, Notion, Slack, and more. Head to the Connections page to link your accounts and unlock what your Agents can do.',
      'Once connected, your Agents can read emails, create events, update databases, and take real actions across your tools \u2014 all from a single conversation.',
    ],
  },
  {
    title: 'Browsers',
    body: [
      'OpenSwarm has built-in browsers so you never have to jump between apps. Stay in one place, stay in the zone \u2014 just one seamless workspace for you and your Agents.',
      "And when you'd rather not do it yourself, let an Agent open & control browsers, navigate sites, fill out forms, and complete tasks end-to-end while you watch it happen in real time.",
    ],
  },
  {
    title: 'Select and send',
    body: [
      "Select any existing browser or agent in your dashboard to let a new agent control it. It's the fastest way to get things done \u2014 just select something on your dashboard and let your Agent handle the rest.",
      'No copy-pasting, no context-switching. Just select, send, and let your Agent take it from there.',
    ],
  },
  {
    title: 'Make it yours',
    body: [
      'Customize how OpenSwarm works with Skills, Modes, and Apps. Skills teach your Agents reusable workflows. Modes let you switch between different behavior profiles. Apps are standalone applications that run directly in OpenSwarm that Agents build for you.',
      'Explore the Customization & Apps sections in the sidebar to get started \u2014 or just ask an Agent to help you create your first Skill.',
    ],
  },
];

const USE_CASES = [
  'Software Development',
  'Research & Analysis',
  'Content & Writing',
  'Data & Analytics',
  'Automation & Workflows',
  'Design & Creative',
  'Sales & Outreach',
  'Customer Support',
  'Marketing',
  'Education & Learning',
  'Personal Assistant',
  'Other',
];

const REFERRAL_SOURCES = [
  'Twitter / X',
  'LinkedIn',
  'YouTube',
  'TikTok',
  'Reddit',
  'Hacker News',
  'GitHub',
  'Friend / Word of mouth',
  'Search engine',
  'Blog / Article',
  'Other',
];

const OnboardingModal: React.FC = () => {
  const c = useClaudeTokens();
  const settings = useAppSelector((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'profile' | 'walkthrough' | 'connect' | 'pricing'>('profile');
  const [walkthroughIdx, setWalkthroughIdx] = useState(0);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [useCases, setUseCases] = useState<string[]>([]);
  const [useCaseOther, setUseCaseOther] = useState<string>('');
  const [referralSource, setReferralSource] = useState<string>('');
  const [referralSourceOther, setReferralSourceOther] = useState<string>('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [nineRouterReady, setNineRouterReady] = useState<boolean | null>(null);
  const pollTimerRef = useRef<any>(null);
  const msgHandlerRef = useRef<any>(null);

  // Poll for 9Router readiness (it may still be starting when onboarding shows)
  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 15; // 30 seconds
    const check = () => {
      const alreadySeen = localStorage.getItem('openswarm_onboarding_seen');
      fetch(`${API_BASE}/agents/subscriptions/status`)
        .then((r) => r.json())
        .then((data) => {
          if (data.running) {
            // Skip onboarding only if already seen AND has active subscription
            const connections = data.providers?.connections || [];
            if (alreadySeen === 'true' && connections.some((p: any) => p.isActive)) {
              return;
            }
            // Delay before marking ready — 9Router's OAuth needs time to warm up
            setTimeout(() => setNineRouterReady(true), 3000);
          } else {
            attempts++;
            if (attempts < maxAttempts) {
              setTimeout(check, 2000);
            } else {
              setNineRouterReady(false);
            }
          }
        })
        .catch(() => {
          attempts++;
          if (attempts < maxAttempts) setTimeout(check, 2000);
          else setNineRouterReady(false); // Still show onboarding even if 9Router isn't available
        });
    };
    check();
  }, []);

  // Show once: if not previously dismissed
  useEffect(() => {
    const alreadySeen = localStorage.getItem('openswarm_onboarding_seen');
    if (alreadySeen === 'true') return;
    if (nineRouterReady === null) return; // still checking

    setOpen(true);
    trackEvent('onboarding.started', { step: 'profile' });
  }, [nineRouterReady]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (msgHandlerRef.current) window.removeEventListener('message', msgHandlerRef.current);
    };
  }, []);

  // Auto-dismiss ONLY on the inactive → active transition (i.e. Stripe
  // checkout deep-link activation while the modal is open). We used to fire
  // on any settings tick where Pro was active, which meant a returning user
  // who already had Pro (but cleared onboarding_seen) would see the modal
  // flash then immediately skip to the dashboard.
  const initialProActiveRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!open) { initialProActiveRef.current = null; return; }
    const mode = (settings.data as any).connection_mode;
    const bearer = (settings.data as any).openswarm_bearer_token;
    const isActive = mode === 'openswarm-pro' && !!bearer;
    if (initialProActiveRef.current === null) {
      initialProActiveRef.current = isActive;
      return;
    }
    if (!initialProActiveRef.current && isActive) {
      trackEvent('onboarding.openswarm_pro_activated');
      dismiss();
    }
    // dismiss is stable enough — don't include in deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings.data]);

  const dismiss = async () => {
    localStorage.setItem('openswarm_onboarding_seen', 'true');
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(null);

    // Create a demo dashboard with a pre-populated example agent
    try {
      const createRes = await fetch(`${API_BASE}/dashboards/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Getting Started' }),
      });
      if (createRes.ok) {
        const dashboard = await createRes.json();
        if (dashboard?.id) {
          const seedRes = await fetch(`${API_BASE}/dashboards/${dashboard.id}/seed-demo`, { method: 'POST' });
          if (seedRes.ok) {
            trackEvent('onboarding.completed', { dashboard_id: dashboard.id });
            localStorage.setItem('openswarm_walkthrough_pending', 'true');
            setOpen(false);
            // Force full page load to ensure dashboard mounts fresh with walkthrough
            window.location.href = `${window.location.pathname}${window.location.search}#/dashboard/${dashboard.id}`;
            window.location.reload();
            return;
          }
        }
      }
    } catch (e) {
      console.warn('Demo dashboard creation failed:', e);
    }

    setOpen(false);
  };

  // Actually persist profile + advance to connect step.
  const submitProfile = async () => {
    try {
      const r = await fetch(`${API_BASE}/settings`);
      const currentSettings = await r.json();
      // If "Other" is selected, replace it with the user's custom text
      const resolvedUseCases = useCases.map((u) =>
        u === 'Other' && useCaseOther.trim() ? `Other: ${useCaseOther.trim()}` : u
      );
      const resolvedReferralSource =
        referralSource === 'Other' && referralSourceOther.trim()
          ? `Other: ${referralSourceOther.trim()}`
          : referralSource;
      await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...currentSettings,
          user_name: userName.trim() || null,
          user_email: userEmail.trim() || null,
          user_use_case: resolvedUseCases.length > 0 ? resolvedUseCases.join(', ') : null,
          user_referral_source: resolvedReferralSource || null,
        }),
      });
    } catch {}
    trackEvent('onboarding.profile_submitted', {
      has_name: !!userName.trim(),
      has_email: !!userEmail.trim(),
      use_cases: useCases,
      use_cases_count: useCases.length,
      use_case_other: useCases.includes('Other') ? useCaseOther.trim() : '',
      referral_source: referralSource,
      referral_source_other: referralSource === 'Other' ? referralSourceOther.trim() : '',
    });
    setStep('walkthrough');
    setWalkthroughIdx(0);
    trackEvent('onboarding.education_started');
  };

  const advanceWalkthrough = () => {
    const next = walkthroughIdx + 1;
    const currentTitle = EDUCATION_STEPS[walkthroughIdx]?.title;
    if (next >= EDUCATION_STEPS.length) {
      trackEvent('onboarding.education_completed');
      setStep('connect');
      trackEvent('onboarding.connect_started', { nine_router_ready: nineRouterReady });
      return;
    }
    trackEvent('onboarding.education_step_advanced', { from: walkthroughIdx, title: currentTitle });
    setWalkthroughIdx(next);
  };

  const backWalkthrough = () => {
    setWalkthroughIdx((i) => Math.max(0, i - 1));
  };

  // Whether all required profile fields are filled in.
  const isProfileComplete = (() => {
    const trimmedName = userName.trim();
    const trimmedEmail = userEmail.trim();
    if (!trimmedName) return false;
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) return false;
    if (useCases.length === 0) return false;
    if (useCases.includes('Other') && !useCaseOther.trim()) return false;
    if (!referralSource) return false;
    if (referralSource === 'Other' && !referralSourceOther.trim()) return false;
    return true;
  })();

  // Continue: gate on full profile completion, then submit.
  const handleProfileContinue = async () => {
    const trimmed = userEmail.trim();
    // Invalid format with non-empty value — refuse and force error state.
    if (trimmed && !isValidEmail(trimmed)) {
      setEmailBlurred(true);
      trackEvent('onboarding.email_invalid_blocked', { value_length: trimmed.length });
      return;
    }
    if (!isProfileComplete) return;
    submitProfile();
  };

  const handleApplySuggestion = (suggested: string) => {
    setUserEmail(suggested);
    trackEvent('onboarding.email_suggestion_applied');
  };

  // Same connect logic as Settings/SubscriptionCards
  const handleConnect = async (providerId: string) => {
    // Cancel any previous attempt
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
    setConnecting(providerId);
    trackEvent('onboarding.provider_selected', { provider: providerId });

    // OpenSwarm Pro: switch to the dedicated pricing step so the user can
    // pick a tier + billing interval before heading to Stripe. The
    // post-payment openswarm://auth deep link will dismiss this modal
    // automatically via useDeepLink → fetchSettings.
    if (providerId === 'openswarm-pro') {
      setConnecting(null);
      setStep('pricing');
      return;
    }

    // Delay before calling connect — avoids Claude OAuth rate limit on retries
    await new Promise(r => setTimeout(r, 1000));

    try {
      const r = await fetch(`${API_BASE}/agents/subscriptions/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!r.ok) {
        setConnecting(null);
        return;
      }
      const data = await r.json();

      if (data.flow === 'device_code') {
        if (data.verification_uri) window.open(data.verification_uri, '_blank');

        const timer = setInterval(async () => {
          try {
            const pr = await fetch(`${API_BASE}/agents/subscriptions/poll`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: providerId,
                device_code: data.device_code,
                code_verifier: data.code_verifier,
                extra_data: data.extra_data,
              }),
            });
            const pd = await pr.json();
            if (pd.success) {
              clearInterval(timer);
              pollTimerRef.current = null;
              trackEvent('onboarding.provider_connected', { provider: providerId });
              dismiss();
            }
          } catch {}
        }, 5000);
        pollTimerRef.current = timer;
        setTimeout(() => { clearInterval(timer); pollTimerRef.current = null; setConnecting(null); }, 30000);

      } else if (data.flow === 'authorization_code') {
        const popup = window.open(data.auth_url, 'oauth_connect', 'width=600,height=700');

        // Poll status as primary detection (works in Electron where postMessage may not)
        const statusPoller = setInterval(async () => {
          try {
            const sr = await fetch(`${API_BASE}/agents/subscriptions/status`);
            const sd = await sr.json();
            const connections = sd.providers?.connections || [];
            if (connections.some((p: any) => p.provider === providerId && p.isActive)) {
              clearInterval(statusPoller);
              pollTimerRef.current = null;
              if (msgHandlerRef.current) {
                window.removeEventListener('message', msgHandlerRef.current);
                msgHandlerRef.current = null;
              }
              trackEvent('onboarding.provider_connected', { provider: providerId });
              dismiss();
            }
          } catch {}
        }, 2000);
        pollTimerRef.current = statusPoller;

        // Also listen for postMessage from callback page (faster when it works)
        const msgHandler = async (event: MessageEvent) => {
          const d = event.data;
          const callbackData = d?.type === 'oauth_callback' ? d.data : d;
          if (callbackData?.code) {
            window.removeEventListener('message', msgHandler);
            msgHandlerRef.current = null;
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
            if (popup && !popup.closed) popup.close();
            try {
              await fetch(`${API_BASE}/agents/subscriptions/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  provider: providerId,
                  code: callbackData.code,
                  redirect_uri: data.redirect_uri,
                  code_verifier: data.code_verifier,
                  state: callbackData.state || data.state,
                }),
              });
            } catch {}
            trackEvent('onboarding.provider_connected', { provider: providerId });
            dismiss();
          }
        };
        window.addEventListener('message', msgHandler);
        msgHandlerRef.current = msgHandler;

        setTimeout(() => {
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
          if (msgHandlerRef.current) { window.removeEventListener('message', msgHandlerRef.current); msgHandlerRef.current = null; }
          setConnecting(null);
        }, 30000);

      } else {
        setConnecting(null);
      }
    } catch {
      setConnecting(null);
    }
  };

  const handleApiKey = () => { trackEvent('onboarding.api_key_chosen'); dismiss(); };
  const handleSkip = () => {
    trackEvent(step === 'profile' ? 'onboarding.profile_skipped' : 'onboarding.connect_skipped');
    dismiss();
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={step === 'connect' ? handleSkip : undefined} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Box sx={{
        width: step === 'walkthrough' ? 600 : step === 'pricing' ? 780 : 480, maxWidth: '90vw',
        bgcolor: c.bg.surface, borderRadius: `${c.radius.xl}px`,
        border: `1px solid ${c.border.subtle}`,
        p: step === 'walkthrough' ? 0 : 3.5, outline: 'none',
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        {step !== 'walkthrough' && (
          <Typography sx={{ fontSize: '1.5rem', fontWeight: 700, color: c.text.primary, mb: 0.5, textAlign: 'center' }}>
            Welcome to OpenSwarm
          </Typography>
        )}

        {step === 'profile' ? (
          <>
            <Typography sx={{ fontSize: '0.88rem', color: c.text.muted, mb: 2.5, textAlign: 'center' }}>
              Tell us a bit about yourself
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2.5 }}>
              <TextField
                placeholder="Your name"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                size="small"
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    fontSize: '0.92rem',
                    color: c.text.primary,
                    borderRadius: `${c.radius.md}px`,
                    '& fieldset': { borderColor: c.border.subtle },
                    '&:hover fieldset': { borderColor: c.border.medium },
                    '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                  },
                  '& .MuiOutlinedInput-input::placeholder': { color: c.text.ghost, opacity: 1 },
                }}
              />
              {(() => {
                const trimmed = userEmail.trim();
                const valid = trimmed.length > 0 && isValidEmail(trimmed);
                const showError = emailBlurred && trimmed.length > 0 && !valid;
                const suggestion = valid ? getEmailSuggestion(trimmed) : null;
                return (
                  <Box>
                    <TextField
                      placeholder="Email address"
                      type="email"
                      value={userEmail}
                      onChange={(e) => setUserEmail(e.target.value)}
                      onBlur={() => setEmailBlurred(true)}
                      error={showError}
                      size="small"
                      fullWidth
                      InputProps={{
                        endAdornment: valid ? (
                          <InputAdornment position="end">
                            <CheckCircleIcon sx={{ fontSize: 16, color: c.status.success }} />
                          </InputAdornment>
                        ) : undefined,
                      }}
                      sx={{
                        '& .MuiOutlinedInput-root': {
                          fontSize: '0.92rem',
                          color: c.text.primary,
                          borderRadius: `${c.radius.md}px`,
                          '& fieldset': { borderColor: showError ? c.status.error : c.border.subtle },
                          '&:hover fieldset': { borderColor: showError ? c.status.error : c.border.medium },
                          '&.Mui-focused fieldset': { borderColor: showError ? c.status.error : c.accent.primary },
                        },
                        '& .MuiOutlinedInput-input::placeholder': { color: c.text.ghost, opacity: 1 },
                      }}
                    />
                    {showError && (
                      <Typography sx={{ fontSize: '0.78rem', color: c.status.error, mt: 0.4, ml: 0.5 }}>
                        That doesn't look like a valid email address
                      </Typography>
                    )}
                    {suggestion && (
                      <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mt: 0.4, ml: 0.5 }}>
                        Did you mean{' '}
                        <Box
                          component="span"
                          onClick={() => handleApplySuggestion(suggestion)}
                          sx={{
                            color: c.accent.primary,
                            fontWeight: 600,
                            cursor: 'pointer',
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          {suggestion}
                        </Box>
                        ?
                      </Typography>
                    )}
                  </Box>
                );
              })()}

              <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mt: 0.5 }}>
                What will you use OpenSwarm for?
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {USE_CASES.map((uc) => (
                  <Box
                    key={uc}
                    onClick={() => setUseCases(prev => prev.includes(uc) ? prev.filter(u => u !== uc) : [...prev, uc])}
                    sx={{
                      px: 1.5, py: 0.6,
                      borderRadius: `${c.radius.md}px`,
                      border: `1px solid ${useCases.includes(uc) ? c.accent.primary : c.border.subtle}`,
                      bgcolor: useCases.includes(uc) ? `${c.accent.primary}15` : 'transparent',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      '&:hover': { borderColor: c.border.medium },
                    }}
                  >
                    <Typography sx={{ fontSize: '0.82rem', color: useCases.includes(uc) ? c.accent.primary : c.text.secondary }}>
                      {uc}
                    </Typography>
                  </Box>
                ))}
              </Box>
              {useCases.includes('Other') && (
                <TextField
                  placeholder="Tell us what else..."
                  value={useCaseOther}
                  onChange={(e) => setUseCaseOther(e.target.value)}
                  size="small"
                  fullWidth
                  sx={{
                    mt: 0.5,
                    '& .MuiOutlinedInput-root': {
                      fontSize: '0.92rem',
                      color: c.text.primary,
                      borderRadius: `${c.radius.md}px`,
                      '& fieldset': { borderColor: c.border.subtle },
                      '&:hover fieldset': { borderColor: c.border.medium },
                      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                    },
                    '& .MuiOutlinedInput-input::placeholder': { color: c.text.ghost, opacity: 1 },
                  }}
                />
              )}

              <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mt: 0.5 }}>
                How did you hear about OpenSwarm?
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {REFERRAL_SOURCES.map((src) => (
                  <Box
                    key={src}
                    onClick={() => setReferralSource(prev => prev === src ? '' : src)}
                    sx={{
                      px: 1.5, py: 0.6,
                      borderRadius: `${c.radius.md}px`,
                      border: `1px solid ${referralSource === src ? c.accent.primary : c.border.subtle}`,
                      bgcolor: referralSource === src ? `${c.accent.primary}15` : 'transparent',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      '&:hover': { borderColor: c.border.medium },
                    }}
                  >
                    <Typography sx={{ fontSize: '0.82rem', color: referralSource === src ? c.accent.primary : c.text.secondary }}>
                      {src}
                    </Typography>
                  </Box>
                ))}
              </Box>
              {referralSource === 'Other' && (
                <TextField
                  placeholder="Where did you hear about us?"
                  value={referralSourceOther}
                  onChange={(e) => setReferralSourceOther(e.target.value)}
                  size="small"
                  fullWidth
                  sx={{
                    mt: 0.5,
                    '& .MuiOutlinedInput-root': {
                      fontSize: '0.92rem',
                      color: c.text.primary,
                      borderRadius: `${c.radius.md}px`,
                      '& fieldset': { borderColor: c.border.subtle },
                      '&:hover fieldset': { borderColor: c.border.medium },
                      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                    },
                    '& .MuiOutlinedInput-input::placeholder': { color: c.text.ghost, opacity: 1 },
                  }}
                />
              )}
            </Box>

            <Button
              onClick={handleProfileContinue}
              fullWidth
              disabled={!isProfileComplete}
              sx={{
                textTransform: 'none', fontSize: '0.92rem', fontWeight: 600,
                bgcolor: c.accent.primary, color: '#fff',
                borderRadius: `${c.radius.md}px`, py: 1,
                '&:hover': { bgcolor: c.accent.hover },
                '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.4 },
                mb: 1,
              }}
            >
              Continue
            </Button>
          </>
        ) : step === 'walkthrough' ? (
          <>
            {/* Hero image area — soft pastel multi-color blob. Proportionally
                larger than the content area so it reads as the visual anchor. */}
            <Box
              sx={{
                position: 'relative',
                width: '100%',
                height: 400,
                background: `
                  radial-gradient(circle at 18% 78%, #F5A574 0%, rgba(245,165,116,0) 48%),
                  radial-gradient(circle at 58% 55%, #E9A5D0 0%, rgba(233,165,208,0) 52%),
                  radial-gradient(circle at 82% 22%, #B9C9F4 0%, rgba(185,201,244,0) 58%),
                  linear-gradient(135deg, #C4D0F2 0%, #EDB3CC 50%, #F5B088 100%)
                `,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              <Typography
                sx={{
                  position: 'relative',
                  zIndex: 2,
                  fontSize: 88,
                  color: '#fff',
                  filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.18))',
                  lineHeight: 1,
                }}
              >
                ✦
              </Typography>
            </Box>

            <Box sx={{ px: 3, pt: 2, pb: 2.5 }}>
              <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'center', mb: 1.75 }}>
                {EDUCATION_STEPS.map((_, i) => (
                  <Box
                    key={i}
                    sx={{
                      width: i === walkthroughIdx ? 16 : 5,
                      height: 5,
                      borderRadius: 3,
                      bgcolor: i === walkthroughIdx ? c.accent.primary : i < walkthroughIdx ? c.accent.primary + '60' : c.border.medium,
                      transition: 'all 0.25s',
                    }}
                  />
                ))}
              </Box>

              <Box
                sx={{
                  display: 'inline-block',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  color: c.accent.primary,
                  bgcolor: c.accent.primary + '1a',
                  border: `1px solid ${c.accent.primary}33`,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  px: 1.1,
                  py: 0.35,
                  borderRadius: `${c.radius.sm}px`,
                  mb: 1,
                  fontFamily: c.font.sans,
                }}
              >
                Step {walkthroughIdx + 1}
              </Box>

              <Typography sx={{ fontSize: '1.25rem', fontWeight: 700, color: c.text.primary, mb: 1 }}>
                {EDUCATION_STEPS[walkthroughIdx].title}
              </Typography>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2.5, minHeight: 130 }}>
                {EDUCATION_STEPS[walkthroughIdx].body.map((p, i) => (
                  <Typography key={i} sx={{ fontSize: '1.02rem', color: c.text.secondary, lineHeight: 1.6 }}>
                    {p}
                  </Typography>
                ))}
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button
                  onClick={backWalkthrough}
                  disabled={walkthroughIdx === 0}
                  sx={{
                    textTransform: 'none', fontSize: '0.92rem', fontWeight: 600,
                    color: c.text.tertiary, borderRadius: `${c.radius.md}px`, px: 1.5, py: 0.75,
                    visibility: walkthroughIdx === 0 ? 'hidden' : 'visible',
                    '&:hover': { bgcolor: `${c.accent.primary}08` },
                  }}
                >
                  ← Back
                </Button>
                <Box sx={{ flex: 1 }} />
                <Button
                  onClick={advanceWalkthrough}
                  sx={{
                    textTransform: 'none', fontSize: '0.92rem', fontWeight: 600,
                    bgcolor: c.accent.primary, color: '#fff',
                    borderRadius: `${c.radius.md}px`, px: 2.25, py: 0.75,
                    '&:hover': { bgcolor: c.accent.hover },
                  }}
                >
                  {walkthroughIdx === EDUCATION_STEPS.length - 1 ? 'Continue' : 'Next'}
                </Button>
              </Box>
            </Box>
          </>
        ) : step === 'pricing' ? (
          <>
            <Typography sx={{ fontSize: '0.88rem', color: c.text.muted, mb: 2.5, textAlign: 'center' }}>
              Pick your OpenSwarm Pro plan
            </Typography>

            <PlanPicker source="onboarding" defaultPlan="pro_plus" />

            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 2 }}>
              <Button
                onClick={() => { setStep('connect'); trackEvent('onboarding.pricing_back'); }}
                startIcon={<ArrowBackIcon sx={{ fontSize: 14 }} />}
                sx={{
                  textTransform: 'none', fontSize: '0.85rem', fontWeight: 500,
                  color: c.text.tertiary, '&:hover': { bgcolor: `${c.accent.primary}08` },
                }}
              >
                Back
              </Button>
              <Button
                onClick={handleSkip}
                sx={{ textTransform: 'none', fontSize: '0.82rem', color: c.text.ghost, '&:hover': { bgcolor: 'transparent', color: c.text.muted } }}
              >
                Skip for now
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Typography sx={{ fontSize: '0.88rem', color: c.text.muted, mb: 3, textAlign: 'center' }}>
              Connect an AI model to get started
            </Typography>

            {/* Subscription options */}
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
              Use your existing subscription
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 2.5 }}>
              {SUBSCRIPTION_PROVIDERS.map((p) => (
                <Box
                  key={p.id}
                  onClick={() => !p.preview && !connecting && nineRouterReady && handleConnect(p.id)}
                  sx={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
                    cursor: p.preview || !nineRouterReady ? 'default' : connecting ? 'wait' : 'pointer',
                    opacity: p.preview ? 0.5 : !nineRouterReady ? 0.6 : 1,
                    transition: 'border-color 0.15s, background 0.15s',
                    ...(!p.preview && nineRouterReady && { '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` } }),
                  }}
                >
                  <Box>
                    <Typography sx={{ fontSize: '0.92rem', fontWeight: 600, color: c.text.primary }}>{p.name}</Typography>
                    <Typography sx={{ fontSize: '0.75rem', color: c.text.muted }}>{p.desc}</Typography>
                  </Box>
                  <Typography sx={{ fontSize: '0.78rem', color: p.preview ? c.text.ghost : connecting === p.id ? c.accent.primary : !nineRouterReady ? c.text.ghost : c.text.tertiary, fontStyle: p.preview ? 'italic' : 'normal' }}>
                    {p.preview ? 'Coming soon' : connecting === p.id ? 'Connecting...' : !nineRouterReady && nineRouterReady !== false ? 'Starting...' : 'Connect \u2192'}
                  </Typography>
                </Box>
              ))}
            </Box>

            {/* API key option */}
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
              Or use an API key
            </Typography>
            <Box
              onClick={handleApiKey}
              sx={{
                p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
                cursor: 'pointer', mb: 2.5,
                '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` },
              }}
            >
              <Typography sx={{ fontSize: '0.88rem', color: c.text.primary }}>
                I have an API key
              </Typography>
              <Typography sx={{ fontSize: '0.75rem', color: c.text.muted }}>
                Go to Settings &rarr; Models to enter your key
              </Typography>
            </Box>

            {/* Skip */}
            <Button
              onClick={handleSkip}
              fullWidth
              sx={{ textTransform: 'none', fontSize: '0.82rem', color: c.text.ghost, '&:hover': { bgcolor: 'transparent', color: c.text.muted } }}
            >
              Skip for now
            </Button>
          </>
        )}
      </Box>
    </Modal>
  );
};

export default OnboardingModal;
